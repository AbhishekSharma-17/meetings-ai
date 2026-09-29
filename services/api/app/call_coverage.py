"""Read model for call coordination: every assistant record in a workspace, keyed by the call.

Everything here is scoped to one organization id passed in by the caller; nothing reads
across workspaces. ``AssistantRecord`` joins a meeting with its schedule, calendar source
and coverage rows so the coordination service can decide which assistants point at the
same call (same key, overlapping time window) and who each one covers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .call_keys import Window, call_key, call_key_for_url, windows_overlap
from .database import (
    CalendarEventCacheRow,
    CalendarScheduleRow,
    MeetingCoverageRow,
    MeetingRow,
    MeetingSourceRow,
    MeetingTenantRow,
    UserRow,
)

# Vexa capture statuses in which a bot is (or is about to be) in the call.
JOINING_STATUSES = frozenset({"requested", "joining", "awaiting_admission"})
IN_CALL_STATUSES = frozenset({"active", "needs_human_help"})
LIVE_STATUSES = JOINING_STATUSES | IN_CALL_STATUSES
# A send-now capture with no calendar window is assumed to run at most this long.
SEND_NOW_WINDOW = timedelta(hours=4)
# How far around a window to look for teammates' calendar copies of the call.
CALENDAR_SLACK = timedelta(hours=12)


def _utc(value: datetime) -> datetime:
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC)


@dataclass(frozen=True)
class AssistantRecord:
    meeting_id: str
    key: str
    title: str | None
    status: str
    schedule_status: str | None
    window: Window
    created_at: datetime
    owner_id: str | None
    decision: str | None
    handed_to: str | None
    sharers: tuple[str, ...] = field(default_factory=tuple)
    recap_sharers: tuple[str, ...] = field(default_factory=tuple)

    @property
    def state(self) -> str:
        """scheduled | joining | in_call | ended | idle — what the assistant is doing now."""
        if self.decision == "handed_over":
            return "idle"
        if self.status in IN_CALL_STATUSES:
            return "in_call"
        if self.status in JOINING_STATUSES or self.schedule_status == "joining":
            return "joining"
        if self.schedule_status == "pending" and self.status in {"created", "failed"}:
            return "scheduled"
        if self.status in {"stopping", "completed"}:
            return "ended"
        return "idle"

    @property
    def active(self) -> bool:
        return self.state in {"scheduled", "joining", "in_call"}

    @property
    def starts_at(self) -> datetime:
        return self.window[0]

    def same_call(self, key: str, window: Window) -> bool:
        return self.key == key and windows_overlap(self.window, window)


def _window(meeting: MeetingRow, schedule: CalendarScheduleRow | None, source: MeetingSourceRow | None) -> Window:
    if schedule is not None:
        return _utc(schedule.starts_at), _utc(schedule.ends_at)
    if source is not None:
        return _utc(source.starts_at), _utc(source.ends_at)
    start = _utc(meeting.joined_at or meeting.created_at)
    end = _utc(meeting.stopped_at) if meeting.stopped_at else start + SEND_NOW_WINDOW
    return start, max(end, start)


def load_records(session: Session, organization_id: str, *, platform: str | None = None,
                 meeting_ids: list[str] | None = None) -> list[AssistantRecord]:
    """Assistant records of one workspace (optionally one platform or a set of meetings)."""
    query = select(MeetingRow).join(MeetingTenantRow, MeetingTenantRow.meeting_id == MeetingRow.id).where(
        MeetingTenantRow.organization_id == organization_id,
        # In-person recordings have no call to share or double-join; coordination never considers them.
        MeetingRow.platform != "in_person")
    if platform:
        query = query.where(MeetingRow.platform == platform)
    if meeting_ids is not None:
        if not meeting_ids:
            return []
        query = query.where(MeetingRow.id.in_(meeting_ids))
    meetings = session.execute(query).scalars().all()
    if not meetings:
        return []
    ids = [row.id for row in meetings]
    schedules = {row.meeting_id: row for row in session.execute(select(CalendarScheduleRow).where(
        CalendarScheduleRow.meeting_id.in_(ids), CalendarScheduleRow.organization_id == organization_id)).scalars()}
    sources = {row.meeting_id: row for row in session.execute(select(MeetingSourceRow).where(
        MeetingSourceRow.meeting_id.in_(ids), MeetingSourceRow.organization_id == organization_id)).scalars()}
    coverage: dict[str, list[MeetingCoverageRow]] = {}
    for row in session.execute(select(MeetingCoverageRow).where(
            MeetingCoverageRow.meeting_id.in_(ids), MeetingCoverageRow.organization_id == organization_id)).scalars():
        coverage.setdefault(row.meeting_id, []).append(row)
    return [_record(row, schedules.get(row.id), sources.get(row.id), coverage.get(row.id, [])) for row in meetings]


def _record(meeting: MeetingRow, schedule: CalendarScheduleRow | None, source: MeetingSourceRow | None,
            coverage: list[MeetingCoverageRow]) -> AssistantRecord:
    owner = next((row for row in coverage if row.role == "owner"), None)
    sharing = sorted((row for row in coverage if row.role == "sharing"), key=lambda row: _utc(row.decided_at))
    return AssistantRecord(
        meeting_id=meeting.id, key=call_key(meeting.platform, meeting.native_meeting_id), title=meeting.title,
        status=meeting.status, schedule_status=schedule.status if schedule else None,
        window=_window(meeting, schedule, source), created_at=_utc(meeting.created_at),
        owner_id=owner.user_id if owner else (schedule.user_id if schedule else None),
        decision=owner.decision if owner else None, handed_to=owner.handed_to_meeting_id if owner else None,
        sharers=tuple(row.user_id for row in sharing),
        recap_sharers=tuple(row.user_id for row in sharing if row.receive_recap),
    )


def load_record(session: Session, organization_id: str, meeting_id: str) -> AssistantRecord | None:
    found = load_records(session, organization_id, meeting_ids=[meeting_id])
    return found[0] if found else None


def same_call_records(session: Session, organization_id: str, key: str, window: Window,
                      exclude: str | None = None) -> list[AssistantRecord]:
    platform = key.split(":", 1)[0]
    return sorted((record for record in load_records(session, organization_id, platform=platform)
                   if record.meeting_id != exclude and record.same_call(key, window)),
                  key=lambda record: (record.starts_at, record.created_at, record.meeting_id))


def calendar_holders(session: Session, organization_id: str, key: str, window: Window) -> dict[str, CalendarEventCacheRow]:
    """user id → that person's own synced calendar copy of this call (their private calendar row)."""
    rows = session.execute(select(CalendarEventCacheRow).where(
        CalendarEventCacheRow.organization_id == organization_id,
        CalendarEventCacheRow.starts_at >= window[0] - CALENDAR_SLACK,
        CalendarEventCacheRow.starts_at <= window[1] + CALENDAR_SLACK,
    )).scalars().all()
    holders: dict[str, CalendarEventCacheRow] = {}
    for row in rows:
        url = row.payload.get("meeting_url") if isinstance(row.payload, dict) else None
        if call_key_for_url(url) == key and windows_overlap((row.starts_at, row.ends_at), window):
            holders.setdefault(row.user_id, row)
    return holders


def coverage_row(session: Session, organization_id: str, meeting_id: str, user_id: str) -> MeetingCoverageRow | None:
    row = session.get(MeetingCoverageRow, (meeting_id, user_id))
    return row if row is not None and row.organization_id == organization_id else None


def names(session: Session, user_ids: set[str]) -> dict[str, str]:
    if not user_ids:
        return {}
    rows = session.execute(select(UserRow.id, UserRow.display_name, UserRow.email).where(UserRow.id.in_(user_ids))).all()
    return {user_id: (display or (email or "A teammate").split("@")[0]) for user_id, display, email in rows}


def emails(session: Session, user_ids: set[str]) -> dict[str, str]:
    if not user_ids:
        return {}
    rows = session.execute(select(UserRow.id, UserRow.email).where(UserRow.id.in_(user_ids))).all()
    return {user_id: email for user_id, email in rows if email}
