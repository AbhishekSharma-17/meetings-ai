"""The final pass of an in-person recording, and cleanup of abandoned audio.

Final pass (background job ``in_person_finalize``): assemble the stored chunks in order, split them
into the largest parts the provider allows (adjacent parts share one chunk of overlap), transcribe
each part with speaker diarization, reconcile speaker labels across parts, save the transcript as
"Speaker A/B/…" segments, propose speaker names (from the transcript and, when the model accepts
voice references, from attendees' saved voice samples — see ``in_person_voice``), mark the meeting completed (which starts the
normal post-meeting pipeline: minutes draft, knowledge indexing, notifications) and delete the audio.

Cleanup (``run``; only the background leader process runs it): audio of a session idle for 24 hours
is deleted and the session marked failed; a final pass interrupted for 2 hours is marked failed so it
can be retried; audio left behind by a crash after a successful pass is deleted.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from meetings_contracts import MeetingStatus, MeetingTranscriptSegment, MomGuidance

from .in_person_audio import Part, plan_parts, standalone, stream_header, streams
from .in_person_models import ABANDONED_AFTER_HOURS
from .in_person_naming import suggest_names
from .in_person_reconcile import GlobalSegment, reconcile
from .in_person_service import FINALIZE_JOB, InPersonService
from .in_person_store import SessionSnapshot
from .in_person_stt import SttError, SttResult, route_for, supports_known_speakers
from .in_person_voice import VoiceReference, merge, pick_attendees, references, voice_matches, voice_suggestions
from .tenant import tenant_scope

logger = logging.getLogger(__name__)
PART_ATTEMPTS = 3
CLEANUP_INTERVAL_SECONDS = 600
STUCK_FINALIZING = timedelta(hours=2)
GUIDANCE_LIMIT = 2000
_RETRY_DELAYS = (2.0, 6.0)


class FinalizeError(RuntimeError):
    """A safe message for the recorder; the audio stays stored so the pass can be retried."""


def _clock(ms: float) -> str:
    seconds = int(ms // 1000)
    hours, rest = divmod(seconds, 3600)
    return f"{hours}:{rest // 60:02d}:{rest % 60:02d}" if hours else f"{rest // 60}:{rest % 60:02d}"


class InPersonFinalizer:
    def __init__(self, service: InPersonService, providers: Any, *, retry_delays: tuple[float, ...] = _RETRY_DELAYS) -> None:
        self.service = service
        self.providers = providers
        self.retry_delays = retry_delays
        self.voice_samples: Any = None  # VoiceSampleService; set by install_in_person

    @property
    def store(self):
        return self.service.store

    # ----- job ---------------------------------------------------------------------------------------
    def register(self, jobs: Any) -> None:
        from .background_jobs import JobFailure

        async def run(context) -> dict[str, Any]:
            meeting_id = UUID(context.payload["meeting_id"])
            try:
                return await self.finalize(context.organization_id, meeting_id, progress=context.progress)
            except FinalizeError as exc:
                raise JobFailure(str(exc), 502) from exc

        def failed(job) -> None:
            # Also runs when a restart interrupted the job: the session must not stay "finalizing".
            if job.subject_id:
                self._fail(UUID(str(self._org_of(job))), UUID(job.subject_id),
                           job.error or "Creating the transcript was interrupted. Retry to try again.")

        jobs.register(FINALIZE_JOB, run, on_failure=failed, workspace_level=True)

    @staticmethod
    def _org_of(job) -> str:
        from .tenant import current_organization_id

        return str(current_organization_id())  # hooks run inside the job's workspace scope

    async def finalize(self, organization_id: UUID, meeting_id: UUID, *, progress=None) -> dict[str, Any]:
        snapshot = self.store.get(organization_id, meeting_id)
        if snapshot.status != "finalizing":
            return {"meeting_id": str(meeting_id), "status": snapshot.status}
        try:
            segments, diarized, profile, route, voices = await self._transcribe(snapshot, progress)
            await self._stage(snapshot, "saving", "Saving the transcript", progress)
            self._save_transcript(meeting_id, segments, diarized, profile, route)
            self._save_moments(meeting_id, snapshot)
            await self._stage(snapshot, "naming", "Suggesting speaker names", progress)
            suggestions = await self._names(meeting_id, snapshot, voices) if diarized else []
        except FinalizeError as exc:
            self._fail(organization_id, meeting_id, str(exc))
            raise
        except Exception as exc:
            # Only the error type: a driver message could quote transcript text.
            logger.error("in-person final pass failed for %s: %s", meeting_id, type(exc).__name__)
            self._fail(organization_id, meeting_id, "Creating the transcript failed unexpectedly. Retry to try again.")
            raise FinalizeError("Creating the transcript failed unexpectedly. Retry to try again.") from exc
        self.store.update(organization_id, meeting_id, status="done", finalize_stage="done", finalize_message="Done",
                          speaker_labels="diarized" if diarized else "single", name_suggestions=suggestions, error=None)
        self.service._set_meeting(meeting_id, MeetingStatus.COMPLETED)
        self.store.delete_chunks(organization_id, meeting_id)  # audio is kept only until the transcript is saved
        return {"meeting_id": str(meeting_id), "segments": len(segments), "diarized": diarized}

    async def _stage(self, snapshot: SessionSnapshot, stage: str, message: str, progress, **values: Any) -> None:
        self.store.update(snapshot.organization_id, snapshot.meeting_id, finalize_stage=stage,
                          finalize_message=message, **values)
        if progress is not None:
            await progress(stage, message)

    async def _transcribe(self, snapshot: SessionSnapshot, progress):
        await self._stage(snapshot, "assembling", "Putting the audio together", progress)
        try:
            profile = self.service.transcriber.profile()
            route = route_for(profile)
        except SttError as exc:
            raise FinalizeError(str(exc)) from exc
        meta = self.store.chunk_meta(snapshot.organization_id, snapshot.meeting_id)
        if not meta:
            raise FinalizeError("The audio of this recording is no longer stored.")
        parts = plan_parts(meta, max_bytes=route.max_part_bytes, max_ms=route.max_part_ms)
        headers = self._headers(snapshot, meta)
        await self._stage(snapshot, "transcribing", f"Transcribing {len(parts)} part{'s' if len(parts) != 1 else ''}",
                          progress, parts_total=len(parts), parts_done=0)
        meeting = self.service.repository.get_meeting(snapshot.meeting_id)
        refs = self._voice_references(snapshot) if supports_known_speakers(route) else []
        results: list[tuple[Part, SttResult]] = []
        for part in parts:
            audio = self._part_audio(snapshot, part, headers)
            results.append((part, await self._transcribe_part(profile, snapshot, part, audio, meeting.language, refs)))
            await self._stage(snapshot, "transcribing", f"Transcribed part {part.index + 1} of {len(parts)}",
                              progress, parts_done=part.index + 1)
        diarized = any(result.diarized for _, result in results)
        if len(results) > 1:
            await self._stage(snapshot, "reconciling", "Matching speakers across parts", progress)
        segments = await reconcile(results, providers=self.providers, meeting_id=snapshot.meeting_id)
        if not any(item.text.strip() for item in segments):
            raise FinalizeError("No speech was recognised in this recording.")
        return segments, diarized, profile, route, voice_matches(segments, refs) if diarized else {}

    def _voice_references(self, snapshot: SessionSnapshot) -> list[VoiceReference]:
        """Saved voice samples of the people expected at this meeting (the recorder first), never others'."""
        if self.voice_samples is None:
            return []
        try:
            identities = self.voice_samples.identities(snapshot.organization_id)
            if not identities:
                return []
            chosen = pick_attendees(identities, recorder_id=snapshot.recorded_by, expected=list(snapshot.expected_people),
                                    invitees=self._invitee_people(snapshot.meeting_id, snapshot))
            return references(self.voice_samples.load(snapshot.organization_id, chosen))
        except Exception as exc:  # noqa: BLE001 - voice samples only add suggestions; transcription goes on without them
            logger.warning("voice samples unavailable for %s: %s", snapshot.meeting_id, type(exc).__name__)
            return []

    def _headers(self, snapshot: SessionSnapshot, meta) -> dict[int, bytes | None]:
        firsts = [group[0].seq for group in streams(meta)]
        data = self.store.chunk_bytes(snapshot.organization_id, snapshot.meeting_id, firsts)
        return {seq: stream_header(snapshot.mime_type, data.get(seq, b"")) for seq in firsts}

    def _part_audio(self, snapshot: SessionSnapshot, part: Part, headers: dict[int, bytes | None]) -> bytes:
        data = self.store.chunk_bytes(snapshot.organization_id, snapshot.meeting_id, list(part.seqs))
        missing = [seq for seq in part.seqs if seq not in data]
        if missing:
            raise FinalizeError("Some of the recorded audio is missing, so the transcript can't be created.")
        audio = standalone(snapshot.mime_type, headers.get(part.stream_first_seq), [data[seq] for seq in part.seqs],
                           starts_stream=part.seqs[0] == part.stream_first_seq)
        if audio is None:
            raise FinalizeError("The recorded audio could not be split for transcription.")
        return audio

    async def _transcribe_part(self, profile, snapshot: SessionSnapshot, part: Part, audio: bytes,
                               language: str | None, refs: list[VoiceReference] | None = None) -> SttResult:
        for attempt in range(PART_ATTEMPTS):
            try:
                return await self.service.transcriber.transcribe(
                    profile, audio, snapshot.mime_type, diarize=True, language=language,
                    purpose="in_person_transcription", meeting_id=snapshot.meeting_id,
                    audio_ms=part.duration_ms, part=part.index, known_speakers=tuple(ref.known for ref in refs or []),
                )
            except SttError as exc:
                if not exc.retryable or attempt == PART_ATTEMPTS - 1:
                    raise FinalizeError(f"Transcription failed: {exc}") from exc
                await asyncio.sleep(self.retry_delays[min(attempt, len(self.retry_delays) - 1)])
        raise FinalizeError("Transcription failed.")

    # ----- saving -------------------------------------------------------------------------------------
    def _save_transcript(self, meeting_id: UUID, segments: list[GlobalSegment], diarized: bool, profile, route) -> None:
        repository = self.service.repository
        source = "in_person_diarized" if diarized else "in_person_single"
        rows = [MeetingTranscriptSegment(
            segment_id=f"in-person-{index:05d}", start_seconds=round(item.start, 3),
            end_seconds=round(max(item.end, item.start), 3), text=item.text,
            speaker=f"Speaker {item.label}" if diarized and item.label else "Speaker",
            speaker_key=item.label if diarized else None, attribution_source=source, completed=True,
        ) for index, item in enumerate(segments) if item.text.strip()]
        repository.replace_transcript(meeting_id, rows)
        repository.save_transcription_route(meeting_id, profile, route.host or "unknown")

    def _save_moments(self, meeting_id: UUID, snapshot: SessionSnapshot) -> None:
        """Moments marked while recording steer the minutes draft (through the meeting's MOM guidance)."""
        if not snapshot.moments:
            return
        repository = self.service.repository
        guidance = repository.get_mom_guidance(meeting_id)
        lines = [f"[{_clock(item.get('at_ms') or 0)}] {item.get('label') or 'Marked as important'}" for item in snapshot.moments]
        note = "Moments the recorder marked as important (give them weight in the minutes):\n" + "\n".join(lines)
        combined = f"{guidance.instructions}\n\n{note}".strip() if guidance.instructions else note
        repository.save_mom_guidance(meeting_id, MomGuidance(
            template=guidance.template, instructions=combined[:GUIDANCE_LIMIT], focus_fields=guidance.focus_fields,
        ))

    async def _names(self, meeting_id: UUID, snapshot: SessionSnapshot,
                     voices: dict[str, VoiceReference] | None = None) -> list[dict[str, Any]]:
        segments = self.service.repository.get_transcript(meeting_id)
        invitees = self._invitees(meeting_id, snapshot)
        voice = voice_suggestions(voices or {}, segments)
        try:
            spoken = await suggest_names(self.providers, meeting_id=meeting_id, segments=segments,
                                         expected=[name for name in snapshot.expected_people if name not in invitees],
                                         invitees=invitees)
        except Exception as exc:  # noqa: BLE001 - names can be suggested again later; the transcript is saved
            logger.warning("speaker naming failed for %s: %s", meeting_id, type(exc).__name__)
            spoken = []
        return merge(spoken, voice)

    def _invitees(self, meeting_id: UUID, snapshot: SessionSnapshot) -> list[str]:
        return [str(person.get("name")) for person in self._invitee_people(meeting_id, snapshot) if person.get("name")]

    def _invitee_people(self, meeting_id: UUID, snapshot: SessionSnapshot) -> list[dict[str, Any]]:
        schedule = self.service.calendar_schedule
        if schedule is None:
            return []
        from .database import MeetingSourceRow

        with schedule.database.session_factory() as session:
            row = session.get(MeetingSourceRow, str(meeting_id))
            if row is None or row.organization_id != str(snapshot.organization_id):
                return []
            return [person for person in row.invitees or [] if isinstance(person, dict)]

    def _fail(self, organization_id: UUID, meeting_id: UUID, message: str) -> None:
        snapshot = self.store.find(organization_id, meeting_id)
        if snapshot is None or snapshot.status != "finalizing":
            return
        with tenant_scope(organization_id):
            self.store.update(organization_id, meeting_id, status="failed", finalize_stage="failed",
                              finalize_message=message[:300], error=message[:1000])
            self.service._set_meeting(meeting_id, MeetingStatus.FAILED, error=message[:1000])

    # ----- cleanup (leader only) ------------------------------------------------------------------------
    async def run(self) -> None:
        while True:
            try:
                self.cleanup()
            except Exception:
                logger.exception("in-person cleanup failed")
            await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)

    def cleanup(self, now: datetime | None = None) -> dict[str, int]:
        del now  # the store compares against its own clock; kept for call-site symmetry
        counts = {"abandoned": 0, "stuck": 0, "orphaned": 0, "completed": 0}
        for organization_id, meeting_id, status in self.store.idle_sessions(
                timedelta(hours=ABANDONED_AFTER_HOURS), frozenset({"recording", "paused", "failed"})):
            with tenant_scope(organization_id):
                if status == "failed" and self.store.chunk_count(organization_id, meeting_id) == 0:
                    continue  # already cleaned; failed sessions keep their consent record, not audio
                self.store.delete_chunks(organization_id, meeting_id)
                if status != "failed":
                    message = "Recording was abandoned; its audio was deleted after 24 hours without activity."
                    self.store.update(organization_id, meeting_id, touch=False, status="failed", error=message,
                                      stopped_at=datetime.now(UTC))
                    self.service._set_meeting(meeting_id, MeetingStatus.FAILED, error=message)
                counts["abandoned"] += 1
        for organization_id, meeting_id, _ in self.store.idle_sessions(STUCK_FINALIZING, frozenset({"finalizing"})):
            self._fail(organization_id, meeting_id, "Creating the transcript was interrupted. Retry to try again.")
            counts["stuck"] += 1
        for organization_id, meeting_id in self.store.orphaned_chunk_meetings(frozenset({"done"})):
            self.store.delete_chunks(organization_id, meeting_id)
            counts["orphaned"] += 1
        # A restart between saving the session as done and completing the meeting: finish the job.
        for organization_id, meeting_id in self.store.done_but_meeting_open():
            with tenant_scope(organization_id):
                self.service._set_meeting(meeting_id, MeetingStatus.COMPLETED)
            counts["completed"] += 1
        return counts
