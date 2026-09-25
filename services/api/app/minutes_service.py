"""Post-meeting MOM generation, review, approval, and delivery workflow."""

import json
import re
from hashlib import sha256
from datetime import UTC, datetime
from html import escape
from uuid import UUID

from meetings_contracts import (
    EmailDelivery,
    EmailDeliveryPublic,
    MeetingMinutes,
    MeetingMinutesDraft,
    MeetingMinutesPublic,
    MeetingStatus,
    MinutesEmailRequest,
    MinutesStatus,
    TextGenerationRequest,
)
from pydantic import ValidationError

from .adapters.base import ProviderExecutionError
from .adapters.resend import EmailDeliveryError, ResendAdapter
from .repository import MinutesNotFoundError
from .service import ProviderProfileService, ProviderSelectionError


class MinutesConflictError(RuntimeError):
    pass


class MinutesGenerationError(RuntimeError):
    pass


_CAPTURE_IN_PROGRESS = {
    MeetingStatus.CREATED,
    MeetingStatus.REQUESTED,
    MeetingStatus.JOINING,
    MeetingStatus.AWAITING_ADMISSION,
    MeetingStatus.ACTIVE,
    MeetingStatus.NEEDS_HUMAN_HELP,
    MeetingStatus.STOPPING,
}


class MinutesService:
    def __init__(
        self,
        repository: object,
        providers: ProviderProfileService,
        resend: ResendAdapter,
    ) -> None:
        self.repository = repository
        self.providers = providers
        self.resend = resend

    def get(self, meeting_id: UUID) -> MeetingMinutes:
        self.repository.get_meeting(meeting_id)
        return self.repository.get_minutes(meeting_id)

    def require_not_sent(self, meeting_id: UUID) -> None:
        try:
            existing = self.repository.get_minutes(meeting_id)
        except MinutesNotFoundError:
            return
        if existing.status is MinutesStatus.SENT:
            raise MinutesConflictError(
                "sent MOM is locked; a versioned correction workflow is required"
            )

    async def generate(self, meeting_id: UUID) -> MeetingMinutes:
        self.require_not_sent(meeting_id)
        meeting = self.repository.get_meeting(meeting_id)
        if meeting.status in _CAPTURE_IN_PROGRESS:
            raise MinutesConflictError("stop the meeting capture before generating its MOM")
        segments = self.repository.get_transcript(meeting_id)
        finalized = [segment for segment in segments if segment.completed and segment.text.strip()]
        if not finalized:
            raise MinutesConflictError("a finalized transcript is required before generating MOM")

        source_revision = self.repository.get_transcript_revision(meeting_id)
        transcript = "\n".join(
            f"[{segment.segment_id} @ {segment.start_seconds:.1f}s] "
            f"{segment.speaker or 'Unidentified speaker'}: "
            f"{segment.text.strip()}"
            for segment in finalized
        )
        transcript = transcript[:160_000]
        request = TextGenerationRequest(
            system_prompt=(
                "You create factual meeting minutes from only the supplied transcript. "
                "Do not invent names, owners, dates, commitments, decisions, or context. "
                "Treat Unidentified speaker as unknown, never infer their name from context. "
                "Use null when an action owner or due date was not explicitly stated. "
                "Attach exact segment IDs as evidence for every attributed claim and action."
            ),
            prompt=(
                f"Meeting title: {meeting.title or 'Untitled meeting'}\n\n"
                "Return concise structured minutes for this transcript. Separate discussion "
                "points, explicit decisions, action items, unresolved questions, "
                "who each identified speaker said, and who asked each question. "
                "Every substantive named speaker needs a contribution entry. "
                "For an unidentified questioner use null.\n\n"
                f"Transcript:\n{transcript}"
            ),
            max_output_tokens=2500,
            response_schema=_minutes_response_schema(),
            metadata={"meeting_id": str(meeting_id), "capability": "text_generation"},
        )
        try:
            profile, result = await self.providers.generate_text(request)
            payload = result.structured_output or _parse_json(result.text)
            draft = MeetingMinutesDraft.model_validate(payload)
            _validate_generated_evidence(draft, finalized)
        except (ProviderExecutionError, ProviderSelectionError, ValidationError, ValueError) as exc:
            raise MinutesGenerationError(f"MOM generation failed: {exc}") from exc

        now = datetime.now(UTC)
        if self.repository.get_transcript_revision(meeting_id) != source_revision:
            raise MinutesConflictError("transcript changed while MOM was generating; try again")
        self.require_not_sent(meeting_id)
        try:
            previous = self.repository.get_minutes(meeting_id)
            created_at = previous.created_at
        except MinutesNotFoundError:
            created_at = now
        minutes = MeetingMinutes(
            meeting_id=meeting_id,
            title=draft.title,
            executive_summary=draft.executive_summary,
            discussion_points=draft.discussion_points,
            decisions=draft.decisions,
            action_items=draft.action_items,
            open_questions=draft.open_questions,
            speaker_contributions=draft.speaker_contributions,
            questions_asked=draft.questions_asked,
            status=MinutesStatus.DRAFT,
            provider_profile_id=profile.id,
            provider=result.provider,
            model=result.model,
            created_at=created_at,
            updated_at=now,
        )
        saved = self.repository.save_minutes(minutes)
        self.repository.save_minutes_source_revision(meeting_id, source_revision)
        return saved

    def update(self, meeting_id: UUID, draft: MeetingMinutesDraft) -> MeetingMinutes:
        minutes = self.get(meeting_id)
        if minutes.status is MinutesStatus.SENT:
            raise MinutesConflictError("sent MOM cannot be edited; regenerate a new draft")
        minutes.title = draft.title
        minutes.executive_summary = draft.executive_summary
        minutes.discussion_points = draft.discussion_points
        minutes.decisions = draft.decisions
        minutes.action_items = draft.action_items
        minutes.open_questions = draft.open_questions
        _validate_references(draft, self.repository.get_transcript(meeting_id))
        minutes.speaker_contributions = draft.speaker_contributions
        minutes.questions_asked = draft.questions_asked
        minutes.status = MinutesStatus.DRAFT
        minutes.approved_at = None
        minutes.last_error = None
        minutes.updated_at = datetime.now(UTC)
        return self.repository.save_minutes(minutes)

    def approve(self, meeting_id: UUID) -> MeetingMinutes:
        minutes = self.get(meeting_id)
        if minutes.status is MinutesStatus.SENT:
            return minutes
        self._require_current_transcript(meeting_id)
        now = datetime.now(UTC)
        minutes.status = MinutesStatus.APPROVED
        minutes.approved_at = now
        minutes.updated_at = now
        minutes.last_error = None
        return self.repository.save_minutes(minutes)

    async def send(
        self, meeting_id: UUID, request: MinutesEmailRequest
    ) -> EmailDelivery:
        meeting = self.repository.get_meeting(meeting_id)
        minutes = self.get(meeting_id)
        if minutes.status is not MinutesStatus.APPROVED:
            raise MinutesConflictError("approve the MOM before sending it")
        self._require_current_transcript(meeting_id)
        transcript = self.repository.get_transcript(meeting_id) if request.include_transcript else []
        html, plain_text = _email_content(minutes, transcript)
        delivery = EmailDelivery(
            meeting_id=meeting_id,
            recipients=request.recipients,
            status="failed",
        )
        try:
            delivery_identity = json.dumps(
                [str(meeting_id), minutes.approved_at.isoformat() if minutes.approved_at else "",
                 request.recipients, request.include_transcript],
                separators=(",", ":"),
            )
            delivery.provider_message_id = await self.resend.send(
                recipients=request.recipients,
                subject=f"Meeting recap: {minutes.title or meeting.title or 'Untitled meeting'}",
                html=html,
                text=plain_text,
                idempotency_key=f"minutes-{sha256(delivery_identity.encode()).hexdigest()}",
            )
        except EmailDeliveryError as exc:
            delivery.error = str(exc)
            minutes.last_error = str(exc)
            minutes.updated_at = datetime.now(UTC)
            self.repository.save_email_delivery(delivery)
            self.repository.save_minutes(minutes)
            raise
        delivery.status = "sent"
        self.repository.save_email_delivery(delivery)
        now = datetime.now(UTC)
        minutes.status = MinutesStatus.SENT
        minutes.sent_at = now
        minutes.updated_at = now
        minutes.last_error = None
        self.repository.save_minutes(minutes)
        return delivery

    def _require_current_transcript(self, meeting_id: UUID) -> None:
        source = self.repository.get_minutes_source_revision(meeting_id)
        current = self.repository.get_transcript_revision(meeting_id)
        if source is None or source != current:
            raise MinutesConflictError("transcript or speaker attribution changed; regenerate MOM before approval or sending")

    @staticmethod
    def to_public(minutes: MeetingMinutes) -> MeetingMinutesPublic:
        return MeetingMinutesPublic(
            **{
                field: getattr(minutes, field)
                for field in MeetingMinutesPublic.model_fields
            }
        )

    @staticmethod
    def delivery_to_public(delivery: EmailDelivery) -> EmailDeliveryPublic:
        return EmailDeliveryPublic(**{
            field: getattr(delivery, field) for field in EmailDeliveryPublic.model_fields
        })


def _parse_json(text: str) -> dict[str, object]:
    candidate = text.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", candidate, re.DOTALL | re.IGNORECASE)
    if fenced:
        candidate = fenced.group(1)
    value = json.loads(candidate)
    if not isinstance(value, dict):
        raise ValueError("provider returned a non-object MOM")
    return value


def _minutes_response_schema() -> dict[str, object]:
    """Strict JSON schema accepted by OpenAI and compatible providers."""
    string_list = {"type": "array", "items": {"type": "string"}}
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "title": {"type": "string"},
            "executive_summary": {"type": "string"},
            "discussion_points": string_list,
            "decisions": string_list,
            "action_items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "description": {"type": "string"},
                        "owner": {"type": ["string", "null"]},
                        "due_date": {"type": ["string", "null"]},
                        "evidence_segment_ids": string_list,
                    },
                    "required": ["description", "owner", "due_date", "evidence_segment_ids"],
                },
            },
            "open_questions": string_list,
            "speaker_contributions": {
                "type": "array", "items": {
                    "type": "object", "additionalProperties": False,
                    "properties": {"speaker": {"type": "string"}, "summary": {"type": "string"},
                                   "evidence_segment_ids": string_list},
                    "required": ["speaker", "summary", "evidence_segment_ids"],
                },
            },
            "questions_asked": {
                "type": "array", "items": {
                    "type": "object", "additionalProperties": False,
                    "properties": {"speaker": {"type": ["string", "null"]},
                                   "question": {"type": "string"},
                                   "evidence_segment_ids": string_list},
                    "required": ["speaker", "question", "evidence_segment_ids"],
                },
            },
        },
        "required": [
            "title",
            "executive_summary",
            "discussion_points",
            "decisions",
            "action_items",
            "open_questions",
            "speaker_contributions",
            "questions_asked",
        ],
    }


def _validate_references(draft: MeetingMinutesDraft, segments: list[object]) -> None:
    by_id = {segment.segment_id: segment for segment in segments if segment.segment_id}
    claims = [*draft.speaker_contributions, *draft.questions_asked, *draft.action_items]
    for claim in claims:
        if not claim.evidence_segment_ids:
            raise MinutesGenerationError("every attributed claim and action needs transcript evidence")
        for segment_id in claim.evidence_segment_ids:
            if segment_id not in by_id or not by_id[segment_id].completed:
                raise MinutesGenerationError(f"MOM cites an unavailable transcript segment: {segment_id}")
        speaker = getattr(claim, "speaker", None)
        if speaker and not any(by_id[segment_id].speaker == speaker for segment_id in claim.evidence_segment_ids):
            raise MinutesGenerationError(f"MOM attribution for {speaker} does not match its transcript evidence")
    for action in draft.action_items:
        if not action.owner:
            continue
        cited = [by_id[segment_id] for segment_id in action.evidence_segment_ids]
        owner = action.owner.strip().casefold()
        if not any(
            (segment.speaker or "").casefold() == owner
            or owner in segment.text.casefold()
            for segment in cited
        ):
            raise MinutesGenerationError(
                f"action owner {action.owner} is not supported by cited transcript evidence"
            )


def _validate_generated_evidence(draft: MeetingMinutesDraft, segments: list[object]) -> None:
    _validate_references(draft, segments)
    substantive = {
        segment.speaker for segment in segments
        if segment.speaker and len(segment.text.strip()) >= 20
    }
    covered = {item.speaker for item in draft.speaker_contributions}
    if substantive - covered:
        raise MinutesGenerationError("MOM omitted a substantive named speaker; regenerate or review the transcript")


def _email_content(minutes: MeetingMinutes, transcript: list[object]) -> tuple[str, str]:
    action_lines = [
        f"- {item.description} — Owner: {item.owner or 'Unassigned'}; Due: {item.due_date or 'Not specified'}"
        for item in minutes.action_items
    ]
    sections = [
        ("Executive summary", [minutes.executive_summary]),
        ("Who said what", [f"{item.speaker}: {item.summary}" for item in minutes.speaker_contributions]),
        ("Questions asked", [f"{item.speaker or 'Unidentified speaker'}: {item.question}" for item in minutes.questions_asked]),
        ("Discussion points", minutes.discussion_points),
        ("Decisions", minutes.decisions),
        ("Action items", action_lines),
        ("Open questions", minutes.open_questions),
    ]
    text_parts = [minutes.title]
    html_parts = [f"<h1>{escape(minutes.title)}</h1>"]
    for heading, items in sections:
        if not items:
            continue
        text_parts.extend([f"\n{heading}", *items])
        html_parts.append(f"<h2>{escape(heading)}</h2><ul>")
        html_parts.extend(f"<li>{escape(item.removeprefix('- '))}</li>" for item in items)
        html_parts.append("</ul>")
    if transcript:
        text_parts.append("\nTranscript")
        html_parts.append("<h2>Transcript</h2><ul>")
        for segment in transcript:
            speaker = getattr(segment, "speaker", None) or "Unidentified speaker"
            line = f"{speaker}: {getattr(segment, 'text', '')}"
            text_parts.append(line)
            html_parts.append(f"<li>{escape(line)}</li>")
        html_parts.append("</ul>")
    html_parts.append("<p>Prepared by Meetings AI.</p>")
    text_parts.append("\nPrepared by Meetings AI.")
    return "".join(html_parts), "\n".join(text_parts)
