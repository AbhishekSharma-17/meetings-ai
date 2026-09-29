"""Read-only history of detected calendar changes (moved, cancelled, link changed).

Roles: a scheduled meeting's history is visible to whoever may manage that meeting (owners and
admins; the ``require_admin`` middleware also checks the meeting belongs to the workspace). A synced
calendar event's history is visible only to the person whose calendar it came from.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import FastAPI, HTTPException, Request

from .calendar_cache import CalendarCacheService
from .calendar_changes import CalendarChangeHistory, event_changes, meeting_changes
from .calendar_schedule import CalendarScheduleService
from .composio_calendar import CalendarError
from .database import Database


def register_calendar_change_routes(app: FastAPI, *, database: Database, calendar_schedule: CalendarScheduleService,
                                    calendar_cache: CalendarCacheService) -> None:
    @app.get("/v1/meetings/{meeting_id}/schedule/changes", response_model=CalendarChangeHistory)
    def scheduled_meeting_changes(meeting_id: UUID, request: Request) -> CalendarChangeHistory:
        actor = request.state.actor
        schedule = calendar_schedule.get(actor, meeting_id)
        if schedule is None:
            raise HTTPException(status_code=404, detail="scheduled meeting not found")
        with database.session_factory() as session:
            items = meeting_changes(session, str(actor.organization_id), str(meeting_id))
        return CalendarChangeHistory(items=items, provider=schedule.provider, last_checked_at=schedule.last_checked_at)

    @app.get("/v1/calendar/events/{event_id}/changes", response_model=CalendarChangeHistory)
    def calendar_event_changes(event_id: UUID, request: Request) -> CalendarChangeHistory:
        actor = request.state.actor
        try:
            row = calendar_cache.get_row(actor, event_id)
        except CalendarError as exc:
            raise HTTPException(status_code=404, detail="saved calendar event not found") from exc
        with database.session_factory() as session:
            items = event_changes(session, str(actor.organization_id), str(actor.user_id), row.id,
                                  row.connection_id, row.event_id)
        return CalendarChangeHistory(items=items, provider=row.provider)
