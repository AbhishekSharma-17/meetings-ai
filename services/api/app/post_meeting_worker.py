"""Single-process reconciler; replace with a queued worker before scaling replicas."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

from meetings_contracts import MeetingStatus

from .repository import MinutesNotFoundError
from .tenant import tenant_scope

logger = logging.getLogger(__name__)
ACTIVE = {
    MeetingStatus.REQUESTED, MeetingStatus.JOINING, MeetingStatus.AWAITING_ADMISSION,
    MeetingStatus.ACTIVE, MeetingStatus.NEEDS_HUMAN_HELP, MeetingStatus.STOPPING,
}


class PostMeetingJobConflictError(RuntimeError):
    pass


class PostMeetingWorker:
    def __init__(self, repository: object, meetings: object, minutes: object, interval_seconds: int = 20):
        self.repository = repository
        self.meetings = meetings
        self.minutes = minutes
        self.interval_seconds = interval_seconds
        self._locks: dict[UUID, asyncio.Lock] = {}

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:
                logger.exception("post-meeting reconciliation failed")
            await asyncio.sleep(self.interval_seconds)

    async def tick(self) -> None:
        for organization_id, meeting_id in self.repository.list_worker_scopes():
            with tenant_scope(organization_id):
                await self.process_meeting(meeting_id)

    async def process_meeting(self, meeting_id: UUID) -> None:
        async with self._locks.setdefault(meeting_id, asyncio.Lock()):
            await self._process_locked(meeting_id)

    async def retry(self, meeting_id: UUID) -> object:
        """Retry one failed draft immediately, without waiting for the poll interval."""
        async with self._locks.setdefault(meeting_id, asyncio.Lock()):
            meeting = self.repository.get_meeting(meeting_id)
            job = self.repository.get_post_meeting_job(meeting_id)
            if job is None:
                raise PostMeetingJobConflictError("automatic drafting is not enabled for this meeting")
            if meeting.status is not MeetingStatus.COMPLETED:
                raise PostMeetingJobConflictError("meeting capture must complete before retrying MOM drafting")
            if meeting.vexa_meeting_id is None:
                raise PostMeetingJobConflictError("meeting has no capture to process")
            try:
                self.repository.get_minutes(meeting_id)
            except MinutesNotFoundError:
                pass
            else:
                raise PostMeetingJobConflictError("a MOM already exists; review it instead of retrying")
            self.repository.save_post_meeting_job(
                meeting_id, attempts=0, next_retry_at=None,
                last_error=None, completed_at=None,
            )
            await self._process_locked(meeting_id)
            return self.repository.get_post_meeting_job(meeting_id)

    async def _process_locked(self, meeting_id: UUID) -> None:
        meeting = self.repository.get_meeting(meeting_id)
        if meeting.vexa_meeting_id is None:
            return
        job = self.repository.get_post_meeting_job(meeting.id)
        if job is None:
            return  # Historical meetings are not auto-processed on upgrade.
        if meeting.status in ACTIVE:
            try:
                meeting = await self.meetings.refresh(meeting.id)
            except Exception as exc:
                logger.warning("meeting refresh failed for %s: %s", meeting.id, exc)
                return
        if meeting.status is not MeetingStatus.COMPLETED:
            return
        try:
            self.repository.get_minutes(meeting.id)
            if not job.completed_at:
                self.repository.save_post_meeting_job(
                    meeting.id, attempts=job.attempts, next_retry_at=None,
                    last_error=None, completed_at=datetime.now(UTC),
                )
            return  # Never overwrite a human-reviewed or approved draft.
        except MinutesNotFoundError:
            pass
        now = datetime.now(UTC)
        if job.completed_at or job.attempts >= 5:
            return
        retry_at = job.next_retry_at
        if retry_at and retry_at.replace(tzinfo=retry_at.tzinfo or UTC) > now:
            return
        try:
            await self.meetings.transcript(meeting.id)
            await self.minutes.generate(meeting.id)
            self.repository.save_post_meeting_job(
                meeting.id, attempts=job.attempts,
                next_retry_at=None, last_error=None, completed_at=datetime.now(UTC),
            )
        except Exception as exc:
            attempts = job.attempts + 1
            self.repository.save_post_meeting_job(
                meeting.id, attempts=attempts,
                next_retry_at=now + timedelta(seconds=min(30 * 2 ** (attempts - 1), 600)),
                last_error=str(exc)[:1000], completed_at=None,
            )
            logger.warning("MOM draft attempt %s failed for %s: %s", attempts, meeting.id, exc)
