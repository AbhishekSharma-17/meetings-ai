"""Same-call identity: which meeting records point at one real call.

A call is identified by its platform plus the platform's native meeting id (what
``parse_meeting_url`` extracts), normalized so link variants of one call agree: Meet codes
and Jitsi rooms are case-insensitive, Zoom ids are digits only (passcodes and vanity hosts
never matter), and Teams thread ids keep their case-sensitive token but not the fixed
``19:meeting_…@thread.v2`` wrapper's case. Recurring meetings reuse one link, so a call is
the key plus an overlapping time window.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

from .meeting_links import parse_meeting_url

# Calendars, manual schedules and send-now records disagree by a few minutes.
OVERLAP_GRACE = timedelta(minutes=5)
_TEAMS_THREAD = re.compile(r"^19:meeting_(.+)@thread\.v2$", re.IGNORECASE)

Window = tuple[datetime, datetime]


def call_key(platform: str, native_id: str) -> str:
    """``platform:normalized-id``; platforms never collide."""
    name = str(getattr(platform, "value", platform)).strip().lower()
    value = str(native_id or "").strip()
    if name in {"google_meet", "jitsi"}:
        value = value.lower()
    elif name == "zoom":
        value = re.sub(r"\D", "", value)
    elif name == "teams":
        thread = _TEAMS_THREAD.match(value)
        if thread:
            value = f"19:meeting_{thread.group(1)}@thread.v2"
    return f"{name}:{value}"


def call_key_for_url(url: str | None) -> str | None:
    parsed = parse_meeting_url(url or "") if url else None
    if parsed is None:
        return None
    platform, native_id = parsed
    return call_key(platform.value, native_id)


def _utc(value: datetime) -> datetime:
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC)


def windows_overlap(left: Window, right: Window, grace: timedelta = OVERLAP_GRACE) -> bool:
    """True when two [start, end] windows overlap, allowing ``grace`` either side."""
    left_start, left_end = _utc(left[0]), _utc(left[1])
    right_start, right_end = _utc(right[0]), _utc(right[1])
    return left_start < right_end + grace and right_start < left_end + grace
