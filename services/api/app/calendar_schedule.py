"""Explicit calendar-event scheduling; a single worker joins at the event time."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

from meetings_contracts import MeetingCreate, MeetingPublic
from pydantic import BaseModel
from sqlalchemy import select, update

from .accounts import Actor
from .composio_calendar import CalendarError, CalendarRange, ComposioCalendar
from .database import CalendarScheduleRow, Database
from .meeting_service import MeetingService
from .tenant import tenant_scope

logger = logging.getLogger(__name__)


class ScheduleCreate(BaseModel):
    connection_id: str
    event_id: str
    period: CalendarRange
    timezone: str = "UTC"
    meeting: MeetingCreate


class ManualScheduleCreate(BaseModel):
    starts_at: datetime
    ends_at: datetime | None = None
    meeting: MeetingCreate


class CalendarSchedulePublic(BaseModel):
    meeting_id: UUID
    connection_id: str
    provider: str
    event_id: str
    starts_at: datetime
    ends_at: datetime
    status: str
    last_error: str | None = None


class CalendarScheduleError(ValueError):
    pass


def _public(row: CalendarScheduleRow) -> CalendarSchedulePublic:
    return CalendarSchedulePublic(
        meeting_id=UUID(row.meeting_id), event_id=row.event_id,
        connection_id=row.connection_id, provider=row.provider,
        starts_at=row.starts_at, ends_at=row.ends_at,
        status=row.status, last_error=row.last_error,
    )


class CalendarScheduleService:
    def __init__(self, database: Database, calendar: ComposioCalendar, meetings: MeetingService):
        self.database, self.calendar, self.meetings = database, calendar, meetings

    def list(self, actor: Actor) -> list[CalendarSchedulePublic]:
        with self.database.session_factory() as session:
            rows = session.execute(select(CalendarScheduleRow).where(
                CalendarScheduleRow.organization_id == str(actor.organization_id),
            ).order_by(CalendarScheduleRow.starts_at.desc())).scalars().all()
            return [_public(row) for row in rows]

    def get(self, actor: Actor, meeting_id: UUID) -> CalendarSchedulePublic | None:
        with self.database.session_factory() as session:
            row = session.get(CalendarScheduleRow, str(meeting_id))
            return _public(row) if row and row.organization_id == str(actor.organization_id) else None

    async def create(self, actor: Actor, payload: ScheduleCreate) -> tuple[CalendarSchedulePublic, MeetingPublic]:
        # Never trust the event URL or start time posted by the browser. Re-read
        # this account's calendar and bind the capture to that source event.
        scan = await self.calendar.events(actor, payload.connection_id, payload.period, payload.timezone)
        event = next((item for item in scan.events if item.event_id == payload.event_id), None)
        if event is None:
            raise CalendarScheduleError("selected event is no longer available; scan the calendar again")
        now = datetime.now(UTC)
        if event.starts_at.astimezone(UTC) <= now + timedelta(minutes=1):
            raise CalendarScheduleError("this meeting starts too soon to schedule; use Send assistant now")
        with self.database.session_factory() as session:
            existing = session.execute(select(CalendarScheduleRow).where(
                CalendarScheduleRow.organization_id == str(actor.organization_id),
                CalendarScheduleRow.connection_id == payload.connection_id,
                CalendarScheduleRow.event_id == event.event_id,
                CalendarScheduleRow.starts_at == event.starts_at,
            )).scalar_one_or_none()
            if existing:
                raise CalendarScheduleError("this calendar event already has a record in this workspace; delete that record before importing it again")
        meeting_payload = payload.meeting.model_copy(update={
            "meeting_url": event.meeting_url,
            "title": payload.meeting.title or event.title,
        })
        meeting = self.meetings.create(meeting_payload)
        with self.database.session_factory.begin() as session:
            row = CalendarScheduleRow(
                meeting_id=str(meeting.id), organization_id=str(actor.organization_id),
                user_id=str(actor.user_id), connection_id=event.connection_id,
                provider=event.provider, event_id=event.event_id,
                starts_at=event.starts_at, ends_at=event.ends_at,
                status="pending", attempts=0, last_error=None,
                created_at=now, updated_at=now,
            )
            session.add(row)
        return _public(row), self.meetings.to_public(meeting)

    def create_manual(self, actor: Actor, payload: ManualScheduleCreate) -> tuple[CalendarSchedulePublic, MeetingPublic]:
        now = datetime.now(UTC)
        if payload.starts_at.tzinfo is None:
            raise CalendarScheduleError("scheduled start must include a time zone")
        if payload.ends_at is not None and payload.ends_at.tzinfo is None:
            raise CalendarScheduleError("scheduled end must include a time zone")
        starts_at = payload.starts_at.astimezone(UTC)
        ends_at = payload.ends_at.astimezone(UTC) if payload.ends_at else starts_at + timedelta(hours=4)
        if starts_at <= now + timedelta(minutes=1):
            raise CalendarScheduleError("schedule at least one minute ahead, or send the assistant now")
        if ends_at <= starts_at or ends_at > starts_at + timedelta(hours=12):
            raise CalendarScheduleError("scheduled end must be after the start and within 12 hours")
        meeting = self.meetings.create(payload.meeting)
        with self.database.session_factory.begin() as session:
            row = CalendarScheduleRow(
                meeting_id=str(meeting.id), organization_id=str(actor.organization_id),
                user_id=str(actor.user_id), connection_id="manual", provider="manual",
                event_id=str(meeting.id), starts_at=starts_at, ends_at=ends_at,
                status="pending", attempts=0, last_error=None,
                created_at=now, updated_at=now,
            )
            session.add(row)
        return _public(row), self.meetings.to_public(meeting)

    def cancel(self, actor: Actor, meeting_id: UUID) -> CalendarSchedulePublic:
        with self.database.session_factory.begin() as session:
            row = session.get(CalendarScheduleRow, str(meeting_id))
            if row is None or row.organization_id != str(actor.organization_id):
                raise CalendarScheduleError("scheduled meeting not found")
            if row.status != "pending":
                raise CalendarScheduleError("only a pending scheduled join can be cancelled")
            row.status = "cancelled"
            row.updated_at = datetime.now(UTC)
            return _public(row)

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
            except Exception:
                logger.exception("calendar schedule reconciliation failed")
            await asyncio.sleep(15)

    async def tick(self) -> None:
        now = datetime.now(UTC)
        with self.database.session_factory() as session:
            rows = session.execute(select(CalendarScheduleRow.organization_id, CalendarScheduleRow.meeting_id, CalendarScheduleRow.starts_at, CalendarScheduleRow.ends_at).where(
                CalendarScheduleRow.status == "pending",
                CalendarScheduleRow.starts_at <= now,
            )).all()
        for organization_id, meeting_id, starts_at, ends_at in rows:
            starts_at = starts_at.replace(tzinfo=starts_at.tzinfo or UTC)
            ends_at = ends_at.replace(tzinfo=ends_at.tzinfo or UTC)
            if now >= ends_at or now > starts_at + timedelta(minutes=10):
                with self.database.session_factory.begin() as session:
                    session.execute(update(CalendarScheduleRow).where(
                        CalendarScheduleRow.meeting_id == meeting_id,
                        CalendarScheduleRow.status == "pending",
                    ).values(status="missed", last_error="scheduled start was missed; use a fresh meeting link to join manually", updated_at=now))
                continue
            with self.database.session_factory.begin() as session:
                claimed = session.execute(update(CalendarScheduleRow).where(
                    CalendarScheduleRow.meeting_id == meeting_id,
                    CalendarScheduleRow.status == "pending",
                ).values(status="joining", attempts=CalendarScheduleRow.attempts + 1, updated_at=now)).rowcount
            if not claimed:
                continue
            try:
                with tenant_scope(UUID(organization_id)):
                    await self.meetings.join(UUID(meeting_id))
            except Exception as exc:
                logger.warning("scheduled join failed for meeting %s: %s", meeting_id, exc)
                with self.database.session_factory.begin() as session:
                    row = session.get(CalendarScheduleRow, meeting_id)
                    if row:
                        row.status = "failed"
                        row.last_error = str(exc)[:1000]
                        row.updated_at = datetime.now(UTC)
            else:
                with self.database.session_factory.begin() as session:
                    row = session.get(CalendarScheduleRow, meeting_id)
                    if row:
                        row.status = "joined"
                        row.updated_at = datetime.now(UTC)
