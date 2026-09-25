import asyncio
import json
import re
from base64 import b64decode
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from meetings_contracts import (
    MeetingMinutesDraft,
    MeetingStatus,
    MeetingTranscriptSegment,
    ProviderType,
    TextGenerationResult,
)

from app.adapters.resend import EmailDeliveryError, ResendAdapter
from app.adapters.vexa import VexaCaptureAdapter
from app.main import create_app
from app.minutes_service import MinutesGenerationError, _email_content, _normalize_generated_evidence, _validate_references


class FakeTextAdapter:
    async def generate_text(self, profile, request):
        assert request.max_output_tokens == 12000
        assert "MOM template: actions." in request.prompt
        assert "Requested focus fields: Risks" in request.prompt
        assert "SPEAKER=Anna\nTEXT=We approved the internal MVP" in request.prompt
        segment_id = re.search(r"ID=([^\n]+)", request.prompt).group(1)
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
                    "evidence_segment_ids": [segment_id],
                }
            ],
            "open_questions": ["When should production deployment begin?"],
            "speaker_contributions": [{
                "speaker": "Anna", "summary": "Approved another internal MVP test.",
                "evidence_segment_ids": [segment_id],
            }],
            "questions_asked": [],
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
        assert request.headers["idempotency-key"].startswith("minutes-")
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
                "mom_guidance": {"template": "actions", "instructions": "Emphasize blockers", "focus_fields": ["Risks"]},
            },
        ).json()
        meeting_id = meeting["id"]
        assert client.get(f"/v1/meetings/{meeting_id}/mom-guidance").json()["template"] == "actions"
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
                    text="We approved the internal MVP for another test. Abhishek will run another meeting test.",
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
        assert "Anna" not in str(sent_payloads[0]["text"])
        assert "<img src=\"cid:meetings-ai-logo\"" in str(sent_payloads[0]["html"])
        attachments = sent_payloads[0]["attachments"]
        assert attachments[0]["filename"] == "meetings-ai-logo.png"
        assert attachments[0]["content_id"] == "meetings-ai-logo"
        transcript_file = next(item for item in attachments if item["filename"] == "meeting-transcript.md")
        assert "Anna" in b64decode(transcript_file["content"]).decode("utf-8")
        assert "Transcript</h2><ul>" not in str(sent_payloads[0]["html"])

        final = client.get(f"/v1/meetings/{meeting_id}/minutes")
        assert final.json()["status"] == "sent"
        assert final.json()["sent_at"] is not None


def test_resend_status_and_missing_sender_do_not_silently_use_test_domain() -> None:
    adapter = ResendAdapter("send-only-test-key", None)
    app = create_app(
        database_url="sqlite+pysqlite:///:memory:",
        credential_key="test-key",
        resend_adapter=adapter,
    )
    with TestClient(app) as client:
        status = client.get("/v1/integrations/resend/status")
        assert status.status_code == 200
        assert status.json() == {
            "api_key_configured": True,
            "sender_configured": False,
            "sender": None,
            "can_attempt_send": False,
            "domain_verification": "not_checked",
        }

    with pytest.raises(EmailDeliveryError, match="RESEND_FROM_EMAIL"):
        asyncio.run(adapter.send(
            recipients=["team@example.test"],
            subject="Test",
            html="<p>Test</p>",
            text="Test",
        ))


def test_email_hides_internal_evidence_ids_and_escapes_meeting_content() -> None:
    segment_id = "csrc-201:9:1790332285194"
    segment = SimpleNamespace(segment_id=segment_id, start_seconds=100.0, completed=True, speaker="Anna", text="Agreed to follow up")
    minutes = SimpleNamespace(
        title="Client <script>alert(1)</script>",
        executive_summary=f"Follow-up agreed. [{segment_id}]",
        discussion_points=[f"Plan reviewed. [{segment_id}]"], decisions=[], action_items=[],
        open_questions=[], speaker_contributions=[], questions_asked=[],
    )
    html, plain = _email_content(minutes, [segment], include_transcript=True)
    assert segment_id not in html + plain
    assert "Transcript 00:00" in html + plain
    assert "<script>" not in html
    assert "&lt;script&gt;" in html
    assert "Follow-up agreed" in plain
    assert "Agreed to follow up" not in html + plain


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


def test_generated_evidence_only_normalizes_a_real_id_with_copied_timestamp() -> None:
    segment = SimpleNamespace(segment_id="csrc-201:1:1790332177958", speaker="Anna", text="We approved the plan.", completed=True)
    draft = MeetingMinutesDraft(
        title="Review", executive_summary="The plan was approved.",
        speaker_contributions=[{
            "speaker": "Anna", "summary": "Approved the plan.",
            "evidence_segment_ids": ["csrc-201:1:1790332177958 @ 1790332178.0s"],
        }],
    )
    _normalize_generated_evidence(draft, [segment])
    assert draft.speaker_contributions[0].evidence_segment_ids == [segment.segment_id]
    _validate_references(draft, [segment])
    draft.speaker_contributions[0].evidence_segment_ids = ["invented @ 1790332178.0s"]
    _normalize_generated_evidence(draft, [segment])
    with pytest.raises(MinutesGenerationError, match="unavailable transcript segment"):
        _validate_references(draft, [segment])
