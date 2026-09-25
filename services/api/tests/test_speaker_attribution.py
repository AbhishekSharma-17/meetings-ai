import json

import httpx
from fastapi.testclient import TestClient
from meetings_contracts import MeetingStatus, ProviderType, TextGenerationResult

from app.adapters.resend import ResendAdapter
from app.adapters.vexa import VexaCaptureAdapter
from app.main import create_app


class MultiSpeakerModel:
    def __init__(self):
        self.prompts = []

    async def generate_text(self, profile, request):
        self.prompts.append(request.prompt)
        third = "Eve" if "Eve: The budget" in request.prompt else "Carol"
        payload = {
            "title": "Launch review",
            "executive_summary": "The team discussed launch timing and budget.",
            "discussion_points": ["Launch timing", "Budget"],
            "decisions": ["Launch on October 1"],
            "action_items": [{
                "description": "Send the final deck", "owner": "Bob", "due_date": None,
                "evidence_segment_ids": ["s2"],
            }],
            "open_questions": ["Budget remains open"],
            "speaker_contributions": [
                {"speaker": "Alice", "summary": "Asked about launch timing.", "evidence_segment_ids": ["s1"]},
                {"speaker": "Bob", "summary": "Committed to the final deck.", "evidence_segment_ids": ["s2"]},
                {"speaker": third, "summary": "Flagged the budget issue.", "evidence_segment_ids": ["s3"]},
            ],
            "questions_asked": [{
                "speaker": "Alice", "question": "What is the launch date?",
                "evidence_segment_ids": ["s1"],
            }],
        }
        return TextGenerationResult(
            text=json.dumps(payload), structured_output=payload,
            provider="fake", model="economy-model",
        )


def test_multispeaker_review_persists_and_stale_mom_cannot_be_sent():
    def vexa_handler(request):
        if request.url.path == "/transcripts/by-id/42":
            return httpx.Response(200, json={
                "status": "completed", "segments": [
                    {"segment_id": "s1", "start": 0, "end": 2, "speaker": "Alice",
                     "source": "glow-bound", "text": "What is the launch date?", "completed": True},
                    {"segment_id": "s2", "start": 3, "end": 7, "speaker": "Bob",
                     "source": "glow-bound", "text": "We launch on October 1. I will send the final deck.", "completed": True},
                    {"segment_id": "s3", "start": 8, "end": 10, "speaker": "seg_3",
                     "source": "provisional-cluster-id", "text": "The budget decision remains open.", "completed": True},
                ],
            })
        if request.url.path.endswith("/participants"):
            return httpx.Response(200, json={
                "observed_roster": "not_recorded", "participants": [
                    {"name": "Alice", "email": "alice@example.test", "source": "invite"},
                    {"name": "Silent Invitee", "email": "silent@example.test", "source": "invite"},
                    {"name": "Bob", "email": None, "source": "speaker"},
                ],
            })
        return httpx.Response(200, json={"status": "completed"})

    app = create_app(
        database_url="sqlite+pysqlite:///:memory:", credential_key="test-key",
        vexa_adapter=VexaCaptureAdapter("http://vexa.test", transport=httpx.MockTransport(vexa_handler)),
        resend_adapter=ResendAdapter("test-key", "Meetings AI <bot@example.test>",
                                     transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"id": "email-test"}))),
    )
    model = MultiSpeakerModel()
    app.state.profile_service.adapters[ProviderType.OPENAI] = model
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
        meeting = app.state.repository.get_meeting(meeting_id)
        meeting.vexa_meeting_id = 42
        meeting.status = MeetingStatus.COMPLETED
        app.state.repository.save_meeting(meeting)

        transcript = client.get(f"/v1/meetings/{meeting_id}/transcript").json()["segments"]
        assert [(item["segment_id"], item["speaker"]) for item in transcript] == [
            ("s1", "Alice"), ("s2", "Bob"), ("s3", None),
        ]
        assert transcript[2]["raw_speaker"] == "seg_3"
        roster = client.get(f"/v1/meetings/{meeting_id}/participants").json()
        assert roster["observed_roster"] == "not_recorded"
        assert [(item["name"], item["source"]) for item in roster["participants"]] == [
            ("Alice", "invite"), ("Silent Invitee", "invite"),
            ("Alice", "speaker"), ("Bob", "speaker"),
        ]
        assert roster["participants"][2]["email"] is None  # No guessed email join.

        correction = client.put(
            f"/v1/meetings/{meeting_id}/transcript/segments/s3/speaker",
            json={"display_name": "Carol", "apply_to_raw_label": False},
        )
        assert correction.status_code == 200
        assert correction.json()["segments"][2]["speaker_reviewed"] is True
        assert client.get(f"/v1/meetings/{meeting_id}/transcript").json()["segments"][2]["speaker"] == "Carol"
        assert client.put(f"/v1/meetings/{meeting_id}/speaker-identities", json={
            "speaker": "Unknown person", "email": "unknown@example.test",
        }).status_code == 409
        identity = client.put(f"/v1/meetings/{meeting_id}/speaker-identities", json={
            "speaker": "Carol", "email": "carol@example.test",
        })
        assert identity.status_code == 200
        assert identity.json()[0]["email"] == "carol@example.test"
        assert client.get(f"/v1/meetings/{meeting_id}/delivery-settings").json()["participant_recipients"] == []

        draft = client.post(f"/v1/meetings/{meeting_id}/minutes/generate")
        assert draft.status_code == 200
        assert "[s1 @" in model.prompts[-1] and "Carol:" in model.prompts[-1]
        assert draft.json()["questions_asked"][0]["speaker"] == "Alice"
        assert draft.json()["speaker_contributions"][2]["speaker"] == "Carol"
        assert client.post(f"/v1/meetings/{meeting_id}/minutes/approve").status_code == 200

        revised = client.put(
            f"/v1/meetings/{meeting_id}/transcript/segments/s3/speaker",
            json={"display_name": "Eve"},
        )
        assert revised.status_code == 200
        assert client.get(f"/v1/meetings/{meeting_id}/speaker-identities").json() == []
        assert client.get(f"/v1/meetings/{meeting_id}/minutes").json()["status"] == "draft"
        assert client.post(f"/v1/meetings/{meeting_id}/minutes/approve").status_code == 409
        assert client.post(f"/v1/meetings/{meeting_id}/minutes/send", json={
            "recipients": ["team@example.test"],
        }).status_code == 409
        regenerated = client.post(f"/v1/meetings/{meeting_id}/minutes/generate")
        assert regenerated.status_code == 200
        assert regenerated.json()["speaker_contributions"][2]["speaker"] == "Eve"
        assert client.post(f"/v1/meetings/{meeting_id}/minutes/approve").status_code == 200


def test_invalid_speaker_evidence_is_rejected():
    from app.minutes_service import MinutesGenerationError, _validate_generated_evidence
    from meetings_contracts import MeetingMinutesDraft, MeetingTranscriptSegment

    draft = MeetingMinutesDraft(
        title="Review", executive_summary="Summary",
        speaker_contributions=[{
            "speaker": "Alice", "summary": "Spoke about launch.",
            "evidence_segment_ids": ["bob-turn"],
        }],
    )
    segments = [MeetingTranscriptSegment(
        segment_id="bob-turn", start_seconds=0, end_seconds=2,
        speaker="Bob", text="We should launch in October.",
    )]
    try:
        _validate_generated_evidence(draft, segments)
        raise AssertionError("mismatched speaker citation was accepted")
    except MinutesGenerationError as exc:
        assert "attribution" in str(exc)


def test_manual_action_needs_cited_evidence_for_its_owner():
    from app.minutes_service import MinutesGenerationError, _validate_references
    from meetings_contracts import MeetingMinutesDraft, MeetingTranscriptSegment

    segment = MeetingTranscriptSegment(
        segment_id="s1", start_seconds=0, end_seconds=3,
        speaker="Alice", text="I will send the deck.",
    )
    unsupported = MeetingMinutesDraft(
        title="Review", executive_summary="Summary",
        action_items=[{"description": "Send deck", "owner": "Bob",
                       "evidence_segment_ids": ["s1"]}],
    )
    try:
        _validate_references(unsupported, [segment])
        raise AssertionError("unsupported owner was accepted")
    except MinutesGenerationError as exc:
        assert "owner Bob" in str(exc)
