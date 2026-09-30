"""Meeting sharing and recap resend routes.

- ``GET /v1/meetings/{id}/sharing`` (owners/admins): who the meeting is shared with (including
  revoked shares) and every recap email: first send or resend, recipients, status, sender.
- ``POST /v1/meetings/{id}/shares`` / ``DELETE /v1/meetings/{id}/shares/{share_id}`` (owners/admins):
  share with workspace members (each gets a notification) / revoke one share.
- ``POST /v1/meetings/{id}/minutes/resend`` (owners/admins): email the sent recap again.
- ``GET /v1/meetings/{id}/shared-view`` (a member it is shared with): who shared it, their note and
  the approved minutes. The meeting and its transcript come from the usual read routes, which
  ``main.py`` opens to people with an active share.
- ``GET /v1/me/shared-meetings`` (anyone): meetings currently shared with me.
"""

from __future__ import annotations

import re
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request
from meetings_contracts import EmailDeliveryPublic, MinutesEmailRequest

from .adapters.resend import EmailDeliveryError
from .meeting_sharing import (
    MeetingShareCreate,
    MeetingSharingPublic,
    MeetingSharingService,
    SharedMeetingView,
    SharedWithMeItem,
    ShareNotFoundError,
    SharingError,
)
from .minutes_service import MinutesConflictError
from .rate_limit import SlidingWindowLimiter
from .repository import MeetingNotFoundError, MinutesNotFoundError

_ID = r"[0-9a-f-]{36}"
_MEMBER_ROUTES = (
    ("GET", re.compile(rf"/v1/meetings/{_ID}/shared-view")),
    ("GET", re.compile(r"/v1/me/shared-meetings")),
)
RESENDS_PER_HOUR = 10


def sharing_route_allowed(method: str, path: str) -> bool:
    return any(method == allowed and pattern.fullmatch(path) for allowed, pattern in _MEMBER_ROUTES)


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, (ShareNotFoundError, MeetingNotFoundError)):
        return HTTPException(status_code=404, detail=str(exc) if isinstance(exc, ShareNotFoundError) else "meeting not found")
    if isinstance(exc, MinutesNotFoundError):
        return HTTPException(status_code=404, detail="MOM has not been generated")
    if isinstance(exc, SharingError):
        return HTTPException(status_code=422, detail=str(exc))
    if isinstance(exc, MinutesConflictError):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, EmailDeliveryError):
        return HTTPException(status_code=502, detail=str(exc))
    raise exc


_ERRORS = (ShareNotFoundError, MeetingNotFoundError, MinutesNotFoundError, SharingError, MinutesConflictError, EmailDeliveryError)


def register_sharing_routes(app: FastAPI, sharing: MeetingSharingService, minutes) -> None:
    resend_limit = SlidingWindowLimiter(RESENDS_PER_HOUR, 3600, "too many recap resends for this meeting; try again later")

    @app.get("/v1/meetings/{meeting_id}/sharing", response_model=MeetingSharingPublic)
    def meeting_sharing(meeting_id: UUID, request: Request) -> MeetingSharingPublic:
        try:
            return sharing.history(request.state.actor, meeting_id)
        except _ERRORS as exc:
            raise _error(exc) from exc

    @app.post("/v1/meetings/{meeting_id}/shares", response_model=MeetingSharingPublic)
    def share_meeting(meeting_id: UUID, payload: MeetingShareCreate, request: Request) -> MeetingSharingPublic:
        try:
            return sharing.share(request.state.actor, meeting_id, payload)
        except _ERRORS as exc:
            raise _error(exc) from exc

    @app.delete("/v1/meetings/{meeting_id}/shares/{share_id}", response_model=MeetingSharingPublic)
    def revoke_share(meeting_id: UUID, share_id: UUID, request: Request) -> MeetingSharingPublic:
        try:
            return sharing.revoke(request.state.actor, meeting_id, share_id)
        except _ERRORS as exc:
            raise _error(exc) from exc

    @app.post("/v1/meetings/{meeting_id}/minutes/resend", response_model=EmailDeliveryPublic)
    async def resend_minutes(meeting_id: UUID, payload: MinutesEmailRequest, request: Request) -> EmailDeliveryPublic:
        resend_limit.check(f"{request.state.actor.organization_id}:{meeting_id}")
        actor = request.state.actor
        try:
            return minutes.delivery_to_public(await minutes.send_again(meeting_id, payload, on_attempt=lambda delivery_id: sharing.record_sender(
                actor, meeting_id, delivery_id, "resend", payload.include_transcript)))
        except _ERRORS as exc:
            raise _error(exc) from exc

    @app.get("/v1/meetings/{meeting_id}/shared-view", response_model=SharedMeetingView)
    def shared_view(meeting_id: UUID, request: Request) -> SharedMeetingView:
        try:
            return sharing.shared_view(request.state.actor, meeting_id)
        except _ERRORS as exc:
            raise _error(exc) from exc

    @app.get("/v1/me/shared-meetings", response_model=list[SharedWithMeItem])
    def shared_with_me(request: Request) -> list[SharedWithMeItem]:
        return sharing.shared_with_me(request.state.actor)
