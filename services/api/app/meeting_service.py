import logging
from datetime import UTC, datetime
from typing import Any
from hashlib import sha256
from uuid import UUID
from urllib.parse import urlsplit

from meetings_contracts import (
    Meeting,
    MeetingCreate,
    MeetingKnowledgeUpdate,
    MeetingListResponse,
    MeetingPublic,
    MeetingScheduleSummary,
    MeetingParticipant,
    MeetingParticipantsResponse,
    MeetingPlatform,
    MeetingStatus,
    MeetingTranscriptResponse,
    MeetingTranscriptSegment,
    MinutesStatus,
)

from .adapters.vexa import ASSISTANTS_BUSY, AssistantsBusyError, VexaAPIError, VexaCaptureAdapter
from .leave_rules import LeaveReason
from .meeting_links import parse_meeting_url
from .notification_events import NO_EVENTS
from .repository import RecipientGroupNotFoundError
from .service import ProviderProfileService
from .stt_route import signed_stt_override


class MeetingValidationError(ValueError):
    pass


class MeetingConflictError(RuntimeError):
    pass


_VEXA_STATUSES = {item.value: item for item in MeetingStatus if item is not MeetingStatus.CREATED}
_VEXA_STATUSES["needs_help"] = MeetingStatus.NEEDS_HUMAN_HELP
_TERMINAL_STATUSES = {MeetingStatus.COMPLETED, MeetingStatus.FAILED}
_LIVE_STATUSES = {MeetingStatus.ACTIVE, MeetingStatus.NEEDS_HUMAN_HELP, MeetingStatus.STOPPING}
# Meetings whose empty-transcript glitch was already logged (one small entry per affected meeting).
_EMPTY_TRANSCRIPT_LOGGED: set[UUID] = set()
logger = logging.getLogger(__name__)


class MeetingService:
    # Notification hooks (NotificationEvents); a no-op unless wired in create_app.
    events: Any = NO_EVENTS
    # Auto-leave hooks (LeaveService: automatic_leave/joining/stopped/finished); a no-op unless wired.
    leave: Any = NO_EVENTS
    # Call coordination (CallCoordinationService.join_refused); a no-op unless wired.
    coordination: Any = NO_EVENTS

    def __init__(
        self, repository: object, vexa: VexaCaptureAdapter,
        providers: ProviderProfileService | None = None,
        stt_signing_key: str = "",
        knowledge_bases: object | None = None,
    ) -> None:
        self.repository = repository
        self.vexa = vexa
        self.providers = providers
        self.stt_signing_key = stt_signing_key
        self.knowledge_bases = knowledge_bases

    def create(self, payload: MeetingCreate) -> Meeting:
        meeting_url = str(payload.meeting_url)
        parsed = parse_meeting_url(meeting_url)
        if parsed is None:
            host = (urlsplit(meeting_url).hostname or "").lower()
            if host == "webex.com" or host.endswith(".webex.com"):
                raise MeetingValidationError("Webex meetings aren't supported yet; the assistant can join Google Meet, Teams, Zoom or Jitsi")
            raise MeetingValidationError(
                "meeting_url must be a supported Google Meet, Teams, Zoom, or Jitsi link"
            )
        platform, native_id = parsed
        if payload.knowledge_base_id and self.knowledge_bases:
            self.knowledge_bases.get(payload.knowledge_base_id)
        require_groups = getattr(self.repository, "require_recipient_groups", None)
        if payload.delivery_settings.internal_group_ids and require_groups:
            try:
                require_groups(payload.delivery_settings.internal_group_ids)
            except RecipientGroupNotFoundError as exc:
                # Checked before anything is saved, so a stale team id never leaves a half-created meeting.
                raise MeetingValidationError(str(exc)) from exc
        meeting = Meeting(
            meeting_url=meeting_url,
            title=payload.title,
            bot_name=payload.bot_name,
            language=payload.language,
            transcribe_enabled=payload.transcribe_enabled,
            recording_enabled=payload.recording_enabled,
            tags=payload.tags,
            knowledge_enabled=payload.knowledge_enabled,
            knowledge_base_id=payload.knowledge_base_id,
            platform=platform,
            native_meeting_id=native_id,
        )
        saved = self.repository.save_meeting(meeting)
        if saved.knowledge_base_id and self.knowledge_bases:
            self.knowledge_bases.assign_meeting(saved.id, saved.knowledge_base_id)
        self.repository.save_delivery_settings(saved.id, payload.delivery_settings)
        self.repository.save_mom_guidance(saved.id, payload.mom_guidance)
        self.repository.initialize_post_meeting_job(saved.id)
        return saved

    def list(self) -> MeetingListResponse:
        meetings = self.repository.list_meetings()
        ids = [item.id for item in meetings]
        statuses = self.repository.minutes_statuses(ids)
        schedules = self.repository.schedule_summaries(ids)
        items = [self.to_public(item, statuses.get(str(item.id)), schedules.get(str(item.id))) for item in meetings]
        return MeetingListResponse(items=items, count=len(items))

    async def delete(self, meeting_id: UUID) -> None:
        meeting = self.repository.get_meeting(meeting_id)
        if meeting.status not in {MeetingStatus.CREATED, MeetingStatus.COMPLETED, MeetingStatus.FAILED}:
            raise MeetingConflictError("stop the assistant and wait for capture to finish before deleting this meeting")
        if meeting.vexa_meeting_id is not None:
            await self.vexa.delete_meeting(meeting.vexa_meeting_id)
        self.repository.delete_meeting(meeting_id)

    def update_knowledge(self, meeting_id: UUID, update: MeetingKnowledgeUpdate) -> Meeting:
        meeting = self.repository.get_meeting(meeting_id)
        if "knowledge_base_id" in update.model_fields_set and update.knowledge_base_id and self.knowledge_bases:
            self.knowledge_bases.get(update.knowledge_base_id)
        self.repository.save_knowledge_settings(
            meeting_id, tags=update.tags, knowledge_enabled=update.knowledge_enabled,
        )
        meeting.tags = update.tags
        meeting.knowledge_enabled = update.knowledge_enabled
        if "knowledge_base_id" in update.model_fields_set:
            if self.knowledge_bases:
                self.knowledge_bases.assign_meeting(meeting_id, update.knowledge_base_id)
            meeting.knowledge_base_id = update.knowledge_base_id
        return meeting

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
        if meeting.platform is MeetingPlatform.IN_PERSON:
            # Recorded from a phone or laptop browser: there is never an assistant to send (or Vexa to call).
            raise MeetingConflictError("in-person meetings are recorded from a browser; there is no assistant to join")
        if meeting.status not in {MeetingStatus.CREATED, MeetingStatus.FAILED}:
            raise MeetingConflictError(
                f"meeting cannot join while status is {meeting.status.value}"
            )
        stt_override = None
        profile = None
        if meeting.transcribe_enabled and self.providers:
            profile = self.providers.resolve_transcription_profile()
            if profile is not None:
                stt_override = signed_stt_override(
                    profile, meeting.meeting_url, self.stt_signing_key,
                )
        meeting.status = MeetingStatus.REQUESTED
        meeting.last_error = None
        meeting.updated_at = datetime.now(UTC)
        self.repository.save_meeting(meeting)
        # A retry must not display the route from the previous bot attempt.
        self.repository.clear_transcription_route(meeting.id)
        self.leave.joining(meeting)
        automatic_leave = self.leave.automatic_leave()
        try:
            upstream = await self.vexa.join(
                meeting_url=meeting.meeting_url,
                bot_name=meeting.bot_name,
                language=meeting.language,
                transcribe_enabled=meeting.transcribe_enabled,
                recording_enabled=meeting.recording_enabled,
                stt_override=stt_override,
                **({"automatic_leave": automatic_leave} if automatic_leave else {}),
            )
            if profile is not None:
                data = upstream.get("data")
                attested = data.get("stt_override_profile_id") if isinstance(data, dict) else None
                if attested != str(profile.id):
                    try:
                        await self.vexa.stop(meeting.platform.value, meeting.native_meeting_id)
                    except VexaAPIError:
                        pass
                    raise VexaAPIError(
                        "join", 502,
                        "Vexa did not attest the selected STT profile; bot stop was requested",
                    )
            meeting.vexa_meeting_id = _integer(upstream.get("id"), "Vexa meeting id")
        except VexaAPIError as exc:
            if exc.status_code == 429:
                # Every assistant is in another call: the meeting waits (still "created"), it hasn't failed.
                meeting.status = MeetingStatus.CREATED
                meeting.last_error = ASSISTANTS_BUSY
                meeting.updated_at = datetime.now(UTC)
                self.repository.save_meeting(meeting)
                raise AssistantsBusyError(exc.operation, 429, ASSISTANTS_BUSY) from exc
            meeting.status = MeetingStatus.FAILED
            # A teammate's assistant already in this call makes this one stand down (one bot per call).
            meeting.last_error = self.coordination.join_refused(meeting, exc) or str(exc)
            meeting.updated_at = datetime.now(UTC)
            self.repository.save_meeting(meeting)
            self.events.meeting_status(meeting)
            raise

        meeting.platform = _enum_or_current(
            upstream.get("platform"), type(meeting.platform), meeting.platform
        )
        meeting.native_meeting_id = str(
            upstream.get("native_meeting_id") or meeting.native_meeting_id
        )
        meeting.status = _status(upstream.get("status"), MeetingStatus.REQUESTED)
        meeting.last_error = _upstream_failure(upstream, meeting.status)
        now = datetime.now(UTC)
        if meeting.status is MeetingStatus.ACTIVE:
            meeting.joined_at = meeting.joined_at or now
        meeting.updated_at = now
        saved = self.repository.save_meeting(meeting)
        if profile is not None and stt_override is not None:
            self.repository.save_transcription_route(
                meeting.id, profile, urlsplit(str(stt_override["url"])).hostname or "unknown",
            )
        else:
            self.repository.clear_transcription_route(meeting.id)
        self.events.meeting_status(saved)
        return saved

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
        meeting.last_error = _upstream_failure(upstream, meeting.status)
        saved = self.repository.save_meeting(meeting)
        self.events.meeting_status(saved)
        self._record_finish(saved, upstream)
        return saved

    async def stop(
        self, meeting_id: UUID, *, end_reason: LeaveReason = LeaveReason.USER_STOPPED,
        ended_by: str = "user", quiet_since: datetime | None = None, already_gone_ok: bool = False,
    ) -> Meeting:
        """Ask the assistant to leave. ``already_gone_ok`` treats Vexa's "no active bot" (404) as left."""
        meeting = self.repository.get_meeting(meeting_id)
        if meeting.status in {MeetingStatus.STOPPING, *_TERMINAL_STATUSES}:
            return meeting
        if meeting.platform is MeetingPlatform.IN_PERSON:
            raise MeetingConflictError("stop an in-person recording on the device that is recording it")
        if meeting.vexa_meeting_id is None:
            raise MeetingConflictError("meeting has not been joined yet")
        try:
            await self.vexa.stop(meeting.platform.value, meeting.native_meeting_id)
        except VexaAPIError as exc:
            if not (already_gone_ok and exc.status_code == 404):
                raise
        now = datetime.now(UTC)
        meeting.status = MeetingStatus.STOPPING
        meeting.stopped_at = now
        meeting.updated_at = now
        meeting.last_error = None
        saved = self.repository.save_meeting(meeting)
        self.leave.stopped(saved, end_reason, ended_by, quiet_since)
        return saved

    def mark_completed(self, meeting_id: UUID) -> Meeting:
        """Close a capture Vexa no longer tracks, so the post-meeting pipeline can run."""
        meeting = self.repository.get_meeting(meeting_id)
        if meeting.status in _TERMINAL_STATUSES:
            return meeting
        now = datetime.now(UTC)
        meeting.status = MeetingStatus.COMPLETED
        meeting.stopped_at = meeting.stopped_at or now
        meeting.updated_at = now
        saved = self.repository.save_meeting(meeting)
        self.events.meeting_status(saved)
        return saved

    def _record_finish(self, meeting: Meeting, upstream: dict[str, Any]) -> None:
        if meeting.status in _TERMINAL_STATUSES:
            self.leave.finished(meeting, _completion_reason(upstream))

    async def transcript(self, meeting_id: UUID, *, allow_cached: bool = True) -> MeetingTranscriptResponse:
        """Fresh transcript from Vexa; with ``allow_cached`` a Vexa outage falls back to the saved copy."""
        meeting = self.repository.get_meeting(meeting_id)
        if meeting.platform is MeetingPlatform.IN_PERSON:
            # The final pass saves the transcript; live captions are not part of it.
            stored = self.repository.get_transcript(meeting.id)
            return MeetingTranscriptResponse(
                meeting_id=meeting.id, vexa_meeting_id=None, status=meeting.status,
                segments=stored, segment_count=len(stored),
            )
        if meeting.vexa_meeting_id is None:
            cached = self.repository.get_transcript(meeting.id)
            if meeting.status is MeetingStatus.COMPLETED and cached:
                return MeetingTranscriptResponse(
                    meeting_id=meeting.id, vexa_meeting_id=None,
                    status=meeting.status, segments=cached, segment_count=len(cached),
                )
            raise MeetingConflictError("meeting has not been joined yet")
        try:
            upstream = await self.vexa.get_transcript(meeting.vexa_meeting_id)
        except VexaAPIError:
            cached = self.repository.get_transcript(meeting.id)
            if not cached or not allow_cached:
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
        self.events.meeting_status(meeting)
        self._record_finish(meeting, upstream)
        segments = [
            _segment(raw)
            for raw in upstream.get("segments", [])
            if isinstance(raw, dict)
        ]
        if segments or not self._keep_stored_transcript(meeting):
            self.repository.replace_transcript(meeting.id, segments)
        resolved = self.repository.get_transcript(meeting.id)
        self._record_transcription_usage(meeting, resolved)
        return MeetingTranscriptResponse(
            meeting_id=meeting.id,
            vexa_meeting_id=meeting.vexa_meeting_id,
            status=meeting.status,
            segments=resolved,
            segment_count=len(resolved),
        )

    def _keep_stored_transcript(self, meeting: Meeting) -> bool:
        """An empty transcript from Vexa mid-call is a glitch, not silence: never wipe what we already saved."""
        if meeting.status not in _LIVE_STATUSES or not self.repository.get_transcript(meeting.id):
            return False
        if meeting.id not in _EMPTY_TRANSCRIPT_LOGGED:
            _EMPTY_TRANSCRIPT_LOGGED.add(meeting.id)
            logger.warning("Vexa returned an empty transcript for in-call meeting %s; kept the saved one", meeting.id)
        return True

    def _record_transcription_usage(self, meeting: Meeting, segments: "list[MeetingTranscriptSegment]") -> None:
        """Once a capture is final, log its speech-to-text usage (idempotent per bot session)."""
        ledger = getattr(self.providers, "usage", None) if self.providers else None
        if ledger is None or not meeting.transcribe_enabled or meeting.vexa_meeting_id is None \
                or meeting.status is not MeetingStatus.COMPLETED:
            return
        ledger.record_transcription(
            meeting_id=meeting.id, capture_id=meeting.vexa_meeting_id,
            route=self.repository.get_transcription_route(meeting.id), segments=segments,
            joined_at=meeting.joined_at, stopped_at=meeting.stopped_at,
        )

    async def participants(self, meeting_id: UUID) -> MeetingParticipantsResponse:
        meeting = self.repository.get_meeting(meeting_id)
        if meeting.vexa_meeting_id is None:
            return MeetingParticipantsResponse(meeting_id=meeting_id, participants=[])
        try:
            upstream = await self.vexa.get_participants(
                meeting.platform.value, meeting.native_meeting_id,
            )
        except VexaAPIError as exc:
            if exc.status_code not in {404, 501, 503}:
                raise
            upstream = None
        participants = []
        if upstream:
            for item in upstream.get("participants", []):
                if isinstance(item, dict) and item.get("name") and item.get("source") == "invite":
                    participants.append(MeetingParticipant(
                        name=str(item["name"]),
                        email=str(item["email"]) if item.get("email") else None,
                        source=str(item.get("source") or "unknown"),
                        response_status=str(item["response_status"]) if item.get("response_status") else None,
                    ))
        speakers = dict.fromkeys(
            segment.speaker for segment in self.repository.get_transcript(meeting_id)
            if segment.speaker and segment.completed
        )
        participants.extend(MeetingParticipant(name=name, source="speaker") for name in speakers)
        return MeetingParticipantsResponse(
            meeting_id=meeting_id, participants=participants,
            observed_roster=str(upstream.get("observed_roster") or "not_recorded") if upstream else "not_recorded",
            upstream_available=upstream is not None,
        )

    def to_public_with_minutes(self, meeting: Meeting) -> MeetingPublic:
        """One meeting with where its minutes are (draft, approved, sent) and its scheduled join."""
        return self.to_public(meeting, self.repository.minutes_statuses([meeting.id]).get(str(meeting.id)),
                              self.repository.schedule_summaries([meeting.id]).get(str(meeting.id)))

    @staticmethod
    def to_public(meeting: Meeting, minutes_status: MinutesStatus | None = None,
                  schedule: MeetingScheduleSummary | None = None) -> MeetingPublic:
        # minutes_status and schedule live beside the meeting record; lists pass them in.
        fields = {field: getattr(meeting, field) for field in MeetingPublic.model_fields if field not in {"minutes_status", "schedule"}}
        return MeetingPublic(**fields, minutes_status=minutes_status, schedule=schedule)


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


def _completion_reason(upstream: dict[str, Any]) -> str | None:
    data = upstream.get("data")
    value = upstream.get("completion_reason") or (data.get("completion_reason") if isinstance(data, dict) else None)
    return str(value) if value else None


def _status(value: object, fallback: MeetingStatus) -> MeetingStatus:
    return _VEXA_STATUSES.get(str(value), fallback)


def _upstream_failure(
    upstream: dict[str, object], status: MeetingStatus
) -> str | None:
    """Keep Vexa's asynchronous failure reason visible on the product record."""
    if status is not MeetingStatus.FAILED:
        return None

    data = upstream.get("data")
    nested = data if isinstance(data, dict) else {}
    join_evidence = nested.get("join_evidence")
    evidence = join_evidence if isinstance(join_evidence, dict) else {}
    candidates = (
        upstream.get("failure_reason"),
        upstream.get("error"),
        upstream.get("detail"),
        nested.get("reason"),
        evidence.get("detail"),
    )
    for candidate in candidates:
        if candidate:
            # Browser failures can contain multi-line Chromium logs. Preserve the
            # useful diagnosis while keeping the API/UI response bounded.
            detail = " ".join(str(candidate).split())
            if "without having a XServer running" in detail or "Missing X server" in detail:
                return (
                    "Vexa browser could not start because its local display server "
                    "was unavailable."
                )
            detail = detail[:1000]
            return f"Vexa capture failed: {detail}"

    stage = upstream.get("failure_stage") or nested.get("failure_stage")
    if stage:
        return f"Vexa capture failed during {stage}."
    return "Vexa capture failed without a diagnostic reason."


def _enum_or_current(value: object, enum_type: type, current: object) -> object:
    if value is None:
        return current
    try:
        return enum_type(value)
    except (TypeError, ValueError):
        return current


# Vexa publishes a segment as `<speaker key>:<start in epoch ms>` and may later re-publish the same
# sentence as `<speaker key>:<sequence number>`. Speaker corrections and minutes evidence are stored by
# segment ID, so both forms are mapped to the original time-based one: each sentence keeps one ID.
_EPOCH_SECONDS = 1_000_000_000   # starts above this are absolute times, not offsets into the call
_MAX_SEQUENCE = 1_000_000        # a real sequence number, never an epoch-ms timestamp


def _stable_segment_id(raw_id: str, speaker_key: object, start: float) -> str:
    key = str(speaker_key or "")
    prefix, separator, suffix = raw_id.rpartition(":")
    if (not key or not separator or prefix != key or not suffix.isdigit()
            or int(suffix) >= _MAX_SEQUENCE or start < _EPOCH_SECONDS):
        return raw_id
    return f"{key}:{round(start * 1000)}"


def _segment(item: dict[str, object]) -> MeetingTranscriptSegment:
    start = max(_number(item.get("start"), 0), 0)
    end = max(_number(item.get("end"), start), start)
    raw_id = _stable_segment_id(str(item.get("segment_id") or "").strip(), item.get("speaker_key"), start)
    if len(raw_id) > 255:
        raw_id = f"vexa-{sha256(raw_id.encode()).hexdigest()}"
    raw_speaker = str(item["speaker"]) if item.get("speaker") is not None else None
    return MeetingTranscriptSegment(
        segment_id=raw_id or None,
        start_seconds=start,
        end_seconds=end,
        text=str(item.get("text") or ""),
        speaker=raw_speaker,
        raw_speaker=raw_speaker,
        speaker_key=str(item["speaker_key"])[:255] if item.get("speaker_key") is not None else None,
        attribution_source=str(item["source"])[:80] if item.get("source") is not None else None,
        language=str(item["language"]) if item.get("language") is not None else None,
        completed=bool(item.get("completed", True)),
    )
