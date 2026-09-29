"""Compare what we stored about a calendar event with what the calendar says now. Pure: no I/O.

Matching is by exact event id within one connection. Google and Outlook keep an event's id (and
each recurring instance's own id) when it is moved, so "the same id at another time" is a move and a
*different* instance of a series is never mistaken for it. A Zoom recurring meeting is different: every
occurrence shares one id and Zoom lists only the next occurrence, so for a series (or any id listed at
several starts) only a same-day change counts as a move; anything else could be a skipped or a later
occurrence and is left alone (never moved, never cancelled).

Absence alone only proves cancellation when the caller says the lookup was ``complete`` (a wide,
untruncated window); a provider-confirmed cancellation (Google ``status == cancelled``) always does.

Calendly has no stable id across reschedules: rescheduling cancels the booking and creates a new
one. In order of confidence:
  1. the old booking's invitee says ``rescheduled`` and names the new booking → moved to it
     (or, if that booking is outside the window, the old join is stopped);
  2. the invitee record says cancelled without a reschedule → cancelled;
  3. otherwise a heuristic: exactly one other active booking with the same event-type name, the
     same (known, non-empty) invitee emails, starting within 60 days of the old start and not
     already followed by another schedule → moved to it; none and a complete lookup → cancelled;
     anything ambiguous → do nothing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal

from .composio_calendar import CalendarEvent

ReconcileKind = Literal["unchanged", "updated", "cancelled", "unknown"]
CancelReason = Literal["cancelled", "removed", "link_removed", "rescheduled_elsewhere"]
CALENDLY_MATCH_WINDOW = timedelta(days=60)
# How far one occurrence of a shared-id series may move and still be recognised as the same one.
SERIES_MOVE_TOLERANCE = timedelta(hours=12)


@dataclass(frozen=True)
class StoredEvent:
    """Our snapshot of one calendar event (a schedule's source or a synced cache row)."""

    connection_id: str
    provider: str
    event_id: str
    starts_at: datetime
    ends_at: datetime
    meeting_url: str | None = None
    title: str | None = None
    agenda: str | None = None
    invitee_emails: frozenset[str] = frozenset()


@dataclass(frozen=True)
class CalendarLookup:
    """What one connection's calendar says now, plus what the caller could prove about it."""

    events: tuple[CalendarEvent, ...] = ()
    complete: bool = False
    cancelled_ids: frozenset[str] = frozenset()
    skipped_ids: frozenset[str] = frozenset()
    replacement_id: str | None = None
    rescheduled: bool | None = None
    claimed_ids: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class Reconciliation:
    kind: ReconcileKind
    event: CalendarEvent | None = None
    moved: bool = False
    link_changed: bool = False
    event_id_changed: bool = False
    reason: CancelReason | None = None


UNKNOWN = Reconciliation("unknown")


def _utc(value: datetime) -> datetime:
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC).replace(microsecond=0)


def _emails(event: CalendarEvent) -> frozenset[str]:
    return frozenset(person.email.lower() for person in event.invitees if person.email)


def _same_link(left: str | None, right: str | None) -> bool:
    return (left or "").strip() == (right or "").strip()


def _same_id(stored: StoredEvent, events: tuple[CalendarEvent, ...]) -> Reconciliation | None:
    """The event under our id, or UNKNOWN when a shared-id series makes the answer ambiguous."""
    matches = [event for event in events if event.event_id == stored.event_id]
    if not matches:
        return None
    same = [event for event in matches if _utc(event.starts_at) == _utc(stored.starts_at)]
    if same:
        return compare(stored, same[0])
    if len(matches) == 1 and not matches[0].series:
        return compare(stored, matches[0])
    near = [event for event in matches if abs(_utc(event.starts_at) - _utc(stored.starts_at)) <= SERIES_MOVE_TOLERANCE]
    return compare(stored, near[0]) if len(near) == 1 else UNKNOWN


def compare(stored: StoredEvent, current: CalendarEvent, *, event_id_changed: bool = False) -> Reconciliation:
    moved = _utc(current.starts_at) != _utc(stored.starts_at) or _utc(current.ends_at) != _utc(stored.ends_at)
    link_changed = stored.meeting_url is not None and not _same_link(stored.meeting_url, current.meeting_url)
    details = (stored.title is not None and current.title != stored.title) or (
        stored.agenda is not None and current.agenda != stored.agenda) or (
        bool(current.invitees) and _emails(current) != stored.invitee_emails)
    if not (moved or link_changed or details or event_id_changed):
        return Reconciliation("unchanged", event=current)
    return Reconciliation("updated", event=current, moved=moved, link_changed=link_changed,
                          event_id_changed=event_id_changed)


def _calendly_candidates(stored: StoredEvent, lookup: CalendarLookup) -> list[CalendarEvent]:
    if not stored.invitee_emails or not stored.title:
        return []
    title = stored.title.casefold()
    return [
        event for event in lookup.events
        if event.event_id != stored.event_id and event.event_id not in lookup.claimed_ids
        and event.title.casefold() == title and _emails(event) == stored.invitee_emails
        and abs(_utc(event.starts_at) - _utc(stored.starts_at)) <= CALENDLY_MATCH_WINDOW
    ]


def _calendly(stored: StoredEvent, lookup: CalendarLookup) -> Reconciliation:
    if lookup.replacement_id:
        replacement = next((event for event in lookup.events if event.event_id == lookup.replacement_id), None)
        if replacement is not None:
            return compare(stored, replacement, event_id_changed=True)
        return Reconciliation("cancelled", reason="rescheduled_elsewhere")
    if lookup.rescheduled is False:
        return Reconciliation("cancelled", reason="cancelled")
    candidates = _calendly_candidates(stored, lookup)
    if len(candidates) == 1:
        return compare(stored, candidates[0], event_id_changed=True)
    if not candidates and lookup.complete:
        return Reconciliation("cancelled", reason="rescheduled_elsewhere" if lookup.rescheduled else "removed")
    return UNKNOWN


def reconcile(stored: StoredEvent, lookup: CalendarLookup) -> Reconciliation:
    found = _same_id(stored, lookup.events)
    if found is not None:
        return found
    if stored.event_id in lookup.cancelled_ids:
        return Reconciliation("cancelled", reason="cancelled")
    if stored.event_id in lookup.skipped_ids:
        return Reconciliation("cancelled", reason="link_removed")
    if stored.provider == "calendly":
        return _calendly(stored, lookup)
    return Reconciliation("cancelled", reason="removed") if lookup.complete else UNKNOWN
