"""Plain-language notifications for automatic leaves: the heads-up and "the assistant left".

Times are rendered per reader (their zone and 12/24-hour clock). Dedupe keys make every notice
idempotent across watchdog passes and API replicas. Notification failures never break the caller.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from .leave_rules import LeavePlan, LeavePolicy, LeaveReason
from .notification_events import _title as quoted_title
from .time_display import TimePreferences, format_time

logger = logging.getLogger(__name__)
# Quiet stretches longer than this read better as "since 11:04" than as a count of minutes.
LONG_QUIET_MINUTES = 60
# End reasons that people hear about (a person's own stop is not news to them).
ANNOUNCED_END_REASONS = frozenset({
    LeaveReason.ENDED_QUIET_AFTER_SCHEDULE, LeaveReason.SILENT, LeaveReason.NO_ONE_JOINED,
    LeaveReason.EVERYONE_LEFT, LeaveReason.HOST_ENDED, LeaveReason.TIME_LIMIT, LeaveReason.NOT_ADMITTED,
    LeaveReason.BOT_LOST,
})

Reader = Callable[[TimePreferences], str]


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _minutes(start: datetime, end: datetime) -> int:
    return max(1, round((_utc(end) - _utc(start)).total_seconds() / 60))


def _plural(count: int, unit: str) -> str:
    return f"{count} {unit}" if count == 1 else f"{count} {unit}s"


def limit_phrase(policy: LeavePolicy) -> str:
    """"the 4-hour limit of the meeting-bot service" or "the workspace's 3-hour limit for one call"."""
    if policy.cap_is_service_limit:
        return f"the {policy.cap_hours}-hour limit of the meeting-bot service"
    return f"the workspace's {policy.cap_hours}-hour limit for one call"


def heads_up_clause(plan: LeavePlan, policy: LeavePolicy, joined_at: datetime, reader: TimePreferences) -> str:
    if plan.reason is LeaveReason.TIME_LIMIT:
        return f"it reaches {limit_phrase(policy)}"
    if plan.reason is LeaveReason.NO_ONE_JOINED:
        return f"no one has spoken since it joined at {format_time(joined_at, reader)}"
    since = plan.quiet_since or joined_at
    return f"it's been quiet since {format_time(since, reader)}"


def left_clause(reason: LeaveReason, *, ended_at: datetime, quiet_since: datetime | None,
                scheduled_end: datetime | None, joined_at: datetime | None, policy: LeavePolicy,
                reader: TimePreferences) -> str:
    if reason is LeaveReason.ENDED_QUIET_AFTER_SCHEDULE and quiet_since and scheduled_end:
        quiet_from = max(_utc(quiet_since), _utc(scheduled_end))
        minutes = _minutes(quiet_from, ended_at)
        end = format_time(scheduled_end, reader)
        if minutes > LONG_QUIET_MINUTES:
            return f"no one had spoken since {format_time(quiet_since, reader)}, after the scheduled end ({end})"
        return f"no one had spoken for {_plural(minutes, 'minute')} after the scheduled end ({end})"
    if reason in {LeaveReason.SILENT, LeaveReason.ENDED_QUIET_AFTER_SCHEDULE} and quiet_since:
        minutes = _minutes(quiet_since, ended_at)
        if minutes > LONG_QUIET_MINUTES:
            return f"no one had spoken since {format_time(quiet_since, reader)}"
        return f"no one had spoken for {_plural(minutes, 'minute')}"
    if reason is LeaveReason.NO_ONE_JOINED:
        return f"no one spoke after it joined at {format_time(joined_at, reader)}" if joined_at \
            else "no one spoke after it joined"
    if reason is LeaveReason.EVERYONE_LEFT:
        return "no one could be heard any more, so everyone seems to have left"
    if reason is LeaveReason.HOST_ENDED:
        return "the host ended the meeting"
    if reason is LeaveReason.TIME_LIMIT:
        return f"it reached {limit_phrase(policy)}"
    if reason is LeaveReason.BOT_LOST:
        return "the meeting-bot service lost track of the call"
    if reason is LeaveReason.NOT_ADMITTED:
        return "no one admitted it from the waiting room"
    return "the call ended"


class LeaveNotices:
    def __init__(self, notifications: Any) -> None:
        self.notifications = notifications

    def heads_up(self, organization_id: UUID | str, meeting: Any, plan: LeavePlan, policy: LeavePolicy,
                 minutes_left: int) -> int:
        name = quoted_title(meeting.title)
        joined_at = meeting.joined_at or meeting.created_at

        def title(reader: TimePreferences) -> str:
            clause = heads_up_clause(plan, policy, joined_at, reader)
            return f"The assistant will leave {name} in {_plural(minutes_left, 'minute')} — {clause}"

        body = ("Everything captured so far is kept, and the minutes are drafted as usual."
                if plan.reason is LeaveReason.TIME_LIMIT else "Still talking? Open the meeting and choose Keep in call.")
        return self._send(organization_id, meeting.id, kind="assistant.leaving_soon", severity="warning", title=title,
                          body=body,
                          dedupe_key=f"meeting:{meeting.id}:leave-warning:{plan.leave_at.strftime('%Y%m%dT%H%M')}")

    def left(self, organization_id: UUID | str, meeting: Any, reason: LeaveReason, *, ended_at: datetime,
             quiet_since: datetime | None, scheduled_end: datetime | None, policy: LeavePolicy) -> int:
        if reason not in ANNOUNCED_END_REASONS:
            return 0
        name = quoted_title(meeting.title)

        def title(reader: TimePreferences) -> str:
            clause = left_clause(reason, ended_at=ended_at, quiet_since=quiet_since, scheduled_end=scheduled_end,
                                 joined_at=meeting.joined_at, policy=policy, reader=reader)
            return f"The assistant left {name} — {clause}"

        return self._send(organization_id, meeting.id, kind="assistant.left", severity="info", title=title,
                          body="The transcript is saved. Open the meeting to review it.",
                          dedupe_key=f"meeting:{meeting.id}:{meeting.vexa_meeting_id}:left")

    def _send(self, organization_id: UUID | str, meeting_id: UUID, **kwargs: Any) -> int:
        try:
            return self.notifications.notify_meeting(organization_id, meeting_id, **kwargs)
        except Exception:
            logger.exception("could not send the auto-leave notification")
            return 0
