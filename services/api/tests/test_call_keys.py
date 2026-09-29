"""Same-call keys: one key per real call, whatever link variant a calendar or a person pasted."""

from datetime import UTC, datetime, timedelta

import pytest

from app.call_keys import call_key, call_key_for_url, windows_overlap

T0 = datetime(2026, 10, 6, 15, tzinfo=UTC)


@pytest.mark.parametrize("left, right", [
    ("https://meet.google.com/abc-defg-hij", "https://meet.google.com/ABC-DEFG-HIJ?authuser=1&hs=122"),
    ("https://meet.google.com/abc-defg-hij", "https://meet.google.com/lookup/abc-defg-hij/"),
    ("https://zoom.us/j/81234567890", "https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123.1"),
    ("https://zoom.us/j/81234567890", "https://zoom.us/wc/join/81234567890#success"),
    ("https://zoom.us/j/81234567890?pwd=one", "https://acme.zoom.us/j/81234567890?pwd=two"),
    ("https://teams.microsoft.com/l/meetup-join/19%3ameeting_NTg0ZWQ5@thread.v2/0?context=%7b%22Tid%22%3a%22a%22%7d",
     "https://teams.microsoft.com/l/meetup-join/19%3AMeeting_NTg0ZWQ5%40Thread.V2/0?context=other"),
    ("https://teams.microsoft.com/meet/2468013579?p=AbCd", "https://teams.microsoft.com/meet/2468013579?p=XyZ"),
    ("https://meet.jit.si/NorthwindStandup", "https://meet.jit.si/northwindstandup"),
])
def test_link_variants_of_one_call_share_a_key(left: str, right: str) -> None:
    assert call_key_for_url(left) is not None
    assert call_key_for_url(left) == call_key_for_url(right)


@pytest.mark.parametrize("left, right", [
    ("https://meet.google.com/abc-defg-hij", "https://meet.google.com/abc-defg-hik"),
    ("https://zoom.us/j/81234567890", "https://zoom.us/j/81234567891"),
    # Teams thread ids are case-sensitive tokens; only the fixed prefix/suffix are normalized.
    ("https://teams.microsoft.com/l/meetup-join/19%3ameeting_NTg0ZWQ5@thread.v2/0",
     "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ntg0zwq5@thread.v2/0"),
])
def test_different_calls_never_share_a_key(left: str, right: str) -> None:
    assert call_key_for_url(left) != call_key_for_url(right)


def test_platforms_never_collide_and_unsupported_links_have_no_key() -> None:
    assert call_key("zoom", "123456789") != call_key("teams", "123456789")
    assert call_key_for_url("https://example.com/j/81234567890") is None
    assert call_key_for_url("not a link") is None
    assert call_key("google_meet", " ABC-DEFG-HIJ ") == "google_meet:abc-defg-hij"
    assert call_key("zoom", "812 3456 7890") == "zoom:81234567890"


def test_overlap_window_uses_a_small_grace_and_separates_recurring_occurrences() -> None:
    hour = timedelta(hours=1)
    assert windows_overlap((T0, T0 + hour), (T0 + timedelta(minutes=30), T0 + 2 * hour))
    # Back-to-back or a few minutes apart still counts (clocks and calendars disagree slightly).
    assert windows_overlap((T0, T0 + hour), (T0 + hour + timedelta(minutes=4), T0 + 2 * hour))
    # Next week's occurrence of the same recurring link is a different call.
    assert not windows_overlap((T0, T0 + hour), (T0 + timedelta(days=7), T0 + timedelta(days=7) + hour))
    assert not windows_overlap((T0, T0 + hour), (T0 + 2 * hour, T0 + 3 * hour))
    naive = datetime(2026, 10, 6, 15, 10)
    assert windows_overlap((T0, T0 + hour), (naive, naive + hour))
