"""Keep scheduled assistants and briefings attached when a calendar account is reconnected.

Reconnecting creates a new connected-account id and disconnecting removed the old one, so pending
schedules (and briefings kept on the old account's events) would be stranded: never re-checked for
moves, not shown as scheduled, and flagged "reconnect the calendar" forever. They are moved to the
same event on one of the person's connected accounts of the same provider: the same event id, or
the same meeting link starting within a minute (a different mailbox holds the same call under a
different id). No schema changes: rows are re-pointed in place.

Two entry points: ``after_sync`` (a calendar sync just stored an account's events) and
``relink_orphans`` (the watcher found a schedule whose account is gone, just before re-checking it).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .accounts import Actor
from .calendar_cache import _has_prep_work
from .calendar_watch_apply import ATTENTION_PREFIX, WatchedSchedule
from .composio_calendar import CalendarConnection, CalendarError, CalendarEvent
from .database import (
    CalendarEventCacheRow,
    CalendarEventChangeRow,
    CalendarScheduleRow,
    Database,
    KnowledgeChunkRow,
    KnowledgeDocumentRow,
    MeetingPrepInputRow,
    MeetingPrepRow,
    MeetingSourceRow,
)
from .meeting_links import parse_meeting_url

logger = logging.getLogger(__name__)
SAME_START = timedelta(seconds=60)
# Schedules this far past their start are the scheduler's to mark missed, not ours to move.
STALE_AFTER = timedelta(minutes=10)
ACTIVE_STATUSES = ("pending", "joining", "joined")


def _utc(value: datetime) -> datetime:
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC)


def _same_call(left: str | None, right: str | None) -> bool:
    parsed = parse_meeting_url(left or "")
    return parsed is not None and parsed == parse_meeting_url(right or "")


def match_event(event_id: str, starts_at: datetime, meeting_url: str | None,
                events: list[CalendarEvent]) -> CalendarEvent | None:
    """The event on another account that is this call, or None when it isn't there or is ambiguous.

    Same id first (the same mailbox reconnected; it may have moved meanwhile, which the watcher then
    reports as a move), else the same meeting link at the same time.
    """
    by_id = [event for event in events if event.event_id == event_id]
    if len(by_id) == 1:
        return by_id[0]
    timed = [event for event in by_id if abs(_utc(event.starts_at) - starts_at) <= SAME_START]
    if timed:
        return timed[0]
    by_link = [event for event in events
               if abs(_utc(event.starts_at) - starts_at) <= SAME_START and _same_call(meeting_url, event.meeting_url)]
    return by_link[0] if len(by_link) == 1 else None


class NoRelink:
    """Default hook: nothing to re-attach (tests and deployments without the service)."""

    def after_sync(self, *_args: Any, **_kwargs: Any) -> int:
        return 0

    async def relink_orphans(self, *_args: Any, **_kwargs: Any) -> set[str]:
        return set()


class CalendarRelinker:
    def __init__(self, database: Database, calendar: Any) -> None:
        self.database = database
        self.calendar = calendar

    # ----- after a sync ---------------------------------------------------------------------
    def after_sync(self, actor: Actor, connection: CalendarConnection, events: list[CalendarEvent],
                   active_ids: set[str], now: datetime | None = None) -> int:
        """Re-attach stranded schedules and briefings to ``connection``'s events; returns schedules moved."""
        now = now or datetime.now(UTC)
        organization_id, user_id = str(actor.organization_id), str(actor.user_id)
        moved = self._relink(organization_id, user_id, connection, events, active_ids | {connection.id}, now)
        self._rehome_prep(organization_id, user_id, connection, events, active_ids | {connection.id})
        return len(moved)

    # ----- from the watcher -----------------------------------------------------------------
    async def relink_orphans(self, actor: Actor, connection_id: str, schedules: list[WatchedSchedule],
                             connections: list[CalendarConnection], now: datetime | None = None) -> set[str]:
        """Look for ``schedules`` (whose account ``connection_id`` is gone) on the person's other
        active accounts of the same provider; returns the meeting ids moved."""
        now = now or datetime.now(UTC)
        if not schedules:
            return set()
        provider = schedules[0].stored.provider
        candidates = [item for item in connections
                      if item.status == "ACTIVE" and item.provider == provider and item.id != connection_id]
        active_ids = {item.id for item in connections if item.status == "ACTIVE"}
        moved: set[str] = set()
        for candidate in candidates:
            remaining = [schedule for schedule in schedules if schedule.meeting_id not in moved]
            if not remaining:
                break
            start = min(schedule.stored.starts_at for schedule in remaining) - timedelta(days=1)
            end = max(schedule.stored.ends_at for schedule in remaining) + timedelta(days=1)
            try:
                found = await self.calendar.events_for_window(actor, candidate.id, start, end, "UTC",
                                                              connection=candidate, enrich_invitees=False)
            except CalendarError as exc:
                logger.warning("could not look for stranded schedules on another %s account: %s", provider, exc)
                continue
            moved |= self._relink(str(actor.organization_id), str(actor.user_id), candidate, found.events,
                                  active_ids, now, only={schedule.meeting_id for schedule in remaining})
        return moved

    # ----- schedules ------------------------------------------------------------------------
    def _relink(self, organization_id: str, user_id: str, target: CalendarConnection, events: list[CalendarEvent],
                active_ids: set[str], now: datetime, only: set[str] | None = None) -> set[str]:
        if not events:
            return set()
        moved: set[str] = set()
        with self.database.session_factory.begin() as session:
            rows = session.execute(select(CalendarScheduleRow).where(
                CalendarScheduleRow.organization_id == organization_id,
                CalendarScheduleRow.user_id == user_id,
                CalendarScheduleRow.provider == target.provider,
                CalendarScheduleRow.status == "pending",
                CalendarScheduleRow.connection_id.not_in(active_ids),
                CalendarScheduleRow.starts_at > now - STALE_AFTER,
            )).scalars().all()
            for row in rows:
                if only is not None and row.meeting_id not in only:
                    continue
                source = session.get(MeetingSourceRow, row.meeting_id)
                event = match_event(row.event_id, _utc(row.starts_at), source.meeting_url if source else None, events)
                if event is not None and self._move(session, row, source, target, event, now):
                    moved.add(row.meeting_id)
        if moved:
            logger.info("re-attached %d scheduled assistant(s) to a reconnected %s account", len(moved), target.provider)
        return moved

    @staticmethod
    def _move(session: Session, row: CalendarScheduleRow, source: MeetingSourceRow | None,
              target: CalendarConnection, event: CalendarEvent, now: datetime) -> bool:
        duplicate = session.execute(select(CalendarScheduleRow).where(
            CalendarScheduleRow.organization_id == row.organization_id,
            CalendarScheduleRow.connection_id == target.id,
            CalendarScheduleRow.event_id == event.event_id,
            CalendarScheduleRow.meeting_id != row.meeting_id,
        )).scalars().all()
        starts = (_utc(row.starts_at), _utc(event.starts_at))
        if any(item.status in ACTIVE_STATUSES and any(abs(_utc(item.starts_at) - start) <= SAME_START for start in starts)
               for item in duplicate):
            # The person already scheduled this call again on the reconnected account: never join twice.
            row.status = "cancelled"
            row.last_error = "Replaced by the assistant scheduled on the reconnected calendar"
            row.updated_at = now
            return False
        if any(_utc(item.starts_at) == _utc(row.starts_at) for item in duplicate):
            return False  # an old finished record holds this exact slot; leave the schedule flagged
        row.connection_id = target.id
        row.event_id = event.event_id
        if row.last_error and row.last_error.startswith(ATTENTION_PREFIX):
            row.last_error = None
        row.updated_at = now
        if source is not None:
            source.connection_id = target.id
            source.event_id = event.event_id
        return True

    # ----- briefings --------------------------------------------------------------------------
    def _rehome_prep(self, organization_id: str, user_id: str, target: CalendarConnection,
                     events: list[CalendarEvent], active_ids: set[str]) -> int:
        """Briefings, prep inputs and prep uploads kept on a removed account's events follow the
        same event on ``target`` (unless that event already has prep work of its own)."""
        rehomed = 0
        with self.database.session_factory.begin() as session:
            stranded = session.execute(select(CalendarEventCacheRow).where(
                CalendarEventCacheRow.organization_id == organization_id,
                CalendarEventCacheRow.user_id == user_id,
                CalendarEventCacheRow.provider == target.provider,
                CalendarEventCacheRow.connection_id.not_in(active_ids),
            )).scalars().all()
            for old in stranded:
                payload = old.payload if isinstance(old.payload, dict) else {}
                event = match_event(old.event_id, _utc(old.starts_at), payload.get("meeting_url"), events)
                if event is None:
                    continue
                new = session.execute(select(CalendarEventCacheRow).where(
                    CalendarEventCacheRow.organization_id == organization_id,
                    CalendarEventCacheRow.user_id == user_id,
                    CalendarEventCacheRow.connection_id == target.id,
                    CalendarEventCacheRow.event_id == event.event_id,
                    CalendarEventCacheRow.starts_at == _utc(event.starts_at),
                )).scalar_one_or_none()
                if new is None or _has_prep_work(session, new.id):
                    continue
                _repoint(session, organization_id, old.id, new.id)
                session.delete(old)
                rehomed += 1
        return rehomed


def _repoint(session: Session, organization_id: str, old_id: str, new_id: str) -> None:
    session.execute(update(MeetingPrepRow).where(
        MeetingPrepRow.organization_id == organization_id, MeetingPrepRow.calendar_event_id == old_id,
    ).values(calendar_event_id=new_id))
    session.execute(update(MeetingPrepInputRow).where(
        MeetingPrepInputRow.organization_id == organization_id, MeetingPrepInputRow.calendar_event_id == old_id,
    ).values(calendar_event_id=new_id))
    for table in (KnowledgeDocumentRow, KnowledgeChunkRow):
        session.execute(update(table).where(
            table.organization_id == organization_id, table.scope == "prep", table.scope_id == old_id,
        ).values(scope_id=new_id))
    session.execute(update(CalendarEventChangeRow).where(
        CalendarEventChangeRow.organization_id == organization_id, CalendarEventChangeRow.cache_event_id == old_id,
    ).values(cache_event_id=new_id))
    session.flush()
