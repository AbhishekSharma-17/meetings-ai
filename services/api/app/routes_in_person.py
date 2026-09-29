"""Routes for recording in-person meetings from a phone or laptop browser.

All routes are authenticated and workspace-scoped. Owners, admins and members may record (viewers
may not); only the recorder may upload audio or control their recording; the recorder and workspace
admins may view it and name its speakers. Chunk bodies are raw audio (``content-type`` = the
recording's audio type), at most 2 MB each. Audio and transcript text are never logged.
"""

from __future__ import annotations

import re
from typing import Annotated
from uuid import UUID

from fastapi import FastAPI, HTTPException, Query, Request, Response
from starlette.concurrency import run_in_threadpool

from .in_person_models import (
    MAX_CHUNK_BYTES,
    CalendarLink,
    ChunkAccepted,
    InPersonCreate,
    InPersonSessionPublic,
    MomentInput,
    SpeakerNameApprovals,
    SpeakerNameDismissal,
    SpeakerNamesView,
    StopInput,
)
from .in_person_names import SpeakerNamingService
from .in_person_service import InPersonService
from .in_person_store import InPersonError, SessionNotFoundError
from .rate_limit import SlidingWindowLimiter
from .repository import MeetingNotFoundError
from .sqlalchemy_repository import TranscriptReviewConflictError

_ID = r"[0-9a-f-]{36}"
_ACTIONS = r"chunks|pause|resume|moments|stop|retry|discard|speaker-names/(?:approve|dismiss|refresh)"
_MEMBER_ROUTES = (
    ("POST", re.compile(r"/v1/in-person/meetings")),
    ("GET", re.compile(rf"/v1/in-person/meetings/{_ID}(?:/speaker-names)?")),
    ("GET", re.compile(r"/v1/in-person/calendar-links")),
    ("POST", re.compile(rf"/v1/in-person/meetings/{_ID}/(?:{_ACTIONS})")),
)


def in_person_route_allowed(method: str, path: str, role: str) -> bool:
    """Non-admin access for the ``require_admin`` middleware: members yes, viewers never."""
    return role == "member" and any(method == allowed and pattern.fullmatch(path) for allowed, pattern in _MEMBER_ROUTES)


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, InPersonError):
        return HTTPException(status_code=exc.status_code, detail=exc.detail)
    if isinstance(exc, TranscriptReviewConflictError):
        return HTTPException(status_code=409, detail=str(exc))
    return HTTPException(status_code=404, detail="recording not found")  # SessionNotFound / MeetingNotFound


_HANDLED = (InPersonError, SessionNotFoundError, MeetingNotFoundError, TranscriptReviewConflictError)


async def _read_limited(request: Request, limit: int) -> bytes:
    """The request body, refusing anything over ``limit`` bytes without reading it all into memory."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise InPersonError(413, f"an audio chunk can be at most {limit // (1024 * 1024)} MB")
    body = bytearray()
    async for piece in request.stream():
        body.extend(piece)
        if len(body) > limit:
            raise InPersonError(413, f"an audio chunk can be at most {limit // (1024 * 1024)} MB")
    return bytes(body)


def register_in_person_routes(app: FastAPI, *, service: InPersonService, naming: SpeakerNamingService) -> None:
    create_limit = SlidingWindowLimiter(12, 3600, "too many recordings started; try again later")
    chunk_limit = SlidingWindowLimiter(600, 600, "audio is arriving too fast; the upload will retry")
    control_limit = SlidingWindowLimiter(120, 600, "too many recording actions; try again in a minute")

    def public(request: Request, snapshot) -> InPersonSessionPublic:
        return service.public(request.state.actor, snapshot)

    @app.post("/v1/in-person/meetings", response_model=InPersonSessionPublic, status_code=201)
    async def create_recording(payload: InPersonCreate, request: Request) -> InPersonSessionPublic:
        actor = request.state.actor
        create_limit.check(actor.user_id)
        try:
            return public(request, await service.create(actor, payload))
        except _HANDLED as exc:
            raise _error(exc) from exc

    @app.get("/v1/in-person/calendar-links", response_model=list[CalendarLink])
    def calendar_links(request: Request) -> list[CalendarLink]:
        """Calendar events that have an in-person recording: admins see all, members their own."""
        actor = request.state.actor
        if actor.role not in {"owner", "admin", "member"}:
            raise HTTPException(status_code=403, detail="viewers cannot see recordings")
        rows = service.store.calendar_links(actor.organization_id, None if actor.is_admin else actor.user_id)
        return [CalendarLink(**row) for row in rows]

    @app.get("/v1/in-person/meetings/{meeting_id}", response_model=InPersonSessionPublic)
    def get_recording(meeting_id: UUID, request: Request) -> InPersonSessionPublic:
        try:
            return public(request, service.session_for_viewer(request.state.actor, meeting_id))
        except _HANDLED as exc:
            raise _error(exc) from exc

    @app.post("/v1/in-person/meetings/{meeting_id}/chunks", response_model=ChunkAccepted)
    async def upload_chunk(
        meeting_id: UUID, request: Request,
        seq: Annotated[int, Query(ge=0, le=100_000)],
        duration_ms: Annotated[int, Query(ge=1, le=60_000)],
        stream_start: Annotated[int, Query(ge=0, le=1)] = 0,
    ) -> ChunkAccepted:
        actor = request.state.actor
        chunk_limit.check(actor.user_id)
        try:
            data = await _read_limited(request, MAX_CHUNK_BYTES)
            accepted = await run_in_threadpool(
                service.add_chunk, actor, meeting_id, seq=seq, data=data, duration_ms=duration_ms,
                stream_start=bool(stream_start), content_type=request.headers.get("content-type"),
            )
        except _HANDLED as exc:
            raise _error(exc) from exc
        if not accepted.duplicate:
            service.schedule_preview(actor, meeting_id, seq)
        return accepted

    @app.post("/v1/in-person/meetings/{meeting_id}/pause", response_model=InPersonSessionPublic)
    def pause_recording(meeting_id: UUID, request: Request) -> InPersonSessionPublic:
        return _control(request, lambda actor: service.pause(actor, meeting_id))

    @app.post("/v1/in-person/meetings/{meeting_id}/resume", response_model=InPersonSessionPublic)
    def resume_recording(meeting_id: UUID, request: Request) -> InPersonSessionPublic:
        return _control(request, lambda actor: service.resume(actor, meeting_id))

    @app.post("/v1/in-person/meetings/{meeting_id}/moments", response_model=InPersonSessionPublic)
    def mark_moment(meeting_id: UUID, payload: MomentInput, request: Request) -> InPersonSessionPublic:
        return _control(request, lambda actor: service.add_moment(actor, meeting_id, payload.at_ms, payload.label))

    @app.post("/v1/in-person/meetings/{meeting_id}/stop", response_model=InPersonSessionPublic)
    async def stop_recording(meeting_id: UUID, payload: StopInput, request: Request) -> InPersonSessionPublic:
        # async: submitting the final-pass job schedules it on this event loop.
        return _control(request, lambda actor: service.stop(actor, meeting_id, payload.final_seq))

    @app.post("/v1/in-person/meetings/{meeting_id}/retry", response_model=InPersonSessionPublic)
    async def retry_recording(meeting_id: UUID, request: Request) -> InPersonSessionPublic:
        return _control(request, lambda actor: service.retry(actor, meeting_id))

    @app.post("/v1/in-person/meetings/{meeting_id}/discard", status_code=204)
    def discard_recording(meeting_id: UUID, request: Request) -> Response:
        control_limit.check(request.state.actor.user_id)
        try:
            service.discard(request.state.actor, meeting_id)
        except _HANDLED as exc:
            raise _error(exc) from exc
        return Response(status_code=204)

    def _control(request: Request, action) -> InPersonSessionPublic:
        control_limit.check(request.state.actor.user_id)
        try:
            return public(request, action(request.state.actor))
        except _HANDLED as exc:
            raise _error(exc) from exc

    # ----- speaker names -------------------------------------------------------------------------------
    @app.get("/v1/in-person/meetings/{meeting_id}/speaker-names", response_model=SpeakerNamesView)
    def speaker_names(meeting_id: UUID, request: Request) -> SpeakerNamesView:
        try:
            return naming.view(request.state.actor, meeting_id)
        except _HANDLED as exc:
            raise _error(exc) from exc

    @app.post("/v1/in-person/meetings/{meeting_id}/speaker-names/approve", response_model=SpeakerNamesView)
    def approve_speaker_names(meeting_id: UUID, payload: SpeakerNameApprovals, request: Request) -> SpeakerNamesView:
        control_limit.check(request.state.actor.user_id)
        try:
            return naming.approve(request.state.actor, meeting_id, payload)
        except _HANDLED as exc:
            raise _error(exc) from exc

    @app.post("/v1/in-person/meetings/{meeting_id}/speaker-names/dismiss", response_model=SpeakerNamesView)
    def dismiss_speaker_name(meeting_id: UUID, payload: SpeakerNameDismissal, request: Request) -> SpeakerNamesView:
        control_limit.check(request.state.actor.user_id)
        try:
            return naming.dismiss(request.state.actor, meeting_id, payload.speaker)
        except _HANDLED as exc:
            raise _error(exc) from exc

    @app.post("/v1/in-person/meetings/{meeting_id}/speaker-names/refresh", response_model=SpeakerNamesView)
    async def refresh_speaker_names(meeting_id: UUID, request: Request) -> SpeakerNamesView:
        try:
            return await naming.refresh(request.state.actor, meeting_id)
        except _HANDLED as exc:
            raise _error(exc) from exc

    app.state.in_person_close = service.close
