"""In-person recording: consent, lifecycle, chunk validation, final pass, naming and the post-meeting pipeline.

OpenRouter speech-to-text and the text model are mocked; Vexa fails the test if it is ever called.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from in_person_helpers import (
    WEBM_HEADER,
    FakeOpenRouterStt,
    FakeTextModel,
    configure_providers,
    no_vexa,
    start_recording,
    upload,
    wait_for,
    webm_chunk,
)
from sqlalchemy import select, update

from app.database import InPersonChunkRow, InPersonSessionRow, UsageEventRow
from app.main import create_app
from app.tenant import tenant_scope


@pytest.fixture()
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("IN_PERSON_CLEANUP_ENABLED", "0")
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'in-person.db'}", credential_key="test-key",
                     vexa_adapter=no_vexa())
    stt, text = FakeOpenRouterStt(), FakeTextModel()
    with TestClient(app) as client:
        configure_providers(app, client, stt, text)
        yield {"app": app, "client": client, "stt": stt, "text": text}


def _chunks(app, meeting_id: str) -> list[InPersonChunkRow]:
    with app.state.database.session_factory() as session:
        return session.execute(select(InPersonChunkRow).where(InPersonChunkRow.meeting_id == meeting_id)).scalars().all()


def _record(client: TestClient, pieces: int = 3, **overrides) -> str:
    meeting_id = start_recording(client, **overrides)["meeting_id"]
    for seq in range(pieces):
        assert upload(client, meeting_id, seq).status_code == 200
    return meeting_id


# ----- consent and creation -----------------------------------------------------------------------------
def test_recording_requires_consent_and_stores_it_with_the_meeting(world) -> None:
    client = world["client"]
    refused = client.post("/v1/in-person/meetings", json={
        "device": "phone", "mime_type": "audio/webm", "consent": {"everyone_agreed": False, "notice_shown": False}})
    assert refused.status_code == 422
    assert "agreed to be recorded" in refused.text
    missing = client.post("/v1/in-person/meetings", json={"device": "phone", "mime_type": "audio/webm"})
    assert missing.status_code == 422

    session = start_recording(client, expected_people=["Priya Shah", " Marcus "])
    assert session["status"] == "recording"
    assert session["consent"]["everyone_agreed"] is True and session["consent"]["notice_shown"] is True
    assert session["consent"]["agreed_at"]
    assert session["mime_type"] == "audio/webm" and session["device"] == "phone" and session["is_recorder"]
    assert session["last_seq"] == -1 and session["limits"]["chunk_ms"] == 15_000
    meeting = client.get(f"/v1/meetings/{session['meeting_id']}").json()
    assert meeting["platform"] == "in_person" and meeting["status"] == "active"
    assert meeting["meeting_url"] == "" and meeting["vexa_meeting_id"] is None
    listed = client.get("/v1/meetings").json()["items"]
    assert [item["platform"] for item in listed] == ["in_person"]


def test_unsupported_audio_type_and_missing_stt_profile_are_explained(world, tmp_path) -> None:
    client = world["client"]
    bad = client.post("/v1/in-person/meetings", json={
        "device": "laptop", "mime_type": "audio/x-flac", "consent": {"everyone_agreed": True}})
    assert bad.status_code == 415
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'bare.db'}", credential_key="k", vexa_adapter=no_vexa())
    with TestClient(app) as bare:
        response = bare.post("/v1/in-person/meetings", json={
            "device": "phone", "mime_type": "audio/webm", "consent": {"everyone_agreed": True}})
        assert response.status_code == 409
        assert "Speech to text default" in response.json()["detail"]


def test_vexa_routes_refuse_in_person_meetings(world) -> None:
    client = world["client"]
    meeting_id = start_recording(client)["meeting_id"]
    assert client.post(f"/v1/meetings/{meeting_id}/join").status_code == 409
    assert client.post(f"/v1/meetings/{meeting_id}/stop").status_code == 409
    assert client.get(f"/v1/meetings/{meeting_id}/transcript").json()["segments"] == []
    assert client.get(f"/v1/meetings/{meeting_id}/participants").status_code == 200


# ----- chunks ----------------------------------------------------------------------------------------------
def test_chunk_sequence_duplicates_gaps_size_and_type(world) -> None:
    client = world["client"]
    meeting_id = start_recording(client)["meeting_id"]
    first = upload(client, meeting_id, 0)
    assert first.status_code == 200 and first.json() == {
        "seq": 0, "duplicate": False, "last_seq": 0, "received_chunks": 1, "duration_ms": 15_000,
        "total_bytes": len(webm_chunk(0))}
    again = upload(client, meeting_id, 0)
    assert again.status_code == 200 and again.json()["duplicate"] is True and again.json()["received_chunks"] == 1
    gap = upload(client, meeting_id, 2)
    assert gap.status_code == 409 and gap.json()["detail"]["expected_seq"] == 1
    assert upload(client, meeting_id, 1, content_type="audio/mp4").status_code == 415
    assert upload(client, meeting_id, 1, content_type="text/plain").status_code == 415
    assert upload(client, meeting_id, 1, b"").status_code == 422
    assert upload(client, meeting_id, 1, b"x" * (2 * 1024 * 1024 + 1)).status_code == 413
    assert upload(client, meeting_id, 1, duration_ms=0).status_code == 422
    assert upload(client, meeting_id, 1, duration_ms=25_000).status_code == 422
    assert upload(client, meeting_id, 1).status_code == 200
    assert [row.seq for row in _chunks(world["app"], meeting_id)] == [0, 1]
    assert _chunks(world["app"], meeting_id)[0].stream_start is True


def test_chunk_limits_total_duration(world) -> None:
    client, app = world["client"], world["app"]
    meeting_id = start_recording(client)["meeting_id"]
    assert upload(client, meeting_id, 0).status_code == 200
    with app.state.database.session_factory.begin() as session:
        session.execute(update(InPersonSessionRow).where(InPersonSessionRow.meeting_id == meeting_id).values(
            duration_ms=4 * 60 * 60 * 1000))
    over = upload(client, meeting_id, 1, duration_ms=20_000)
    assert over.status_code == 413 and "4 hour" in over.json()["detail"]


def test_chunk_upload_is_rate_limited(world) -> None:
    client = world["client"]
    meeting_id = start_recording(client)["meeting_id"]
    statuses = [upload(client, meeting_id, 0).status_code for _ in range(601)]
    assert statuses[:600].count(200) == 600 and statuses[-1] == 429


def test_live_preview_captions_use_the_stream_header_and_are_metered(world) -> None:
    client, stt, app = world["client"], world["stt"], world["app"]
    meeting_id = start_recording(client)["meeting_id"]
    assert upload(client, meeting_id, 0).status_code == 200
    session = _wait_captions(client, meeting_id, 1)
    assert session["captions"][0] == {"seq": 0, "start_ms": 0, "text": "we should ship the pilot"}
    assert stt.requests[0]["response_format"] == "json" and "diarize" not in stt.requests[0]
    assert stt.requests[0]["input_audio"]["format"] == "webm"
    assert stt.audio(0) == webm_chunk(0)
    assert upload(client, meeting_id, 1).status_code == 200
    session = _wait_captions(client, meeting_id, 2)
    assert session["captions"][1]["start_ms"] == 15_000
    assert stt.audio(1) == WEBM_HEADER + webm_chunk(1)  # header of chunk 0 + the new cluster
    with app.state.database.session_factory() as db:
        rows = db.execute(select(UsageEventRow).where(UsageEventRow.purpose == "in_person_live_preview")).scalars().all()
    assert len(rows) == 2 and all(row.kind == "transcription" and row.meeting_id == meeting_id for row in rows)
    assert rows[0].unit_type == "audio_seconds" and rows[0].units == 15 and rows[0].estimated_usd == 0.0001
    assert rows[0].price_source == "provider_reported_cost"


def _wait_captions(client: TestClient, meeting_id: str, count: int) -> dict:
    import time

    for _ in range(200):
        session = client.get(f"/v1/in-person/meetings/{meeting_id}").json()
        if len(session["captions"]) >= count:
            return session
        time.sleep(0.02)
    raise AssertionError("captions never arrived")


# ----- controls ---------------------------------------------------------------------------------------------
def test_pause_resume_moments_and_stop_with_missing_audio(world) -> None:
    client = world["client"]
    meeting_id = _record(client, pieces=2)
    assert client.post(f"/v1/in-person/meetings/{meeting_id}/pause").json()["status"] == "paused"
    assert upload(client, meeting_id, 2).status_code == 200  # a piece flushed after Pause is still accepted
    assert client.post(f"/v1/in-person/meetings/{meeting_id}/resume").json()["status"] == "recording"
    marked = client.post(f"/v1/in-person/meetings/{meeting_id}/moments", json={"at_ms": 20_000, "label": "  Budget  "})
    assert marked.json()["moments"] == [{"at_ms": 20_000, "label": "Budget"}]
    early = client.post(f"/v1/in-person/meetings/{meeting_id}/stop", json={"final_seq": 4})
    assert early.status_code == 409 and early.json()["detail"]["expected_seq"] == 3


def test_stop_without_audio_fails_cleanly(world) -> None:
    client = world["client"]
    meeting_id = start_recording(client)["meeting_id"]
    stopped = client.post(f"/v1/in-person/meetings/{meeting_id}/stop", json={"final_seq": -1}).json()
    assert stopped["status"] == "failed" and "No audio" in stopped["error"]
    assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] == "failed"


def test_discard_deletes_meeting_and_audio(world) -> None:
    client, app = world["client"], world["app"]
    meeting_id = _record(client, pieces=1)
    assert client.post(f"/v1/in-person/meetings/{meeting_id}/discard").status_code == 204
    assert client.get(f"/v1/meetings/{meeting_id}").status_code == 404
    assert _chunks(app, meeting_id) == []


# ----- final pass ---------------------------------------------------------------------------------------------
def test_stop_runs_one_diarized_pass_saves_speakers_and_deletes_audio(world) -> None:
    client, stt, app, text = world["client"], world["stt"], world["app"], world["text"]
    meeting_id = _record(client, pieces=3, expected_people=["Priya Shah"])
    client.post(f"/v1/in-person/meetings/{meeting_id}/moments", json={"at_ms": 6000, "label": "Launch date"})
    stopping = client.post(f"/v1/in-person/meetings/{meeting_id}/stop", json={"final_seq": 2})
    assert stopping.status_code == 200 and stopping.json()["status"] == "finalizing"
    done = wait_for(client, meeting_id, {"done", "failed"})
    assert done["status"] == "done", done
    assert done["speaker_labels"] == "diarized" and done["finalize"]["stage"] == "done"
    assert done["captions"] == []

    final = [body for body in stt.requests if body.get("diarize")]
    assert len(final) == 1
    assert final[0]["response_format"] == "verbose_json" and final[0]["timestamp_granularities"] == ["segment", "word"]
    assert final[0]["model"] == "google/gemini-3.5-transcribe"
    assert base64_audio(final[0]) == webm_chunk(0) + webm_chunk(1) + webm_chunk(2)  # one continuous file

    transcript = client.get(f"/v1/meetings/{meeting_id}/transcript").json()
    assert [(item["raw_speaker"], item["text"]) for item in transcript["segments"]] == [
        ("Speaker A", "Hi everyone, I'm Priya from product."),
        ("Speaker B", "Thanks, Priya. Marcus here, finance."),
        ("Speaker A", "Let's ship the pilot in October."),
    ]
    assert transcript["segments"][0]["attribution_source"] == "in_person_diarized"
    assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] == "completed"
    assert _chunks(app, meeting_id) == []  # audio is deleted once the transcript is saved
    route = client.get(f"/v1/meetings/{meeting_id}/transcription-route").json()
    assert route["mode"] == "profile" and route["endpoint_host"] == "openrouter.ai"
    guidance = client.get(f"/v1/meetings/{meeting_id}/mom-guidance").json()
    assert "[0:06] Launch date" in guidance["instructions"]
    naming_prompt = next(item for item in text.requests if item.metadata["purpose"] == "in_person_speaker_naming")
    assert "Priya Shah" in naming_prompt.prompt and naming_prompt.response_schema["required"] == ["speakers"]

    with app.state.database.session_factory() as db:
        rows = db.execute(select(UsageEventRow).where(UsageEventRow.purpose == "in_person_transcription")).scalars().all()
    assert len(rows) == 1 and rows[0].meeting_id == meeting_id and rows[0].units == 30.0
    assert rows[0].estimated_usd == 0.0021 and rows[0].details["endpoint_host"] == "openrouter.ai"
    assert "Priya" not in str(rows[0].details)  # no transcript text in the ledger


def base64_audio(body: dict) -> bytes:
    import base64

    return base64.b64decode(body["input_audio"]["data"])


def test_speaker_names_are_suggested_with_evidence_and_applied_only_when_approved(world) -> None:
    client = world["client"]
    meeting_id = _record(client, pieces=1)
    client.post(f"/v1/in-person/meetings/{meeting_id}/stop", json={"final_seq": 0})
    wait_for(client, meeting_id, {"done"})
    view = client.get(f"/v1/in-person/meetings/{meeting_id}/speaker-names").json()
    assert view["status"] == "ready" and not view["single_speaker"]
    rows = {row["speaker"]: row for row in view["speakers"]}
    assert rows["Speaker A"]["suggestion"]["name"] == "Priya Shah"
    assert rows["Speaker A"]["suggestion"]["evidence"] == [
        {"quote": "I'm Priya from product", "at_seconds": 0.0, "kind": "self_introduction"}]
    assert rows["Speaker A"]["state"] == "suggested" and rows["Speaker A"]["current_name"] is None
    before = client.get(f"/v1/meetings/{meeting_id}/transcript").json()["segments"]
    assert {item["speaker"] for item in before} == {"Speaker A", "Speaker B"}  # nothing applied yet

    approved = client.post(f"/v1/in-person/meetings/{meeting_id}/speaker-names/approve", json={
        "approvals": [{"speaker": "Speaker A", "name": "Priya Shah"}]}).json()
    assert {row["speaker"]: row["state"] for row in approved["speakers"]} == {"Speaker A": "approved", "Speaker B": "suggested"}
    after = client.get(f"/v1/meetings/{meeting_id}/transcript").json()["segments"]
    assert [item["speaker"] for item in after] == ["Priya Shah", "Speaker B", "Priya Shah"]
    dismissed = client.post(f"/v1/in-person/meetings/{meeting_id}/speaker-names/dismiss", json={"speaker": "Speaker B"}).json()
    assert {row["speaker"]: row["state"] for row in dismissed["speakers"]}["Speaker B"] == "dismissed"
    unknown = client.post(f"/v1/in-person/meetings/{meeting_id}/speaker-names/approve", json={
        "approvals": [{"speaker": "Speaker Z", "name": "Nobody"}]})
    assert unknown.status_code == 409
    # The email suggestions treat unnamed diarization labels as generic, and named people normally.
    suggestions = client.get(f"/v1/meetings/{meeting_id}/speaker-suggestions")
    assert suggestions.status_code == 200
    assert all(item["speaker"] != "Speaker B" for item in suggestions.json())


def test_no_speaker_labels_falls_back_to_a_single_speaker(world) -> None:
    client, stt = world["client"], world["stt"]
    stt.reject_diarize = True
    meeting_id = _record(client, pieces=1)
    client.post(f"/v1/in-person/meetings/{meeting_id}/stop", json={"final_seq": 0})
    done = wait_for(client, meeting_id, {"done", "failed"})
    assert done["status"] == "done" and done["speaker_labels"] == "single"
    formats = [(body["response_format"], body.get("diarize")) for body in stt.requests if body["response_format"] != "json"
               or body.get("diarize") is not None]
    assert formats[0] == ("verbose_json", True) and formats[1] == ("verbose_json", None)
    transcript = client.get(f"/v1/meetings/{meeting_id}/transcript").json()["segments"]
    assert {item["speaker"] for item in transcript} == {"Speaker"}
    view = client.get(f"/v1/in-person/meetings/{meeting_id}/speaker-names").json()
    assert view["status"] == "not_applicable" and view["single_speaker"] is True
    assert "rename or reassign" in view["message"]
    segment = transcript[1]["segment_id"]
    corrected = client.put(f"/v1/meetings/{meeting_id}/transcript/segments/{segment}/speaker",
                           json={"display_name": "Marcus"})
    assert corrected.status_code == 200
    assert [item["speaker"] for item in corrected.json()["segments"]] == ["Speaker", "Marcus", "Speaker"]


def test_failed_final_pass_keeps_audio_for_retry(world) -> None:
    client, stt, app = world["client"], world["stt"], world["app"]
    stt.fail_status = 401
    meeting_id = _record(client, pieces=2)
    client.post(f"/v1/in-person/meetings/{meeting_id}/stop", json={"final_seq": 1})
    failed = wait_for(client, meeting_id, {"failed", "done"})
    assert failed["status"] == "failed" and "rejected the API key" in failed["error"]
    assert "stt-secret-key" not in failed["error"]
    assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] == "failed"
    assert len(_chunks(app, meeting_id)) == 2
    stt.fail_status = None
    retried = client.post(f"/v1/in-person/meetings/{meeting_id}/retry")
    assert retried.status_code == 200 and retried.json()["status"] == "finalizing"
    assert wait_for(client, meeting_id, {"done", "failed"})["status"] == "done"
    assert _chunks(app, meeting_id) == []


def test_post_meeting_worker_drafts_minutes_for_in_person_meetings_without_vexa(world) -> None:
    client, app = world["client"], world["app"]
    meeting_id = _record(client, pieces=1)
    client.post(f"/v1/in-person/meetings/{meeting_id}/stop", json={"final_seq": 0})
    wait_for(client, meeting_id, {"done"})
    from app.database import LEGACY_ORGANIZATION_ID

    async def process() -> None:
        with tenant_scope(LEGACY_ORGANIZATION_ID):
            await app.state.post_meeting_worker.process_meeting(UUID(meeting_id))

    client.portal.call(process)
    minutes = client.get(f"/v1/meetings/{meeting_id}/minutes")
    assert minutes.status_code == 200 and minutes.json()["status"] == "draft"
    assert minutes.json()["title"] == "Pilot planning"
    notes = client.get("/v1/notifications").json()
    titles = [item["title"] for item in (notes["items"] if isinstance(notes, dict) else notes)]
    assert any("Capture finished" in title for title in titles)
    assert any("inutes" in title for title in titles)


# ----- cleanup ------------------------------------------------------------------------------------------------
def test_cleanup_deletes_abandoned_audio_and_unsticks_finalizing(world) -> None:
    client, app = world["client"], world["app"]
    abandoned = _record(client, pieces=2)
    stuck = _record(client, pieces=1)
    fresh = _record(client, pieces=1)
    old = datetime.now(UTC) - timedelta(hours=25)
    with app.state.database.session_factory.begin() as session:
        session.execute(update(InPersonSessionRow).where(InPersonSessionRow.meeting_id == abandoned).values(last_activity_at=old))
        session.execute(update(InPersonSessionRow).where(InPersonSessionRow.meeting_id == stuck).values(
            status="finalizing", last_activity_at=datetime.now(UTC) - timedelta(hours=3)))
    counts = app.state.in_person_finalizer.cleanup()
    assert counts == {"abandoned": 1, "stuck": 1, "orphaned": 0, "completed": 0}
    assert _chunks(app, abandoned) == [] and len(_chunks(app, stuck)) == 1 and len(_chunks(app, fresh)) == 1
    session = client.get(f"/v1/in-person/meetings/{abandoned}").json()
    assert session["status"] == "failed" and "abandoned" in session["error"]
    assert client.get(f"/v1/meetings/{abandoned}").json()["status"] == "failed"
    assert client.get(f"/v1/in-person/meetings/{stuck}").json()["status"] == "failed"
    assert app.state.in_person_finalizer.cleanup()["abandoned"] == 0  # idempotent


def test_cleanup_loop_runs_only_in_the_leader(monkeypatch, tmp_path) -> None:
    """The loop is started from start_loops, which only the background leader runs (see leader.py)."""
    monkeypatch.delenv("IN_PERSON_CLEANUP_ENABLED", raising=False)
    started: list[str] = []

    async def fake_run(self) -> None:
        started.append("cleanup")
        await asyncio.sleep(3600)

    monkeypatch.setattr("app.in_person_finalize.InPersonFinalizer.run", fake_run)

    class NeverLeader:
        def try_acquire(self) -> bool:
            return False

        def still_held(self) -> bool:
            return False

        def release(self) -> None:
            return None

    monkeypatch.setattr("app.main.leader_lock_for", lambda database: NeverLeader())
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'follower.db'}", credential_key="k", vexa_adapter=no_vexa())
    with TestClient(app):
        pass
    assert started == []
    leader_app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'leader.db'}", credential_key="k", vexa_adapter=no_vexa())
    monkeypatch.undo()
    monkeypatch.setattr("app.in_person_finalize.InPersonFinalizer.run", fake_run)
    with TestClient(leader_app):
        pass
    assert started == ["cleanup"]


# ----- starting from a calendar event -----------------------------------------------------------------------------
class _Calendar:
    """One calendar with one event; ``events_for_window`` is what the server re-reads (never the browser's copy)."""

    def __init__(self) -> None:
        from app.composio_calendar import CalendarEvent

        start = datetime(2026, 9, 29, 15, 0, tzinfo=UTC)
        self.event = CalendarEvent(
            connection_id="google", provider="googlecalendar", event_id="evt-1", title="Acme onsite review",
            starts_at=start, ends_at=start + timedelta(hours=1), meeting_url="https://meet.google.com/abc-defg-hij",
            platform="google_meet", agenda="Budget", organizer="host@example.com",
            invitees=[{"name": "Priya Shah", "email": "priya@example.com"}, {"name": "Marcus Lee", "email": "m@example.com"}])

    async def events_for_window(self, actor, connection_id, start, end, timezone, **kwargs):
        from app.composio_calendar import CalendarEventsResponse

        events = [self.event] if connection_id == "google" else []
        return CalendarEventsResponse(events=events, range_start=start, range_end=end, timezone=timezone)


def test_recording_from_a_calendar_event_carries_title_invitees_and_source(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("IN_PERSON_CLEANUP_ENABLED", "0")
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'calendar.db'}", credential_key="k",
                     vexa_adapter=no_vexa(), calendar_adapter=_Calendar())
    text = FakeTextModel()
    with TestClient(app) as client:
        configure_providers(app, client, FakeOpenRouterStt(), text)
        reference = {"connection_id": "google", "event_id": "evt-1", "event_date": "2026-09-29", "timezone": "UTC"}
        missing = client.post("/v1/in-person/meetings", json={
            "device": "laptop", "mime_type": "audio/webm", "consent": {"everyone_agreed": True},
            "calendar_event": {**reference, "event_id": "gone"}})
        assert missing.status_code == 404
        session = start_recording(client, title=None, calendar_event=reference, expected_people=["Dana"])
        meeting_id = session["meeting_id"]
        assert session["title"] == "Acme onsite review"
        source = client.get(f"/v1/meetings/{meeting_id}/source")
        assert source.status_code == 200 and source.json()["event_id"] == "evt-1"
        assert upload(client, meeting_id, 0).status_code == 200
        client.post(f"/v1/in-person/meetings/{meeting_id}/stop", json={"final_seq": 0})
        assert wait_for(client, meeting_id, {"done", "failed"})["status"] == "done"
        prompt = next(item for item in text.requests if item.metadata["purpose"] == "in_person_speaker_naming").prompt
        assert "Dana" in prompt and "Priya Shah" in prompt and "Marcus Lee" in prompt


def test_cleanup_completes_a_meeting_left_open_by_a_restart_and_deletes_leftover_audio(world) -> None:
    client, app = world["client"], world["app"]
    meeting_id = _record(client, pieces=2)
    with app.state.database.session_factory.begin() as session:  # as if the process died mid-success
        session.execute(update(InPersonSessionRow).where(InPersonSessionRow.meeting_id == meeting_id).values(status="done"))
    assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] == "active"
    counts = app.state.in_person_finalizer.cleanup()
    assert counts["completed"] == 1 and counts["orphaned"] == 1
    assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] == "completed"
    assert _chunks(app, meeting_id) == []
    assert app.state.in_person_finalizer.cleanup()["completed"] == 0
