"""Call coordination routes: teammates who set an assistant for the same call decide who brings it.

- ``POST /v1/call-coordination/check`` (owners/admins, before scheduling or sending): teammates'
  assistants already set for a meeting link and time, your own duplicates, and a count of other
  people with the call on their calendar.
- ``GET /v1/call-coordination/calendar`` (any member): facts for your own synced events.
- ``GET /v1/call-coordination/meetings`` library chips (admins: all; others: meetings covering them).
- ``GET /v1/meetings/{id}/coordination`` the meeting's panel (admins, or people it covers).
- ``POST|DELETE /v1/meetings/{id}/coverage`` share a teammate's assistant / stop sharing. Members
  may share only a call that is on their own synced calendar.
- ``GET /v1/meetings/{id}/coverage/minutes`` approved or sent minutes for people it covers.

What sharing grants a member: this meeting's status, transcript, approved minutes and leave
status, and optionally the recap email (only their own address is added to or removed from the
recipients). Never delete, stop, join, edit or otherwise change delivery; knowledge
bases, search and chat keep their own access rules (sharing never adds a meeting to anyone's base).
"""

from __future__ import annotations

import re
from datetime import datetime
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request
from meetings_contracts import MeetingMinutesPublic, MinutesStatus

from .call_coordination import CallCoordinationService
from .call_coordination_views import CoordinationError
from .coordination_models import CalendarCoordination, CallCheck, CallCheckRequest, CoverageSummary, MeetingCoordination, ShareRequest
from .repository import MeetingNotFoundError, MinutesNotFoundError

_ID = r"[0-9a-f-]{36}"
# Routes a non-admin may reach; per-meeting access is checked by the service.
_MEMBER_ROUTES = (
    ("GET", re.compile(r"/v1/call-coordination/(?:calendar|meetings)")),
    ("GET", re.compile(rf"/v1/meetings/{_ID}/(?:coordination|coverage/minutes)")),
    ("POST", re.compile(rf"/v1/meetings/{_ID}/coverage")),
    ("DELETE", re.compile(rf"/v1/meetings/{_ID}/coverage")),
)
def member_route_allowed(method: str, path: str) -> bool:
    return any(method == allowed and pattern.fullmatch(path) for allowed, pattern in _MEMBER_ROUTES)


def _raise(exc: CoordinationError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


def register_call_coordination_routes(app: FastAPI, *, coordination: CallCoordinationService, minutes_service) -> None:
    @app.post("/v1/call-coordination/check", response_model=CallCheck)
    def check_call(payload: CallCheckRequest, request: Request) -> CallCheck:
        return coordination.check(request.state.actor, payload)

    @app.get("/v1/call-coordination/calendar", response_model=list[CalendarCoordination])
    def calendar_coordination(start: datetime, end: datetime, request: Request) -> list[CalendarCoordination]:
        try:
            return coordination.calendar(request.state.actor, start, end)
        except CoordinationError as exc:
            raise _raise(exc) from exc

    @app.get("/v1/call-coordination/meetings", response_model=list[CoverageSummary])
    def coverage_summaries(request: Request) -> list[CoverageSummary]:
        return coordination.summaries(request.state.actor)

    @app.get("/v1/meetings/{meeting_id}/coordination", response_model=MeetingCoordination)
    def meeting_coordination(meeting_id: UUID, request: Request) -> MeetingCoordination:
        try:
            return coordination.view(request.state.actor, meeting_id)
        except CoordinationError as exc:
            raise _raise(exc) from exc

    @app.post("/v1/meetings/{meeting_id}/coverage", response_model=MeetingCoordination)
    def share_assistant(meeting_id: UUID, payload: ShareRequest, request: Request) -> MeetingCoordination:
        try:
            return coordination.share(request.state.actor, meeting_id, payload.receive_recap)
        except CoordinationError as exc:
            raise _raise(exc) from exc

    @app.delete("/v1/meetings/{meeting_id}/coverage", response_model=MeetingCoordination)
    def stop_sharing(meeting_id: UUID, request: Request) -> MeetingCoordination:
        try:
            return coordination.stop_sharing(request.state.actor, meeting_id)
        except CoordinationError as exc:
            raise _raise(exc) from exc

    @app.get("/v1/meetings/{meeting_id}/coverage/minutes", response_model=MeetingMinutesPublic)
    def shared_minutes(meeting_id: UUID, request: Request) -> MeetingMinutesPublic:
        actor = request.state.actor
        if not actor.is_admin and not coordination.can_read(actor, meeting_id):
            raise HTTPException(status_code=404, detail="meeting not found")
        try:
            minutes = minutes_service.get(meeting_id)
        except (MeetingNotFoundError, MinutesNotFoundError) as exc:
            raise HTTPException(status_code=404, detail="minutes are not ready yet") from exc
        if minutes.status is MinutesStatus.DRAFT:
            # Drafts are the owner's work in progress; sharers see minutes once approved.
            raise HTTPException(status_code=404, detail="minutes are still being reviewed")
        return minutes_service.to_public(minutes)
