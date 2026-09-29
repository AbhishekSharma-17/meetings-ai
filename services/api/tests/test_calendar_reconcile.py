"""Pure reconciliation of a stored calendar snapshot with what the calendar says now."""

from datetime import UTC, datetime, timedelta

from app.calendar_reconcile import CalendarLookup, StoredEvent, reconcile
from app.composio_calendar import CalendarEvent

START = datetime(2026, 9, 29, 15, 0, tzinfo=UTC)


def _stored(**overrides) -> StoredEvent:
    values = dict(
        connection_id="ca-1", provider="googlecalendar", event_id="evt-1", starts_at=START,
        ends_at=START + timedelta(hours=1), meeting_url="https://meet.google.com/abc-defg-hij",
        title="Customer call", invitee_emails=frozenset({"asha@example.test"}),
    )
    values.update(overrides)
    return StoredEvent(**values)


def _event(event_id: str = "evt-1", *, start: datetime = START, minutes: int = 60,
           url: str = "https://meet.google.com/abc-defg-hij", title: str = "Customer call",
           provider: str = "googlecalendar", emails: tuple[str, ...] = ("asha@example.test",)) -> CalendarEvent:
    platform = "zoom" if "zoom" in url else "google_meet"
    return CalendarEvent(
        connection_id="ca-1", provider=provider, event_id=event_id, title=title, starts_at=start,
        ends_at=start + timedelta(minutes=minutes), meeting_url=url, platform=platform,
        invitees=[{"name": email, "email": email} for email in emails],
    )


def test_no_change_is_unchanged_and_idempotent() -> None:
    lookup = CalendarLookup(events=(_event(),))
    first = reconcile(_stored(), lookup)
    assert first.kind == "unchanged"
    assert reconcile(_stored(), lookup) == first


def test_same_instant_in_another_zone_is_not_a_move() -> None:
    local = START.astimezone(__import__("zoneinfo").ZoneInfo("Asia/Kolkata"))
    assert reconcile(_stored(), CalendarLookup(events=(_event(start=local),))).kind == "unchanged"


def test_moved_event_reports_new_times() -> None:
    later = START + timedelta(days=1, hours=2)
    result = reconcile(_stored(), CalendarLookup(events=(_event(start=later, minutes=30),)))
    assert result.kind == "updated"
    assert result.moved and not result.link_changed
    assert result.event is not None and result.event.starts_at == later
    assert result.event.ends_at == later + timedelta(minutes=30)


def test_end_only_change_counts_as_moved() -> None:
    result = reconcile(_stored(), CalendarLookup(events=(_event(minutes=90),)))
    assert result.kind == "updated" and result.moved


def test_moved_into_the_past_is_still_a_move() -> None:
    earlier = START - timedelta(days=3)
    result = reconcile(_stored(), CalendarLookup(events=(_event(start=earlier),)))
    assert result.moved and result.event is not None and result.event.starts_at == earlier


def test_link_change_is_detected_without_a_move() -> None:
    result = reconcile(_stored(), CalendarLookup(events=(_event(url="https://zoom.us/j/12345678901"),)))
    assert result.kind == "updated"
    assert result.link_changed and not result.moved


def test_title_only_change_is_a_silent_update() -> None:
    result = reconcile(_stored(), CalendarLookup(events=(_event(title="Customer call (v2)"),)))
    assert result.kind == "updated"
    assert not result.moved and not result.link_changed


def test_confirmed_cancellation() -> None:
    result = reconcile(_stored(), CalendarLookup(cancelled_ids=frozenset({"evt-1"})))
    assert result.kind == "cancelled" and result.reason == "cancelled"


def test_absent_from_a_complete_wide_window_is_cancelled() -> None:
    result = reconcile(_stored(), CalendarLookup(events=(_event("other"),), complete=True))
    assert result.kind == "cancelled" and result.reason == "removed"


def test_absent_but_truncated_lookup_is_a_no_op() -> None:
    assert reconcile(_stored(), CalendarLookup(events=(_event("other"),), complete=False)).kind == "unknown"


def test_event_without_a_supported_link_any_more_stops_the_join() -> None:
    result = reconcile(_stored(), CalendarLookup(skipped_ids=frozenset({"evt-1"})))
    assert result.kind == "cancelled" and result.reason == "link_removed"


def test_recurring_instances_match_only_the_exact_instance_id() -> None:
    stored = _stored(event_id="series_20260929T150000Z")
    next_week = _event("series_20261006T150000Z", start=START + timedelta(days=7))
    # The instance itself is gone: another instance of the same series is never mistaken for it.
    assert reconcile(stored, CalendarLookup(events=(next_week,))).kind == "unknown"
    moved = _event("series_20260929T150000Z", start=START + timedelta(hours=1))
    result = reconcile(stored, CalendarLookup(events=(next_week, moved)))
    assert result.moved and result.event is not None and result.event.event_id == "series_20260929T150000Z"


def test_same_id_listed_twice_prefers_the_stored_start() -> None:
    result = reconcile(_stored(), CalendarLookup(events=(_event(start=START + timedelta(days=7)), _event())))
    assert result.kind == "unchanged"


def _calendly(**overrides) -> StoredEvent:
    values = dict(provider="calendly", event_id="https://api.calendly.com/scheduled_events/old", title="Discovery",
                  invitee_emails=frozenset({"guest@example.test"}))
    return _stored(**{**values, **overrides})


def _booking(uuid: str, *, days: int = 2, title: str = "Discovery", emails: tuple[str, ...] = ("guest@example.test",)):
    return _event(f"https://api.calendly.com/scheduled_events/{uuid}", start=START + timedelta(days=days),
                  title=title, provider="calendly", emails=emails)


def test_calendly_invitee_reschedule_points_at_the_new_booking() -> None:
    new = _booking("new")
    result = reconcile(_calendly(), CalendarLookup(events=(new,), replacement_id=new.event_id, rescheduled=True))
    assert result.kind == "updated" and result.moved and result.event_id_changed
    assert result.event is not None and result.event.event_id == new.event_id


def test_calendly_rescheduled_to_a_booking_outside_the_window_stops_the_old_join() -> None:
    result = reconcile(_calendly(), CalendarLookup(replacement_id="https://api.calendly.com/scheduled_events/far",
                                                   rescheduled=True, complete=True))
    assert result.kind == "cancelled" and result.reason == "rescheduled_elsewhere"


def test_calendly_plain_cancellation() -> None:
    result = reconcile(_calendly(), CalendarLookup(events=(_booking("new"),), rescheduled=False))
    assert result.kind == "cancelled" and result.reason == "cancelled"


def test_calendly_heuristic_same_type_and_invitees_is_a_move() -> None:
    result = reconcile(_calendly(), CalendarLookup(events=(_booking("new"), _booking("other", title="Intro")), complete=True))
    assert result.moved and result.event_id_changed
    assert result.event is not None and result.event.event_id.endswith("/new")


def test_calendly_heuristic_ignores_claimed_far_or_different_bookings() -> None:
    claimed = _booking("claimed")
    far = _booking("far", days=90)
    stranger = _booking("stranger", emails=("someone@example.test",))
    lookup = CalendarLookup(events=(claimed, far, stranger), complete=True, claimed_ids=frozenset({claimed.event_id}))
    result = reconcile(_calendly(), lookup)
    assert result.kind == "cancelled" and result.reason == "removed"


def test_calendly_heuristic_with_two_candidates_does_nothing() -> None:
    lookup = CalendarLookup(events=(_booking("a"), _booking("b", days=3)), complete=True)
    assert reconcile(_calendly(), lookup).kind == "unknown"


def test_calendly_heuristic_needs_known_invitees() -> None:
    lookup = CalendarLookup(events=(_booking("new", emails=()),), complete=False)
    assert reconcile(_calendly(invitee_emails=frozenset()), lookup).kind == "unknown"


ZOOM = "https://zoom.us/j/123456789"


def _zoom_series(start: datetime) -> CalendarEvent:
    return _event("zoom-123", start=start, url=ZOOM, provider="zoom").model_copy(update={"series": True})


def test_a_skipped_zoom_occurrence_is_never_mistaken_for_a_move_or_a_cancellation() -> None:
    stored = _stored(provider="zoom", event_id="zoom-123", meeting_url=ZOOM)
    next_week = _zoom_series(START + timedelta(days=7))
    # Zoom lists a recurring meeting once, at its next occurrence: that proves nothing about ours.
    for lookup in (CalendarLookup(events=(next_week,)), CalendarLookup(events=(next_week,), complete=True)):
        assert reconcile(stored, lookup).kind == "unknown"


def test_a_same_day_change_to_a_zoom_occurrence_is_a_move() -> None:
    stored = _stored(provider="zoom", event_id="zoom-123", meeting_url=ZOOM)
    later_today = _zoom_series(START + timedelta(hours=2))
    result = reconcile(stored, CalendarLookup(events=(later_today, _zoom_series(START + timedelta(days=7)))))
    assert result.kind == "updated" and result.moved and result.event == later_today


def test_a_single_zoom_meeting_moved_a_week_is_still_a_move() -> None:
    stored = _stored(provider="zoom", event_id="zoom-9", meeting_url=ZOOM)
    moved = _event("zoom-9", start=START + timedelta(days=7), url=ZOOM, provider="zoom")
    assert reconcile(stored, CalendarLookup(events=(moved,), complete=True)).moved


def test_one_id_at_several_far_starts_is_ambiguous() -> None:
    result = reconcile(_stored(), CalendarLookup(events=(
        _event(start=START + timedelta(days=7)), _event(start=START + timedelta(days=14)))))
    assert result.kind == "unknown"
