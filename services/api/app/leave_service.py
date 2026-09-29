"""Auto-leave orchestration shared by the join path, the watchdog and the API.

``MeetingService`` calls the hooks here (``automatic_leave``, ``joining``, ``stopped``, ``finished``);
every hook is failure-safe so a leave-bookkeeping problem never breaks capture.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from meetings_contracts import MeetingStatus
from pydantic import BaseModel
from sqlalchemy import select

from .accounts import Actor
from .database import CalendarScheduleRow, Database, MeetingSourceRow
from .leave_notices import LeaveNotices
from .leave_rules import (
    LeavePolicy, LeaveReason, LeaveSituation, automatic_leave_payload, can_keep, decide, last_speech_at,
    reason_from_vexa, safety_cap_at, warned_for,
)
from .leave_store import LeavePermissionError, LeavePolicyService, LeavePolicyValues, LeaveState, MeetingLeaveStore
from .tenant import current_organization_id

logger = logging.getLogger(__name__)
IN_CALL = frozenset({MeetingStatus.ACTIVE, MeetingStatus.NEEDS_HUMAN_HELP})
TERMINAL = frozenset({MeetingStatus.COMPLETED, MeetingStatus.FAILED})


class LeaveConflictError(RuntimeError):
    pass


class LeavePlanPublic(BaseModel):
    leave_at: datetime
    reason: str
    quiet_since: datetime | None = None
    heads_up_sent: bool = False


class LeaveEndPublic(BaseModel):
    reason: str
    ended_by: str | None = None
    ended_at: datetime | None = None
    quiet_since: datetime | None = None


class MeetingLeaveView(BaseModel):
    meeting_id: UUID
    in_call: bool
    policy: LeavePolicyValues
    # The safety cap in force: min(workspace max_hours, the meeting-bot service's own limit).
    effective_max_hours: int
    service_max_hours: int
    cap_is_service_limit: bool = False
    joined_at: datetime | None = None
    scheduled_end: datetime | None = None
    last_speech_at: datetime | None = None
    safety_cap_at: datetime | None = None
    keep_until: datetime | None = None
    # Owners/admins may make it leave; can_keep is also False once keeping can no longer help.
    can_manage: bool = False
    can_keep: bool = False
    next_leave: LeavePlanPublic | None = None
    ended: LeaveEndPublic | None = None
    last_error: str | None = None


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


class LeaveService:
    def __init__(self, database: Database, repository: Any, policies: LeavePolicyService,
                 store: MeetingLeaveStore, notices: LeaveNotices | None = None) -> None:
        self.database = database
        self.repository = repository
        self.policies = policies
        self.store = store
        self.notices = notices

    # ----- MeetingService hooks (never raise) ------------------------------------------------------
    def automatic_leave(self) -> dict[str, int] | None:
        try:
            return automatic_leave_payload(self.policies.policy())
        except Exception:
            logger.exception("could not load the leave policy; Vexa's default leave rules apply")
            return None

    def joining(self, meeting: Any) -> None:
        try:
            self.store.reset(meeting.id)
        except Exception:
            logger.exception("could not reset leave state for %s", meeting.id)

    def stopped(self, meeting: Any, end_reason: LeaveReason, ended_by: str,
                quiet_since: datetime | None = None) -> None:
        try:
            self.store.record_end(meeting.id, end_reason, ended_by, datetime.now(UTC), quiet_since)
        except Exception:
            logger.exception("could not record why %s ended", meeting.id)

    def finished(self, meeting: Any, vexa_reason: str | None) -> None:
        """Vexa reports the capture over: keep its reason unless we already recorded ours."""
        if meeting.status not in TERMINAL:
            return
        try:
            reason, ended_by = (LeaveReason.CAPTURE_FAILED, "vexa") if meeting.status is MeetingStatus.FAILED \
                else reason_from_vexa(vexa_reason)
            now = datetime.now(UTC)
            if self.store.record_end(meeting.id, reason, ended_by, now) and self.notices and ended_by != "user":
                self.notices.left(current_organization_id(), meeting, reason, ended_at=now, quiet_since=None,
                                  scheduled_end=self.scheduled_window(meeting)[1], policy=self.policies.policy())
        except Exception:
            logger.exception("could not record Vexa's completion reason for %s", meeting.id)

    # ----- situation -------------------------------------------------------------------------------
    def scheduled_window(self, meeting: Any) -> tuple[datetime | None, datetime | None]:
        """The calendar start/end, if the assistant joined before the meeting was due to end."""
        org = str(current_organization_id())
        with self.database.session_factory() as session:
            window = session.execute(select(CalendarScheduleRow.starts_at, CalendarScheduleRow.ends_at).where(
                CalendarScheduleRow.meeting_id == str(meeting.id), CalendarScheduleRow.organization_id == org,
            )).first() or session.execute(select(MeetingSourceRow.starts_at, MeetingSourceRow.ends_at).where(
                MeetingSourceRow.meeting_id == str(meeting.id), MeetingSourceRow.organization_id == org,
            )).first()
        if window is None:
            return None, None
        start, end = _utc(window[0]), _utc(window[1])
        joined = _utc(meeting.joined_at)
        if joined is not None and end is not None and joined > end:
            return None, None  # sent after the event was over: treat it like an ad-hoc meeting
        return start, end

    def situation(self, meeting: Any, now: datetime, segments: list[Any], state: LeaveState,
                  window: tuple[datetime | None, datetime | None]) -> LeaveSituation:
        joined = _utc(meeting.joined_at) or _utc(meeting.created_at) or now
        fresh = last_speech_at(((item.start_seconds, item.end_seconds, item.text) for item in segments),
                               anchor=joined, now=now)
        # The watermark never moves back, so a transcript that briefly comes back empty is not silence.
        speech = max((moment for moment in (fresh, state.last_speech_at) if moment is not None), default=None)
        return LeaveSituation(
            now=now, joined_at=joined, scheduled_start=window[0], scheduled_end=window[1], last_speech_at=speech,
            transcription_enabled=bool(meeting.transcribe_enabled), keep_until=state.keep_until,
            speech_ever=bool(segments) or state.last_speech_at is not None,
            warned_leave_at=state.warned_leave_at, warned_at=state.warned_at,
        )

    def record_speech(self, meeting: Any, segments: list[Any], now: datetime) -> LeaveState:
        """Advance the last-speech watermark from a fresh transcript and return the current state."""
        joined = _utc(meeting.joined_at) or _utc(meeting.created_at) or now
        fresh = last_speech_at(((item.start_seconds, item.end_seconds, item.text) for item in segments),
                               anchor=joined, now=now)
        if fresh is not None:
            self.store.advance_speech(meeting.id, fresh, now)
        return self.store.get(meeting.id)

    # ----- API -------------------------------------------------------------------------------------
    def view(self, actor: Actor, meeting_id: UUID, now: datetime | None = None) -> MeetingLeaveView:
        now = now or datetime.now(UTC)
        meeting = self.repository.get_meeting(meeting_id)
        policy = self.policies.policy()
        state = self.store.get(meeting_id)
        window = self.scheduled_window(meeting)
        view = MeetingLeaveView(
            meeting_id=meeting_id, in_call=meeting.status in IN_CALL and state.end_reason is None,
            policy=LeavePolicyValues.of(policy), effective_max_hours=policy.cap_hours,
            service_max_hours=policy.service_max_hours, cap_is_service_limit=policy.cap_is_service_limit,
            joined_at=_utc(meeting.joined_at), scheduled_end=window[1], keep_until=state.keep_until,
            can_manage=actor.is_admin, last_error=state.last_error,
        )
        if state.end_reason:
            view.ended = LeaveEndPublic(reason=state.end_reason, ended_by=state.ended_by,
                                        ended_at=state.ended_at or _utc(meeting.stopped_at), quiet_since=state.quiet_since)
        if view.in_call:
            self._fill_plan(view, meeting, now, state, window, policy)
        return view

    def keep(self, actor: Actor, meeting_id: UUID) -> MeetingLeaveView:
        if not actor.is_admin:
            raise LeavePermissionError("only workspace owners and admins can keep the assistant in a call")
        meeting = self.repository.get_meeting(meeting_id)
        if meeting.status not in IN_CALL:
            raise LeaveConflictError("the assistant is not in this call any more")
        now = datetime.now(UTC)
        policy = self.policies.policy()
        cap = safety_cap_at(_utc(meeting.joined_at) or _utc(meeting.created_at) or now, policy)
        if not can_keep(now, cap):
            raise LeaveConflictError(f"the assistant is about to reach the {policy.cap_hours}-hour limit for one call "
                                     "and can't stay longer")
        self.store.keep(meeting_id, actor.user_id, now, cap)
        return self.view(actor, meeting_id)

    def _fill_plan(self, view: MeetingLeaveView, meeting: Any, now: datetime, state: LeaveState,
                   window: tuple[datetime | None, datetime | None], policy: LeavePolicy) -> None:
        segments = self.repository.get_transcript(meeting.id) if meeting.transcribe_enabled else []
        situation = self.situation(meeting, now, segments, state, window)
        decision = decide(situation, policy)
        view.last_speech_at = situation.last_speech_at
        view.safety_cap_at = safety_cap_at(situation.joined_at, policy)
        view.can_keep = view.can_manage and can_keep(now, view.safety_cap_at)
        if decision.plan is not None:
            view.next_leave = LeavePlanPublic(
                leave_at=decision.leave_at or decision.plan.leave_at, reason=decision.plan.reason.value,
                quiet_since=decision.plan.quiet_since, heads_up_sent=warned_for(situation, decision.plan),
            )
