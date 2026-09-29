"""The "Name the speakers" step of an in-person meeting: view, approve, dismiss and refresh suggestions.

Suggestions are stored on the session; approving one renames every transcript line with that raw
label (the same speaker correction a person can make by hand), so nothing changes until someone
approves. After names are approved, the normal speaker-contact (email) suggestions take over.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from .in_person_models import SpeakerNameApprovals, SpeakerNameRow, SpeakerNamesView, SpeakerNameSuggestion
from .in_person_naming import suggest_names
from .in_person_store import InPersonError
from .rate_limit import SlidingWindowLimiter

_SAMPLE_CHARS = 140


class SpeakerNamingService:
    def __init__(self, service: Any, finalizer: Any) -> None:
        self.service = service
        self.finalizer = finalizer
        self.refresh_limit = SlidingWindowLimiter(6, 3600, "speaker names were refreshed recently; try again later")

    def view(self, actor: Any, meeting_id: UUID) -> SpeakerNamesView:
        snapshot = self.service.session_for_viewer(actor, meeting_id)
        if snapshot.status in {"recording", "paused", "finalizing"}:
            return SpeakerNamesView(status="pending", message="Speakers are identified after the recording stops.")
        if snapshot.status == "failed":
            return SpeakerNamesView(status="unavailable", message="The transcript was not created.")
        segments = self.service.repository.get_transcript(meeting_id)
        single = snapshot.speaker_labels == "single"
        rows = self._rows(segments, snapshot.name_suggestions)
        if single:
            return SpeakerNamesView(status="not_applicable", single_speaker=True, speakers=rows, message=(
                "The speech-to-text model didn't separate speakers, so everything is under one Speaker. "
                "You can rename or reassign individual lines in the transcript."))
        message = None if any(row.suggestion for row in rows) else (
            "No names were said aloud clearly enough to suggest. You can name each speaker yourself.")
        return SpeakerNamesView(status="ready", speakers=rows, message=message)

    @staticmethod
    def _rows(segments: list[Any], suggestions: tuple[dict[str, Any], ...]) -> list[SpeakerNameRow]:
        stored = {item.get("speaker"): item for item in suggestions}
        grouped: dict[str, list[Any]] = {}
        for segment in segments:
            if segment.raw_speaker:
                grouped.setdefault(segment.raw_speaker, []).append(segment)
        rows = []
        for speaker, items in sorted(grouped.items(), key=lambda pair: pair[1][0].start_seconds):
            reviewed = next((item.speaker for item in items if item.speaker_reviewed and item.speaker), None)
            entry = stored.get(speaker)
            suggestion = SpeakerNameSuggestion.model_validate({key: entry[key] for key in ("name", "confidence", "reason", "evidence")}) if entry else None
            state = entry.get("state", "suggested") if entry else "none"
            if reviewed and state != "approved":
                state = "approved"
            rows.append(SpeakerNameRow(
                speaker=speaker, segments=len(items), first_at_seconds=items[0].start_seconds,
                sample=items[0].text[:_SAMPLE_CHARS] if items[0].text else None, current_name=reviewed,
                state=state, suggestion=suggestion,
            ))
        return rows

    def approve(self, actor: Any, meeting_id: UUID, payload: SpeakerNameApprovals) -> SpeakerNamesView:
        snapshot = self.service.session_for_viewer(actor, meeting_id)
        if snapshot.status != "done":
            raise InPersonError(409, "speakers can be named once the transcript is ready")
        repository = self.service.repository
        segments = repository.get_transcript(meeting_id)
        first_line = {}
        for segment in segments:
            if segment.raw_speaker and segment.segment_id and segment.raw_speaker not in first_line:
                first_line[segment.raw_speaker] = segment.segment_id
        speakers = [item.speaker for item in payload.approvals]
        if len(set(speakers)) != len(speakers):
            raise InPersonError(422, "each speaker can be named only once per request")
        unknown = [speaker for speaker in speakers if speaker not in first_line]
        if unknown:
            raise InPersonError(409, f"{unknown[0]} is not a speaker in this transcript")
        for item in payload.approvals:
            repository.correct_speaker(meeting_id, first_line[item.speaker], item.name, apply_to_raw_label=True)
        states = {item.speaker: item.name for item in payload.approvals}
        self._save_states(actor, meeting_id, snapshot, lambda entry: {**entry, "state": "approved", "approved_name": states[entry["speaker"]]}
                          if entry.get("speaker") in states else entry)
        return self.view(actor, meeting_id)

    def dismiss(self, actor: Any, meeting_id: UUID, speaker: str) -> SpeakerNamesView:
        snapshot = self.service.session_for_viewer(actor, meeting_id)
        if not any(item.get("speaker") == speaker for item in snapshot.name_suggestions):
            raise InPersonError(404, "there is no suggestion for that speaker")
        self._save_states(actor, meeting_id, snapshot,
                          lambda entry: {**entry, "state": "dismissed"} if entry.get("speaker") == speaker else entry)
        return self.view(actor, meeting_id)

    async def refresh(self, actor: Any, meeting_id: UUID) -> SpeakerNamesView:
        snapshot = self.service.session_for_viewer(actor, meeting_id)
        if snapshot.status != "done" or snapshot.speaker_labels != "diarized":
            raise InPersonError(409, "names can be suggested once a transcript with separate speakers is ready")
        self.refresh_limit.check(f"{actor.organization_id}:{meeting_id}")
        segments = self.service.repository.get_transcript(meeting_id)
        unnamed = [segment for segment in segments if not segment.speaker_reviewed]
        try:
            fresh = await suggest_names(self.finalizer.providers, meeting_id=meeting_id, segments=segments,
                                        expected=list(snapshot.expected_people),
                                        invitees=self.finalizer._invitees(meeting_id, snapshot))
        except Exception as exc:  # noqa: BLE001 - provider errors become a readable 502
            raise InPersonError(502, "speaker names could not be suggested right now; try again later") from exc
        kept = [item for item in snapshot.name_suggestions if item.get("state") == "approved"]
        approved = {item["speaker"] for item in kept}
        still_open = {segment.raw_speaker for segment in unnamed}
        merged = kept + [item for item in fresh if item["speaker"] not in approved and item["speaker"] in still_open]
        self.service.store.update(actor.organization_id, meeting_id, touch=False, name_suggestions=merged)
        return self.view(actor, meeting_id)

    def _save_states(self, actor: Any, meeting_id: UUID, snapshot: Any, change) -> None:
        updated = [change(dict(entry)) for entry in snapshot.name_suggestions]
        self.service.store.update(actor.organization_id, meeting_id, touch=False, name_suggestions=updated)
