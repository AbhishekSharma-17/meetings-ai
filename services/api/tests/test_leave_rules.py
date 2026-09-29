"""Pure auto-leave decisions: when the assistant leaves a call, and the Vexa leave payload."""

from datetime import UTC, datetime, timedelta

import pytest

from app.leave_rules import (
    LeavePolicy,
    LeaveReason,
    LeaveSituation,
    automatic_leave_payload,
    can_keep,
    decide,
    extended_keep,
    last_speech_at,
    reason_from_vexa,
)

POLICY = LeavePolicy(max_hours=8, service_max_hours=8)  # silence 10, quiet 5, no one joined 10, cap 8 h
JOINED = datetime(2026, 9, 29, 10, 31, tzinfo=UTC)
START = datetime(2026, 9, 29, 10, 30, tzinfo=UTC)
END = datetime(2026, 9, 29, 11, 0, tzinfo=UTC)


def at(hour: int, minute: int, second: int = 0) -> datetime:
    return datetime(2026, 9, 29, hour, minute, second, tzinfo=UTC)


def situation(now: datetime, *, last: datetime | None, scheduled: bool = True, **extra) -> LeaveSituation:
    return LeaveSituation(
        now=now, joined_at=JOINED, scheduled_start=START if scheduled else None,
        scheduled_end=END if scheduled else None, last_speech_at=last, transcription_enabled=True, **extra,
    )


# ----- defaults and the Vexa payload -------------------------------------------------------------
def test_default_policy_values() -> None:
    default = LeavePolicy()
    assert (default.silence_minutes, default.quiet_after_end_minutes, default.no_one_joined_minutes,
            default.max_hours, default.service_max_hours, default.cap_hours) == (10, 5, 10, 4, 4, 4)


def test_safety_cap_never_exceeds_the_meeting_bot_service_limit() -> None:
    assert LeavePolicy(max_hours=8, service_max_hours=4).cap_hours == 4
    assert LeavePolicy(max_hours=8, service_max_hours=4).cap_is_service_limit is True
    assert LeavePolicy(max_hours=3, service_max_hours=4).cap_hours == 3
    assert LeavePolicy(max_hours=3, service_max_hours=4).cap_is_service_limit is False
    assert automatic_leave_payload(LeavePolicy(max_hours=8, service_max_hours=4))["max_bot_time"] == 4 * 3_600_000


def test_automatic_leave_payload_is_in_milliseconds_and_caps_only_at_max_hours() -> None:
    payload = automatic_leave_payload(LeavePolicy(silence_minutes=12, no_one_joined_minutes=7, max_hours=6,
                                                  service_max_hours=8))
    assert payload == {
        "everyone_left_timeout": 12 * 60_000,
        "no_one_joined_timeout": 7 * 60_000,
        "max_bot_time": 6 * 3_600_000,
    }
    assert all(isinstance(value, int) and value > 0 for value in payload.values())


# ----- the scheduled end never makes the assistant leave on its own ------------------------------
def test_meeting_that_ends_on_time_leaves_after_the_quiet_window_with_a_heads_up_first() -> None:
    # Last words at 10:59, scheduled end 11:00: leave at 11:04 (5 quiet minutes), warn at 11:02.
    assert decide(situation(at(11, 1), last=at(10, 59)), POLICY).action == "stay"
    warn = decide(situation(at(11, 2), last=at(10, 59)), POLICY)
    assert warn.action == "warn"
    assert warn.plan.reason is LeaveReason.ENDED_QUIET_AFTER_SCHEDULE
    assert warn.plan.leave_at == at(11, 4) and warn.plan.quiet_since == at(10, 59)
    warned = {"warned_leave_at": warn.plan.leave_at, "warned_at": at(11, 2)}
    assert decide(situation(at(11, 3), last=at(10, 59), **warned), POLICY).action == "stay"
    leave = decide(situation(at(11, 4), last=at(10, 59), **warned), POLICY)
    assert leave.action == "leave" and leave.plan.reason is LeaveReason.ENDED_QUIET_AFTER_SCHEDULE


def test_meeting_running_two_hours_over_with_ongoing_speech_stays() -> None:
    for minutes_over in (1, 30, 60, 119):
        now = END + timedelta(minutes=minutes_over)
        decision = decide(situation(now, last=now - timedelta(seconds=40)), POLICY)
        assert decision.action == "stay", minutes_over


def test_overrun_then_quiet_leaves_five_minutes_after_the_last_speech() -> None:
    last = END + timedelta(hours=2, minutes=3)
    warn = decide(situation(last + timedelta(minutes=3), last=last), POLICY)
    assert warn.action == "warn" and warn.plan.leave_at == last + timedelta(minutes=5)
    leave = decide(situation(last + timedelta(minutes=5), last=last, warned_leave_at=warn.plan.leave_at,
                             warned_at=last + timedelta(minutes=3)), POLICY)
    assert leave.action == "leave" and leave.plan.reason is LeaveReason.ENDED_QUIET_AFTER_SCHEDULE


def test_new_speech_resets_the_timer_however_long_past_the_end() -> None:
    first_quiet = END + timedelta(minutes=50)
    warned = decide(situation(first_quiet + timedelta(minutes=3), last=first_quiet), POLICY)
    assert warned.action == "warn"
    spoke_again = first_quiet + timedelta(minutes=4)
    after = decide(situation(spoke_again + timedelta(minutes=1), last=spoke_again,
                             warned_leave_at=warned.plan.leave_at, warned_at=first_quiet + timedelta(minutes=3)), POLICY)
    assert after.action == "stay"
    assert after.plan.leave_at == spoke_again + timedelta(minutes=5)


def test_quiet_mid_meeting_under_the_silence_window_stays() -> None:
    assert decide(situation(at(10, 50), last=at(10, 41)), POLICY).action == "stay"


def test_silence_before_the_scheduled_end_uses_the_silence_window_plus_margin() -> None:
    # Before the end: 10 minutes of silence + 5 minute margin (Vexa's own audio timeout goes first).
    decision = decide(situation(at(10, 50), last=at(10, 35)), POLICY)
    assert decision.plan.reason is LeaveReason.SILENT
    assert decision.plan.leave_at == at(10, 50)
    assert decision.action == "warn"


def test_quiet_that_starts_before_the_end_switches_to_the_shorter_window_at_the_end() -> None:
    # Quiet since 10:57: the silence rule would leave at 11:12; after the end, 5 quiet minutes → 11:02.
    decision = decide(situation(at(11, 0, 30), last=at(10, 57)), POLICY)
    assert decision.plan.reason is LeaveReason.ENDED_QUIET_AFTER_SCHEDULE
    assert decision.plan.leave_at == at(11, 2)


def test_ad_hoc_meeting_uses_the_silence_window() -> None:
    decision = decide(situation(at(12, 0), last=at(11, 45), scheduled=False), POLICY)
    assert decision.plan.reason is LeaveReason.SILENT and decision.plan.leave_at == at(12, 0)


def test_noise_only_meeting_with_no_transcript_leaves_on_the_no_one_joined_backstop() -> None:
    decision = decide(situation(at(10, 39), last=None), POLICY)
    assert decision.action == "warn"
    assert decision.plan.reason is LeaveReason.NO_ONE_JOINED
    assert decision.plan.leave_at == at(10, 41) and decision.plan.quiet_since == JOINED


def test_early_join_counts_no_one_joined_from_the_scheduled_start() -> None:
    early = LeaveSituation(now=at(10, 30), joined_at=at(10, 20), scheduled_start=START, scheduled_end=END,
                           last_speech_at=None, transcription_enabled=True)
    assert decide(early, POLICY).plan.leave_at == at(10, 40)


def test_without_transcription_only_the_safety_cap_applies() -> None:
    quiet = LeaveSituation(now=at(13, 0), joined_at=JOINED, scheduled_start=START, scheduled_end=END,
                           last_speech_at=None, transcription_enabled=False)
    decision = decide(quiet, POLICY)
    assert decision.action == "stay" and decision.plan.reason is LeaveReason.TIME_LIMIT


# ----- keep in call ----------------------------------------------------------------------------
def test_keep_until_postpones_a_quiet_leave_and_warns_again_before_it_ends() -> None:
    keep = at(11, 34)
    kept = situation(at(11, 10), last=at(10, 59), keep_until=keep, warned_leave_at=at(11, 4), warned_at=at(11, 2))
    assert decide(kept, POLICY).action == "stay"
    warn = decide(situation(at(11, 32), last=at(10, 59), keep_until=keep, warned_leave_at=at(11, 4),
                            warned_at=at(11, 2)), POLICY)
    assert warn.action == "warn" and warn.plan.leave_at == keep


def test_keep_never_extends_the_safety_cap() -> None:
    cap = JOINED + timedelta(hours=8)
    assert extended_keep(cap - timedelta(minutes=15), None, cap) == cap
    assert can_keep(cap - timedelta(minutes=11), cap) is True
    assert can_keep(cap - timedelta(minutes=10), cap) is False
    talking = situation(cap, last=cap - timedelta(seconds=10), keep_until=cap, warned_leave_at=cap,
                        warned_at=cap - timedelta(minutes=10))
    decision = decide(talking, POLICY)
    assert decision.action == "leave" and decision.plan.reason is LeaveReason.TIME_LIMIT


# ----- the safety cap --------------------------------------------------------------------------
def test_safety_cap_warns_ten_minutes_ahead_then_leaves_even_while_people_talk() -> None:
    cap = JOINED + timedelta(hours=8)
    warn = decide(situation(cap - timedelta(minutes=10), last=cap - timedelta(minutes=10, seconds=5)), POLICY)
    assert warn.action == "warn" and warn.plan.reason is LeaveReason.TIME_LIMIT and warn.plan.leave_at == cap
    leave = decide(situation(cap, last=cap - timedelta(seconds=5), warned_leave_at=cap,
                             warned_at=cap - timedelta(minutes=10)), POLICY)
    assert leave.action == "leave" and leave.plan.reason is LeaveReason.TIME_LIMIT


def test_a_late_heads_up_still_gives_people_the_full_warning_time() -> None:
    # The watchdog was down past the planned leave: warn now and leave two minutes later, not at once.
    warn = decide(situation(at(12, 0), last=at(10, 59)), POLICY)
    assert warn.action == "warn" and warn.leave_at == at(12, 2)
    early = decide(situation(at(12, 1), last=at(10, 59), warned_leave_at=warn.plan.leave_at, warned_at=at(12, 0)), POLICY)
    assert early.action == "stay"
    leave = decide(situation(at(12, 2), last=at(10, 59), warned_leave_at=warn.plan.leave_at, warned_at=at(12, 0)), POLICY)
    assert leave.action == "leave"


def test_heads_up_is_sent_once_per_plan() -> None:
    first = decide(situation(at(11, 2), last=at(10, 59)), POLICY)
    again = decide(situation(at(11, 2, 40), last=at(10, 59), warned_leave_at=first.plan.leave_at,
                             warned_at=at(11, 2)), POLICY)
    assert first.action == "warn" and again.action == "stay"


# ----- speech recorded before but no time now --------------------------------------------------
def test_no_one_joined_only_applies_when_no_speech_was_ever_recorded() -> None:
    ever = decide(situation(at(10, 42), last=None, speech_ever=True), POLICY)
    assert ever.plan.reason is LeaveReason.SILENT and ever.action == "stay"
    assert decide(situation(at(10, 42), last=None), POLICY).plan.reason is LeaveReason.NO_ONE_JOINED


# ----- speech times from transcript segments ---------------------------------------------------
def test_last_speech_reads_absolute_epoch_and_relative_segment_times() -> None:
    now = at(11, 30)
    absolute = [(at(11, 3).timestamp(), at(11, 4, 54).timestamp(), "Thanks all")]
    assert last_speech_at(absolute, anchor=JOINED, now=now) == at(11, 4, 54)
    relative = [(10.0, 60.0, "Hello"), (1_000.0, 1_200.0, "Bye")]
    assert last_speech_at(relative, anchor=JOINED, now=now) == JOINED + timedelta(seconds=1_200)


def test_last_speech_ignores_blank_segments_and_clamps_future_times() -> None:
    now = at(11, 0)
    assert last_speech_at([(1.0, 2.0, "   ")], anchor=JOINED, now=now) is None
    future = [(at(11, 5).timestamp(), at(11, 6).timestamp(), "clock skew")]
    assert last_speech_at(future, anchor=JOINED, now=now) == now
    assert last_speech_at([(5.0, 9.0, "no anchor")], anchor=None, now=now) is None


# ----- Vexa's completion reasons ---------------------------------------------------------------
@pytest.mark.parametrize(("vexa", "reason", "ended_by"), [
    ("left_alone", LeaveReason.EVERYONE_LEFT, "vexa"),
    ("startup_alone", LeaveReason.NO_ONE_JOINED, "vexa"),
    ("evicted", LeaveReason.HOST_ENDED, "host"),
    ("max_bot_time_exceeded", LeaveReason.TIME_LIMIT, "vexa"),
    ("awaiting_admission_timeout", LeaveReason.NOT_ADMITTED, "vexa"),
    ("awaiting_admission_rejected", LeaveReason.NOT_ADMITTED, "host"),
    ("stopped", LeaveReason.USER_STOPPED, "user"),
    (None, LeaveReason.CAPTURE_ENDED, "vexa"),
    ("something_new", LeaveReason.CAPTURE_ENDED, "vexa"),
])
def test_vexa_completion_reasons_map_to_plain_end_reasons(vexa, reason, ended_by) -> None:
    assert reason_from_vexa(vexa) == (reason, ended_by)
