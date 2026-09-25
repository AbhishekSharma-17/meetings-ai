import asyncio
import json
import re

import httpx
from fastapi.testclient import TestClient
from meetings_contracts import MeetingStatus, ProviderType, TextGenerationResult

from app.adapters.resend import ResendAdapter
from app.adapters.base import ProviderExecutionError
from app.adapters.vexa import VexaCaptureAdapter
from app.main import create_app
from app.post_meeting_worker import PostMeetingWorker


class DraftAdapter:
    calls = 0

    async def generate_text(self, profile, request):
        self.calls += 1
        assert "Anna:" in request.prompt
        segment_id = re.search(r"\[([^ ]+) @", request.prompt).group(1)
        payload = {
            "title": "Review", "executive_summary": "Review completed.",
            "discussion_points": ["The team discussed the MVP."],
            "decisions": [], "action_items": [], "open_questions": [],
            "speaker_contributions": [{
                "speaker": "Anna", "summary": "Reviewed the MVP.",
                "evidence_segment_ids": [segment_id],
            }],
            "questions_asked": [],
        }
        return TextGenerationResult(
            text=json.dumps(payload), structured_output=payload,
            provider="fake", model="economy-model",
        )


def test_admin_gate_and_session_cookie(monkeypatch):
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "a-private-password")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "a-distinct-signing-secret")
    app = create_app(database_url="sqlite+pysqlite:///:memory:", credential_key="test-key")
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/v1/meetings").status_code == 401
        assert client.get("/v1/auth/session").json() == {"authenticated": False}
        assert client.post("/v1/auth/login", json={"password": "wrong"}).status_code == 401
        login = client.post("/v1/auth/login", json={"password": "a-private-password"})
        assert login.status_code == 200
        assert "httponly" in login.headers["set-cookie"].lower()
        assert "samesite=strict" in login.headers["set-cookie"].lower()
        assert client.get("/v1/meetings").status_code == 200
        assert client.post("/v1/auth/logout").status_code == 200
        assert client.get("/v1/meetings").status_code == 401


def test_saved_recipients_and_auto_draft_require_explicit_approval(monkeypatch):
    monkeypatch.delenv("MEETINGS_AI_ADMIN_PASSWORD", raising=False)
    monkeypatch.delenv("MEETINGS_AI_SESSION_SECRET", raising=False)
    sent = []

    def vexa_handler(request):
        if request.url.path == "/transcripts/by-id/42":
            return httpx.Response(200, json={
                "status": "completed",
            "segments": [{"segment_id": "s1", "start": 0, "end": 4, "text": "We reviewed the MVP.",
                              "speaker": "Anna", "completed": True}],
            })
        return httpx.Response(200, json={"status": "completed"})

    def resend_handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "email-test"})

    app = create_app(
        database_url="sqlite+pysqlite:///:memory:", credential_key="test-key",
        vexa_adapter=VexaCaptureAdapter("http://vexa.test", transport=httpx.MockTransport(vexa_handler)),
        resend_adapter=ResendAdapter("test-key", "Meetings AI <bot@example.test>",
                                     transport=httpx.MockTransport(resend_handler)),
    )
    adapter = DraftAdapter()
    app.state.profile_service.adapters[ProviderType.OPENAI] = adapter
    with TestClient(app) as client:
        profile = client.post("/v1/provider-profiles", json={
            "name": "MOM", "provider_type": "openai", "execution_location": "cloud",
            "capabilities": [{"capability": "text_generation", "model": "economy-model"}],
            "api_key": "test-only",
        }).json()
        client.put("/v1/provider-defaults/text_generation", json={
            "policy": "cloud_only", "cloud_profile_id": profile["id"],
        })
        created = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
            "delivery_settings": {
                "internal_recipients": ["TEAM@example.test", "team@example.test"],
                "participant_recipients": ["guest@example.test"],
                "send_to_participants": False,
            },
        })
        assert created.status_code == 201
        meeting_id = created.json()["id"]
        settings = client.get(f"/v1/meetings/{meeting_id}/delivery-settings").json()
        assert settings["internal_recipients"] == ["team@example.test"]
        meeting = app.state.repository.get_meeting(meeting_id)
        meeting.status = MeetingStatus.COMPLETED
        meeting.vexa_meeting_id = 42
        app.state.repository.save_meeting(meeting)

        asyncio.run(app.state.post_meeting_worker.tick())
        asyncio.run(app.state.post_meeting_worker.tick())
        assert adapter.calls == 1
        job = client.get(f"/v1/meetings/{meeting_id}/post-meeting-job").json()
        assert job["completed_at"] is not None
        assert job["attempts"] == 0
        assert client.get(f"/v1/meetings/{meeting_id}/minutes").json()["status"] == "draft"
        assert not sent
        assert client.post(f"/v1/meetings/{meeting_id}/minutes/send-configured").status_code == 409

        client.post(f"/v1/meetings/{meeting_id}/minutes/approve")
        delivery = client.post(f"/v1/meetings/{meeting_id}/minutes/send-configured")
        assert delivery.status_code == 200
        assert sent[0]["to"] == ["team@example.test"]
        assert client.post(f"/v1/meetings/{meeting_id}/minutes/generate").status_code == 409
        assert adapter.calls == 1


def test_failed_auto_draft_can_be_retried_without_duplicate_send(monkeypatch):
    monkeypatch.delenv("MEETINGS_AI_ADMIN_PASSWORD", raising=False)
    monkeypatch.delenv("MEETINGS_AI_SESSION_SECRET", raising=False)

    class FailOnceAdapter(DraftAdapter):
        calls = 0

        async def generate_text(self, profile, request):
            if self.calls == 0:
                self.calls += 1
                raise ProviderExecutionError("temporary model outage")
            return await super().generate_text(profile, request)

    def vexa_handler(request):
        if request.url.path == "/transcripts/by-id/42":
            return httpx.Response(200, json={
                "status": "completed",
                "segments": [{"segment_id": "s1", "start": 0, "end": 4,
                              "text": "We reviewed the MVP.", "speaker": "Anna",
                              "completed": True}],
            })
        return httpx.Response(200, json={"status": "completed"})

    app = create_app(
        database_url="sqlite+pysqlite:///:memory:", credential_key="test-key",
        vexa_adapter=VexaCaptureAdapter(
            "http://vexa.test", transport=httpx.MockTransport(vexa_handler)
        ),
    )
    adapter = FailOnceAdapter()
    app.state.profile_service.adapters[ProviderType.OPENAI] = adapter
    with TestClient(app) as client:
        profile = client.post("/v1/provider-profiles", json={
            "name": "MOM", "provider_type": "openai", "execution_location": "cloud",
            "capabilities": [{"capability": "text_generation", "model": "economy-model"}],
            "api_key": "test-only",
        }).json()
        client.put("/v1/provider-defaults/text_generation", json={
            "policy": "cloud_only", "cloud_profile_id": profile["id"],
        })
        meeting_id = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
        }).json()["id"]
        assert client.post(f"/v1/meetings/{meeting_id}/post-meeting-job/retry").status_code == 409
        meeting = app.state.repository.get_meeting(meeting_id)
        meeting.status = MeetingStatus.COMPLETED
        meeting.vexa_meeting_id = 42
        app.state.repository.save_meeting(meeting)

        asyncio.run(app.state.post_meeting_worker.tick())
        first = client.get(f"/v1/meetings/{meeting_id}/post-meeting-job").json()
        assert first["attempts"] == 1
        assert first["last_error"]
        assert first["next_retry_at"]
        assert client.get(f"/v1/meetings/{meeting_id}/minutes").status_code == 404

        app.state.repository.save_post_meeting_job(
            meeting_id, attempts=5, next_retry_at=None,
            last_error="automatic attempts exhausted", completed_at=None,
        )
        assert client.get(f"/v1/meetings/{meeting_id}/post-meeting-job").json()["exhausted"]

        retried = client.post(f"/v1/meetings/{meeting_id}/post-meeting-job/retry")
        assert retried.status_code == 200
        assert retried.json()["completed_at"] is not None
        assert retried.json()["last_error"] is None
        assert retried.json()["attempts"] == 0
        assert adapter.calls == 2
        assert client.get(f"/v1/meetings/{meeting_id}/minutes").json()["status"] == "draft"
        assert client.post(f"/v1/meetings/{meeting_id}/post-meeting-job/retry").status_code == 409


def test_participant_opt_in_validation():
    app = create_app(database_url="sqlite+pysqlite:///:memory:", credential_key="test-key")
    with TestClient(app) as client:
        meeting_id = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
        }).json()["id"]
        invalid = client.put(f"/v1/meetings/{meeting_id}/delivery-settings", json={
            "internal_recipients": ["team@example.test"],
            "send_to_participants": True,
        })
        assert invalid.status_code == 422
        valid = client.put(f"/v1/meetings/{meeting_id}/delivery-settings", json={
            "internal_recipients": ["team@example.test"],
            "participant_recipients": ["guest@example.test"],
            "send_to_participants": True,
        })
        assert valid.status_code == 200


def test_worker_does_not_poll_historical_meetings():
    class HistoricalRepository:
        def list_worker_scopes(self):
            return []

    class UnexpectedCall:
        async def refresh(self, _meeting_id):
            raise AssertionError("historical meeting must not be polled")

    asyncio.run(PostMeetingWorker(HistoricalRepository(), UnexpectedCall(), UnexpectedCall()).tick())
