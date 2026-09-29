"""Workspace-isolated, per-account snapshots of discovered meeting events.

A moved event keeps its cache row (and so its row id): the row is re-keyed in place to the new
time, so briefings, prep inputs and prep uploads that reference the row stay attached.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .accounts import Actor
from .calendar_changes import first_moves
from .composio_calendar import CalendarEvent, CalendarError, CalendarInvitee, ComposioCalendar, calendar_date_window
from .database import CalendarEventCacheRow, CalendarSyncStateRow, Database, KnowledgeDocumentRow, MeetingPrepInputRow, MeetingPrepRow


class CalendarSyncRequest(BaseModel):
    connection_ids: list[str] = Field(default_factory=list, max_length=20)
    start_date: date
    end_date: date
    # Omitted: the signed-in person's effective time zone (manual choice, else their browser's).
    timezone: str | None = Field(default=None, max_length=100)


class CachedCalendarEvent(CalendarEvent):
    id: UUID
    synced_at: datetime
    # The start before the first detected move (only while the event is at another time now).
    rescheduled_from: datetime | None = None


CachedCalendarEvent.model_rebuild(_types_namespace={"CalendarInvitee": CalendarInvitee})


class CalendarSyncState(BaseModel):
    connection_id: str
    last_synced_at: datetime
    range_start: datetime
    range_end: datetime
    truncated: bool


class CachedCalendarResponse(BaseModel):
    events: list[CachedCalendarEvent]
    syncs: list[CalendarSyncState]


class CalendarSyncResponse(CachedCalendarResponse):
    errors: dict[str, str] = Field(default_factory=dict)


def _has_prep_work(session, event_row_id: str) -> bool:
    """A saved briefing, prep inputs or a prep upload still references this event."""
    return bool(session.execute(select(MeetingPrepRow.id).where(
        MeetingPrepRow.calendar_event_id == event_row_id,
    ).limit(1)).first() or session.get(MeetingPrepInputRow, event_row_id) or session.execute(
        select(KnowledgeDocumentRow.id).where(
            KnowledgeDocumentRow.scope == "prep", KnowledgeDocumentRow.scope_id == event_row_id,
        ).limit(1)).first())


logger = logging.getLogger(__name__)


def _utc(value: datetime) -> datetime:
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC)


class _NoChangeHook:
    async def cache_moved(self, *_args: Any, **_kwargs: Any) -> None:
        return None


@dataclass(frozen=True)
class CacheMove:
    """A synced event that the calendar now shows at another time; its row was re-keyed in place."""

    cache_event_id: str
    old_starts_at: datetime
    old_ends_at: datetime
    event: CalendarEvent


def _write_event(row: CalendarEventCacheRow, event: CalendarEvent, now: datetime) -> None:
    row.event_id = event.event_id
    row.starts_at = _utc(event.starts_at)
    row.ends_at = _utc(event.ends_at)
    row.payload = event.model_dump(mode="json")
    row.synced_at = now


def rekey_cache_row(session: Session, row: CalendarEventCacheRow, event: CalendarEvent,
                    now: datetime) -> CalendarEventCacheRow | None:
    """Move ``row`` to ``event``'s identity and time; returns the row that now holds the event.

    If a row already exists at the new time (a sync that ran before the move was noticed inserted
    it), the one that carries prep work survives; with prep work on both, nothing changes (None).
    """
    other = session.execute(select(CalendarEventCacheRow).where(
        CalendarEventCacheRow.organization_id == row.organization_id,
        CalendarEventCacheRow.user_id == row.user_id,
        CalendarEventCacheRow.connection_id == row.connection_id,
        CalendarEventCacheRow.event_id == event.event_id,
        CalendarEventCacheRow.starts_at == _utc(event.starts_at),
        CalendarEventCacheRow.id != row.id,
    )).scalars().first()
    if other is not None:
        ours, theirs = _has_prep_work(session, row.id), _has_prep_work(session, other.id)
        if ours and theirs:
            return None
        if theirs:
            session.delete(row)
            _write_event(other, event, now)
            return other
        session.delete(other)
        session.flush()
    _write_event(row, event, now)
    return row


def rekey_moved_rows(session: Session, organization_id: str, user_id: str, connection_id: str,
                     events: list[CalendarEvent], now: datetime) -> list[CacheMove]:
    """Re-key cached rows whose event (matched by exact id) now starts at another time.

    Ids listed more than once (a series under one id) or cached more than once are left to the
    exact (id, start) matching so two occurrences are never confused.
    """
    fetched: dict[str, list[CalendarEvent]] = {}
    for event in events:
        fetched.setdefault(event.event_id, []).append(event)
    if not fetched:
        return []
    rows = session.execute(select(CalendarEventCacheRow).where(
        CalendarEventCacheRow.organization_id == organization_id,
        CalendarEventCacheRow.user_id == user_id,
        CalendarEventCacheRow.connection_id == connection_id,
        CalendarEventCacheRow.event_id.in_(list(fetched)),
    )).scalars().all()
    cached: dict[str, list[CalendarEventCacheRow]] = {}
    for row in rows:
        cached.setdefault(row.event_id, []).append(row)
    moves: list[CacheMove] = []
    for event_id, candidates in fetched.items():
        known = cached.get(event_id, [])
        if len(candidates) != 1 or len(known) != 1 or _utc(known[0].starts_at) == _utc(candidates[0].starts_at):
            continue
        row, event = known[0], candidates[0]
        old_start, old_end = _utc(row.starts_at), _utc(row.ends_at)
        target = rekey_cache_row(session, row, event, now)
        if target is not None:
            moves.append(CacheMove(target.id, old_start, old_end, event))
    return moves


class CalendarCacheService:
    # Receives re-keyed (moved) events after a manual sync; set to the calendar watcher in create_app.
    changes: Any = _NoChangeHook()

    def __init__(self, database: Database, calendar: ComposioCalendar) -> None:
        self.database = database
        self.calendar = calendar

    @staticmethod
    def _public(row: CalendarEventCacheRow, moved_from: dict[str, datetime]) -> CachedCalendarEvent:
        original = moved_from.get(row.id)
        if original is not None and original == _utc(row.starts_at):
            original = None
        return CachedCalendarEvent(**row.payload, id=UUID(row.id), synced_at=row.synced_at, rescheduled_from=original)

    def list(self, actor: Actor, first: date, last: date, timezone: str) -> CachedCalendarResponse:
        start, end = calendar_date_window(first, last, timezone)
        with self.database.session_factory() as session:
            # Events are shown only for accounts that are still connected. A
            # disconnected account's sync state is removed, so its leftover rows
            # (kept only when a saved briefing references them) stay hidden here.
            connected = select(CalendarSyncStateRow.connection_id).where(
                CalendarSyncStateRow.organization_id == str(actor.organization_id),
                CalendarSyncStateRow.user_id == str(actor.user_id),
            )
            rows = session.execute(select(CalendarEventCacheRow).where(
                CalendarEventCacheRow.organization_id == str(actor.organization_id),
                CalendarEventCacheRow.user_id == str(actor.user_id),
                CalendarEventCacheRow.connection_id.in_(connected),
                CalendarEventCacheRow.starts_at >= start.astimezone(UTC),
                CalendarEventCacheRow.starts_at < end.astimezone(UTC),
            ).order_by(CalendarEventCacheRow.starts_at, CalendarEventCacheRow.provider)).scalars().all()
            syncs = session.execute(select(CalendarSyncStateRow).where(
                CalendarSyncStateRow.organization_id == str(actor.organization_id),
                CalendarSyncStateRow.user_id == str(actor.user_id),
            )).scalars().all()
            moved_from = first_moves(session, str(actor.organization_id), cache_event_ids=[row.id for row in rows])
            return CachedCalendarResponse(
                events=[self._public(row, moved_from) for row in rows],
                syncs=[CalendarSyncState(
                    connection_id=row.connection_id, last_synced_at=row.last_synced_at,
                    range_start=row.range_start, range_end=row.range_end, truncated=row.truncated,
                ) for row in syncs],
            )

    def get_event(self, actor: Actor, event_id: UUID) -> CachedCalendarEvent:
        with self.database.session_factory() as session:
            row = session.get(CalendarEventCacheRow, str(event_id))
            if row is None or row.organization_id != str(actor.organization_id) or row.user_id != str(actor.user_id):
                raise CalendarError("saved calendar event not found")
            return self._public(row, first_moves(session, str(actor.organization_id), cache_event_ids=[row.id]))

    def get_row(self, actor: Actor, event_id: UUID) -> CalendarEventCacheRow:
        """The actor's own cached row (organization and user checked) or CalendarError."""
        with self.database.session_factory() as session:
            row = session.get(CalendarEventCacheRow, str(event_id))
            if row is None or row.organization_id != str(actor.organization_id) or row.user_id != str(actor.user_id):
                raise CalendarError("saved calendar event not found")
            return row

    def forget_connection(self, actor: Actor, connection_id: str) -> int:
        """Drop a disconnected account's cached events and sync state; returns rows removed.

        Events that a saved briefing, prep inputs or prep upload still reference are
        kept (so the briefing stays readable) but no longer listed in the calendar.
        """
        removed = 0
        with self.database.session_factory.begin() as session:
            rows = session.execute(select(CalendarEventCacheRow).where(
                CalendarEventCacheRow.organization_id == str(actor.organization_id),
                CalendarEventCacheRow.user_id == str(actor.user_id),
                CalendarEventCacheRow.connection_id == connection_id,
            )).scalars().all()
            for row in rows:
                if not _has_prep_work(session, row.id):
                    session.delete(row)
                    removed += 1
            state = session.get(CalendarSyncStateRow, (str(actor.organization_id), str(actor.user_id), connection_id))
            if state is not None:
                session.delete(state)
        return removed

    def forget_missing_connections(self, actor: Actor, active_ids: set[str]) -> int:
        with self.database.session_factory() as session:
            cached = set(session.execute(select(CalendarSyncStateRow.connection_id).where(
                CalendarSyncStateRow.organization_id == str(actor.organization_id),
                CalendarSyncStateRow.user_id == str(actor.user_id),
            )).scalars()) | set(session.execute(select(CalendarEventCacheRow.connection_id).where(
                CalendarEventCacheRow.organization_id == str(actor.organization_id),
                CalendarEventCacheRow.user_id == str(actor.user_id),
            ).distinct()).scalars())
        return sum(self.forget_connection(actor, connection_id) for connection_id in cached - active_ids)

    async def _announce_moves(self, actor: Actor, connection_id: str, moves: list[CacheMove]) -> None:
        try:
            await self.changes.cache_moved(str(actor.organization_id), str(actor.user_id), connection_id,
                                           moves[0].event.provider, moves, source="sync")
        except Exception:  # recording the history must never fail the sync itself
            logger.exception("could not record moved calendar events after a sync")

    async def sync(self, actor: Actor, request: CalendarSyncRequest) -> CalendarSyncResponse:
        timezone = request.timezone or "UTC"
        start, end = calendar_date_window(request.start_date, request.end_date, timezone)
        connections = {item.id: item for item in await self.calendar.connections(actor) if item.status == "ACTIVE"}
        selected = list(dict.fromkeys(request.connection_ids)) if request.connection_ids else list(connections)
        # Accounts disconnected elsewhere (Composio dashboard, expiry) must not
        # leave their meetings behind in the calendar.
        self.forget_missing_connections(actor, set(connections))
        if not selected:
            raise CalendarError("connect an account before syncing events")
        if any(item not in connections for item in selected):
            raise CalendarError("select only active calendar accounts connected to your user")
        errors: dict[str, str] = {}
        for connection_id in selected:
            try:
                found = await self.calendar.events_for_window(actor, connection_id, start, end, timezone)
            except CalendarError as exc:
                errors[connection_id] = str(exc)
                continue
            now = datetime.now(UTC)
            with self.database.session_factory.begin() as session:
                # A moved event keeps its row (and every briefing that points at it).
                moves = rekey_moved_rows(session, str(actor.organization_id), str(actor.user_id),
                                         connection_id, found.events, now)
                session.flush()
                previous = session.execute(select(CalendarEventCacheRow).where(
                    CalendarEventCacheRow.organization_id == str(actor.organization_id),
                    CalendarEventCacheRow.user_id == str(actor.user_id),
                    CalendarEventCacheRow.connection_id == connection_id,
                    CalendarEventCacheRow.starts_at >= start.astimezone(UTC),
                    CalendarEventCacheRow.starts_at < end.astimezone(UTC),
                )).scalars().all()
                existing = {(row.event_id, row.starts_at.astimezone(UTC) if row.starts_at.tzinfo else row.starts_at.replace(tzinfo=UTC)): row for row in previous}
                seen: set[tuple[str, datetime]] = set()
                for event in found.events:
                    key = (event.event_id, event.starts_at.astimezone(UTC))
                    seen.add(key)
                    row = existing.get(key)
                    if row is None:
                        row = CalendarEventCacheRow(
                            id=str(uuid4()), organization_id=str(actor.organization_id), user_id=str(actor.user_id),
                            connection_id=connection_id, provider=event.provider, event_id=event.event_id,
                            starts_at=key[1], ends_at=event.ends_at.astimezone(UTC),
                            payload=event.model_dump(mode="json"), synced_at=now,
                        )
                        session.add(row)
                    else:
                        row.ends_at = event.ends_at.astimezone(UTC)
                        row.payload = event.model_dump(mode="json")
                        row.synced_at = now
                # A capped provider response is not a full snapshot. Preserve
                # unseen events until a complete scan can establish deletion.
                if not found.truncated:
                    for key, row in existing.items():
                        if key not in seen:
                            # Keep a prepared meeting's event identity so its
                            # saved briefing is still readable after removal
                            # from the upstream calendar.
                            if not _has_prep_work(session, row.id):
                                session.delete(row)
                sync_key = (str(actor.organization_id), str(actor.user_id), connection_id)
                state = session.get(CalendarSyncStateRow, sync_key)
                if state is None:
                    state = CalendarSyncStateRow(organization_id=sync_key[0], user_id=sync_key[1], connection_id=connection_id,
                        last_synced_at=now, range_start=start.astimezone(UTC), range_end=end.astimezone(UTC), truncated=found.truncated)
                    session.add(state)
                else:
                    state.last_synced_at = now
                    state.range_start = start.astimezone(UTC)
                    state.range_end = end.astimezone(UTC)
                    state.truncated = found.truncated
            if moves:
                await self._announce_moves(actor, connection_id, moves)
        snapshot = self.list(actor, request.start_date, request.end_date, timezone)
        return CalendarSyncResponse(**snapshot.model_dump(), errors=errors)
