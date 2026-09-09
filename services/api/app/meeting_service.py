from datetime import UTC, datetime
from uuid import UUID

from meetings_contracts import (
    Meeting,
    MeetingCreate,
    MeetingListResponse,
    MeetingPublic,
    MeetingStatus,
    MeetingTranscriptResponse,
    MeetingTranscriptSegment,
)

from .adapters.vexa import VexaAPIError, VexaCaptureAdapter
from .meeting_links import parse_meeting_url


class MeetingValidationError(ValueError):
    pass


class MeetingConflictError(RuntimeError):
    pass


_VEXA_STATUSES = {item.value: item for item in MeetingStatus if item is not MeetingStatus.CREATED}
_VEXA_STATUSES["needs_help"] = MeetingStatus.NEEDS_HUMAN_HELP
_TERMINAL_STATUSES = {MeetingStatus.COMPLETED, MeetingStatus.FAILED}


class MeetingService:
    def __init__(self, repository: object, vexa: VexaCaptureAdapter) -> None:
        self.repository = repository
        self.vexa = vexa

    def create(self, payload: MeetingCreate) -> Meeting:
        meeting_url = str(payload.meeting_url)
        parsed = parse_meeting_url(meeting_url)
        if parsed is None:
            raise MeetingValidationError(
                "meeting_url must be a supported Google Meet, Teams, Zoom, or Jitsi link"
            )
        platform, native_id = parsed
        meeting = Meeting(
            meeting_url=meeting_url,
            title=payload.title,
            bot_name=payload.bot_name,
            language=payload.language,
            transcribe_enabled=payload.transcribe_enabled,
            recording_enabled=payload.recording_enabled,
            platform=platform,
            native_meeting_id=native_id,
        )
        return self.repository.save_meeting(meeting)

    def list(self) -> MeetingListResponse:
        items = [self.to_public(item) for item in self.repository.list_meetings()]
        return MeetingListResponse(items=items, count=len(items))

    async def get(self, meeting_id: UUID) -> Meeting:
        meeting = self.repository.get_meeting(meeting_id)
        if meeting.vexa_meeting_id is None or meeting.status in _TERMINAL_STATUSES:
            return meeting
        try:
            return await self.refresh(meeting_id)
        except VexaAPIError:
            # Detail polling remains available from durable state during a Vexa outage.
            return meeting

    async def join(self, meeting_id: UUID) -> Meeting:
        meeting = self.repository.get_meeting(meeting_id)
        if meeting.status not in {MeetingStatus.CREATED, MeetingStatus.FAILED}:
            raise MeetingConflictError(
                f"meeting cannot join while status is {meeting.status.value}"
            )
        meeting.status = MeetingStatus.REQUESTED
        meeting.last_error = None
        meeting.updated_at = datetime.now(UTC)
        self.repository.save_meeting(meeting)
        try:
            upstream = await self.vexa.join(
                meeting_url=meeting.meeting_url,
                bot_name=meeting.bot_name,
                language=meeting.language,
                transcribe_enabled=meeting.transcribe_enabled,
                recording_enabled=meeting.recording_enabled,
            )
            meeting.vexa_meeting_id = _integer(upstream.get("id"), "Vexa meeting id")
        except VexaAPIError as exc:
            meeting.status = MeetingStatus.FAILED
            meeting.last_error = str(exc)
            meeting.updated_at = datetime.now(UTC)
            self.repository.save_meeting(meeting)
            raise

        meeting.platform = _enum_or_current(
            upstream.get("platform"), type(meeting.platform), meeting.platform
        )
        meeting.native_meeting_id = str(
            upstream.get("native_meeting_id") or meeting.native_meeting_id
        )
        meeting.status = _status(upstream.get("status"), MeetingStatus.REQUESTED)
        now = datetime.now(UTC)
        if meeting.status is MeetingStatus.ACTIVE:
            meeting.joined_at = meeting.joined_at or now
        meeting.updated_at = now
        return self.repository.save_meeting(meeting)

    async def refresh(self, meeting_id: UUID) -> Meeting:
        meeting = self.repository.get_meeting(meeting_id)
        if meeting.vexa_meeting_id is None:
            raise MeetingConflictError("meeting has not been joined yet")
        upstream = await self.vexa.get_meeting(meeting.vexa_meeting_id)
        meeting.status = _status(upstream.get("status"), meeting.status)
        now = datetime.now(UTC)
        if meeting.status is MeetingStatus.ACTIVE:
            meeting.joined_at = meeting.joined_at or now
        meeting.last_refreshed_at = now
        meeting.updated_at = now
        meeting.last_error = None
        return self.repository.save_meeting(meeting)

    async def stop(self, meeting_id: UUID) -> Meeting:
        meeting = self.repository.get_meeting(meeting_id)
        if meeting.status in {MeetingStatus.STOPPING, *_TERMINAL_STATUSES}:
            return meeting
        if meeting.vexa_meeting_id is None:
            raise MeetingConflictError("meeting has not been joined yet")
        await self.vexa.stop(meeting.platform.value, meeting.native_meeting_id)
        now = datetime.now(UTC)
        meeting.status = MeetingStatus.STOPPING
        meeting.stopped_at = now
        meeting.updated_at = now
        meeting.last_error = None
        return self.repository.save_meeting(meeting)

    async def transcript(self, meeting_id: UUID) -> MeetingTranscriptResponse:
        meeting = self.repository.get_meeting(meeting_id)
        if meeting.vexa_meeting_id is None:
            raise MeetingConflictError("meeting has not been joined yet")
        try:
            upstream = await self.vexa.get_transcript(meeting.vexa_meeting_id)
        except VexaAPIError:
            cached = self.repository.get_transcript(meeting.id)
            if not cached:
                raise
            return MeetingTranscriptResponse(
                meeting_id=meeting.id,
                vexa_meeting_id=meeting.vexa_meeting_id,
                status=meeting.status,
                segments=cached,
                segment_count=len(cached),
            )
        meeting.status = _status(upstream.get("status"), meeting.status)
        now = datetime.now(UTC)
        meeting.last_refreshed_at = now
        meeting.updated_at = now
        self.repository.save_meeting(meeting)
        segments = [
            _segment(raw)
            for raw in upstream.get("segments", [])
            if isinstance(raw, dict)
        ]
        self.repository.replace_transcript(meeting.id, segments)
        return MeetingTranscriptResponse(
            meeting_id=meeting.id,
            vexa_meeting_id=meeting.vexa_meeting_id,
            status=meeting.status,
            segments=segments,
            segment_count=len(segments),
        )

    @staticmethod
    def to_public(meeting: Meeting) -> MeetingPublic:
        return MeetingPublic(
            **{field: getattr(meeting, field) for field in MeetingPublic.model_fields}
        )


def _integer(value: object, label: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise VexaAPIError("join", 502, f"{label} is missing or invalid") from exc


def _number(value: object, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _status(value: object, fallback: MeetingStatus) -> MeetingStatus:
    return _VEXA_STATUSES.get(str(value), fallback)


def _enum_or_current(value: object, enum_type: type, current: object) -> object:
    if value is None:
        return current
    try:
        return enum_type(value)
    except (TypeError, ValueError):
        return current


def _segment(item: dict[str, object]) -> MeetingTranscriptSegment:
    start = max(_number(item.get("start"), 0), 0)
    end = max(_number(item.get("end"), start), start)
    return MeetingTranscriptSegment(
        start_seconds=start,
        end_seconds=end,
        text=str(item.get("text") or ""),
        speaker=str(item["speaker"]) if item.get("speaker") is not None else None,
        language=str(item["language"]) if item.get("language") is not None else None,
        completed=bool(item.get("completed", True)),
    )
