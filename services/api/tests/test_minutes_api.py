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


def _listed_minutes_status(client: TestClient, meeting_id: str) -> str | None:
    listed = client.get("/v1/meetings").json()["items"]
    return next(item for item in listed if item["id"] == meeting_id)["minutes_status"]


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

        assert _listed_minutes_status(client, meeting_id) is None  # no minutes yet
        generated = client.post(f"/v1/meetings/{meeting_id}/minutes/generate")
        assert generated.status_code == 200
        assert _listed_minutes_status(client, meeting_id) == "draft"
        assert generated.json()["status"] == "draft"
        assert generated.json()["action_items"][0]["owner"] == "Abhishek"
        assert generated.json()["provider"] == "fake-openai"
        real_ids = {item["segment_id"] for item in client.get(f"/v1/meetings/{meeting_id}/transcript").json()["segments"]}
        assert set(generated.json()["action_items"][0]["evidence_segment_ids"]) <= real_ids  # short IDs mapped back

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
        assert _listed_minutes_status(client, meeting_id) == "approved"

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
        # The meetings list shows the recap as sent, not still "ready to review".
        assert _listed_minutes_status(client, meeting_id) == "sent"
        assert client.get(f"/v1/meetings/{meeting_id}").json()["minutes_status"] == "sent"
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


def _segments(*rows):
    return [SimpleNamespace(segment_id=sid, speaker=speaker, text=text, completed=True) for sid, speaker, text in rows]


def test_generated_evidence_accepts_short_segment_ids_and_maps_them_back() -> None:
    from app.minutes_service import _normalize_generated_evidence

    segments = _segments(("csrc-840:1:1790750354645", "Anna", "We approved the plan."),
                         ("csrc-2970:11:1790752587221", "Ben", "I will send the deck."))
    aliases = {"S1": segments[0].segment_id, "S2": segments[1].segment_id}
    draft = MeetingMinutesDraft(
        title="Review", executive_summary="Summary",
        speaker_contributions=[{"speaker": "Ben", "summary": "Sends the deck.", "evidence_segment_ids": ["S2", "[s2]", "S2 @ 12.0s"]}],
    )
    _normalize_generated_evidence(draft, segments, aliases)
    assert draft.speaker_contributions[0].evidence_segment_ids == [segments[1].segment_id] * 3


def test_unsupported_generated_claims_are_left_out_instead_of_failing_the_draft() -> None:
    from app.minutes_service import _drop_unsupported_generated_claims

    segments = _segments(("s1", "Anna", "We approved the plan."), ("s2", "Ben", "I will send the deck by Friday."))
    draft = MeetingMinutesDraft(
        title="Review", executive_summary="Summary",
        action_items=[
            {"description": "Send the deck", "owner": "Ben", "evidence_segment_ids": ["s2", "csrc-9:1:123"]},
            {"description": "Invented task", "owner": None, "evidence_segment_ids": ["csrc-2970:11:1790752587221"]},
            {"description": "Book the room", "owner": "Carol", "evidence_segment_ids": ["s1"]},
        ],
        speaker_contributions=[
            {"speaker": "Anna", "summary": "Approved the plan.", "evidence_segment_ids": ["s1"]},
            {"speaker": "Anna", "summary": "Misattributed.", "evidence_segment_ids": ["s2"]},
        ],
        questions_asked=[{"speaker": "Ben", "question": "Who approves?", "evidence_segment_ids": ["s1"]}],
    )
    changes = _drop_unsupported_generated_claims(draft, segments)
    assert changes > 0
    actions = {item.description: item for item in draft.action_items}
    assert actions["Send the deck"].evidence_segment_ids == ["s2"]  # the invented citation is removed
    assert "Invented task" not in actions  # no evidence left, so the claim is left out
    assert actions["Book the room"].owner is None  # owner not supported by the evidence: unassigned
    assert [item.summary for item in draft.speaker_contributions] == ["Approved the plan."]
    assert draft.questions_asked[0].speaker is None  # asker not supported: treated as unidentified
    _validate_references(draft, segments)  # what remains passes the strict check used for approval


def test_one_bad_citation_no_longer_sinks_the_whole_draft(monkeypatch) -> None:
    """Regression: a Teams meeting's MOM failed every retry on one unavailable segment ID."""
    import app.minutes_service as minutes_module

    segment = MeetingTranscriptSegment(segment_id="csrc-2970:11:1790752587221", start_seconds=1790752587.221,
                                       end_seconds=1790752590.0, speaker="Anna",
                                       text="I will send the deck to the client on Friday.")
    draft_payload = {
        "title": "Client sync", "executive_summary": "The deck goes out on Friday.",
        "discussion_points": [], "decisions": [], "open_questions": [], "questions_asked": [],
        "action_items": [
            {"description": "Send the deck", "owner": "Anna", "due_date": "Friday", "evidence_segment_ids": ["S1"]},
            {"description": "Stale citation", "owner": None, "due_date": None, "evidence_segment_ids": ["csrc-2970:11:0"]},
        ],
        "speaker_contributions": [{"speaker": "Anna", "summary": "Owns the deck.", "evidence_segment_ids": ["S1"]}],
    }
    draft = MeetingMinutesDraft.model_validate(draft_payload)
    aliases = {"S1": segment.segment_id}
    minutes_module._normalize_generated_evidence(draft, [segment], aliases)
    minutes_module._check_speaker_coverage(draft, [segment])
    minutes_module._drop_unsupported_generated_claims(draft, [segment])
    minutes_module._validate_references(draft, [segment])
    assert [item.description for item in draft.action_items] == ["Send the deck"]
    assert draft.action_items[0].evidence_segment_ids == [segment.segment_id]
