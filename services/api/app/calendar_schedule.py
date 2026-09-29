"""Explicit calendar-event scheduling; a single worker joins at the event time."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

from meetings_contracts import MeetingCreate, MeetingPublic
from pydantic import BaseModel
from sqlalchemy import select, update

from .accounts import Actor
from .calendar_changes import first_moves
from .composio_calendar import CalendarError, CalendarEvent, CalendarRange, ComposioCalendar, calendar_date_window
from .database import CalendarScheduleRow, Database, MeetingSourceRow
from .adapters.vexa import VexaAPIError
from .meeting_service import MeetingService
from .notification_events import NO_EVENTS
from .tenant import tenant_scope

logger = logging.getLogger(__name__)


class ScheduleCreate(BaseModel):
    connection_id: str
    event_id: str
    period: CalendarRange | None = None
    event_date: date | None = None
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
    # The start before the first detected reschedule (only while the join is at another time now).
    rescheduled_from: datetime | None = None
    # When the calendar watcher last confirmed this event with the calendar.
    last_checked_at: datetime | None = None


class CalendarScheduleError(ValueError):
    pass


def _utc(value: datetime) -> datetime:
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC)


def _public(row: CalendarScheduleRow, moved_from: dict[str, datetime] | None = None,
            checked: datetime | None = None) -> CalendarSchedulePublic:
    original = (moved_from or {}).get(row.meeting_id)
    return CalendarSchedulePublic(
        meeting_id=UUID(row.meeting_id), event_id=row.event_id,
        connection_id=row.connection_id, provider=row.provider,
        starts_at=_utc(row.starts_at), ends_at=_utc(row.ends_at),
        status=row.status, last_error=row.last_error,
        rescheduled_from=original if original is not None and original != _utc(row.starts_at) else None,
        last_checked_at=checked,
    )


class CalendarScheduleService:
    # Notification hooks (NotificationEvents); a no-op unless wired in create_app.
    events: Any = NO_EVENTS
    # The calendar watcher (calendar_watch.CalendarWatchService); None when not wired.
    watcher: Any = None

    def __init__(self, database: Database, calendar: ComposioCalendar, meetings: MeetingService):
        self.database, self.calendar, self.meetings = database, calendar, meetings

    def list(self, actor: Actor) -> list[CalendarSchedulePublic]:
        with self.database.session_factory() as session:
            rows = session.execute(select(CalendarScheduleRow).where(
                CalendarScheduleRow.organization_id == str(actor.organization_id),
            ).order_by(CalendarScheduleRow.starts_at.desc())).scalars().all()
            moved = first_moves(session, str(actor.organization_id), meeting_ids=[row.meeting_id for row in rows])
            return [_public(row, moved, self._checked(row.meeting_id)) for row in rows]

    def _checked(self, meeting_id: str) -> datetime | None:
        return self.watcher.last_checked(meeting_id) if self.watcher is not None else None

    def get(self, actor: Actor, meeting_id: UUID) -> CalendarSchedulePublic | None:
        with self.database.session_factory() as session:
            row = session.get(CalendarScheduleRow, str(meeting_id))
            if row is None or row.organization_id != str(actor.organization_id):
                return None
            moved = first_moves(session, row.organization_id, meeting_ids=[row.meeting_id])
            return _public(row, moved, self._checked(row.meeting_id))

    def source(self, actor: Actor, meeting_id: UUID) -> CalendarEvent | None:
        with self.database.session_factory() as session:
            row = session.get(MeetingSourceRow, str(meeting_id))
            if row is None or row.organization_id != str(actor.organization_id):
                return None
            return CalendarEvent(
                connection_id=row.connection_id, provider=row.provider, event_id=row.event_id,
                title=row.title, starts_at=_utc(row.starts_at), ends_at=_utc(row.ends_at),
                meeting_url=row.meeting_url, platform=row.platform, agenda=row.agenda, organizer=row.organizer,
                invitees=row.invitees,
            )

    def _save_source(self, actor: Actor, meeting_id: UUID, event: CalendarEvent) -> None:
        with self.database.session_factory.begin() as session:
            session.add(MeetingSourceRow(
                meeting_id=str(meeting_id), organization_id=str(actor.organization_id),
                provider=event.provider, connection_id=event.connection_id, event_id=event.event_id,
                title=event.title, meeting_url=event.meeting_url, platform=event.platform,
                starts_at=_utc(event.starts_at), ends_at=_utc(event.ends_at),
                agenda=event.agenda, organizer=event.organizer,
                invitees=[person.model_dump() for person in event.invitees], saved_at=datetime.now(UTC),
            ))

    async def _verified_event(self, actor: Actor, payload: ScheduleCreate) -> CalendarEvent:
        if payload.event_date:
            start, end = calendar_date_window(payload.event_date, payload.event_date, payload.timezone)
            scan = await self.calendar.events_for_window(actor, payload.connection_id, start, end, payload.timezone)
        elif payload.period:
            scan = await self.calendar.events(actor, payload.connection_id, payload.period, payload.timezone)
        else:
            raise CalendarScheduleError("choose the event date or a calendar range")
        event = next((item for item in scan.events if item.event_id == payload.event_id), None)
        if event is None:
            raise CalendarScheduleError("selected event is no longer available; scan the source again")
        return event

    def _assert_not_imported(self, actor: Actor, event: CalendarEvent) -> None:
        with self.database.session_factory() as session:
            existing = session.execute(select(MeetingSourceRow).where(
                MeetingSourceRow.organization_id == str(actor.organization_id),
                MeetingSourceRow.meeting_url == event.meeting_url,
            )).scalars().all()
            if any(abs((row.starts_at.replace(tzinfo=row.starts_at.tzinfo or UTC) - event.starts_at.astimezone(UTC)).total_seconds()) < 60 for row in existing):
                raise CalendarScheduleError("this meeting link and start time already have a record in this workspace")

    async def create_now(self, actor: Actor, payload: ScheduleCreate) -> MeetingPublic:
        event = await self._verified_event(actor, payload)
        now = datetime.now(UTC)
        if event.starts_at.astimezone(UTC) > now + timedelta(minutes=1) or event.ends_at.astimezone(UTC) <= now:
            raise CalendarScheduleError("this event is not in progress; schedule the assistant for its start time")
        self._assert_not_imported(actor, event)
        meeting = self.meetings.create(payload.meeting.model_copy(update={
            "meeting_url": event.meeting_url, "title": payload.meeting.title or event.title,
        }))
        self._save_source(actor, meeting.id, event)
        try:
            return self.meetings.to_public(await self.meetings.join(meeting.id))
        except VexaAPIError:
            return self.meetings.to_public(self.meetings.repository.get_meeting(meeting.id))

    async def create(self, actor: Actor, payload: ScheduleCreate) -> tuple[CalendarSchedulePublic, MeetingPublic]:
        # Never trust the event URL or start time posted by the browser. Re-read
        # this account's calendar and bind the capture to that source event.
        event = await self._verified_event(actor, payload)
        now = datetime.now(UTC)
        if event.starts_at.astimezone(UTC) <= now + timedelta(minutes=1):
            raise CalendarScheduleError("this meeting starts too soon to schedule; use Send assistant now")
        self._assert_not_imported(actor, event)
        with self.database.session_factory() as session:
            existing = session.execute(select(CalendarScheduleRow).where(
                CalendarScheduleRow.organization_id == str(actor.organization_id),
                CalendarScheduleRow.connection_id == payload.connection_id,
                CalendarScheduleRow.event_id == event.event_id,
                CalendarScheduleRow.starts_at == _utc(event.starts_at),
            )).scalar_one_or_none()
            if existing:
                raise CalendarScheduleError("this calendar event already has a record in this workspace; delete that record before importing it again")
        meeting_payload = payload.meeting.model_copy(update={
            "meeting_url": event.meeting_url,
            "title": payload.meeting.title or event.title,
        })
        meeting = self.meetings.create(meeting_payload)
        self._save_source(actor, meeting.id, event)
        with self.database.session_factory.begin() as session:
            row = CalendarScheduleRow(
                meeting_id=str(meeting.id), organization_id=str(actor.organization_id),
                user_id=str(actor.user_id), connection_id=event.connection_id,
                provider=event.provider, event_id=event.event_id,
                starts_at=_utc(event.starts_at), ends_at=_utc(event.ends_at),
                status="pending", attempts=0, last_error=None,
                created_at=now, updated_at=now,
            )
            session.add(row)
        self.events.schedule_created(actor.organization_id, meeting.id, meeting.title, event.starts_at)
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
        self.events.schedule_created(actor.organization_id, meeting.id, meeting.title, starts_at)
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

    async def _due_after_recheck(self, meeting_id: str, provider: str, now: datetime) -> tuple[datetime, datetime] | None:
        """Re-verify a calendar-backed join with its calendar first (bounded; see calendar_watch).

        Returns the (possibly moved) start and end, or None when it is no longer due or pending.
        """
        if self.watcher is None or provider == "manual":
            return None
        await self.watcher.verify_before_join(meeting_id, now)
        with self.database.session_factory() as session:
            row = session.get(CalendarScheduleRow, meeting_id)
            if row is None or row.status != "pending" or _utc(row.starts_at) > now:
                return None
            return _utc(row.starts_at), _utc(row.ends_at)

    async def tick(self) -> None:
        now = datetime.now(UTC)
        self.events.schedule_reminders(now)
        with self.database.session_factory() as session:
            rows = session.execute(select(CalendarScheduleRow.organization_id, CalendarScheduleRow.meeting_id, CalendarScheduleRow.starts_at, CalendarScheduleRow.ends_at, CalendarScheduleRow.provider).where(
                CalendarScheduleRow.status == "pending",
                CalendarScheduleRow.starts_at <= now,
            )).all()
        for organization_id, meeting_id, starts_at, ends_at, provider in rows:
            starts_at = starts_at.replace(tzinfo=starts_at.tzinfo or UTC)
            ends_at = ends_at.replace(tzinfo=ends_at.tzinfo or UTC)
            if self.watcher is not None and provider != "manual":
                # The event may have moved (or been cancelled) since the last periodic check.
                fresh = await self._due_after_recheck(meeting_id, provider, now)
                if fresh is None:
                    continue
                starts_at, ends_at = fresh
            if now >= ends_at or now > starts_at + timedelta(minutes=10):
                with self.database.session_factory.begin() as session:
                    session.execute(update(CalendarScheduleRow).where(
                        CalendarScheduleRow.meeting_id == meeting_id,
                        CalendarScheduleRow.status == "pending",
                    ).values(status="missed", last_error="scheduled start was missed; use a fresh meeting link to join manually", updated_at=now))
                self.events.schedule_missed(organization_id, meeting_id)
                continue
            with self.database.session_factory.begin() as session:
                claimed = session.execute(update(CalendarScheduleRow).where(
                    CalendarScheduleRow.meeting_id == meeting_id,
                    CalendarScheduleRow.status == "pending",
                    CalendarScheduleRow.starts_at <= now,  # not moved later in the meantime
                ).values(status="joining", attempts=CalendarScheduleRow.attempts + 1, updated_at=now)).rowcount
            if not claimed:
                continue
            try:
                with tenant_scope(UUID(organization_id)):
                    await self.meetings.join(UUID(meeting_id))
            except Exception as exc:
                logger.warning("scheduled join failed for meeting %s: %s", meeting_id, exc)
                if not isinstance(exc, VexaAPIError):  # a Vexa failure is announced by the meeting status hook
                    self.events.schedule_failed(organization_id, meeting_id, str(exc), 1)
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
