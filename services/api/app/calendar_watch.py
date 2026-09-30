"""Polls connected calendars so scheduled joins and synced events follow reschedules.

Cadence (all env-configurable, see ``WatchSettings.from_env``):
- every pending, calendar-backed schedule is re-checked every 10 min, every 2 min once it starts
  within 2 h, and once more right before joining when the last check is older than 2 min (bounded
  by a few seconds: if the calendar is slow or down, the join happens at the stored time);
- every synced calendar (``calendar_sync_state``) is scanned every 15 min for the next 14 days so a
  moved event keeps its prep work and its owner hears about it.

Calls are grouped per connection: one list call (≤3 pages) per due connection per round. A
schedule that is not in that list costs a confirmation lookup (Google: a ``showDeleted`` list
around the old time; every provider: a wide, untruncated window proving absence; Calendly: the old
booking's invitees). Checks run as the schedule's owner, rebuilt with their current membership;
without it, or without an active connection, the schedule is flagged (and joins at the stored
time) instead of failing silently. Nothing runs when Composio isn't configured.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import select

from .accounts import Actor
from .calendar_cache import CacheMove, rekey_moved_rows
from .calendar_reconcile import (
    CALENDLY_MATCH_WINDOW, UNKNOWN, CalendarLookup, Reconciliation, StoredEvent, reconcile,
)
from .calendar_relink import NoRelink
from .calendar_watch_apply import CalendarChangeApplier, WatchedSchedule
from .composio_calendar import CalendarConnection, CalendarError, CalendarEventsResponse
from .database import (
    CalendarScheduleRow,
    CalendarSyncStateRow,
    Database,
    OrganizationMembershipRow,
    UserRow,
)

logger = logging.getLogger(__name__)
MISSED_AFTER = timedelta(minutes=10)
FAILURES_BEFORE_ATTENTION = 3
# Invitee lookups per missing Calendly booking (one Composio call each).
CALENDLY_ENRICH_LIMIT = 10
ConnectionKey = tuple[str, str, str]  # organization, user, connection


def _seconds(name: str, default: float, low: float, high: float) -> float:
    try:
        value = float(os.getenv(name, "") or default)
    except ValueError:
        return default
    return min(max(value, low), high)


def _utc(value: datetime) -> datetime:
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC)


@dataclass(frozen=True)
class WatchSettings:
    enabled: bool = True
    tick_seconds: float = 30
    interval: timedelta = timedelta(minutes=10)
    soon_interval: timedelta = timedelta(minutes=2)
    soon_window: timedelta = timedelta(hours=2)
    sync_interval: timedelta = timedelta(minutes=15)
    horizon: timedelta = timedelta(days=14)
    absence_horizon: timedelta = timedelta(days=90)
    prejoin_max_age: timedelta = timedelta(minutes=2)
    prejoin_timeout: float = 4.0
    connection_ttl: timedelta = timedelta(minutes=10)

    @classmethod
    def from_env(cls) -> WatchSettings:
        return cls(
            enabled=os.getenv("CALENDAR_WATCH_ENABLED", "1") != "0",
            tick_seconds=_seconds("CALENDAR_WATCH_TICK_SECONDS", 30, 5, 600),
            interval=timedelta(seconds=_seconds("CALENDAR_WATCH_INTERVAL_SECONDS", 600, 60, 86_400)),
            soon_interval=timedelta(seconds=_seconds("CALENDAR_WATCH_SOON_INTERVAL_SECONDS", 120, 30, 3_600)),
            soon_window=timedelta(seconds=_seconds("CALENDAR_WATCH_SOON_WINDOW_SECONDS", 7_200, 0, 86_400)),
            sync_interval=timedelta(seconds=_seconds("CALENDAR_WATCH_SYNC_INTERVAL_SECONDS", 900, 60, 86_400)),
            horizon=timedelta(days=_seconds("CALENDAR_WATCH_HORIZON_DAYS", 14, 1, 60)),
            prejoin_max_age=timedelta(seconds=_seconds("CALENDAR_WATCH_PREJOIN_MAX_AGE_SECONDS", 120, 0, 3_600)),
            prejoin_timeout=_seconds("CALENDAR_WATCH_PREJOIN_TIMEOUT_SECONDS", 4, 0.5, 15),
        )


class CalendarWatchService:
    # Moves schedules of a removed account to the same event on a reconnected one (calendar_relink).
    relinker: Any = NoRelink()

    def __init__(self, database: Database, calendar: Any, applier: CalendarChangeApplier,
                 settings: WatchSettings | None = None) -> None:
        self.database, self.calendar, self.applier = database, calendar, applier
        self.settings = settings or WatchSettings()
        self._checked: dict[str, datetime] = {}      # meeting id → last successful check
        self._attempted: dict[str, datetime] = {}    # meeting id → last attempt (drives the cadence)
        self._scanned: dict[ConnectionKey, datetime] = {}
        self._failures: dict[ConnectionKey, int] = {}
        self._connections: dict[tuple[str, str], tuple[datetime, list[CalendarConnection]]] = {}

    @property
    def enabled(self) -> bool:
        return self.settings.enabled and bool(getattr(self.calendar, "configured", False))

    def last_checked(self, meeting_id: UUID | str) -> datetime | None:
        return self._checked.get(str(meeting_id))

    # ----- loop -----------------------------------------------------------------------------
    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:
                logger.exception("calendar watch round failed")
            await asyncio.sleep(self.settings.tick_seconds)

    async def tick(self, now: datetime | None = None) -> None:
        if not self.enabled:
            return
        now = now or datetime.now(UTC)
        due = self._due_schedules(now)
        synced = self._due_synced(now)
        for key in sorted(set(due) | synced):
            try:
                await self._check_connection(key, due.get(key, []), scan=key in synced, now=now)
            except Exception:
                logger.exception("calendar watch failed for one connection")

    async def verify_before_join(self, meeting_id: str, now: datetime | None = None) -> None:
        """Re-check a due schedule unless it was confirmed moments ago; never blocks a join for long."""
        if not self.enabled:
            return
        now = now or datetime.now(UTC)
        last = self._checked.get(meeting_id)
        if last is not None and now - last < self.settings.prejoin_max_age:
            return
        schedule = self.applier.schedule(meeting_id)
        if schedule is None:
            return
        key = (schedule.organization_id, schedule.user_id, schedule.stored.connection_id)
        try:
            await asyncio.wait_for(self._check_connection(key, [schedule], scan=False, now=now),
                                   timeout=self.settings.prejoin_timeout)
        except TimeoutError:
            logger.warning("calendar re-check before joining meeting %s timed out; joining at the stored time", meeting_id)
        except Exception:
            logger.exception("calendar re-check before joining meeting %s failed; joining at the stored time", meeting_id)

    # ----- what is due ----------------------------------------------------------------------
    def _interval(self, starts_at: datetime, now: datetime) -> timedelta:
        return self.settings.soon_interval if starts_at - now <= self.settings.soon_window else self.settings.interval

    def _due_schedules(self, now: datetime) -> dict[ConnectionKey, list[WatchedSchedule]]:
        due: dict[ConnectionKey, list[WatchedSchedule]] = {}
        with self.database.session_factory() as session:
            rows = session.execute(select(CalendarScheduleRow).where(
                CalendarScheduleRow.status == "pending", CalendarScheduleRow.provider != "manual",
                CalendarScheduleRow.starts_at > now - MISSED_AFTER,
            )).scalars().all()
            for row in rows:
                last = self._attempted.get(row.meeting_id)
                if last is not None and now - last < self._interval(_utc(row.starts_at), now):
                    continue
                due.setdefault((row.organization_id, row.user_id, row.connection_id), []).append(self.applier.load(session, row))
        return due

    def _due_synced(self, now: datetime) -> set[ConnectionKey]:
        with self.database.session_factory() as session:
            keys = session.execute(select(
                CalendarSyncStateRow.organization_id, CalendarSyncStateRow.user_id, CalendarSyncStateRow.connection_id,
            )).all()
        interval = self.settings.sync_interval
        return {tuple(key) for key in keys if now - self._scanned.get(tuple(key), datetime.min.replace(tzinfo=UTC)) >= interval}  # type: ignore[misc]

    # ----- one connection -------------------------------------------------------------------
    def _owner(self, organization_id: str, user_id: str) -> Actor | None:
        """The owner with their *current* membership (as background jobs do); None once they left."""
        with self.database.session_factory() as session:
            membership = session.get(OrganizationMembershipRow, (organization_id, user_id))
            user = session.get(UserRow, user_id)
            if membership is None or user is None:
                return None
            return Actor(user_id=UUID(user_id), organization_id=UUID(organization_id), email=user.email,
                         display_name=user.display_name, role=membership.role, must_change_password=False,
                         session_version=0)

    async def _connection(self, actor: Actor, connection_id: str, now: datetime) -> CalendarConnection | None:
        cache_key = (str(actor.organization_id), str(actor.user_id))
        cached = self._connections.get(cache_key)
        if cached is None or now - cached[0] >= self.settings.connection_ttl:
            cached = (now, await self.calendar.connections(actor))
            self._connections[cache_key] = cached
        connection = next((item for item in cached[1] if item.id == connection_id), None)
        return connection if connection is not None and connection.status == "ACTIVE" else None

    async def _relink(self, actor: Actor, key: ConnectionKey, schedules: list[WatchedSchedule], now: datetime) -> set[str]:
        if not schedules:
            return set()
        cached = self._connections.get((key[0], key[1]))
        try:
            return await self.relinker.relink_orphans(actor, key[2], schedules, cached[1] if cached else [], now)
        except Exception:
            logger.exception("could not look for stranded schedules on another account")
            return set()

    def _window(self, schedules: list[WatchedSchedule], scan: bool, now: datetime) -> tuple[datetime, datetime]:
        starts = [schedule.stored.starts_at for schedule in schedules]
        low = [start - timedelta(days=1) for start in starts] + ([now - timedelta(hours=1)] if scan else [])
        high = [schedule.stored.ends_at + timedelta(days=1) for schedule in schedules] + ([now + self.settings.horizon] if scan else [])
        return min(low), min(max(high), now + self.settings.absence_horizon)

    def _flag(self, schedules: list[WatchedSchedule], *, owner_left: bool, now: datetime) -> None:
        for schedule in schedules:
            self._attempted[schedule.meeting_id] = now
            self.applier.mark_attention(schedule, owner_left=owner_left, now=now)

    def _failed(self, key: ConnectionKey, schedules: list[WatchedSchedule], now: datetime) -> None:
        self._failures[key] = self._failures.get(key, 0) + 1
        self._connections.pop((key[0], key[1]), None)
        for schedule in schedules:
            self._attempted[schedule.meeting_id] = now
        if self._failures[key] >= FAILURES_BEFORE_ATTENTION:
            self._flag(schedules, owner_left=False, now=now)

    async def _check_connection(self, key: ConnectionKey, schedules: list[WatchedSchedule], *,
                                scan: bool, now: datetime) -> None:
        organization_id, user_id, connection_id = key
        actor = self._owner(organization_id, user_id)
        if actor is None:
            self._flag(schedules, owner_left=True, now=now)
            self._scanned[key] = now
            return
        try:
            connection = await self._connection(actor, connection_id, now)
            if connection is None:
                # Reconnected under a new id? Follow the same event there; flag only what isn't found.
                moved = await self._relink(actor, key, schedules, now)
                self._flag([item for item in schedules if item.meeting_id not in moved], owner_left=False, now=now)
                self._scanned[key] = now
                return
            start, end = self._window(schedules, scan, now)
            found = await self.calendar.events_for_window(actor, connection_id, start, end, "UTC",
                                                          connection=connection, enrich_invitees=False)
        except CalendarError as exc:
            logger.warning("calendar watch lookup failed for a %s connection: %s", key[2][:8], exc)
            self._failed(key, schedules, now)
            self._scanned[key] = now
            return
        self._failures.pop(key, None)
        pending = self.applier.pending_on_connection(organization_id, user_id, connection_id)
        if scan:
            schedules = schedules + self._affected_schedules(key, schedules, pending, found)
        claimed = self._claimed(organization_id, connection_id)
        for schedule in schedules:
            await self._reconcile_schedule(actor, connection, schedule, found, claimed, now)
        if scan:
            self._scan_cache(key, connection.provider, found, set(pending), now)
            self._scanned[key] = now

    # ----- schedules ------------------------------------------------------------------------
    def _claimed(self, organization_id: str, connection_id: str) -> frozenset[str]:
        with self.database.session_factory() as session:
            return frozenset(session.execute(select(CalendarScheduleRow.event_id).where(
                CalendarScheduleRow.organization_id == organization_id,
                CalendarScheduleRow.connection_id == connection_id,
            )).scalars().all())

    @staticmethod
    def _affected_schedules(key: ConnectionKey, known: list[WatchedSchedule], pending: dict[str, WatchedSchedule],
                            found: CalendarEventsResponse) -> list[WatchedSchedule]:
        """Pending schedules not yet due whose event visibly changed in a synced scan."""
        seen = {schedule.meeting_id for schedule in known}
        extra: list[WatchedSchedule] = []
        for event in found.events:
            schedule = pending.get(event.event_id)
            if schedule is None or schedule.meeting_id in seen or schedule.user_id != key[1]:
                continue
            if reconcile(schedule.stored, CalendarLookup(events=(event,))).kind == "updated":
                extra.append(schedule)
                seen.add(schedule.meeting_id)
        return extra

    async def _reconcile_schedule(self, actor: Actor, connection: CalendarConnection, schedule: WatchedSchedule,
                                  found: CalendarEventsResponse, claimed: frozenset[str], now: datetime) -> None:
        claimed = claimed - {schedule.stored.event_id}
        decision = reconcile(schedule.stored, CalendarLookup(
            events=tuple(found.events), skipped_ids=frozenset(found.skipped_ids),
            cancelled_ids=frozenset(found.cancelled_ids), claimed_ids=claimed,
        ))
        if decision.kind == "unknown":
            decision = await self._confirm(actor, connection, schedule.stored, claimed, now)
        self._attempted[schedule.meeting_id] = now
        try:
            self.applier.apply_schedule(schedule, decision, "watcher", now)
        except Exception:
            logger.exception("could not apply a calendar change to meeting %s", schedule.meeting_id)
            return
        if decision.kind != "unknown":
            self._checked[schedule.meeting_id] = now

    async def _confirm(self, actor: Actor, connection: CalendarConnection, stored: StoredEvent,
                       claimed: frozenset[str], now: datetime) -> Reconciliation:
        """The event wasn't where we expected it: find it, or prove it is gone."""
        try:
            cancelled: frozenset[str] = frozenset()
            if connection.provider == "googlecalendar":
                near = await self.calendar.events_for_window(
                    actor, connection.id, stored.starts_at - timedelta(days=1), stored.ends_at + timedelta(days=1), "UTC",
                    connection=connection, include_cancelled=True, enrich_invitees=False)
                cancelled = frozenset(near.cancelled_ids)
                nearby = reconcile(stored, CalendarLookup(events=tuple(near.events), cancelled_ids=cancelled,
                                                          skipped_ids=frozenset(near.skipped_ids)))
                if nearby.kind != "unknown":
                    return nearby
            wide = await self.calendar.events_for_window(
                actor, connection.id, min(stored.starts_at, now) - timedelta(days=1), now + self.settings.absence_horizon,
                "UTC", connection=connection, enrich_invitees=False)
            lookup = CalendarLookup(events=tuple(wide.events), complete=not wide.truncated, cancelled_ids=cancelled,
                                    skipped_ids=frozenset(wide.skipped_ids), claimed_ids=claimed)
            if connection.provider == "calendly":
                lookup = await self._calendly_hints(actor, connection, stored, lookup)
            return reconcile(stored, lookup)
        except CalendarError as exc:
            logger.warning("calendar watch confirmation lookup failed: %s", exc)
            return UNKNOWN

    async def _calendly_hints(self, actor: Actor, connection: CalendarConnection, stored: StoredEvent,
                              lookup: CalendarLookup) -> CalendarLookup:
        """Ask the old booking's invitees whether it was rescheduled, and into which booking."""
        try:
            invitees = await self.calendar.calendly_invitees(actor, connection, stored.event_id, status=None)
        except CalendarError:
            invitees = []
        rescheduled: bool | None = None
        replacement: str | None = None
        if any(item.get("rescheduled") is True for item in invitees):
            rescheduled = True
            replacement = next((uri for uri in (_calendly_event_uri(item.get("new_invitee")) for item in invitees) if uri), None)
        elif invitees and all(item.get("status") in {"canceled", "cancelled"} for item in invitees):
            rescheduled = False
        complete = lookup.complete
        if replacement is None and rescheduled is not False and stored.title:
            # The heuristic compares invitees: fetch them only for bookings of the same type within
            # the match window, nearest the old time first (bounded). If some could not be checked,
            # a missing match proves nothing, so the lookup no longer counts as complete.
            same = sorted(
                (event for event in lookup.events if event.title.casefold() == stored.title.casefold()
                 and event.event_id != stored.event_id
                 and abs(event.starts_at - stored.starts_at) <= CALENDLY_MATCH_WINDOW),
                key=lambda event: abs(event.starts_at - stored.starts_at),
            )
            await self.calendar.enrich_calendly(actor, connection, same, limit=CALENDLY_ENRICH_LIMIT)
            if len(same) > CALENDLY_ENRICH_LIMIT:
                complete = False
        return replace(lookup, rescheduled=rescheduled, replacement_id=replacement, complete=complete)

    # ----- synced events ----------------------------------------------------------------------
    def _scan_cache(self, key: ConnectionKey, provider: str, found: CalendarEventsResponse,
                    scheduled: set[str], now: datetime) -> None:
        """Re-key moved synced events; events with a pending schedule were handled with the schedule."""
        organization_id, user_id, connection_id = key
        events = [event for event in found.events if event.event_id not in scheduled]
        with self.database.session_factory.begin() as session:
            moves = rekey_moved_rows(session, organization_id, user_id, connection_id, events, now)
        if moves:
            self.applier.record_cache_moves(organization_id, user_id, connection_id, provider, moves, "watcher", now)

    async def cache_moved(self, organization_id: str, user_id: str, connection_id: str, provider: str,
                          moves: list[CacheMove], *, source: str = "sync") -> None:
        """A manual sync re-keyed moved events: move any pending schedule too, then tell people once."""
        now = datetime.now(UTC)
        plain: list[CacheMove] = []
        for move in moves:
            schedule = self.applier.pending_for_event(organization_id, connection_id, move.event.event_id)
            if schedule is None or schedule.user_id != user_id:
                plain.append(move)
                continue
            decision = reconcile(schedule.stored, CalendarLookup(events=(move.event,)))
            self.applier.apply_schedule(schedule, decision, "sync", now)
            self._checked[schedule.meeting_id] = now
        if plain:
            self.applier.record_cache_moves(organization_id, user_id, connection_id, provider, plain, "sync", now)


def _calendly_event_uri(value: object) -> str | None:
    """``…/scheduled_events/<event>/invitees/<invitee>`` → ``…/scheduled_events/<event>``."""
    if not isinstance(value, str) or not value.startswith("https://api.calendly.com/scheduled_events/"):
        return None
    event = value.split("/invitees/", 1)[0].rstrip("/")
    return event if event.count("/") == 4 else None

