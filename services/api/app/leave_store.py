"""Leave policy per workspace (``organization_leave_policies``) and per-meeting leave state
(``meeting_leave_state``), schema v27.

Every member can read the policy; owners and admins change it. The state store is always scoped to
the current workspace (``current_organization_id``), like the rest of the application data.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from .accounts import Actor
from .database import Database, MeetingLeaveStateRow, OrganizationLeavePolicyRow
from .leave_rules import DEFAULT_SERVICE_MAX_HOURS, POLICY_LIMITS, LeavePlan, LeavePolicy, LeaveReason, extended_keep
from .tenant import current_organization_id

ERROR_LIMIT = 1000
STOP_BACKOFF_BASE_SECONDS = 30
STOP_BACKOFF_MAX_SECONDS = 600


class LeavePermissionError(PermissionError):
    pass


def _limit(name: str) -> dict[str, int]:
    low, high = POLICY_LIMITS[name]
    return {"ge": low, "le": high}


class LeavePolicyInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    silence_minutes: int = Field(**_limit("silence_minutes"))
    quiet_after_end_minutes: int = Field(**_limit("quiet_after_end_minutes"))
    no_one_joined_minutes: int = Field(**_limit("no_one_joined_minutes"))
    max_hours: int = Field(**_limit("max_hours"))


class LeavePolicyValues(BaseModel):
    silence_minutes: int
    quiet_after_end_minutes: int
    no_one_joined_minutes: int
    max_hours: int

    @classmethod
    def of(cls, policy: LeavePolicy) -> "LeavePolicyValues":
        return cls(silence_minutes=policy.silence_minutes, quiet_after_end_minutes=policy.quiet_after_end_minutes,
                   no_one_joined_minutes=policy.no_one_joined_minutes, max_hours=policy.max_hours)


class LeavePolicyView(LeavePolicyValues):
    # The meeting-bot service ends every call after this many hours, whatever max_hours says.
    service_max_hours: int = DEFAULT_SERVICE_MAX_HOURS
    effective_max_hours: int = DEFAULT_SERVICE_MAX_HOURS
    configured: bool = False
    can_edit: bool = False
    updated_at: datetime | None = None
    defaults: LeavePolicyValues
    limits: dict[str, tuple[int, int]] = Field(default_factory=lambda: dict(POLICY_LIMITS))


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def service_max_hours_from_env(value: str | None) -> int:
    """``VEXA_MAX_BOT_HOURS``: the meeting-bot service's per-call limit (Vexa's BOT_MAX_ACTIVE_MS, default 4 h)."""
    try:
        hours = int(value) if value else DEFAULT_SERVICE_MAX_HOURS
    except ValueError:
        return DEFAULT_SERVICE_MAX_HOURS
    return hours if hours >= 1 else DEFAULT_SERVICE_MAX_HOURS


class LeavePolicyService:
    def __init__(self, database: Database, service_max_hours: int = DEFAULT_SERVICE_MAX_HOURS) -> None:
        self.database = database
        self.service_max_hours = service_max_hours

    def policy(self, organization_id: UUID | str | None = None) -> LeavePolicy:
        org = str(organization_id or current_organization_id())
        with self.database.session_factory() as session:
            row = session.get(OrganizationLeavePolicyRow, org)
        if row is None:
            return LeavePolicy(service_max_hours=self.service_max_hours)
        return LeavePolicy(silence_minutes=row.silence_minutes, quiet_after_end_minutes=row.quiet_after_end_minutes,
                           no_one_joined_minutes=row.no_one_joined_minutes, max_hours=row.max_hours,
                           service_max_hours=self.service_max_hours)

    def view(self, actor: Actor) -> LeavePolicyView:
        with self.database.session_factory() as session:
            row = session.get(OrganizationLeavePolicyRow, str(actor.organization_id))
        policy = self.policy(actor.organization_id)
        values = LeavePolicyValues.of(policy)
        return LeavePolicyView(**values.model_dump(), service_max_hours=policy.service_max_hours,
                               effective_max_hours=policy.cap_hours, configured=row is not None, can_edit=actor.is_admin,
                               updated_at=_utc(row.updated_at) if row else None,
                               defaults=LeavePolicyValues.of(LeavePolicy()))

    def save(self, actor: Actor, payload: LeavePolicyInput) -> LeavePolicyView:
        if not actor.is_admin:
            raise LeavePermissionError("only workspace owners and admins can change when the assistant leaves")
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            row = session.get(OrganizationLeavePolicyRow, str(actor.organization_id))
            if row is None:
                row = OrganizationLeavePolicyRow(organization_id=str(actor.organization_id))
                session.add(row)
            row.silence_minutes = payload.silence_minutes
            row.quiet_after_end_minutes = payload.quiet_after_end_minutes
            row.no_one_joined_minutes = payload.no_one_joined_minutes
            row.max_hours = payload.max_hours
            row.updated_by = str(actor.user_id)
            row.updated_at = now
        return self.view(actor)


@dataclass(frozen=True)
class LeaveState:
    keep_until: datetime | None = None
    warned_at: datetime | None = None
    warned_leave_at: datetime | None = None
    warned_reason: str | None = None
    end_reason: str | None = None
    ended_by: str | None = None
    ended_at: datetime | None = None
    quiet_since: datetime | None = None
    last_speech_at: datetime | None = None
    stop_attempts: int = 0
    next_attempt_at: datetime | None = None
    last_error: str | None = None

    @classmethod
    def of(cls, row: MeetingLeaveStateRow) -> "LeaveState":
        return cls(
            keep_until=_utc(row.keep_until), warned_at=_utc(row.warned_at), warned_leave_at=_utc(row.warned_leave_at),
            warned_reason=row.warned_reason, end_reason=row.end_reason, ended_by=row.ended_by,
            ended_at=_utc(row.ended_at), quiet_since=_utc(row.quiet_since), last_speech_at=_utc(row.last_speech_at),
            stop_attempts=row.stop_attempts,
            next_attempt_at=_utc(row.next_attempt_at), last_error=row.last_error,
        )


NO_STATE = LeaveState()


class MeetingLeaveStore:
    """Per-meeting leave state in the current workspace. Writes are small upserts."""

    def __init__(self, database: Database) -> None:
        self.database = database

    def get(self, meeting_id: UUID) -> LeaveState:
        with self.database.session_factory() as session:
            row = self._owned(session, meeting_id)
            return LeaveState.of(row) if row is not None else NO_STATE

    def reset(self, meeting_id: UUID) -> None:
        """A new bot attempt starts with a clean slate (nothing kept, warned or ended)."""
        with self.database.session_factory.begin() as session:
            row = self._owned(session, meeting_id)
            if row is not None:
                session.delete(row)

    def keep(self, meeting_id: UUID, user_id: UUID, now: datetime, cap: datetime) -> datetime:
        with self.database.session_factory.begin() as session:
            row = self._upsert(session, meeting_id, now)
            row.keep_until = extended_keep(now, _utc(row.keep_until), cap)
            row.kept_by = str(user_id)
            return _utc(row.keep_until)

    def advance_speech(self, meeting_id: UUID, spoken_at: datetime | None, now: datetime) -> datetime | None:
        """Move the last-speech watermark forward (never back). Returns the watermark after the update."""
        with self.database.session_factory.begin() as session:
            row = self._upsert(session, meeting_id, now) if spoken_at else self._owned(session, meeting_id)
            if row is None:
                return None
            current = _utc(row.last_speech_at)
            if spoken_at and (current is None or spoken_at > current):
                row.last_speech_at = spoken_at
                current = spoken_at
            return current

    def record_warning(self, meeting_id: UUID, plan: LeavePlan, now: datetime) -> None:
        with self.database.session_factory.begin() as session:
            row = self._upsert(session, meeting_id, now)
            row.warned_at = now
            row.warned_leave_at = plan.leave_at
            row.warned_reason = plan.reason.value

    def record_end(self, meeting_id: UUID, reason: LeaveReason, ended_by: str, at: datetime,
                   quiet_since: datetime | None = None) -> bool:
        """Record why the call ended; the first recorded reason wins. Returns True when newly recorded."""
        with self.database.session_factory.begin() as session:
            row = self._upsert(session, meeting_id, at)
            if row.end_reason is not None:
                return False
            row.end_reason = reason.value
            row.ended_by = ended_by
            row.ended_at = at
            row.quiet_since = quiet_since
            row.next_attempt_at = None
            row.last_error = None
            return True

    def record_stop_failure(self, meeting_id: UUID, error: str, now: datetime) -> LeaveState:
        with self.database.session_factory.begin() as session:
            row = self._upsert(session, meeting_id, now)
            row.stop_attempts += 1
            delay = min(STOP_BACKOFF_BASE_SECONDS * 2 ** (row.stop_attempts - 1), STOP_BACKOFF_MAX_SECONDS)
            row.next_attempt_at = now + timedelta(seconds=delay)
            row.last_error = error[:ERROR_LIMIT]
            return LeaveState.of(row)

    def record_error(self, meeting_id: UUID, error: str | None, now: datetime) -> None:
        with self.database.session_factory.begin() as session:
            row = self._upsert(session, meeting_id, now)
            row.last_error = error[:ERROR_LIMIT] if error else None

    @staticmethod
    def _owned(session, meeting_id: UUID) -> MeetingLeaveStateRow | None:
        row = session.get(MeetingLeaveStateRow, str(meeting_id))
        if row is None or row.organization_id != str(current_organization_id()):
            return None
        return row

    def _upsert(self, session, meeting_id: UUID, now: datetime) -> MeetingLeaveStateRow:
        row = session.get(MeetingLeaveStateRow, str(meeting_id))
        if row is not None and row.organization_id != str(current_organization_id()):
            raise LookupError("meeting not found")
        if row is None:
            row = MeetingLeaveStateRow(meeting_id=str(meeting_id), organization_id=str(current_organization_id()),
                                       stop_attempts=0)
            session.add(row)
        row.updated_at = now
        return row
