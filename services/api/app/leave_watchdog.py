"""App-side auto-leave watchdog: makes sure the assistant always leaves and the meeting is marked over.

Defence in depth on top of Vexa's own leave rules (which a noisy room can defeat, and whose time cap
depends on the Vexa deployment). One pass every ~60 s over meetings that are in a call or leaving:

- in a call: refresh the status and transcript from Vexa, then ``leave_rules.decide`` → stay, send the
  heads-up, or leave (``MeetingService.stop``; the normal completion → minutes pipeline follows);
- leaving (we asked it to leave, or STOPPING): keep refreshing; if Vexa no longer knows the meeting,
  or it stays unfinished far too long, mark it completed so the minutes still run.

A pass never decides on stale speech: if Vexa cannot be reached the meeting is skipped until the next
pass. Work per pass is bounded, and every meeting is processed in its own workspace scope.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from meetings_contracts import MeetingStatus
from sqlalchemy import select

from .adapters.vexa import VexaAPIError
from .database import Database, MeetingRow, MeetingTenantRow
from .leave_notices import LeaveNotices
from .leave_rules import LeaveDecision, LeaveReason, decide
from .leave_service import IN_CALL, TERMINAL, LeaveService
from .leave_store import LeaveState
from .tenant import current_organization_id, tenant_scope

logger = logging.getLogger(__name__)
INTERVAL_SECONDS = 60
BATCH_LIMIT = 200
WATCHED = (MeetingStatus.ACTIVE, MeetingStatus.NEEDS_HUMAN_HELP, MeetingStatus.STOPPING)
# Leaving that takes longer than this is checked against Vexa and closed if Vexa lost the meeting.
STUCK_AFTER = timedelta(minutes=10)
# ...and after this long we stop waiting for Vexa altogether so the minutes are not held back forever.
GIVE_UP_AFTER = timedelta(minutes=30)


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


class LeaveWatchdog:
    def __init__(self, database: Database, meetings: Any, leave: LeaveService, notices: LeaveNotices | None,
                 interval_seconds: int = INTERVAL_SECONDS, batch_limit: int = BATCH_LIMIT) -> None:
        self.database = database
        self.meetings = meetings
        self.leave = leave
        self.notices = notices
        self.interval_seconds = interval_seconds
        self.batch_limit = batch_limit

    async def run(self) -> None:
        while True:
            await asyncio.sleep(self.interval_seconds)
            try:
                await self.tick()
            except Exception:
                logger.exception("auto-leave watchdog pass failed")

    async def tick(self, now: datetime | None = None) -> None:
        for organization_id, meeting_id in self._candidates():
            with tenant_scope(organization_id):
                try:
                    await self.process(meeting_id, now or datetime.now(UTC))
                except Exception:
                    logger.exception("auto-leave check failed for meeting %s", meeting_id)

    def _candidates(self) -> list[tuple[UUID, UUID]]:
        with self.database.session_factory() as session:
            rows = session.execute(select(MeetingTenantRow.organization_id, MeetingRow.id).join(
                MeetingTenantRow, MeetingTenantRow.meeting_id == MeetingRow.id,
            ).where(
                MeetingRow.status.in_([status.value for status in WATCHED]),
                MeetingRow.vexa_meeting_id.is_not(None),
            ).order_by(MeetingRow.updated_at).limit(self.batch_limit)).all()
        return [(UUID(org), UUID(meeting)) for org, meeting in rows]

    async def process(self, meeting_id: UUID, now: datetime) -> None:
        meeting = self.meetings.repository.get_meeting(meeting_id)
        state = self.leave.store.get(meeting_id)
        if meeting.status is MeetingStatus.STOPPING or state.ended_at is not None:
            await self._settle(meeting, state, now)
            return
        try:
            meeting = await self.meetings.refresh(meeting_id)
        except VexaAPIError as exc:
            self._refresh_failed(meeting, exc, now)
            return
        try:
            segments = (await self.meetings.transcript(meeting_id, allow_cached=False)).segments \
                if meeting.transcribe_enabled and meeting.status in IN_CALL else []
        except VexaAPIError as exc:
            logger.info("auto-leave skipped %s this pass (transcript): %s", meeting_id, exc)
            return
        meeting = self.meetings.repository.get_meeting(meeting_id)
        if meeting.status not in IN_CALL:
            return  # it ended on Vexa's side; the completion hook recorded why
        state = self.leave.record_speech(meeting, segments, now)
        window = self.leave.scheduled_window(meeting)
        policy = self.leave.policies.policy()
        decision = decide(self.leave.situation(meeting, now, segments, state, window), policy)
        if decision.action == "warn":
            self._warn(meeting, decision, now)
        elif decision.action == "leave":
            await self._leave(meeting, decision, state, window, now)

    def _refresh_failed(self, meeting: Any, exc: VexaAPIError, now: datetime) -> None:
        """Vexa unreachable (5xx, network): try again next pass. Vexa lost the meeting (404) for a long
        time: close it so the meeting never stays "in a call" forever and the minutes still run."""
        last_ok = _utc(meeting.last_refreshed_at) or _utc(meeting.updated_at) or now
        if exc.status_code == 404 and meeting.status in IN_CALL and now - last_ok >= GIVE_UP_AFTER:
            self._close(meeting, now, "Vexa no longer knows this capture; it was marked finished.",
                        reason=LeaveReason.BOT_LOST)
            return
        logger.info("auto-leave skipped %s this pass: %s", meeting.id, exc)

    def _warn(self, meeting: Any, decision: LeaveDecision, now: datetime) -> None:
        plan = decision.plan
        self.leave.store.record_warning(meeting.id, plan, now)
        if self.notices:
            leave_at = decision.leave_at or plan.leave_at
            minutes = max(1, round((leave_at - now).total_seconds() / 60))
            self.notices.heads_up(current_organization_id(), meeting, plan, self.leave.policies.policy(), minutes)

    async def _leave(self, meeting: Any, decision: LeaveDecision, state: LeaveState,
                     window: tuple[datetime | None, datetime | None], now: datetime) -> None:
        if state.next_attempt_at is not None and now < state.next_attempt_at:
            return  # backing off after a failed stop request
        plan = decision.plan
        try:
            await self.meetings.stop(meeting.id, end_reason=plan.reason, ended_by="auto",
                                     quiet_since=plan.quiet_since, already_gone_ok=True)
        except VexaAPIError as exc:
            failed = self.leave.store.record_stop_failure(
                meeting.id, f"Couldn't make the assistant leave yet ({exc.detail[:200]}). Retrying automatically.", now)
            logger.warning("auto-leave stop failed for %s (attempt %s): %s", meeting.id, failed.stop_attempts, exc)
            return
        recorded = self.leave.store.get(meeting.id)
        if self.notices and recorded.ended_by == "auto":
            self.notices.left(current_organization_id(), meeting, LeaveReason(recorded.end_reason), ended_at=now,
                              quiet_since=plan.quiet_since, scheduled_end=window[1],
                              policy=self.leave.policies.policy())

    async def _settle(self, meeting: Any, state: LeaveState, now: datetime) -> None:
        """We asked the assistant to leave; converge the record even if Vexa never reports back."""
        since = _utc(meeting.stopped_at) or state.ended_at or _utc(meeting.updated_at) or now
        waited = now - since
        try:
            meeting = await self.meetings.refresh(meeting.id)
        except VexaAPIError as exc:
            if exc.status_code == 404 and waited >= STUCK_AFTER:
                self._close(meeting, now, "Vexa no longer knows this capture; it was marked finished.")
            return
        if meeting.status in TERMINAL:
            return
        if waited >= GIVE_UP_AFTER:
            self._close(meeting, now, "Vexa never confirmed the assistant left; the meeting was marked finished.")

    def _close(self, meeting: Any, now: datetime, note: str, reason: LeaveReason | None = None) -> None:
        recorded = reason is not None and self.leave.store.record_end(meeting.id, reason, "auto", now)
        closed = self.meetings.mark_completed(meeting.id)
        self.leave.store.record_error(meeting.id, note, now)
        self.leave.finished(closed, None)
        if recorded and self.notices:
            self.notices.left(current_organization_id(), closed, reason, ended_at=now, quiet_since=None,
                              scheduled_end=self.leave.scheduled_window(closed)[1],
                              policy=self.leave.policies.policy())
        logger.warning("auto-leave closed stuck meeting %s: %s", meeting.id, note)
