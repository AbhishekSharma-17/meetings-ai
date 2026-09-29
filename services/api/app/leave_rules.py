"""Pure auto-leave rules: when the assistant should leave a call, and what we ask Vexa to enforce.

The assistant leaves only when a meeting is really over:
- Vexa reports the host ended it / removed the bot, or no one could be heard (its own audio timeout);
- it has been genuinely quiet: before the scheduled end (or for ad-hoc meetings) for the silence
  window plus a margin (a transcript backstop for rooms where background noise keeps Vexa's audio
  timeout from firing); after the scheduled end for the shorter quiet-after-end window;
- no one has spoken at all since it joined (the no-one-joined window);
- the safety cap for a forgotten bot: the workspace's max hours, never beyond the meeting-bot service's
  own limit (Vexa ends every call after ``VEXA_MAX_BOT_HOURS``). "Keep in call" cannot extend it.

There is no "everyone left" rule from a live participant roster: this Vexa build does not record who is
present (its participants endpoint reports ``observed_roster: "not_recorded"``), so "everyone left"
comes only from Vexa's own ``left_alone`` completion (its audio-silence timeout).

The scheduled end on its own never makes the assistant leave, and any new speech resets the quiet
timers however long the meeting runs over. Quiet leaves and the safety cap send a heads-up first.
Everything here is a pure function of its inputs so it can be tested without a clock or Vexa.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Literal

# Vexa segment times are either seconds since the meeting started or absolute epoch seconds.
EPOCH_THRESHOLD_SECONDS = 1_000_000_000
# The transcript silence rule waits this much longer than Vexa's own audio-silence leave.
SILENCE_MARGIN = timedelta(minutes=5)
QUIET_HEADS_UP = timedelta(minutes=2)
CAP_HEADS_UP = timedelta(minutes=10)
KEEP_EXTENSION = timedelta(minutes=30)
KEEP_MAX_AHEAD = timedelta(hours=4)
SAME_PLAN_TOLERANCE = timedelta(seconds=1)
MINUTE_MS = 60_000
HOUR_MS = 3_600_000

# Inclusive limits for each policy field (also enforced by the API schema).
POLICY_LIMITS: dict[str, tuple[int, int]] = {
    "silence_minutes": (3, 60),
    "quiet_after_end_minutes": (2, 30),
    "no_one_joined_minutes": (2, 60),
    "max_hours": (2, 12),
}


class LeaveReason(StrEnum):
    ENDED_QUIET_AFTER_SCHEDULE = "ended_quiet_after_schedule"
    SILENT = "silent"
    NO_ONE_JOINED = "no_one_joined"
    EVERYONE_LEFT = "everyone_left"
    TIME_LIMIT = "time_limit"
    HOST_ENDED = "host_ended"
    USER_STOPPED = "user_stopped"
    NOT_ADMITTED = "not_admitted"
    CAPTURE_ENDED = "capture_ended"
    CAPTURE_FAILED = "capture_failed"
    BOT_LOST = "bot_lost"


QUIET_REASONS = frozenset({LeaveReason.ENDED_QUIET_AFTER_SCHEDULE, LeaveReason.SILENT, LeaveReason.NO_ONE_JOINED})
EndedBy = Literal["auto", "user", "host", "vexa"]

# Vexa lifecycle completion_reason → (our end reason, who ended it).
_VEXA_REASONS: dict[str, tuple[LeaveReason, EndedBy]] = {
    "left_alone": (LeaveReason.EVERYONE_LEFT, "vexa"),
    "startup_alone": (LeaveReason.NO_ONE_JOINED, "vexa"),
    "evicted": (LeaveReason.HOST_ENDED, "host"),
    "max_bot_time_exceeded": (LeaveReason.TIME_LIMIT, "vexa"),
    "awaiting_admission_timeout": (LeaveReason.NOT_ADMITTED, "vexa"),
    "awaiting_admission_rejected": (LeaveReason.NOT_ADMITTED, "host"),
    "stopped": (LeaveReason.USER_STOPPED, "user"),
}


DEFAULT_SERVICE_MAX_HOURS = 4


@dataclass(frozen=True)
class LeavePolicy:
    silence_minutes: int = 10
    quiet_after_end_minutes: int = 5
    no_one_joined_minutes: int = 10
    max_hours: int = 4
    # The meeting-bot service's own per-call limit (not stored; comes from VEXA_MAX_BOT_HOURS).
    service_max_hours: int = DEFAULT_SERVICE_MAX_HOURS

    @property
    def cap_hours(self) -> int:
        """The safety cap actually in force: never more than the meeting-bot service allows."""
        return min(self.max_hours, self.service_max_hours)

    @property
    def cap_is_service_limit(self) -> bool:
        return self.service_max_hours <= self.max_hours


@dataclass(frozen=True)
class LeaveSituation:
    now: datetime
    joined_at: datetime
    scheduled_start: datetime | None
    scheduled_end: datetime | None
    last_speech_at: datetime | None
    transcription_enabled: bool
    keep_until: datetime | None = None
    # Someone was transcribed at some point even if no speech time is known now (never "no one joined").
    speech_ever: bool = False
    warned_leave_at: datetime | None = None
    warned_at: datetime | None = None


@dataclass(frozen=True)
class LeavePlan:
    leave_at: datetime
    reason: LeaveReason
    heads_up: timedelta
    quiet_since: datetime | None = None

    @property
    def warn_at(self) -> datetime:
        return self.leave_at - self.heads_up


@dataclass(frozen=True)
class LeaveDecision:
    action: Literal["stay", "warn", "leave"]
    plan: LeavePlan | None = None
    # When the leave will actually happen (a late heads-up still gives people the full warning time).
    leave_at: datetime | None = None


def automatic_leave_payload(policy: LeavePolicy) -> dict[str, int]:
    """Vexa ``POST /bots`` ``automatic_leave`` (milliseconds). ``max_bot_time`` is only the safety cap."""
    return {
        "everyone_left_timeout": policy.silence_minutes * MINUTE_MS,
        "no_one_joined_timeout": policy.no_one_joined_minutes * MINUTE_MS,
        "max_bot_time": policy.cap_hours * HOUR_MS,
    }


def reason_from_vexa(completion_reason: str | None) -> tuple[LeaveReason, EndedBy]:
    return _VEXA_REASONS.get(str(completion_reason or ""), (LeaveReason.CAPTURE_ENDED, "vexa"))


def last_speech_at(segments: Iterable[tuple[float, float, str]], *, anchor: datetime | None,
                   now: datetime) -> datetime | None:
    """Latest moment anyone was transcribed. ``segments`` are (start, end, text) as Vexa sends them.

    Absolute epoch seconds are used as they are; relative offsets are anchored to ``anchor`` (when the
    capture started). Blank segments are not speech. A time ahead of ``now`` (clock skew) counts as now.
    """
    latest: datetime | None = None
    for _start, end, text in segments:
        if not (text or "").strip():
            continue
        if end >= EPOCH_THRESHOLD_SECONDS:
            moment = datetime.fromtimestamp(end, UTC)
        elif anchor is not None:
            moment = _utc(anchor) + timedelta(seconds=max(end, 0))
        else:
            continue
        latest = moment if latest is None or moment > latest else latest
    return min(latest, now) if latest is not None else None


def plans(situation: LeaveSituation, policy: LeavePolicy) -> list[LeavePlan]:
    """Every automatic leave currently in prospect (at most one per kind)."""
    found = [_cap_plan(situation, policy)]
    if situation.transcription_enabled:
        found.append(_quiet_plan(situation, policy))
    return found


def decide(situation: LeaveSituation, policy: LeavePolicy) -> LeaveDecision:
    """Stay, send the heads-up, or leave now. The plan whose heads-up is due first wins."""
    plan = min(plans(situation, policy), key=lambda item: (item.warn_at, item.leave_at))
    now = situation.now
    if plan.heads_up <= timedelta(0):
        return LeaveDecision("leave" if now >= plan.leave_at else "stay", plan, plan.leave_at)
    if not warned_for(situation, plan):
        if now >= plan.warn_at:
            return LeaveDecision("warn", plan, max(plan.leave_at, now + plan.heads_up))
        return LeaveDecision("stay", plan, plan.leave_at)
    warned_at = _utc(situation.warned_at) if situation.warned_at else plan.warn_at
    effective = max(plan.leave_at, warned_at + plan.heads_up)
    return LeaveDecision("leave" if now >= effective else "stay", plan, effective)


def safety_cap_at(joined_at: datetime, policy: LeavePolicy) -> datetime:
    """The latest moment the assistant can stay. "Keep in call" never moves it."""
    return _utc(joined_at) + timedelta(hours=policy.cap_hours)


def extended_keep(now: datetime, keep_until: datetime | None, cap: datetime) -> datetime:
    """Keep in call adds 30 minutes (from now, or from an existing later keep), never past the safety cap."""
    base = max(now, _utc(keep_until)) if keep_until else now
    return min(base + KEEP_EXTENSION, now + KEEP_MAX_AHEAD, _utc(cap))


def can_keep(now: datetime, cap: datetime) -> bool:
    """Keeping only helps while the safety cap is further away than its own heads-up."""
    return _utc(cap) - now > CAP_HEADS_UP


def _cap_plan(situation: LeaveSituation, policy: LeavePolicy) -> LeavePlan:
    return LeavePlan(safety_cap_at(situation.joined_at, policy), LeaveReason.TIME_LIMIT, CAP_HEADS_UP)


def _quiet_plan(situation: LeaveSituation, policy: LeavePolicy) -> LeavePlan:
    joined = _utc(situation.joined_at)
    last = _utc(situation.last_speech_at) if situation.last_speech_at else None
    start = _utc(situation.scheduled_start) if situation.scheduled_start else joined
    if last is None and not situation.speech_ever:
        base = max(joined, start)
        leave_at, reason, quiet_since = base + timedelta(minutes=policy.no_one_joined_minutes), \
            LeaveReason.NO_ONE_JOINED, joined
    else:
        # Speech was recorded but its time is unknown: count quiet from the start, never "no one joined".
        last = last or max(joined, start)
        leave_at, reason = last + timedelta(minutes=policy.silence_minutes) + SILENCE_MARGIN, LeaveReason.SILENT
        if situation.scheduled_end is not None:
            after_end = max(last + timedelta(minutes=policy.quiet_after_end_minutes), _utc(situation.scheduled_end))
            if after_end <= leave_at:
                leave_at, reason = after_end, LeaveReason.ENDED_QUIET_AFTER_SCHEDULE
        quiet_since = last
    if situation.keep_until and _utc(situation.keep_until) > leave_at:
        leave_at = _utc(situation.keep_until)
    return LeavePlan(leave_at, reason, QUIET_HEADS_UP, quiet_since)


def warned_for(situation: LeaveSituation, plan: LeavePlan) -> bool:
    """A heads-up already went out for exactly this planned leave."""
    warned = situation.warned_leave_at
    return warned is not None and abs(_utc(warned) - plan.leave_at) <= SAME_PLAN_TOLERANCE


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)
