"""Auto-leave end to end with a mocked Vexa: policy API, join payload, watchdog, keep, completion reasons."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from app.accounts import Actor
from app.adapters.vexa import VexaCaptureAdapter
from app.database import (
    LEGACY_ADMIN_USER_ID, LEGACY_ORGANIZATION_ID, CalendarScheduleRow, MeetingRow, OrganizationMembershipRow,
)
from app.leave_store import LeavePermissionError, LeavePolicyInput
from app.main import create_app
from app.tenant import tenant_scope

MEETING_URL = "https://meet.google.com/abc-defg-hij"
BOT_PATH = "/bots/google_meet/abc-defg-hij"


class FakeVexa:
    """A scripted Vexa: tests flip ``status``/``segments``/``stop_status`` between watchdog passes."""

    def __init__(self) -> None:
        self.status = "active"
        self.completion_reason: str | None = None
        self.segments: list[dict] = []
        self.stop_status = 200
        self.meeting_status_code = 200
        self.reject_automatic_leave = False
        self.requests: list[tuple[str, str, dict | None]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.requests.append((request.method, request.url.path, body))
        path = request.url.path
        if request.method == "POST" and path == "/bots":
            if self.reject_automatic_leave and "automatic_leave" in body:
                return httpx.Response(422, json={"detail": "automatic_leave has unknown field(s): max_bot_time"})
            return httpx.Response(201, json={"id": 42, "platform": "google_meet",
                                             "native_meeting_id": "abc-defg-hij", "status": "active"})
        if request.method == "GET" and path == "/meetings/42":
            if self.meeting_status_code != 200:
                return httpx.Response(self.meeting_status_code, json={"detail": "Meeting not found"})
            return httpx.Response(200, json={"id": 42, "status": self.status,
                                             "data": {"completion_reason": self.completion_reason}})
        if request.method == "GET" and path == "/transcripts/by-id/42":
            if self.meeting_status_code != 200:
                return httpx.Response(self.meeting_status_code, json={"detail": "unavailable"})
            return httpx.Response(200, json={"id": 42, "status": self.status, "segments": self.segments})
        if request.method == "DELETE" and path == "/meetings/42":
            return httpx.Response(204)
        if request.method == "DELETE" and path == BOT_PATH:
            if self.stop_status == 200:
                self.status = "stopping"
            return httpx.Response(self.stop_status, json={"detail": "stop"})
        raise AssertionError(f"unexpected Vexa request: {request.method} {path}")

    def posts(self) -> list[dict]:
        return [body for method, path, body in self.requests if method == "POST" and path == "/bots"]

    def stops(self) -> int:
        return sum(1 for method, path, _ in self.requests if method == "DELETE" and path == BOT_PATH)


def _app(vexa: FakeVexa):
    adapter = VexaCaptureAdapter("http://vexa.test", "token", transport=httpx.MockTransport(vexa.handler))
    return create_app(database_url="sqlite+pysqlite:///:memory:", credential_key="test-key", vexa_adapter=adapter)


def _segment(at: datetime, text: str = "Thanks everyone") -> dict:
    return {"start": at.timestamp() - 3, "end": at.timestamp(), "text": text, "speaker": "Anna", "completed": True}


def _joined_meeting(client, app, *, joined_at: datetime, schedule: tuple[datetime, datetime] | None) -> str:
    meeting_id = client.post("/v1/meetings", json={"meeting_url": MEETING_URL, "title": "Weekly sync"}).json()["id"]
    assert client.post(f"/v1/meetings/{meeting_id}/join").status_code == 200
    with app.state.database.session_factory.begin() as session:
        session.execute(update(MeetingRow).where(MeetingRow.id == meeting_id).values(joined_at=joined_at))
        if schedule:
            now = datetime.now(UTC)
            session.add(CalendarScheduleRow(
                meeting_id=meeting_id, organization_id=str(LEGACY_ORGANIZATION_ID), user_id=str(LEGACY_ADMIN_USER_ID),
                connection_id="manual", provider="manual", event_id=meeting_id, starts_at=schedule[0],
                ends_at=schedule[1], status="joined", attempts=1, last_error=None, created_at=now, updated_at=now))
    return meeting_id


def _tick(app, now: datetime) -> None:
    asyncio.run(app.state.leave_watchdog.tick(now))


def _state(app, meeting_id: str):
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        return app.state.leave_service.store.get(UUID(meeting_id))


def _notices(client, kind: str) -> list[dict]:
    return [item for item in client.get("/v1/notifications").json()["items"] if item["kind"] == kind]


def _clock() -> datetime:
    return datetime.now(UTC).replace(second=0, microsecond=0)


# ----- policy ----------------------------------------------------------------------------------
def test_leave_policy_defaults_validation_and_join_payload() -> None:
    vexa = FakeVexa()
    app = _app(vexa)
    with TestClient(app) as client:
        policy = client.get("/v1/workspace/leave-policy").json()
        assert (policy["silence_minutes"], policy["quiet_after_end_minutes"], policy["no_one_joined_minutes"],
                policy["max_hours"]) == (10, 5, 10, 4)
        assert (policy["service_max_hours"], policy["effective_max_hours"]) == (4, 4)
        assert policy["configured"] is False and policy["can_edit"] is True
        assert policy["limits"]["max_hours"] == [2, 12]

        for bad in ({"silence_minutes": 2}, {"max_hours": 13}, {"quiet_after_end_minutes": 0},
                    {"overrun_minutes": 30}):
            payload = {"silence_minutes": 10, "quiet_after_end_minutes": 5, "no_one_joined_minutes": 10,
                       "max_hours": 8, **bad}
            assert client.put("/v1/workspace/leave-policy", json=payload).status_code == 422, bad

        saved = client.put("/v1/workspace/leave-policy", json={
            "silence_minutes": 15, "quiet_after_end_minutes": 3, "no_one_joined_minutes": 6, "max_hours": 6})
        assert saved.status_code == 200 and saved.json()["configured"] is True
        assert saved.json()["max_hours"] == 6 and saved.json()["effective_max_hours"] == 4

        meeting_id = client.post("/v1/meetings", json={"meeting_url": MEETING_URL}).json()["id"]
        assert client.post(f"/v1/meetings/{meeting_id}/join").status_code == 200
    assert vexa.posts()[0]["automatic_leave"] == {
        "everyone_left_timeout": 15 * 60_000, "no_one_joined_timeout": 6 * 60_000, "max_bot_time": 4 * 3_600_000}


def test_policy_is_readable_by_members_and_writable_only_by_admins(monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "owner-password-for-test")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "leave-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", "owner@ourco.example")
    app = _app(FakeVexa())
    payload = {"silence_minutes": 12, "quiet_after_end_minutes": 5, "no_one_joined_minutes": 10, "max_hours": 8}
    with TestClient(app) as client:
        assert client.post("/v1/auth/login", json={"email": "owner@ourco.example",
                                                   "password": "owner-password-for-test"}).status_code == 200
        assert client.put("/v1/workspace/leave-policy", json=payload).status_code == 200
        for role in ("member", "viewer"):
            with app.state.database.session_factory.begin() as session:
                session.execute(update(OrganizationMembershipRow).values(role=role))
            view = client.get("/v1/workspace/leave-policy")
            assert view.status_code == 200 and view.json()["silence_minutes"] == 12 and view.json()["can_edit"] is False
            assert client.put("/v1/workspace/leave-policy", json=payload).status_code == 403
            assert client.post(f"/v1/meetings/{uuid4()}/keep").status_code == 403
    member = Actor(user_id=uuid4(), organization_id=LEGACY_ORGANIZATION_ID, email=None, display_name="M",
                   role="member", must_change_password=False, session_version=0)
    with pytest.raises(LeavePermissionError):
        app.state.leave_service.policies.save(member, LeavePolicyInput(**payload))


def test_join_retries_without_automatic_leave_when_vexa_rejects_it(caplog) -> None:
    vexa = FakeVexa()
    vexa.reject_automatic_leave = True
    app = _app(vexa)
    with TestClient(app) as client:
        meeting_id = client.post("/v1/meetings", json={"meeting_url": MEETING_URL}).json()["id"]
        joined = client.post(f"/v1/meetings/{meeting_id}/join")
        assert joined.status_code == 200 and joined.json()["status"] == "active"
    first, second = vexa.posts()
    assert "automatic_leave" in first and "automatic_leave" not in second
    assert "rejected automatic_leave" in caplog.text


# ----- the stuck production meeting: past its end and quiet since 11:04 ------------------------
def test_quiet_after_scheduled_end_warns_then_leaves_once_and_minutes_can_run() -> None:
    now = _clock()
    start, end = now - timedelta(hours=3), now - timedelta(hours=2, minutes=30)
    vexa = FakeVexa()
    vexa.segments = [_segment(start + timedelta(minutes=5)), _segment(end + timedelta(minutes=4, seconds=54))]
    app = _app(vexa)
    with TestClient(app) as client:
        meeting_id = _joined_meeting(client, app, joined_at=start + timedelta(minutes=1), schedule=(start, end))
        _tick(app, now)
        warnings = _notices(client, "assistant.leaving_soon")
        assert len(warnings) == 1 and "in 2 minutes — it's been quiet since" in warnings[0]["title"]
        assert warnings[0]["link_view"] == "meeting" and warnings[0]["link_id"] == meeting_id
        view = client.get(f"/v1/meetings/{meeting_id}/leave").json()
        assert view["in_call"] is True and view["next_leave"]["heads_up_sent"] is True
        assert view["next_leave"]["reason"] == "ended_quiet_after_schedule"

        _tick(app, now + timedelta(minutes=1))
        assert vexa.stops() == 0 and len(_notices(client, "assistant.leaving_soon")) == 1

        _tick(app, now + timedelta(minutes=2))
        assert vexa.stops() == 1
        assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] == "stopping"
        state = _state(app, meeting_id)
        assert (state.end_reason, state.ended_by) == ("ended_quiet_after_schedule", "auto")
        left = _notices(client, "assistant.left")
        assert len(left) == 1 and "after the scheduled end" in left[0]["title"]

        vexa.status, vexa.completion_reason = "completed", "stopped"
        _tick(app, now + timedelta(minutes=3))
        _tick(app, now + timedelta(minutes=4))
        assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] == "completed"
        assert vexa.stops() == 1 and len(_notices(client, "assistant.left")) == 1
        assert _state(app, meeting_id).end_reason == "ended_quiet_after_schedule"
        ended = client.get(f"/v1/meetings/{meeting_id}/leave").json()
        assert ended["in_call"] is False and ended["ended"]["reason"] == "ended_quiet_after_schedule"
        assert ended["ended"]["ended_by"] == "auto" and ended["scheduled_end"] is not None


def test_meeting_running_hours_over_with_ongoing_speech_stays() -> None:
    now = _clock()
    start, end = now - timedelta(hours=3), now - timedelta(hours=2, minutes=30)
    vexa = FakeVexa()
    vexa.segments = [_segment(now - timedelta(seconds=30), "still going")]
    app = _app(vexa)
    with TestClient(app) as client:
        meeting_id = _joined_meeting(client, app, joined_at=start, schedule=(start, end))
        _tick(app, now)
        assert vexa.stops() == 0 and _notices(client, "assistant.leaving_soon") == []
        view = client.get(f"/v1/meetings/{meeting_id}/leave").json()
        assert view["next_leave"]["reason"] == "ended_quiet_after_schedule"
        assert view["safety_cap_at"] is not None


def test_keep_in_call_postpones_the_leave() -> None:
    now = _clock()
    vexa = FakeVexa()
    vexa.segments = [_segment(now - timedelta(minutes=13))]
    app = _app(vexa)
    with TestClient(app) as client:
        meeting_id = _joined_meeting(client, app, joined_at=now - timedelta(minutes=40), schedule=None)
        _tick(app, now)
        assert len(_notices(client, "assistant.leaving_soon")) == 1
        kept = client.post(f"/v1/meetings/{meeting_id}/keep")
        assert kept.status_code == 200
        keep_until = datetime.fromisoformat(kept.json()["keep_until"])
        assert timedelta(minutes=29) < keep_until - datetime.now(UTC) <= timedelta(minutes=30)
        assert kept.json()["next_leave"]["heads_up_sent"] is False
        _tick(app, now + timedelta(minutes=3))
        assert vexa.stops() == 0


def test_failed_stop_backs_off_and_retries() -> None:
    now = _clock()
    vexa = FakeVexa()
    vexa.segments = [_segment(now - timedelta(minutes=16))]
    vexa.stop_status = 503
    app = _app(vexa)
    with TestClient(app) as client:
        meeting_id = _joined_meeting(client, app, joined_at=now - timedelta(minutes=40), schedule=None)
        _tick(app, now)  # heads-up
        _tick(app, now + timedelta(minutes=2))  # leave → Vexa 503
        state = _state(app, meeting_id)
        assert vexa.stops() == 1 and state.stop_attempts == 1 and "Retrying" in state.last_error
        assert client.get(f"/v1/meetings/{meeting_id}/leave").json()["last_error"]
        _tick(app, now + timedelta(minutes=2, seconds=10))
        assert vexa.stops() == 1  # still backing off
        vexa.stop_status = 200
        _tick(app, now + timedelta(minutes=3))
        assert vexa.stops() == 2 and _state(app, meeting_id).end_reason == "silent"
        assert len(_notices(client, "assistant.left")) == 1


def test_vexa_completion_reason_is_captured_once() -> None:
    now = _clock()
    vexa = FakeVexa()
    vexa.segments = [_segment(now - timedelta(minutes=1))]
    app = _app(vexa)
    with TestClient(app) as client:
        meeting_id = _joined_meeting(client, app, joined_at=now - timedelta(minutes=30), schedule=None)
        vexa.status, vexa.completion_reason = "completed", "evicted"
        _tick(app, now)
        _tick(app, now + timedelta(minutes=1))
        state = _state(app, meeting_id)
        assert (state.end_reason, state.ended_by) == ("host_ended", "host")
        left = _notices(client, "assistant.left")
        assert len(left) == 1 and "the host ended the meeting" in left[0]["title"]
        assert vexa.stops() == 0


def test_user_stop_is_recorded_and_stuck_stopping_is_closed_when_vexa_lost_the_meeting() -> None:
    now = _clock()
    vexa = FakeVexa()
    app = _app(vexa)
    with TestClient(app) as client:
        meeting_id = _joined_meeting(client, app, joined_at=now - timedelta(minutes=30), schedule=None)
        assert client.post(f"/v1/meetings/{meeting_id}/stop").json()["status"] == "stopping"
        assert _state(app, meeting_id).end_reason == "user_stopped"
        vexa.meeting_status_code = 404
        stopped_at = datetime.fromisoformat(client.get(f"/v1/meetings/{meeting_id}").json()["stopped_at"])
        _tick(app, stopped_at + timedelta(minutes=5))
        assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] == "stopping"
        _tick(app, stopped_at + timedelta(minutes=11))
        assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] == "completed"
        state = _state(app, meeting_id)
        assert state.end_reason == "user_stopped" and "marked finished" in state.last_error
        assert _notices(client, "assistant.left") == []


def test_watchdog_never_decides_while_vexa_is_unreachable() -> None:
    now = _clock()
    vexa = FakeVexa()
    vexa.segments = [_segment(now - timedelta(hours=1))]
    app = _app(vexa)
    with TestClient(app) as client:
        meeting_id = _joined_meeting(client, app, joined_at=now - timedelta(hours=2), schedule=None)
        vexa.meeting_status_code = 503
        _tick(app, now)
        assert vexa.stops() == 0 and _notices(client, "assistant.leaving_soon") == []
        assert _state(app, meeting_id).warned_at is None


def test_deleting_a_meeting_removes_its_leave_state() -> None:
    now = _clock()
    vexa = FakeVexa()
    app = _app(vexa)
    with TestClient(app) as client:
        meeting_id = _joined_meeting(client, app, joined_at=now - timedelta(minutes=30), schedule=None)
        client.post(f"/v1/meetings/{meeting_id}/stop")
        vexa.status, vexa.completion_reason = "completed", "stopped"
        assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] == "completed"
        assert _state(app, meeting_id).end_reason == "user_stopped"
        assert client.delete(f"/v1/meetings/{meeting_id}").status_code == 204
        assert _state(app, meeting_id).end_reason is None


def _stored(app, meeting_id: str) -> list:
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        return app.state.repository.get_transcript(UUID(meeting_id))


# ----- the meeting-bot service's 4-hour limit ---------------------------------------------------
def test_safety_cap_follows_the_service_limit_and_keep_cannot_extend_it() -> None:
    now = _clock()
    vexa = FakeVexa()
    vexa.segments = [_segment(now - timedelta(seconds=20), "still talking")]
    app = _app(vexa)
    with TestClient(app) as client:
        client.put("/v1/workspace/leave-policy", json={
            "silence_minutes": 10, "quiet_after_end_minutes": 5, "no_one_joined_minutes": 10, "max_hours": 8})
        joined = now - timedelta(hours=4) + timedelta(minutes=10)
        meeting_id = _joined_meeting(client, app, joined_at=joined, schedule=None)
        view = client.get(f"/v1/meetings/{meeting_id}/leave").json()
        assert view["effective_max_hours"] == 4 and view["cap_is_service_limit"] is True
        assert datetime.fromisoformat(view["safety_cap_at"]) == joined + timedelta(hours=4)
        assert view["can_keep"] is False
        refused = client.post(f"/v1/meetings/{meeting_id}/keep")
        assert refused.status_code == 409 and "4-hour limit" in refused.json()["detail"]

        _tick(app, now)
        warning = _notices(client, "assistant.leaving_soon")
        assert len(warning) == 1
        assert "in 10 minutes — it reaches the 4-hour limit of the meeting-bot service" in warning[0]["title"]
        assert "Keep in call" not in warning[0]["body"]
        _tick(app, now + timedelta(minutes=10))
        assert vexa.stops() == 1 and _state(app, meeting_id).end_reason == "time_limit"
        assert "the 4-hour limit of the meeting-bot service" in _notices(client, "assistant.left")[0]["title"]


def test_keep_in_call_is_clamped_to_the_safety_cap() -> None:
    now = _clock()
    vexa = FakeVexa()
    app = _app(vexa)
    with TestClient(app) as client:
        joined = datetime.now(UTC) - timedelta(hours=3, minutes=45)
        meeting_id = _joined_meeting(client, app, joined_at=joined, schedule=None)
        kept = client.post(f"/v1/meetings/{meeting_id}/keep").json()
        assert datetime.fromisoformat(kept["keep_until"]) == joined + timedelta(hours=4)
        assert kept["safety_cap_at"] == kept["keep_until"]


# ----- Vexa lost the bot: never stuck "in a call" -----------------------------------------------
def test_meeting_is_closed_when_vexa_keeps_answering_404_for_thirty_minutes() -> None:
    vexa = FakeVexa()
    app = _app(vexa)
    with TestClient(app) as client:
        meeting_id = _joined_meeting(client, app, joined_at=datetime.now(UTC) - timedelta(minutes=20), schedule=None)
        last_ok = datetime.fromisoformat(client.get(f"/v1/meetings/{meeting_id}").json()["last_refreshed_at"])
        vexa.meeting_status_code = 404
        _tick(app, last_ok + timedelta(minutes=10))
        assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] == "active"
        _tick(app, last_ok + timedelta(minutes=31))
        _tick(app, last_ok + timedelta(minutes=32))
        assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] == "completed"
        state = _state(app, meeting_id)
        assert (state.end_reason, state.ended_by) == ("bot_lost", "auto")
        left = _notices(client, "assistant.left")
        assert len(left) == 1 and "lost track of the call" in left[0]["title"]
        assert vexa.stops() == 0


def test_vexa_outage_never_closes_a_meeting() -> None:
    vexa = FakeVexa()
    app = _app(vexa)
    with TestClient(app) as client:
        meeting_id = _joined_meeting(client, app, joined_at=datetime.now(UTC) - timedelta(minutes=20), schedule=None)
        vexa.meeting_status_code = 503
        _tick(app, datetime.now(UTC) + timedelta(hours=2))
        assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] == "active"
        assert _state(app, meeting_id).end_reason is None


# ----- an empty transcript from Vexa is a glitch, not silence -----------------------------------
def test_empty_transcript_polls_do_not_make_a_talkative_meeting_leave() -> None:
    now = _clock()
    vexa = FakeVexa()
    vexa.segments = [_segment(now - timedelta(minutes=30), "Hello"), _segment(now - timedelta(seconds=30), "Next item")]
    app = _app(vexa)
    with TestClient(app) as client:
        meeting_id = _joined_meeting(client, app, joined_at=now - timedelta(minutes=40), schedule=None)
        _tick(app, now)
        assert len(_stored(app, meeting_id)) == 2
        vexa.segments = []
        _tick(app, now + timedelta(minutes=1))
        _tick(app, now + timedelta(minutes=2))
        assert len(_stored(app, meeting_id)) == 2  # the saved transcript was not wiped
        assert vexa.stops() == 0 and _notices(client, "assistant.leaving_soon") == []
        assert _state(app, meeting_id).last_speech_at == now - timedelta(seconds=30)


def test_speech_watermark_survives_a_wiped_transcript_and_never_moves_back() -> None:
    now = _clock()
    vexa = FakeVexa()
    vexa.segments = [_segment(now - timedelta(seconds=30), "Next item")]
    app = _app(vexa)
    with TestClient(app) as client:
        meeting_id = _joined_meeting(client, app, joined_at=now - timedelta(minutes=40), schedule=None)
        _tick(app, now)
        with tenant_scope(LEGACY_ORGANIZATION_ID):
            app.state.repository.replace_transcript(UUID(meeting_id), [])
        vexa.segments = [_segment(now - timedelta(minutes=35), "an older, partial copy")]
        _tick(app, now + timedelta(minutes=1))
        # Without the watermark this would look like 36 quiet minutes (or "no one joined") and leave.
        assert vexa.stops() == 0 and _notices(client, "assistant.leaving_soon") == []
        assert _state(app, meeting_id).last_speech_at == now - timedelta(seconds=30)
