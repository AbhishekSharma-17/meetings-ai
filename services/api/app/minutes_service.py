"""Post-meeting MOM generation, review, approval, and delivery workflow."""

import json
import re
from base64 import b64encode
from hashlib import sha256
from datetime import UTC, datetime
from html import escape
from pathlib import Path
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
        first_start = min(segment.start_seconds for segment in finalized)
        transcript = "\n".join(
            f"ID={segment.segment_id}\n"
            f"TIME={max(0, segment.start_seconds - first_start):.1f}s into meeting\n"
            f"SPEAKER={segment.speaker or 'Unidentified speaker'}\n"
            f"TEXT={segment.text.strip()}"
            for segment in finalized
        )
        transcript = transcript[:160_000]
        request = TextGenerationRequest(
            system_prompt=(
                "You create factual meeting minutes from only the supplied transcript. "
                "Do not invent names, owners, dates, commitments, decisions, or context. "
                "Treat Unidentified speaker as unknown, never infer their name from context. "
                "Use null when an action owner or due date was not explicitly stated. "
                "Attach exact segment IDs only in evidence_segment_ids arrays for attributed claims and actions. "
                "Never put raw segment IDs or bracketed citations in narrative fields."
            ),
            prompt=(
                f"Meeting title: {meeting.title or 'Untitled meeting'}\n\n"
                "Return concise structured minutes for this transcript. Separate discussion "
                "points, explicit decisions, action items, unresolved questions, "
                "who each identified speaker said, and who asked each question. "
                "Write a concise but comprehensive executive summary covering the meeting purpose, "
                "main themes, outcomes or decisions, open issues, and next steps when evidenced. "
                "Every substantive named speaker needs a contribution entry. "
                "For an unidentified questioner use null.\n\n"
                f"Transcript:\n{transcript}"
            ),
            # This includes reasoning tokens as well as visible JSON. A short
            # cap can truncate a valid draft for a multi-speaker meeting.
            max_output_tokens=12000,
            response_schema=_minutes_response_schema(),
            metadata={"meeting_id": str(meeting_id), "capability": "text_generation"},
        )
        try:
            profile, result = await self.providers.generate_text(request)
            payload = result.structured_output or _parse_json(result.text)
            draft = MeetingMinutesDraft.model_validate(payload)
            _normalize_generated_evidence(draft, finalized)
            _validate_generated_evidence(draft, finalized)
            times = _evidence_times(finalized)
            draft.title = _human_text(draft.title, times)
            draft.executive_summary = _human_text(draft.executive_summary, times)
            draft.discussion_points = [_human_text(item, times) for item in draft.discussion_points]
            draft.decisions = [_human_text(item, times) for item in draft.decisions]
            draft.open_questions = [_human_text(item, times) for item in draft.open_questions]
            for item in draft.action_items:
                item.description = _human_text(item.description, times)
            for item in draft.speaker_contributions:
                item.summary = _human_text(item.summary, times)
            for item in draft.questions_asked:
                item.question = _human_text(item.question, times)
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
        transcript = self.repository.get_transcript(meeting_id)
        html, plain_text = _email_content(minutes, transcript, include_transcript=request.include_transcript)
        attachments = _email_attachments(meeting.title or minutes.title, transcript if request.include_transcript else [])
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
                subject=f"Meeting recap: {_human_text(minutes.title or meeting.title or 'Untitled meeting', _evidence_times(transcript))}",
                html=html,
                text=plain_text,
                attachments=attachments,
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
    try:
        value = json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise ValueError("provider returned incomplete or invalid MOM JSON; retry with a larger output budget") from exc
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


def _normalize_generated_evidence(draft: MeetingMinutesDraft, segments: list[object]) -> None:
    """Remove a copied timestamp only when the remaining ID exactly exists."""
    valid_ids = {segment.segment_id for segment in segments if segment.segment_id}
    for claim in [*draft.speaker_contributions, *draft.questions_asked, *draft.action_items]:
        normalized = []
        for raw in claim.evidence_segment_ids:
            candidate = raw.strip().removeprefix("[").removesuffix("]")
            if candidate not in valid_ids:
                id_part, separator, _ = candidate.partition(" @ ")
                if separator and id_part in valid_ids:
                    candidate = id_part
            normalized.append(candidate)
        claim.evidence_segment_ids = normalized


def _validate_generated_evidence(draft: MeetingMinutesDraft, segments: list[object]) -> None:
    _validate_references(draft, segments)
    substantive = {
        segment.speaker for segment in segments
        if segment.speaker and len(segment.text.strip()) >= 20
    }
    covered = {item.speaker for item in draft.speaker_contributions}
    if substantive - covered:
        raise MinutesGenerationError("MOM omitted a substantive named speaker; regenerate or review the transcript")


_RAW_EVIDENCE = re.compile(r"\[[^\]]*csrc-[^\]]+\]")
_RAW_SEGMENT_ID = re.compile(r"csrc-[A-Za-z0-9:._-]+")


def _clock(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, remaining = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{remaining:02d}" if hours else f"{minutes:02d}:{remaining:02d}"


def _evidence_times(transcript: list[object]) -> dict[str, str]:
    if not transcript:
        return {}
    first = min(float(getattr(item, "start_seconds", 0)) for item in transcript)
    return {
        str(getattr(item, "segment_id", "")): _clock(float(getattr(item, "start_seconds", 0)) - first)
        for item in transcript
    }


def _human_text(value: str, evidence_times: dict[str, str]) -> str:
    """Turn model-inserted internal IDs into readable transcript references."""
    def replace(match: re.Match[str]) -> str:
        times = list(dict.fromkeys(
            evidence_times[item] for item in _RAW_SEGMENT_ID.findall(match.group(0))
            if item in evidence_times
        ))
        return f"(Transcript {', '.join(times)})" if times else ""

    return _RAW_SEGMENT_ID.sub("transcript source", _RAW_EVIDENCE.sub(replace, value)).strip()


def _email_content(
    minutes: MeetingMinutes, transcript: list[object], *, include_transcript: bool = False,
) -> tuple[str, str]:
    times = _evidence_times(transcript)
    title = _human_text(minutes.title, times)
    summary = _human_text(minutes.executive_summary, times)
    sections = [
        ("Discussion points", minutes.discussion_points),
        ("Decisions", minutes.decisions),
        ("Action items", [
            f"{item.description} — Owner: {item.owner or 'Unassigned'} · Due: {item.due_date or 'Not specified'}"
            + (f" (Transcript {', '.join(dict.fromkeys(times[id] for id in item.evidence_segment_ids if id in times))})"
               if any(id in times for id in item.evidence_segment_ids) else "")
            for item in minutes.action_items
        ]),
        ("Open questions", minutes.open_questions),
        ("Who said what", [f"{item.speaker}: {item.summary}" for item in minutes.speaker_contributions]),
        ("Questions asked", [f"{item.speaker or 'Unidentified speaker'}: {item.question}" for item in minutes.questions_asked]),
    ]
    text_parts = [title, "", "EXECUTIVE SUMMARY", summary]
    html_parts = [
        '<!doctype html><html><body style="margin:0;padding:24px;background:#f3f6f5;color:#172322;font-family:Arial,Helvetica,sans-serif;">',
        '<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;margin:auto;border:1px solid #dce7e3;border-radius:16px;background:#ffffff;">',
        '<tr><td style="padding:28px 32px;background:#0e4946;border-radius:16px 16px 0 0;color:#ffffff;">',
        '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="vertical-align:middle;padding-right:12px;">',
        '<img src="cid:meetings-ai-logo" width="42" height="42" alt="Meetings AI" style="display:block;border-radius:10px;" />',
        '</td><td style="vertical-align:middle;font-size:18px;font-weight:700;letter-spacing:.2px;">Meetings AI</td></tr></table>',
        '<p style="margin:25px 0 6px;color:#c5e8e2;font-size:11px;font-weight:700;letter-spacing:2px;">MEETING RECAP</p>',
        f'<h1 style="margin:0;font-size:28px;line-height:1.25;color:#ffffff;">{escape(title)}</h1>',
        '</td></tr><tr><td style="padding:30px 32px;">',
        '<h2 style="margin:0 0 12px;font-size:17px;color:#143e3b;">Executive summary</h2>',
        f'<p style="margin:0 0 24px;line-height:1.65;font-size:15px;">{escape(summary)}</p>',
    ]
    for heading, raw_items in sections:
        items = [_human_text(item, times) for item in raw_items if item.strip()]
        if not items:
            continue
        text_parts.extend(["", heading.upper(), *[f"• {item}" for item in items]])
        html_parts.append(
            f'<h2 style="margin:24px 0 12px;padding-top:20px;border-top:1px solid #e5eeeb;font-size:16px;color:#143e3b;">{escape(heading)}</h2>'
            '<ul style="margin:0;padding-left:22px;line-height:1.6;font-size:14px;">'
        )
        html_parts.extend(f'<li style="margin:0 0 9px;">{escape(item)}</li>' for item in items)
        html_parts.append("</ul>")
    if include_transcript:
        text_parts.extend(["", "The full timestamped transcript is attached as a Markdown file."])
        html_parts.append('<p style="margin:25px 0 0;padding:13px 16px;border-radius:8px;background:#eef7f4;color:#254e49;font-size:13px;">Full timestamped transcript attached as a Markdown file.</p>')
    text_parts.extend(["", "Prepared by Meetings AI. Please review important details against the transcript."])
    html_parts.append('</td></tr><tr><td style="padding:18px 32px;border-top:1px solid #e5eeeb;color:#687b76;font-size:12px;">Prepared by Meetings AI · Review important details against the transcript.</td></tr></table></body></html>')
    return "".join(html_parts), "\n".join(text_parts)


def _transcript_markdown(title: str, transcript: list[object]) -> str:
    times = _evidence_times(transcript)
    lines = [f"# Transcript — {title}", "", "Timestamps are relative to the first captured turn. Speaker names may require review.", ""]
    for segment in transcript:
        if not getattr(segment, "completed", True) or not getattr(segment, "text", "").strip():
            continue
        timestamp = times.get(str(getattr(segment, "segment_id", "")), "00:00")
        speaker = getattr(segment, "speaker", None) or "Unidentified speaker"
        lines.append(f"**[{timestamp}] {speaker}:** {getattr(segment, 'text', '').strip()}")
        lines.append("")
    return "\n".join(lines)


def _email_attachments(title: str, transcript: list[object]) -> list[dict[str, str]]:
    logo_candidates = [
        Path("/app/brand/meetings-ai-avatar-1024.png"),
        Path(__file__).resolve().parents[3] / "apps/web/public/brand/meetings-ai-avatar-1024.png",
    ]
    logo = next((path for path in logo_candidates if path.is_file()), None)
    attachments = []
    if logo:
        attachments.append({
            "filename": "meetings-ai-logo.png",
            "content": b64encode(logo.read_bytes()).decode("ascii"),
            "content_id": "meetings-ai-logo",
        })
    if transcript:
        attachments.append({
            "filename": "meeting-transcript.md",
            "content": b64encode(_transcript_markdown(title, transcript).encode("utf-8")).decode("ascii"),
        })
    return attachments
