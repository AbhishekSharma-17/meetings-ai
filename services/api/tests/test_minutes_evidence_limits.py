"""Long-meeting evidence is retained without an arbitrary citation-count cap."""

import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from meetings_contracts import (
    ActionItem, AttributedQuestion, MeetingMinutesDraft, MeetingStatus,
    MeetingTranscriptSegment, ProviderType, SpeakerContribution, TextGenerationResult,
)
from pydantic import ValidationError

from app.minutes_service import MinutesGenerationError, MinutesService, _validate_references
from app.repository import MinutesNotFoundError


def _payload():
    return {
        "title": "Client meeting", "executive_summary": "The team reviewed the plan.",
        "speaker_contributions": [{"speaker": "Anna", "summary": "Reviewed the plan.",
                                   "evidence_segment_ids": ["S1"]}],
    }


def _segments(speakers):
    return [MeetingTranscriptSegment(segment_id=f"csrc-201:{index}:123456789", speaker=speaker,
                                     start_seconds=index * 5, end_seconds=index * 5 + 4,
                                     text="Reviewed the plan. Carol will send the deck.")
            for index, speaker in enumerate(speakers, 1)]


def _generate(payload, segments, *, structured=True):
    import json

    meeting_id = uuid4()
    repository = MagicMock()
    repository.get_meeting.return_value = SimpleNamespace(status=MeetingStatus.COMPLETED, title="Client meeting")
    repository.get_minutes.side_effect = MinutesNotFoundError(meeting_id)
    repository.get_transcript.return_value = segments
    repository.get_transcript_revision.return_value = "revision-1"
    repository.get_mom_guidance.return_value = SimpleNamespace(template="standard", instructions="", focus_fields=[])
    repository.save_minutes.side_effect = lambda minutes: minutes
    providers = SimpleNamespace(generate_text=AsyncMock(return_value=(
        SimpleNamespace(id=uuid4()), TextGenerationResult(
            text=json.dumps(payload), structured_output=payload if structured else None,
            provider="test", model="test-model"))))
    minutes = asyncio.run(MinutesService(repository, providers, MagicMock()).generate(meeting_id))
    repository.save_minutes_source_revision.assert_called_once_with(meeting_id, "revision-1")
    assert "all distinct supporting segment IDs" in providers.generate_text.call_args.args[0].system_prompt
    return minutes


@pytest.mark.parametrize("structured", [True, False])
@pytest.mark.parametrize("count", [22, 250, 1200])
def test_long_meeting_retains_every_valid_citation(structured, count):
    segments = _segments(["Anna", *["Ben"] * count])
    refs = [f"S{index}" for index in range(2, count + 2)]
    payload = _payload()
    payload["speaker_contributions"].append({"speaker": "Ben", "summary": "Reviewed the plan.",
                                             "evidence_segment_ids": refs})
    payload["action_items"] = [{"description": "Send the deck", "owner": "Carol", "evidence_segment_ids": refs}]
    payload["questions_asked"] = [{"speaker": "Ben", "question": "What is the next step?", "evidence_segment_ids": refs}]
    original = deepcopy(payload)
    minutes = _generate(payload, segments, structured=structured)

    assert minutes.speaker_contributions[1].summary == "Reviewed the plan."
    for claim in [minutes.speaker_contributions[1], minutes.action_items[0], minutes.questions_asked[0]]:
        assert claim.evidence_segment_ids == [item.segment_id for item in segments[1:]]
    assert payload == original  # cleanup does not mutate the provider's raw response
    MeetingMinutesDraft.model_validate({field: getattr(minutes, field) for field in MeetingMinutesDraft.model_fields})
    _validate_references(minutes, segments)


def test_late_identity_grounding_and_all_earlier_evidence_are_retained():
    segments = _segments([*["Anna"] * 21, "Ben"])
    for segment in segments[:-1]:
        segment.text = "Reviewed the plan without an action owner."
    refs = [f"S{index}" for index in range(1, 23)]
    payload = _payload()
    payload["speaker_contributions"].append({"speaker": "Ben", "summary": "Proposed the follow-up.",
                                             "evidence_segment_ids": refs})
    payload["questions_asked"] = [{"speaker": "Ben", "question": "Who sends it?", "evidence_segment_ids": refs}]
    payload["action_items"] = [{"description": "Send the deck", "owner": "Carol", "evidence_segment_ids": refs}]
    minutes = _generate(payload, segments)
    for claim in [minutes.speaker_contributions[1], minutes.questions_asked[0], minutes.action_items[0]]:
        assert claim.evidence_segment_ids == [segment.segment_id for segment in segments]
    assert minutes.action_items[0].owner == "Carol"
    assert minutes.questions_asked[0].speaker == "Ben"
    _validate_references(minutes, segments)


def test_normalization_deduplicates_and_removes_only_unsupported_evidence():
    segments = _segments(["Anna"])
    payload = _payload()
    payload["speaker_contributions"][0]["evidence_segment_ids"] = [
        *[f"invented-{index}" for index in range(22)], "S1", "[s1]", "S1 @ 5.0s"]
    minutes = _generate(payload, segments)
    assert minutes.speaker_contributions[0].evidence_segment_ids == [segments[0].segment_id]


@pytest.mark.parametrize("field, claim", [
    ("speaker_contributions", {"speaker": "Anna", "summary": "Reviewed the plan."}),
    ("questions_asked", {"speaker": "Anna", "question": "What happens next?"}),
    ("action_items", {"description": "Send the deck", "owner": "Anna"}),
])
@pytest.mark.parametrize("count", [22, 250, 1200])
def test_human_edits_accept_long_evidence_lists(field, claim, count):
    payload = _payload()
    refs = [f"S{index}" for index in range(count)]
    payload[field] = [{**claim, "evidence_segment_ids": refs}]
    draft = MeetingMinutesDraft.model_validate(payload)
    assert getattr(draft, field)[0].evidence_segment_ids == refs


@pytest.mark.parametrize("contract", [ActionItem, SpeakerContribution, AttributedQuestion])
def test_evidence_schema_has_no_count_limit(contract):
    assert "maxItems" not in contract.model_json_schema()["properties"]["evidence_segment_ids"]


def test_long_human_evidence_lists_still_require_correct_speaker_attribution():
    segments = _segments(["Anna"] * 22)
    payload = _payload()
    payload["speaker_contributions"] = [{"speaker": "Ben", "summary": "Reviewed the plan.",
                                          "evidence_segment_ids": [segment.segment_id for segment in segments]}]
    draft = MeetingMinutesDraft.model_validate(payload)
    with pytest.raises(MinutesGenerationError, match="does not match"):
        _validate_references(draft, segments)


@pytest.mark.parametrize("field, claim", [
    ("speaker_contributions", {"speaker": "Anna", "summary": "Reviewed the plan."}),
    ("questions_asked", {"speaker": "Anna", "question": "What next?"}),
])
def test_attributed_claims_still_need_at_least_one_citation(field, claim):
    payload = _payload()
    payload[field] = [{**claim, "evidence_segment_ids": []}]
    with pytest.raises(ValidationError, match="at least 1"):
        MeetingMinutesDraft.model_validate(payload)


@pytest.mark.parametrize("refs", [[1] * 22, ["invented"] * 22])
def test_excess_citations_do_not_bypass_type_or_evidence_validation(refs):
    payload = _payload()
    payload["speaker_contributions"][0]["evidence_segment_ids"] = refs
    if isinstance(refs[0], int):
        with pytest.raises(MinutesGenerationError, match="valid string"):
            _generate(payload, _segments(["Anna"]))
    else:
        minutes = _generate(payload, _segments(["Anna"]))
        assert minutes.speaker_contributions == []  # no fabricated references persisted


def test_generation_keeps_other_schema_limits_strict():
    payload = _payload()
    payload["speaker_contributions"][0]["summary"] = "x" * 2001
    with pytest.raises(MinutesGenerationError, match="at most 2000"):
        _generate(payload, _segments(["Anna"]))


def test_api_generates_persists_reads_and_edits_more_than_twenty_citations():
    """Exercise the public API and real SQL repository, not just Pydantic parsing."""
    import json

    from app.main import create_app

    segments = _segments(["Anna"] * 250)
    payload = _payload()
    refs = [f"S{index}" for index in range(1, 251)]
    payload["speaker_contributions"][0]["evidence_segment_ids"] = refs
    payload["questions_asked"] = [{"speaker": "Anna", "question": "Who sends it?", "evidence_segment_ids": refs}]
    payload["action_items"] = [{"description": "Send the deck", "owner": "Carol", "evidence_segment_ids": refs}]
    app = create_app(database_url="sqlite+pysqlite:///:memory:", credential_key="test-key")
    app.state.profile_service.adapters[ProviderType.OPENAI] = SimpleNamespace(
        generate_text=AsyncMock(return_value=TextGenerationResult(
            text=json.dumps(payload), structured_output=payload, provider="test", model="test-model")))

    with TestClient(app) as client:
        profile = client.post("/v1/provider-profiles", json={
            "name": "Evidence test", "provider_type": "openai", "execution_location": "cloud",
            "capabilities": [{"capability": "text_generation", "model": "test-model"}], "api_key": "test-only",
        })
        assert profile.status_code == 201
        assert client.put("/v1/provider-defaults/text_generation", json={
            "policy": "cloud_only", "cloud_profile_id": profile.json()["id"],
        }).status_code == 200
        meeting = client.post("/v1/meetings", json={"meeting_url": "https://meet.google.com/abc-defg-hij"})
        assert meeting.status_code == 201
        meeting_id = meeting.json()["id"]
        persisted = app.state.repository.get_meeting(meeting_id)
        persisted.status = MeetingStatus.COMPLETED
        app.state.repository.save_meeting(persisted)
        app.state.repository.replace_transcript(persisted.id, segments)

        response = client.post(f"/v1/meetings/{meeting_id}/minutes/generate")
        assert response.status_code == 200, response.text
        saved = client.get(f"/v1/meetings/{meeting_id}/minutes").json()
        expected = [segment.segment_id for segment in segments]
        for field in ("speaker_contributions", "questions_asked", "action_items"):
            assert saved[field][0]["evidence_segment_ids"] == expected
        draft = {field: saved[field] for field in MeetingMinutesDraft.model_fields}
        draft["executive_summary"] = "Reviewed and edited by a person."
        updated = client.put(f"/v1/meetings/{meeting_id}/minutes", json=draft)
        assert updated.status_code == 200, updated.text
        assert updated.json()["action_items"][0]["evidence_segment_ids"] == expected
