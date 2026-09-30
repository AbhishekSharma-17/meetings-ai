"""Voice sample endpoints: a person manages their own sample; owners and admins see who has one.

``/v1/me/voice-sample`` (every role) — status, upload (multipart ``file`` + ``duration_ms``), delete, and
``/audio`` to play it back. Audio is only ever served to its owner, with ``Cache-Control: no-store``.
``/v1/workspace/voice-samples`` (owners and admins; not on the member allowlist) — names and dates only.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, Response
from starlette.datastructures import UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from .in_person_stt import SttError, route_for, supports_known_speakers
from .rate_limit import SlidingWindowLimiter
from .voice_samples import (
    MAX_DURATION_MS,
    MAX_SAMPLE_BYTES,
    MIN_DURATION_MS,
    VoiceSampleError,
    VoiceSampleService,
    validate_sample,
)

UPLOADS_PER_WINDOW = 10
# The audio plus multipart framing and the duration field; larger bodies are refused unread.
MAX_REQUEST_BYTES = MAX_SAMPLE_BYTES + 64 * 1024
UPLOAD_WINDOW_SECONDS = 10 * 60
_OWN_PATHS = {"/v1/me/voice-sample": {"GET", "PUT", "DELETE"}, "/v1/me/voice-sample/audio": {"GET"}}
_MATCHING_COPY = {
    "available": "Your workspace's speech-to-text model uses voice samples to suggest names.",
    "unsupported": "Your workspace's speech-to-text model doesn't use voice samples yet. Your sample is kept "
                   "and will be used if the workspace switches to a model that does.",
    "not_configured": "Speech-to-text isn't set up in this workspace yet, so voice samples aren't used.",
}


class SamplePublic(BaseModel):
    mime_type: str
    duration_ms: int
    byte_size: int
    updated_at: datetime


class MatchingPublic(BaseModel):
    status: Literal["available", "unsupported", "not_configured"]
    message: str


class VoiceSampleStatus(BaseModel):
    sample: SamplePublic | None
    matching: MatchingPublic
    min_duration_ms: int = MIN_DURATION_MS
    max_duration_ms: int = MAX_DURATION_MS
    max_bytes: int = MAX_SAMPLE_BYTES


class SampleHolderPublic(BaseModel):
    user_id: UUID
    display_name: str
    duration_ms: int
    updated_at: datetime


async def _read_body(request: Request) -> None:
    """Buffer the body, counting real bytes (not the Content-Length header, which chunked requests omit)."""
    body = bytearray()
    async for piece in request.stream():
        body.extend(piece)
        if len(body) > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="a voice sample can be at most 1 MB")
    request._body = bytes(body)  # Starlette's form parser reads a buffered body from here


async def _read_form(request: Request) -> tuple[UploadFile, int]:
    await _read_body(request)
    try:
        form = await request.form(max_files=1, max_fields=2, max_part_size=1024)
    except Exception as exc:  # malformed multipart, too many parts
        raise HTTPException(status_code=422, detail="send the sample as a multipart form with file and duration_ms") from exc
    file, duration = form.get("file"), form.get("duration_ms")
    if not isinstance(file, UploadFile) or not isinstance(duration, str) or not duration.strip().isdigit():
        raise HTTPException(status_code=422, detail="send the sample as a multipart form with file and duration_ms")
    return file, int(duration.strip())


def voice_sample_route_allowed(method: str, path: str) -> bool:
    """Every signed-in role manages their own sample (the ``require_admin`` member allowlist)."""
    return method in _OWN_PATHS.get(path, set())


def register_voice_sample_routes(app: FastAPI, *, samples: VoiceSampleService, transcriber: Any) -> None:
    limiter = SlidingWindowLimiter(UPLOADS_PER_WINDOW, UPLOAD_WINDOW_SECONDS,
                                   "too many voice sample uploads; try again in a few minutes")

    def matching() -> MatchingPublic:
        try:
            route = route_for(transcriber.profile())
        except SttError:
            return MatchingPublic(status="not_configured", message=_MATCHING_COPY["not_configured"])
        status = "available" if supports_known_speakers(route) else "unsupported"
        return MatchingPublic(status=status, message=_MATCHING_COPY[status])

    def status_for(actor) -> VoiceSampleStatus:
        info = samples.info(actor.organization_id, actor.user_id)
        sample = SamplePublic(mime_type=info.mime_type, duration_ms=info.duration_ms, byte_size=info.byte_size,
                              updated_at=info.updated_at) if info else None
        return VoiceSampleStatus(sample=sample, matching=matching())

    @app.get("/v1/me/voice-sample", response_model=VoiceSampleStatus)
    def get_voice_sample(request: Request) -> VoiceSampleStatus:
        return status_for(request.state.actor)

    @app.put("/v1/me/voice-sample", response_model=VoiceSampleStatus)
    async def upload_voice_sample(request: Request) -> VoiceSampleStatus:
        """Multipart ``file`` + ``duration_ms``; parsed here (not as parameters) so size is checked first."""
        actor = request.state.actor
        limiter.check(str(actor.user_id))
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > MAX_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="a voice sample can be at most 1 MB")
        file, duration_ms = await _read_form(request)
        data = await file.read(MAX_SAMPLE_BYTES + 1)
        try:
            mime_type = validate_sample(data, file.content_type, duration_ms)
            await run_in_threadpool(samples.save, actor.organization_id, actor.user_id, data, mime_type, duration_ms)
        except VoiceSampleError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        return status_for(actor)

    @app.delete("/v1/me/voice-sample", status_code=204)
    def delete_voice_sample(request: Request) -> Response:
        actor = request.state.actor
        samples.delete(actor.organization_id, actor.user_id)
        return Response(status_code=204)

    @app.get("/v1/me/voice-sample/audio")
    def play_voice_sample(request: Request) -> Response:
        actor = request.state.actor
        stored = samples.audio(actor.organization_id, actor.user_id)
        if stored is None:
            raise HTTPException(status_code=404, detail="you have no voice sample in this workspace")
        mime_type, data = stored
        return Response(content=data, media_type=mime_type, headers={
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Vary": "Cookie",
        })

    @app.get("/v1/workspace/voice-samples", response_model=list[SampleHolderPublic])
    def list_voice_samples(request: Request) -> list[SampleHolderPublic]:
        actor = request.state.actor
        if not actor.is_admin:  # also enforced by require_admin; kept here so the route is safe on its own
            raise HTTPException(status_code=403, detail="workspace role does not permit this action")
        return [SampleHolderPublic(user_id=item.user_id, display_name=item.display_name, duration_ms=item.duration_ms,
                                   updated_at=item.updated_at) for item in samples.holders(actor.organization_id)]
