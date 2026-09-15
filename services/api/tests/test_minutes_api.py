import json

import httpx
from fastapi.testclient import TestClient
from meetings_contracts import (
    MeetingStatus,
    MeetingTranscriptSegment,
    ProviderType,
    TextGenerationResult,
)

from app.adapters.resend import ResendAdapter
from app.adapters.vexa import VexaCaptureAdapter
from app.main import create_app


class FakeTextAdapter:
    async def generate_text(self, profile, request):
        assert "Anna: We approved the internal MVP" in request.prompt
        payload = {
            "title": "Internal MVP review",
            "executive_summary": "The team approved continued internal validation.",
            "discussion_points": ["The live transcript was reviewed."],
            "decisions": ["Continue internal validation."],
            "action_items": [
                {
                    "description": "Run another meeting test",
                    "owner": "Abhishek",
                    "due_date": None,
                }
            ],
            "open_questions": ["When should production deployment begin?"],
        }
        return TextGenerationResult(
            text=json.dumps(payload),
            structured_output=payload,
            provider="fake-openai",
            model=profile.models[next(iter(profile.models))],
        )


def test_generate_review_approve_and_send_minutes() -> None:
    sent_payloads: list[dict[str, object]] = []

    def resend_handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer resend-test-key"
        sent_payloads.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "email_123"})

    app = create_app(
        database_url="sqlite+pysqlite:///:memory:",
        credential_key="test-key",
        vexa_adapter=VexaCaptureAdapter(
            "http://vexa.test",
            transport=httpx.MockTransport(lambda request: httpx.Response(500)),
        ),
        resend_adapter=ResendAdapter(
            "resend-test-key",
            "Meetings AI <meetings@example.test>",
            transport=httpx.MockTransport(resend_handler),
        ),
    )
    app.state.profile_service.adapters[ProviderType.OPENAI] = FakeTextAdapter()

    with TestClient(app) as client:
        profile = client.post(
            "/v1/provider-profiles",
            json={
                "name": "MOM test provider",
                "provider_type": "openai",
                "execution_location": "cloud",
                "capabilities": [
                    {"capability": "text_generation", "model": "economy-model"}
                ],
                "api_key": "write-only-key",
            },
        ).json()
        default = client.put(
            "/v1/provider-defaults/text_generation",
            json={"policy": "cloud_only", "cloud_profile_id": profile["id"]},
        )
        assert default.status_code == 200

        meeting = client.post(
            "/v1/meetings",
            json={
                "meeting_url": "https://meet.google.com/abc-defg-hij",
                "title": "Internal MVP review",
            },
        ).json()
        meeting_id = meeting["id"]
        persisted = app.state.repository.get_meeting(meeting_id)
        persisted.status = MeetingStatus.COMPLETED
        app.state.repository.save_meeting(persisted)
        app.state.repository.replace_transcript(
            persisted.id,
            [
                MeetingTranscriptSegment(
                    start_seconds=0,
                    end_seconds=4,
                    speaker="Anna",
                    text="We approved the internal MVP for another test.",
                )
            ],
        )

        generated = client.post(f"/v1/meetings/{meeting_id}/minutes/generate")
        assert generated.status_code == 200
        assert generated.json()["status"] == "draft"
        assert generated.json()["action_items"][0]["owner"] == "Abhishek"
        assert generated.json()["provider"] == "fake-openai"

        unapproved = client.post(
            f"/v1/meetings/{meeting_id}/minutes/send",
            json={"recipients": ["team@example.test"]},
        )
        assert unapproved.status_code == 409

        edited = generated.json()
        draft = {
            key: edited[key]
            for key in (
                "title",
                "executive_summary",
                "discussion_points",
                "decisions",
                "action_items",
                "open_questions",
            )
        }
        draft["executive_summary"] = "Reviewed and corrected by a person."
        saved = client.put(f"/v1/meetings/{meeting_id}/minutes", json=draft)
        assert saved.status_code == 200
        assert saved.json()["executive_summary"] == draft["executive_summary"]

        approved = client.post(f"/v1/meetings/{meeting_id}/minutes/approve")
        assert approved.status_code == 200
        assert approved.json()["status"] == "approved"

        delivered = client.post(
            f"/v1/meetings/{meeting_id}/minutes/send",
            json={
                "recipients": ["TEAM@example.test", "team@example.test"],
                "include_transcript": True,
            },
        )
        assert delivered.status_code == 200
        assert delivered.json()["status"] == "sent"
        assert delivered.json()["recipients"] == ["team@example.test"]
        assert sent_payloads[0]["to"] == ["team@example.test"]
        assert "Reviewed and corrected" in str(sent_payloads[0]["html"])
        assert "Anna" in str(sent_payloads[0]["text"])

        final = client.get(f"/v1/meetings/{meeting_id}/minutes")
        assert final.json()["status"] == "sent"
        assert final.json()["sent_at"] is not None


def test_minutes_require_finished_capture_and_transcript() -> None:
    app = create_app(credential_key="test-key")
    with TestClient(app) as client:
        meeting = client.post(
            "/v1/meetings",
            json={"meeting_url": "https://meet.google.com/abc-defg-hij"},
        ).json()
        response = client.post(f"/v1/meetings/{meeting['id']}/minutes/generate")
        assert response.status_code == 409
        assert "stop the meeting capture" in response.json()["detail"]
