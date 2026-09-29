"""In-person recording sessions: consent, chunk intake, live captions, stop, retry and discard.

Lifecycle (meeting status in brackets): consent + create → recording [active] ⇄ paused [active] →
stop → finalizing [stopping] → done [completed] | failed [failed]. Only the person recording may
upload, pause, mark moments, stop or discard; the recorder and workspace admins may view the
session. The final diarized pass runs as a background job (``in_person_finalize``); raw audio is
kept only until the final transcript is saved.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from meetings_contracts import Meeting, MeetingDeliverySettings, MeetingPlatform, MeetingStatus, MomGuidance

from .composio_calendar import CalendarError, CalendarEvent, calendar_date_window
from .in_person_audio import aligned, stream_header
from .in_person_models import (
    OPEN_STATUSES,
    CaptionPublic,
    ConsentPublic,
    FinalizePublic,
    InPersonCreate,
    InPersonSessionPublic,
    MomentPublic,
    RecorderPublic,
    base_mime_type,
)
from .in_person_store import InPersonError, InPersonStore, NewSession, SessionNotFoundError, SessionSnapshot
from .in_person_stt import InPersonTranscriber, SttError
from .rate_limit import SlidingWindowLimiter

logger = logging.getLogger(__name__)
FINALIZE_JOB = "in_person_finalize"
RECORDING_ROLES = frozenset({"owner", "admin", "member"})
_PREVIEW_CONCURRENCY = 4
DEFAULT_TITLE = "In-person meeting"


def preview_limiter() -> SlidingWindowLimiter:
    """Live captions cost one speech-to-text call per chunk; at most 8 a minute per person."""
    return SlidingWindowLimiter(8, 60, "live captions are catching up")


class InPersonService:
    def __init__(self, *, store: InPersonStore, repository: Any, meetings: Any, transcriber: InPersonTranscriber,
                 calendar_schedule: Any = None, coordination: Any = None, jobs: Any = None) -> None:
        self.store = store
        self.repository = repository
        self.meetings = meetings
        self.transcriber = transcriber
        self.calendar_schedule = calendar_schedule
        self.coordination = coordination
        self.jobs = jobs
        self._preview_limit = preview_limiter()
        self._preview_semaphore = asyncio.Semaphore(_PREVIEW_CONCURRENCY)
        self._previewing: set[UUID] = set()
        self._tasks: set[asyncio.Task[None]] = set()

    # ----- access ---------------------------------------------------------------------------------
    def session_for_viewer(self, actor: Any, meeting_id: UUID) -> SessionSnapshot:
        """The recorder and workspace admins may see a session; anyone else gets a 404."""
        snapshot = self.store.find(actor.organization_id, meeting_id)
        if snapshot is None or not (snapshot.recorded_by == actor.user_id or actor.is_admin):
            raise SessionNotFoundError(meeting_id)
        return snapshot

    def session_for_recorder(self, actor: Any, meeting_id: UUID) -> SessionSnapshot:
        snapshot = self.session_for_viewer(actor, meeting_id)
        if snapshot.recorded_by != actor.user_id:
            raise InPersonError(403, "only the person recording can change this recording")
        return snapshot

    def public(self, actor: Any, snapshot: SessionSnapshot) -> InPersonSessionPublic:
        meeting = self.repository.get_meeting(snapshot.meeting_id)
        captions = [] if snapshot.status in {"done", "failed"} else self.store.captions(
            snapshot.organization_id, snapshot.meeting_id)
        finalize = None
        if snapshot.finalize_stage:
            finalize = FinalizePublic(stage=snapshot.finalize_stage, message=snapshot.finalize_message,
                                      parts_total=snapshot.parts_total, parts_done=snapshot.parts_done)
        return InPersonSessionPublic(
            meeting_id=snapshot.meeting_id, title=meeting.title or DEFAULT_TITLE, status=snapshot.status,
            device=snapshot.device, recorded_by=RecorderPublic(user_id=snapshot.recorded_by, display_name=snapshot.recorder_name),
            is_recorder=snapshot.recorded_by == actor.user_id,
            consent=ConsentPublic(notice_shown=snapshot.consent_notice_shown, agreed_at=snapshot.consent_at),
            mime_type=snapshot.mime_type, started_at=snapshot.started_at, stopped_at=snapshot.stopped_at,
            last_seq=snapshot.last_seq, received_chunks=snapshot.received_chunks, duration_ms=snapshot.duration_ms,
            total_bytes=snapshot.total_bytes,
            captions=[CaptionPublic(seq=item.seq, start_ms=item.start_ms, text=item.preview_text or "") for item in captions],
            moments=[MomentPublic(at_ms=int(item.get("at_ms") or 0), label=item.get("label")) for item in snapshot.moments],
            finalize=finalize, speaker_labels=snapshot.speaker_labels, error=snapshot.error,
        )

    # ----- create -----------------------------------------------------------------------------------
    async def create(self, actor: Any, payload: InPersonCreate) -> SessionSnapshot:
        if actor.role not in RECORDING_ROLES:
            raise InPersonError(403, "viewers cannot record meetings")
        if not payload.consent.everyone_agreed:
            raise InPersonError(422, "confirm that everyone present has agreed to be recorded before you start")
        mime_type = base_mime_type(payload.mime_type)
        if mime_type is None:
            raise InPersonError(415, "this browser records in an audio format that can't be transcribed; "
                                     "try Chrome, Edge, Firefox or Safari")
        try:
            self.transcriber.profile()
        except SttError as exc:
            raise InPersonError(409, str(exc)) from exc
        event = await self._calendar_event(actor, payload) if payload.calendar_event else None
        expected = list(dict.fromkeys([*payload.expected_people, *(person.name for person in (event.invitees if event else []))]))[:30]
        meeting = Meeting(meeting_url="", bot_name="Meetings AI", platform=MeetingPlatform.IN_PERSON, native_meeting_id="",
                          title=payload.title or (event.title if event else None) or DEFAULT_TITLE,
                          language=payload.language, status=MeetingStatus.ACTIVE)
        meeting.native_meeting_id = f"in-person-{meeting.id}"
        meeting.joined_at = datetime.now(UTC)
        saved = self.repository.save_meeting(meeting)
        self.repository.save_delivery_settings(saved.id, MeetingDeliverySettings())
        self.repository.save_mom_guidance(saved.id, MomGuidance())
        self.repository.initialize_post_meeting_job(saved.id)
        if event is not None and self.calendar_schedule is not None:
            self.calendar_schedule._save_source(actor, saved.id, event)
        snapshot = self.store.create(actor.organization_id, NewSession(
            meeting_id=saved.id, recorded_by=actor.user_id, device=payload.device, mime_type=mime_type,
            notice_shown=payload.consent.notice_shown, expected_people=expected,
        ))
        if self.coordination is not None:
            # The recorder owns the meeting, so members can open it like any meeting they own.
            self.coordination.record_owner(actor.organization_id, saved.id, actor.user_id)
        return snapshot

    async def _calendar_event(self, actor: Any, payload: InPersonCreate) -> CalendarEvent:
        """Re-read the event from the person's own calendar; the browser's copy is never trusted."""
        reference = payload.calendar_event
        calendar = getattr(self.calendar_schedule, "calendar", None)
        if calendar is None:
            raise InPersonError(409, "calendars are not available right now; start without the event")
        try:
            start, end = calendar_date_window(reference.event_date, reference.event_date, reference.timezone)
            scan = await calendar.events_for_window(actor, reference.connection_id, start, end, reference.timezone)
        except CalendarError as exc:
            raise InPersonError(409, f"could not read that calendar event: {exc}") from exc
        event = next((item for item in scan.events if item.event_id == reference.event_id), None)
        if event is None:
            raise InPersonError(404, "that calendar event is no longer available; refresh the calendar and try again")
        return event

    # ----- chunks and live captions -------------------------------------------------------------------
    def add_chunk(self, actor: Any, meeting_id: UUID, *, seq: int, data: bytes, duration_ms: int,
                  stream_start: bool, content_type: str | None):
        snapshot = self.session_for_recorder(actor, meeting_id)
        mime_type = base_mime_type(content_type)
        if mime_type is None:
            raise InPersonError(415, f"send the audio as {snapshot.mime_type}")
        return self.store.add_chunk(actor.organization_id, meeting_id, seq=seq, data=data,
                                    duration_ms=duration_ms, stream_start=stream_start, mime_type=mime_type)

    def schedule_preview(self, actor: Any, meeting_id: UUID, seq: int) -> None:
        """Caption the newest piece in the background (call from the event loop, after storing it)."""
        if meeting_id in self._previewing:
            return  # one caption request per meeting at a time; a backlog only captions its newest piece
        try:
            self._preview_limit.check(actor.user_id)
        except Exception:  # noqa: BLE001 - HTTPException 429: skip this caption, never the upload
            return
        self._previewing.add(meeting_id)
        task = asyncio.get_running_loop().create_task(self._preview(actor.organization_id, meeting_id, seq))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _preview(self, organization_id: UUID, meeting_id: UUID, seq: int) -> None:
        from .tenant import tenant_scope

        try:
            async with self._preview_semaphore:
                with tenant_scope(organization_id):
                    await self._caption(organization_id, meeting_id, seq)
        except Exception as exc:  # noqa: BLE001 - captions are best effort; never log audio or text
            logger.info("live caption skipped for %s piece %s: %s", meeting_id, seq, type(exc).__name__)
        finally:
            self._previewing.discard(meeting_id)

    async def _caption(self, organization_id: UUID, meeting_id: UUID, seq: int) -> None:
        snapshot = self.store.get(organization_id, meeting_id)
        if snapshot.status not in OPEN_STATUSES:
            return
        meta = self.store.chunk_meta(organization_id, meeting_id)
        latest = meta[-1] if meta else None
        if latest is None:
            return
        first = next(item for item in reversed(meta) if item.stream_start or item.seq == meta[0].seq)
        wanted = [latest.seq] if latest.stream_start else [first.seq, latest.seq]
        audio_by_seq = self.store.chunk_bytes(organization_id, meeting_id, wanted)
        if latest.stream_start:
            audio = audio_by_seq.get(latest.seq)
        else:
            header = stream_header(snapshot.mime_type, audio_by_seq.get(first.seq, b""))
            body = aligned(snapshot.mime_type, audio_by_seq.get(latest.seq, b""))
            audio = header + body if header and body else None
        if not audio:
            return
        meeting = self.repository.get_meeting(meeting_id)
        profile = self.transcriber.profile()
        result = await self.transcriber.transcribe(
            profile, audio, snapshot.mime_type, diarize=False, language=meeting.language,
            purpose="in_person_live_preview", meeting_id=meeting_id, audio_ms=latest.duration_ms,
        )
        if result.text.strip():
            self.store.set_preview(organization_id, meeting_id, latest.seq, result.text.strip())

    # ----- controls ---------------------------------------------------------------------------------------
    def pause(self, actor: Any, meeting_id: UUID) -> SessionSnapshot:
        self.session_for_recorder(actor, meeting_id)
        return self.store.update(actor.organization_id, meeting_id, allowed=frozenset({"recording", "paused"}), status="paused")

    def resume(self, actor: Any, meeting_id: UUID) -> SessionSnapshot:
        self.session_for_recorder(actor, meeting_id)
        return self.store.update(actor.organization_id, meeting_id, allowed=frozenset({"recording", "paused"}), status="recording")

    def add_moment(self, actor: Any, meeting_id: UUID, at_ms: int, label: str | None) -> SessionSnapshot:
        self.session_for_recorder(actor, meeting_id)
        cleaned = " ".join((label or "").split()) or None
        return self.store.add_moment(actor.organization_id, meeting_id, at_ms, cleaned)

    def stop(self, actor: Any, meeting_id: UUID, final_seq: int) -> SessionSnapshot:
        snapshot = self.session_for_recorder(actor, meeting_id)
        if snapshot.status not in OPEN_STATUSES:
            if snapshot.status in {"finalizing", "done"}:
                return snapshot  # a repeated Stop (double tap, retry after a timeout) is harmless
            raise InPersonError(409, "this recording stopped with an error; retry or discard it")
        if final_seq > snapshot.last_seq:
            raise InPersonError(409, {"message": "some audio has not arrived yet; upload it before stopping",
                                      "expected_seq": snapshot.last_seq + 1})
        now = datetime.now(UTC)
        if snapshot.received_chunks == 0:
            self._set_meeting(meeting_id, MeetingStatus.FAILED, error="No audio was received from the recording device.")
            return self.store.update(actor.organization_id, meeting_id, allowed=OPEN_STATUSES, status="failed",
                                     stopped_at=now, error="No audio was received from the recording device.")
        try:
            stopped = self.store.update(actor.organization_id, meeting_id, allowed=OPEN_STATUSES, status="finalizing",
                                        stopped_at=now, finalize_stage="queued", finalize_message="Waiting to start",
                                        parts_total=0, parts_done=0, error=None)
        except InPersonError:
            current = self.store.get(actor.organization_id, meeting_id)
            if current.status in {"finalizing", "done"}:
                return current  # two Stop taps raced; the first one already started the final pass
            raise
        self._set_meeting(meeting_id, MeetingStatus.STOPPING)
        self.submit_finalize(actor, meeting_id)
        return stopped

    def retry(self, actor: Any, meeting_id: UUID) -> SessionSnapshot:
        """The recorder or an admin (deliberately: a failed pass is often fixed by an admin's provider change)."""
        snapshot = self.session_for_viewer(actor, meeting_id)
        if snapshot.status != "failed":
            raise InPersonError(409, "only a recording that stopped with an error can be retried")
        if self.store.chunk_count(actor.organization_id, meeting_id) == 0:
            raise InPersonError(409, "the audio of this recording is no longer stored, so it can't be transcribed again")
        retried = self.store.update(actor.organization_id, meeting_id, allowed=frozenset({"failed"}), status="finalizing",
                                    finalize_stage="queued", finalize_message="Waiting to start", parts_total=0,
                                    parts_done=0, error=None)
        self._set_meeting(meeting_id, MeetingStatus.STOPPING)
        self.submit_finalize(actor, meeting_id)
        return retried

    def discard(self, actor: Any, meeting_id: UUID) -> None:
        snapshot = self.session_for_recorder(actor, meeting_id)
        if snapshot.status not in {*OPEN_STATUSES, "failed"}:
            raise InPersonError(409, "a finished recording is deleted from the meeting page instead")
        self.store.delete_chunks(actor.organization_id, meeting_id)
        self.repository.delete_meeting(meeting_id)

    def submit_finalize(self, actor: Any, meeting_id: UUID) -> None:
        if self.jobs is None:
            raise InPersonError(503, "background processing is not available")
        self.jobs.submit(organization_id=actor.organization_id, user_id=actor.user_id, kind=FINALIZE_JOB,
                         subject_id=str(meeting_id), payload={"meeting_id": str(meeting_id)})

    def _set_meeting(self, meeting_id: UUID, status: MeetingStatus, *, error: str | None = None) -> Any:
        meeting = self.repository.get_meeting(meeting_id)
        now = datetime.now(UTC)
        meeting.status = status
        meeting.updated_at = now
        meeting.last_error = error
        if status in {MeetingStatus.STOPPING, MeetingStatus.COMPLETED, MeetingStatus.FAILED}:
            meeting.stopped_at = meeting.stopped_at or now
        saved = self.repository.save_meeting(meeting)
        if status in {MeetingStatus.COMPLETED, MeetingStatus.FAILED}:
            # "Capture finished" / "Capture stopped with an error" for the recorder and admins.
            self.meetings.events.meeting_status(saved)
        return saved

    async def close(self) -> None:
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
