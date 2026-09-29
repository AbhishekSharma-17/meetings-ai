"""Apply a reconciliation to what the product stores, then tell people. No calendar calls here.

Every write is conditional on the snapshot the decision was made from (status still pending, same
event id and start), so two API processes, or the watcher racing a manual sync, apply a change
once. Notifications carry stable dedupe keys, so a repeated check never repeats a message.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from meetings_contracts import MeetingPlatform
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .calendar_cache import CacheMove, rekey_cache_row
from .calendar_changes import ChangeRecord, ChangeSource, record_change
from .calendar_reconcile import Reconciliation, StoredEvent
from .composio_calendar import CalendarEvent, provider_name
from .database import (
    CalendarEventCacheRow,
    CalendarScheduleRow,
    Database,
    MeetingRow,
    MeetingSourceRow,
    MeetingTenantRow,
)
from .meeting_links import parse_meeting_url
from .notification_events import NO_EVENTS

logger = logging.getLogger(__name__)
ATTENTION_PREFIX = "Couldn't re-check"
_PLATFORM_NAME = {MeetingPlatform.GOOGLE_MEET: "Google Meet", MeetingPlatform.ZOOM: "Zoom",
                  MeetingPlatform.TEAMS: "Microsoft Teams", MeetingPlatform.JITSI: "Jitsi"}


def _utc(value: datetime) -> datetime:
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC)


def change_key(connection_id: str, event_id: str, suffix: str) -> str:
    """Stable notification dedupe key shared by the watcher and a manual sync."""
    digest = hashlib.sha256(f"{connection_id}\0{event_id}".encode()).hexdigest()[:24]
    return f"calendar-change:{digest}:{suffix}"


def _link_suffix(url: str) -> str:
    return "link:" + hashlib.sha256(url.strip().encode()).hexdigest()[:16]


@dataclass(frozen=True)
class WatchedSchedule:
    """A pending calendar-backed schedule and the snapshot it was made from."""

    meeting_id: str
    organization_id: str
    user_id: str
    title: str | None
    stored: StoredEvent
    raw_starts_at: datetime  # exactly as read, for the optimistic write condition


def _stored(row: CalendarScheduleRow, source: MeetingSourceRow | None, meeting_url: str | None) -> StoredEvent:
    emails = frozenset(
        str(person.get("email")).lower() for person in (source.invitees if source else []) or []
        if isinstance(person, dict) and person.get("email")
    )
    return StoredEvent(
        connection_id=row.connection_id, provider=row.provider, event_id=row.event_id,
        starts_at=_utc(row.starts_at), ends_at=_utc(row.ends_at),
        meeting_url=source.meeting_url if source else meeting_url,
        title=source.title if source else None, agenda=source.agenda if source else None, invitee_emails=emails,
    )


class CalendarChangeApplier:
    # Notification hooks (NotificationEvents); a no-op unless wired in create_app.
    events: Any = NO_EVENTS

    def __init__(self, database: Database) -> None:
        self.database = database

    # ----- reading ----------------------------------------------------------------------------
    def load(self, session: Session, row: CalendarScheduleRow) -> WatchedSchedule:
        source = session.get(MeetingSourceRow, row.meeting_id)
        meeting = session.get(MeetingRow, row.meeting_id)
        return WatchedSchedule(
            meeting_id=row.meeting_id, organization_id=row.organization_id, user_id=row.user_id,
            title=meeting.title if meeting and meeting.title else (source.title if source else None),
            stored=_stored(row, source, meeting.meeting_url if meeting else None), raw_starts_at=row.starts_at,
        )

    def schedule(self, meeting_id: str) -> WatchedSchedule | None:
        with self.database.session_factory() as session:
            row = session.get(CalendarScheduleRow, meeting_id)
            if row is None or row.status != "pending" or row.provider == "manual":
                return None
            return self.load(session, row)

    def pending_on_connection(self, organization_id: str, user_id: str, connection_id: str) -> dict[str, WatchedSchedule]:
        """Pending schedules of one person's connection, keyed by calendar event id."""
        with self.database.session_factory() as session:
            rows = session.execute(select(CalendarScheduleRow).where(
                CalendarScheduleRow.organization_id == organization_id,
                CalendarScheduleRow.user_id == user_id,
                CalendarScheduleRow.connection_id == connection_id,
                CalendarScheduleRow.status == "pending",
            )).scalars().all()
            return {row.event_id: self.load(session, row) for row in rows}

    def pending_for_event(self, organization_id: str, connection_id: str, event_id: str) -> WatchedSchedule | None:
        with self.database.session_factory() as session:
            row = session.execute(select(CalendarScheduleRow).where(
                CalendarScheduleRow.organization_id == organization_id,
                CalendarScheduleRow.connection_id == connection_id,
                CalendarScheduleRow.event_id == event_id,
                CalendarScheduleRow.status == "pending",
            )).scalars().first()
            return self.load(session, row) if row else None

    # ----- schedules ----------------------------------------------------------------------------
    def apply_schedule(self, schedule: WatchedSchedule, decision: Reconciliation, source: ChangeSource,
                       now: datetime | None = None) -> bool:
        """Returns True when something the person should know about changed."""
        now = now or datetime.now(UTC)
        if decision.kind == "unchanged":
            self.clear_attention(schedule)
            return False
        if decision.kind == "cancelled":
            return self._cancel(schedule, decision, source, now)
        if decision.kind == "updated" and decision.event is not None:
            return self._update(schedule, decision, decision.event, source, now)
        return False

    def _claim(self, session: Session, schedule: WatchedSchedule, values: dict[str, Any]) -> bool:
        result = session.execute(update(CalendarScheduleRow).where(
            CalendarScheduleRow.meeting_id == schedule.meeting_id,
            CalendarScheduleRow.organization_id == schedule.organization_id,
            CalendarScheduleRow.status == "pending",
            CalendarScheduleRow.event_id == schedule.stored.event_id,
            CalendarScheduleRow.starts_at == schedule.raw_starts_at,
        ).values(**values))
        return bool(result.rowcount)

    def _update(self, schedule: WatchedSchedule, decision: Reconciliation, event: CalendarEvent,
                source: ChangeSource, now: datetime) -> bool:
        stored = schedule.stored
        start_moved = _utc(event.starts_at) != stored.starts_at
        if start_moved and self._already_scheduled(schedule, event):
            # Another meeting already follows this event at its new time: never join it twice.
            return self._cancel(schedule, Reconciliation("cancelled", reason="rescheduled_elsewhere"), source, now)
        with self.database.session_factory.begin() as session:
            if not self._claim(session, schedule, {
                "starts_at": _utc(event.starts_at), "ends_at": _utc(event.ends_at), "event_id": event.event_id,
                "last_error": None, "updated_at": now,
            }):
                return False
            link_applied = self._update_link(session, schedule, event) if decision.link_changed else False
            self._update_source(session, schedule, event, now)
            cache_id = self._rekey_cache(session, schedule, event, now)
            base = dict(organization_id=schedule.organization_id, user_id=schedule.user_id,
                        connection_id=stored.connection_id, provider=stored.provider, event_id=event.event_id,
                        source=source, meeting_id=schedule.meeting_id, cache_event_id=cache_id)
            if decision.moved and start_moved:
                record_change(session, ChangeRecord(kind="moved", old_starts_at=stored.starts_at, new_starts_at=event.starts_at,
                                                    old_ends_at=stored.ends_at, new_ends_at=event.ends_at, **base), now)
            if decision.link_changed:
                record_change(session, ChangeRecord(kind="link_changed", old_meeting_url=stored.meeting_url,
                                                    new_meeting_url=event.meeting_url, **base), now)
        self._announce_update(schedule, decision, event, start_moved, link_applied)
        return start_moved or decision.link_changed

    def _already_scheduled(self, schedule: WatchedSchedule, event: CalendarEvent) -> bool:
        with self.database.session_factory() as session:
            return session.execute(select(CalendarScheduleRow.meeting_id).where(
                CalendarScheduleRow.organization_id == schedule.organization_id,
                CalendarScheduleRow.connection_id == schedule.stored.connection_id,
                CalendarScheduleRow.event_id == event.event_id,
                CalendarScheduleRow.starts_at == _utc(event.starts_at),
                CalendarScheduleRow.meeting_id != schedule.meeting_id,
                CalendarScheduleRow.status.in_(("pending", "joining", "joined")),
            ).limit(1)).first() is not None

    def _announce_update(self, schedule: WatchedSchedule, decision: Reconciliation, event: CalendarEvent,
                         start_moved: bool, link_applied: bool) -> None:
        stored = schedule.stored
        if decision.moved and start_moved:
            self.events.calendar_event_moved(
                schedule.organization_id, meeting_id=schedule.meeting_id, title=schedule.title or event.title,
                old_start=stored.starts_at, new_start=event.starts_at,
                dedupe_key=change_key(stored.connection_id, event.event_id, _utc(event.starts_at).isoformat()))
        if decision.link_changed:
            parsed = parse_meeting_url(event.meeting_url)
            self.events.calendar_link_changed(
                schedule.organization_id, schedule.meeting_id, title=schedule.title or event.title,
                platform_name=_PLATFORM_NAME.get(parsed[0], "meeting") if parsed else "meeting", applied=link_applied,
                dedupe_key=change_key(stored.connection_id, event.event_id, _link_suffix(event.meeting_url)))

    @staticmethod
    def _update_link(session: Session, schedule: WatchedSchedule, event: CalendarEvent) -> bool:
        """Same validation as creating a meeting; never touches a meeting the assistant already joined."""
        parsed = parse_meeting_url(event.meeting_url)
        meeting = session.get(MeetingRow, schedule.meeting_id)
        owner = session.get(MeetingTenantRow, schedule.meeting_id)
        if parsed is None or meeting is None or owner is None or owner.organization_id != schedule.organization_id:
            return False
        if meeting.status != "created":
            return False
        meeting.meeting_url = event.meeting_url
        meeting.platform = parsed[0].value
        meeting.native_meeting_id = parsed[1]
        meeting.updated_at = datetime.now(UTC)
        return True

    @staticmethod
    def _update_source(session: Session, schedule: WatchedSchedule, event: CalendarEvent, now: datetime) -> None:
        row = session.get(MeetingSourceRow, schedule.meeting_id)
        if row is None or row.organization_id != schedule.organization_id:
            return
        row.event_id = event.event_id
        row.title = event.title
        row.starts_at = _utc(event.starts_at)
        row.ends_at = _utc(event.ends_at)
        row.meeting_url = event.meeting_url
        row.platform = event.platform
        row.agenda = event.agenda if event.agenda is not None else row.agenda
        if event.invitees:
            row.invitees = [person.model_dump() for person in event.invitees]
        row.saved_at = now

    @staticmethod
    def _rekey_cache(session: Session, schedule: WatchedSchedule, event: CalendarEvent, now: datetime) -> str | None:
        stored = schedule.stored
        rows = session.execute(select(CalendarEventCacheRow).where(
            CalendarEventCacheRow.organization_id == schedule.organization_id,
            CalendarEventCacheRow.user_id == schedule.user_id,
            CalendarEventCacheRow.connection_id == stored.connection_id,
            CalendarEventCacheRow.event_id == stored.event_id,
        )).scalars().all()
        exact = [row for row in rows if _utc(row.starts_at) == stored.starts_at]
        row = exact[0] if exact else rows[0] if len(rows) == 1 else None
        if row is None:
            return None
        target = rekey_cache_row(session, row, event, now)
        return target.id if target is not None else row.id

    def _cancel(self, schedule: WatchedSchedule, decision: Reconciliation, source: ChangeSource, now: datetime) -> bool:
        stored = schedule.stored
        name = provider_name(stored.provider)
        message = {
            "link_removed": f"The event in {name} no longer has a supported meeting link",
            "rescheduled_elsewhere": f"Rescheduled in {name} to a time that wasn't found in the next 90 days",
        }.get(decision.reason or "", f"Cancelled in {name}")
        with self.database.session_factory.begin() as session:
            if not self._claim(session, schedule, {"status": "cancelled", "last_error": message, "updated_at": now}):
                return False
            cache = session.execute(select(CalendarEventCacheRow.id).where(
                CalendarEventCacheRow.organization_id == schedule.organization_id,
                CalendarEventCacheRow.user_id == schedule.user_id,
                CalendarEventCacheRow.connection_id == stored.connection_id,
                CalendarEventCacheRow.event_id == stored.event_id,
            )).scalars().first()
            record_change(session, ChangeRecord(
                organization_id=schedule.organization_id, user_id=schedule.user_id,
                connection_id=stored.connection_id, provider=stored.provider, event_id=stored.event_id,
                kind="cancelled", source=source, meeting_id=schedule.meeting_id, cache_event_id=cache,
                old_starts_at=stored.starts_at, old_ends_at=stored.ends_at, old_meeting_url=stored.meeting_url,
            ), now)
        self.events.calendar_event_cancelled(
            schedule.organization_id, schedule.meeting_id, title=schedule.title, provider_name=name,
            reason=decision.reason, dedupe_key=change_key(stored.connection_id, stored.event_id, "cancelled"))
        return True

    # ----- attention ----------------------------------------------------------------------------
    def mark_attention(self, schedule: WatchedSchedule, *, owner_left: bool, now: datetime | None = None) -> None:
        """Keep the join (at the stored time) but say the calendar can't be re-checked; once a day."""
        now = now or datetime.now(UTC)
        name = provider_name(schedule.stored.provider)
        message = (f"{ATTENTION_PREFIX} with {name}: the person who scheduled it left this workspace" if owner_left
                   else f"{ATTENTION_PREFIX} with {name}: reconnect the calendar")
        with self.database.session_factory.begin() as session:
            session.execute(update(CalendarScheduleRow).where(
                CalendarScheduleRow.meeting_id == schedule.meeting_id, CalendarScheduleRow.status == "pending",
            ).values(last_error=message))
        self.events.calendar_check_failed(
            schedule.organization_id, schedule.meeting_id, title=schedule.title, provider_name=name,
            starts_at=schedule.stored.starts_at, owner_left=owner_left,
            dedupe_key=f"calendar-watch:{schedule.meeting_id}:attention:{now.date().isoformat()}")

    def clear_attention(self, schedule: WatchedSchedule) -> None:
        with self.database.session_factory.begin() as session:
            session.execute(update(CalendarScheduleRow).where(
                CalendarScheduleRow.meeting_id == schedule.meeting_id, CalendarScheduleRow.status == "pending",
                CalendarScheduleRow.last_error.like(f"{ATTENTION_PREFIX}%"),
            ).values(last_error=None))

    # ----- synced (cache) events ----------------------------------------------------------------
    def record_cache_moves(self, organization_id: str, user_id: str, connection_id: str, provider: str,
                           moves: list[CacheMove], source: ChangeSource, now: datetime | None = None) -> int:
        """History + a note to the calendar owner for moved synced events without a pending schedule."""
        now = now or datetime.now(UTC)
        announced = 0
        for move in moves:
            event = move.event
            with self.database.session_factory.begin() as session:
                record_change(session, ChangeRecord(
                    organization_id=organization_id, user_id=user_id, connection_id=connection_id, provider=provider,
                    event_id=event.event_id, kind="moved", source=source, cache_event_id=move.cache_event_id,
                    old_starts_at=move.old_starts_at, new_starts_at=event.starts_at,
                    old_ends_at=move.old_ends_at, new_ends_at=event.ends_at,
                ), now)
            announced += self.events.calendar_event_moved(
                organization_id, title=event.title, old_start=move.old_starts_at, new_start=event.starts_at,
                owner_id=user_id, cache_event_id=move.cache_event_id,
                dedupe_key=change_key(connection_id, event.event_id, _utc(event.starts_at).isoformat())) or 0
        return announced
