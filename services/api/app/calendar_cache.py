"""Workspace-isolated, per-account snapshots of discovered meeting events."""

from datetime import UTC, date, datetime
from uuid import UUID, uuid4

from pydantic import BaseModel, Field
from sqlalchemy import select

from .accounts import Actor
from .composio_calendar import CalendarEvent, CalendarError, CalendarInvitee, ComposioCalendar, calendar_date_window
from .database import CalendarEventCacheRow, CalendarSyncStateRow, Database, MeetingPrepRow


class CalendarSyncRequest(BaseModel):
    connection_ids: list[str] = Field(default_factory=list, max_length=20)
    start_date: date
    end_date: date
    timezone: str = Field(default="UTC", max_length=100)


class CachedCalendarEvent(CalendarEvent):
    id: UUID
    synced_at: datetime


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


class CalendarCacheService:
    def __init__(self, database: Database, calendar: ComposioCalendar) -> None:
        self.database = database
        self.calendar = calendar

    def list(self, actor: Actor, first: date, last: date, timezone: str) -> CachedCalendarResponse:
        start, end = calendar_date_window(first, last, timezone)
        with self.database.session_factory() as session:
            rows = session.execute(select(CalendarEventCacheRow).where(
                CalendarEventCacheRow.organization_id == str(actor.organization_id),
                CalendarEventCacheRow.user_id == str(actor.user_id),
                CalendarEventCacheRow.starts_at >= start.astimezone(UTC),
                CalendarEventCacheRow.starts_at < end.astimezone(UTC),
            ).order_by(CalendarEventCacheRow.starts_at, CalendarEventCacheRow.provider)).scalars().all()
            syncs = session.execute(select(CalendarSyncStateRow).where(
                CalendarSyncStateRow.organization_id == str(actor.organization_id),
                CalendarSyncStateRow.user_id == str(actor.user_id),
            )).scalars().all()
            return CachedCalendarResponse(
                events=[CachedCalendarEvent(**row.payload, id=UUID(row.id), synced_at=row.synced_at) for row in rows],
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
            return CachedCalendarEvent(**row.payload, id=UUID(row.id), synced_at=row.synced_at)

    async def sync(self, actor: Actor, request: CalendarSyncRequest) -> CalendarSyncResponse:
        start, end = calendar_date_window(request.start_date, request.end_date, request.timezone)
        connections = {item.id: item for item in await self.calendar.connections(actor) if item.status == "ACTIVE"}
        selected = list(dict.fromkeys(request.connection_ids)) if request.connection_ids else list(connections)
        if not selected:
            raise CalendarError("connect an account before syncing events")
        if any(item not in connections for item in selected):
            raise CalendarError("select only active calendar accounts connected to your user")
        errors: dict[str, str] = {}
        for connection_id in selected:
            try:
                found = await self.calendar.events_for_window(actor, connection_id, start, end, request.timezone)
            except CalendarError as exc:
                errors[connection_id] = str(exc)
                continue
            now = datetime.now(UTC)
            with self.database.session_factory.begin() as session:
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
                            has_prep = session.execute(select(MeetingPrepRow.id).where(
                                MeetingPrepRow.calendar_event_id == row.id,
                            ).limit(1)).first()
                            if not has_prep:
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
        snapshot = self.list(actor, request.start_date, request.end_date, request.timezone)
        return CalendarSyncResponse(**snapshot.model_dump(), errors=errors)
