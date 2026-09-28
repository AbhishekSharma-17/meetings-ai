"""Background jobs: lifecycle, restart recovery, prep and minutes jobs end to end."""

import asyncio
import threading
import time
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from app.background_jobs import INTERRUPTED_MESSAGE, BackgroundJobService, JobFailure
from app.database import (
    LEGACY_ADMIN_USER_ID,
    LEGACY_ORGANIZATION_ID,
    BackgroundJobRow,
    Database,
)
from app.main import create_app
from app.tenant import current_organization_id
from fastapi.testclient import TestClient
from meetings_contracts import (
    MeetingStatus,
    MeetingTranscriptSegment,
    ProviderType,
    TextGenerationResult,
)
from test_calendar_prep import FakeCalendar, _sync, _v2_output


def _database() -> Database:
    database = Database("sqlite+pysqlite:///:memory:")
    database.migrate()
    return database


def _submit(jobs: BackgroundJobService, kind: str, subject: str = "subject-1"):
    return jobs.submit(organization_id=LEGACY_ORGANIZATION_ID, user_id=LEGACY_ADMIN_USER_ID,
                       kind=kind, subject_id=subject, payload={"n": 1})


def test_job_lifecycle_progress_success_failure_and_reuse() -> None:
    database = _database()
    jobs = BackgroundJobService(database, concurrency=1)
    outcomes: list[tuple[str, str]] = []
    release = asyncio.Event()

    async def succeed(context):
        assert current_organization_id() == LEGACY_ORGANIZATION_ID
        await context.progress("writing", "Writing")
        await release.wait()
        return {"doubled": context.payload["n"] * 2}

    async def fail(context):
        raise JobFailure("provider is not configured", 409)

    async def crash(context):
        raise RuntimeError("secret upstream detail")

    jobs.register("ok", succeed, on_success=lambda job: outcomes.append(("ok", job.status)))
    jobs.register("bad", fail, on_failure=lambda job: outcomes.append(("bad", job.error)))
    jobs.register("crash", crash, on_failure=lambda job: outcomes.append(("crash", job.error)))

    async def scenario():
        await jobs.start()
        job, created = _submit(jobs, "ok")
        assert created and job.status == "queued"
        again, created_again = _submit(jobs, "ok")
        assert again.id == job.id and created_again is False
        for _ in range(50):
            await asyncio.sleep(0.01)
            with database.session_factory() as session:
                if session.get(BackgroundJobRow, str(job.id)).stage == "writing":
                    break
        with database.session_factory() as session:
            row = session.get(BackgroundJobRow, str(job.id))
            assert (row.status, row.stage, row.attempts) == ("running", "writing", 1)
        release.set()
        await jobs.wait(job.id)
        bad, _ = _submit(jobs, "bad")
        await jobs.wait(bad.id)
        crashed, _ = _submit(jobs, "crash")
        await jobs.wait(crashed.id)
        return job, bad, crashed

    job, bad, crashed = asyncio.run(scenario())
    with database.session_factory() as session:
        done = session.get(BackgroundJobRow, str(job.id))
        assert (done.status, done.stage, done.result) == ("succeeded", "done", {"doubled": 2})
        failed = session.get(BackgroundJobRow, str(bad.id))
        assert (failed.status, failed.error, failed.result) == ("failed", "provider is not configured", {"error_status": 409})
        generic = session.get(BackgroundJobRow, str(crashed.id))
        assert generic.status == "failed" and "secret" not in generic.error
    assert outcomes == [("ok", "succeeded"), ("bad", "provider is not configured"), ("crash", generic.error)]


def test_cancel_stops_a_running_job_and_hides_other_users_jobs() -> None:
    database = _database()
    jobs = BackgroundJobService(database)
    started = asyncio.Event()

    async def forever(context):
        started.set()
        await asyncio.sleep(60)

    jobs.register("slow", forever)

    class _Actor:
        organization_id = LEGACY_ORGANIZATION_ID
        user_id = LEGACY_ADMIN_USER_ID
        is_admin = True

    class _Stranger(_Actor):
        user_id = uuid4()
        is_admin = False

    async def scenario():
        await jobs.start()
        job, _ = _submit(jobs, "slow")
        await started.wait()
        with pytest.raises(LookupError):
            jobs.get(_Stranger(), job.id)
        assert jobs.list(_Stranger(), active=True) == []
        return await jobs.cancel(_Actor(), job.id)

    cancelled = asyncio.run(scenario())
    assert cancelled.status == "cancelled"


def test_restart_marks_running_jobs_failed_and_resumes_queued_jobs() -> None:
    database = _database()
    now = datetime.now(UTC)

    def row(status: str) -> BackgroundJobRow:
        return BackgroundJobRow(
            id=str(uuid4()), organization_id=str(LEGACY_ORGANIZATION_ID), user_id=str(LEGACY_ADMIN_USER_ID),
            kind="work", subject_id="s", status=status, stage=status, message=None, payload={}, result=None,
            error=None, attempts=1 if status == "running" else 0, created_at=now, started_at=None,
            finished_at=None, updated_at=now,
        )

    interrupted, waiting = row("running"), row("queued")
    with database.session_factory.begin() as session:
        session.add_all([interrupted, waiting])
    failures: list[str] = []
    ran: list[str] = []

    async def work(context):
        ran.append(str(context.job_id))
        return {"ok": True}

    restarted = BackgroundJobService(database)
    restarted.register("work", work, on_failure=lambda job: failures.append(job.error))

    async def scenario():
        await restarted.start()
        await restarted.wait(waiting.id)

    asyncio.run(scenario())
    with database.session_factory() as session:
        first = session.get(BackgroundJobRow, interrupted.id)
        assert (first.status, first.error) == ("failed", INTERRUPTED_MESSAGE)
        assert first.result == {"error_status": 503, "retryable": True}
        assert session.get(BackgroundJobRow, waiting.id).status == "succeeded"
    assert failures == [INTERRUPTED_MESSAGE]
    assert ran == [waiting.id]


def _poll(client: TestClient, job_id: str, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f"/v1/background-jobs/{job_id}").json()
        if job["status"] not in {"queued", "running"}:
            return job
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish: {job}")


def test_prep_job_runs_in_background_saves_the_briefing_and_notifies(tmp_path) -> None:
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'prep-jobs.db'}",
                     credential_key="test-only-credential-key", calendar_adapter=FakeCalendar())
    gate = threading.Event()

    async def synthesize(request, profile_id=None, **_):
        while not gate.is_set():
            await asyncio.sleep(0.01)
        return None, TextGenerationResult(text="", provider="test", model="test-model", structured_output=_v2_output(
            executive_brief="Discuss the planned discovery call.",
        ))

    app.state.profile_service.generate_text = synthesize
    with TestClient(app) as client:
        event_id = _sync(client).json()["events"][0]["id"]
        started = client.post(f"/v1/calendar/events/{event_id}/prep/jobs", json={"research_enabled": False})
        assert started.status_code == 202, started.text
        job = started.json()
        assert job["kind"] == "prep_briefing" and job["subject_id"] == event_id
        # Leaving and returning: the same active job is found again, not a second generation.
        again = client.post(f"/v1/calendar/events/{event_id}/prep/jobs", json={"research_enabled": False})
        assert again.json()["id"] == job["id"]
        active = client.get("/v1/background-jobs", params={"kind": "prep_briefing", "subject_id": event_id, "active": 1})
        assert [item["id"] for item in active.json()] == [job["id"]]
        gate.set()
        finished = _poll(client, job["id"])
        assert finished["status"] == "succeeded", finished
        assert finished["stage"] == "done"
        latest = client.get(f"/v1/calendar/events/{event_id}/prep").json()
        assert latest["id"] == finished["result"]["report_id"]
        page = client.get("/v1/notifications").json()
        assert page["unread_count"] == 1
        note = page["items"][0]
        assert (note["kind"], note["severity"], note["link_view"], note["link_id"]) == (
            "prep.ready", "success", "prep", event_id)
        assert "Acme discovery" in note["title"]
        assert client.get("/v1/background-jobs", params={"active": 1}).json() == []
        assert client.get(f"/v1/background-jobs/{uuid4()}").status_code == 404


def test_prep_job_failure_is_recorded_with_its_status_and_notified(tmp_path) -> None:
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'prep-fail.db'}",
                     credential_key="test-only-credential-key", calendar_adapter=FakeCalendar())
    with TestClient(app) as client:
        event_id = _sync(client).json()["events"][0]["id"]
        # Research enabled without an Exa key is a setup error (409), as on the synchronous endpoint.
        job = client.post(f"/v1/calendar/events/{event_id}/prep/jobs", json={"research_enabled": True}).json()
        finished = _poll(client, job["id"])
        assert finished["status"] == "failed"
        assert finished["result"]["error_status"] == 409
        note = client.get("/v1/notifications").json()["items"][0]
        assert (note["kind"], note["severity"]) == ("prep.failed", "danger")
        assert client.post(f"/v1/calendar/events/{uuid4()}/prep/jobs", json={}).status_code == 404


class _MinutesAdapter:
    async def generate_text(self, profile, request):
        import json
        import re
        segment_id = re.search(r"ID=([^\n]+)", request.prompt).group(1)
        payload = {
            "title": "Weekly sync", "executive_summary": "Agreed next steps.", "discussion_points": ["Roadmap"],
            "decisions": ["Ship it."], "action_items": [], "open_questions": [],
            "speaker_contributions": [{"speaker": "Anna", "summary": "Proposed shipping.",
                                       "evidence_segment_ids": [segment_id]}],
            "questions_asked": [],
        }
        return TextGenerationResult(text=json.dumps(payload), structured_output=payload,
                                    provider="fake", model="economy-model")


def test_minutes_job_generates_the_draft_and_notifies_admins() -> None:
    app = create_app(database_url="sqlite+pysqlite:///:memory:", credential_key="test-key")
    app.state.profile_service.adapters[ProviderType.OPENAI] = _MinutesAdapter()
    with TestClient(app) as client:
        profile = client.post("/v1/provider-profiles", json={
            "name": "MOM", "provider_type": "openai", "execution_location": "cloud",
            "capabilities": [{"capability": "text_generation", "model": "economy-model"}], "api_key": "k",
        }).json()
        client.put("/v1/provider-defaults/text_generation", json={"policy": "cloud_only", "cloud_profile_id": profile["id"]})
        meeting_id = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij", "title": "Weekly sync",
        }).json()["id"]
        meeting = app.state.repository.get_meeting(UUID(meeting_id))
        meeting.status = MeetingStatus.COMPLETED
        app.state.repository.save_meeting(meeting)
        app.state.repository.replace_transcript(meeting.id, [MeetingTranscriptSegment(
            start_seconds=0, end_seconds=4, speaker="Anna", text="Let's ship it this week.")])
        started = client.post(f"/v1/meetings/{meeting_id}/minutes/jobs")
        assert started.status_code == 202, started.text
        finished = _poll(client, started.json()["id"])
        assert finished["status"] == "succeeded", finished
        assert client.get(f"/v1/meetings/{meeting_id}/minutes").json()["status"] == "draft"
        notes = client.get("/v1/notifications").json()["items"]
        assert [(note["kind"], note["link_view"], note["link_id"]) for note in notes] == [
            ("minutes.ready", "meeting", meeting_id)]
        assert client.get("/v1/background-jobs", params={"kind": "minutes_draft", "subject_id": meeting_id}).json()[0]["status"] == "succeeded"



def test_cancel_returns_promptly_when_a_job_ignores_cancellation(monkeypatch) -> None:
    import app.background_jobs as background_jobs

    monkeypatch.setattr(background_jobs, "CANCEL_WAIT_SECONDS", 0.2)
    database = _database()
    jobs = BackgroundJobService(database)
    started = asyncio.Event()
    release = asyncio.Event()

    async def stubborn(context):
        started.set()
        while not release.is_set():
            try:
                await asyncio.sleep(0.05)
            except asyncio.CancelledError:
                continue  # a provider SDK that swallows cancellation
        return {"late": True}

    jobs.register("stubborn", stubborn)

    class _Actor:
        organization_id = LEGACY_ORGANIZATION_ID
        user_id = LEGACY_ADMIN_USER_ID
        is_admin = True

    async def scenario():
        await jobs.start()
        job, _ = _submit(jobs, "stubborn")
        await started.wait()
        began = time.monotonic()
        cancelled = await jobs.cancel(_Actor(), job.id)
        elapsed = time.monotonic() - began
        release.set()
        await jobs.wait(job.id, timeout=5)
        return cancelled, elapsed, jobs.get(_Actor(), job.id)

    cancelled, elapsed, final = asyncio.run(scenario())
    assert cancelled.status == "cancelled" and elapsed < 2
    assert final.status == "cancelled"  # the late finish never overwrites the cancel


def test_minutes_job_rechecks_the_requesters_current_role() -> None:
    app = create_app(database_url="sqlite+pysqlite:///:memory:", credential_key="test-key")
    with TestClient(app) as client:
        meeting_id = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij", "title": "Weekly sync",
        }).json()["id"]
        now = datetime.now(UTC)
        member_id = str(uuid4())
        from app.database import OrganizationMembershipRow, UserRow
        with app.state.database.session_factory.begin() as session:
            session.add(UserRow(id=member_id, email="member@example.test", display_name="Member",
                                auth_subject=f"local:{member_id}", status="active", created_at=now, updated_at=now))
            session.flush()
            session.add(OrganizationMembershipRow(organization_id=str(LEGACY_ORGANIZATION_ID), user_id=member_id,
                                                  role="member", created_at=now))
        job, _ = client.portal.call(lambda: app.state.background_jobs.submit(
            organization_id=LEGACY_ORGANIZATION_ID, user_id=UUID(member_id), kind="minutes_draft",
            subject_id=meeting_id, payload={"meeting_id": meeting_id, "actor": {}}))
        finished = _poll(client, str(job.id))
        assert finished["status"] == "failed"
        assert "owners and admins" in finished["error"]
