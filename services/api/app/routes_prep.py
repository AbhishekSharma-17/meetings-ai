"""Meeting-prep HTTP routes: organizer inputs, briefing generation (sync + SSE progress) and history.

Roles: every signed-in member can read their own event's inputs, latest briefing, history and the
who's-who preview; viewers cannot save inputs or generate (enforced in MeetingPrepService). Calendar events are
per-user snapshots, so all routes first resolve the event inside the caller's workspace.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

from .rate_limit import prep_generation_limiter
from .composio_calendar import CalendarError
from .meeting_prep import MeetingPrepService, PrepHistory, PrepInputs, PrepReport, PrepRequest, WhosWhoRequest
from .prep_parties import WhosWho
from .prep_report import PrepReportV2
from .prep_research import PrepBusyError, PrepConfigError, PrepError, PrepPermissionError
from .tenant import tenant_scope

logger = logging.getLogger(__name__)
PREP_STAGES = ("queued", "planning", "searching", "reading", "writing", "done")


def _http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, CalendarError):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, PrepPermissionError):
        return HTTPException(status_code=403, detail=str(exc))
    if isinstance(exc, (PrepConfigError, PrepBusyError)):
        return HTTPException(status_code=409, detail=str(exc))
    return HTTPException(status_code=502, detail=str(exc))


def register_prep_routes(app: FastAPI, *, meeting_prep: MeetingPrepService) -> None:
    # Shared with the background-job route (routes_jobs) so every generation path counts once.
    prep_limit = app.state.prep_limiter = prep_generation_limiter()

    @app.get("/v1/calendar/events/{event_id}/prep", response_model=PrepReportV2 | PrepReport | None)
    def latest_meeting_prep(event_id: UUID, request: Request) -> PrepReportV2 | PrepReport | None:
        try:
            return meeting_prep.latest(request.state.actor, event_id)
        except CalendarError as exc:
            raise _http_error(exc) from exc

    @app.post("/v1/calendar/events/{event_id}/prep", response_model=PrepReportV2)
    async def generate_meeting_prep(event_id: UUID, payload: PrepRequest, request: Request) -> PrepReportV2:
        prep_limit.check(request.state.actor.user_id)
        try:
            return await meeting_prep.generate(request.state.actor, event_id, payload)
        except (CalendarError, PrepError) as exc:
            raise _http_error(exc) from exc

    @app.post("/v1/calendar/events/{event_id}/prep/stream")
    async def stream_meeting_prep(event_id: UUID, payload: PrepRequest, request: Request) -> StreamingResponse:
        """SSE: ``progress`` {stage, message} … then ``final`` (report) or ``error`` {status, detail}."""
        actor = request.state.actor
        try:
            meeting_prep.cache.get_event(actor, event_id)
            if actor.role == "viewer":
                raise PrepPermissionError("viewers cannot prepare meeting briefings")
            prep_limit.check(actor.user_id)
        except (CalendarError, PrepError) as exc:
            raise _http_error(exc) from exc

        async def events() -> AsyncIterator[str]:
            queue: asyncio.Queue[tuple[str, object]] = asyncio.Queue()

            async def progress(stage: str, message: str) -> None:
                await queue.put(("progress", {"stage": stage, "message": message}))

            async def run() -> None:
                try:
                    with tenant_scope(actor.organization_id):
                        report = await meeting_prep.generate(actor, event_id, payload, progress)
                    await queue.put(("final", report.model_dump(mode="json")))
                except (CalendarError, PrepError) as exc:
                    error = _http_error(exc)
                    await queue.put(("error", {"status": error.status_code, "detail": error.detail}))
                except Exception:
                    logger.exception("meeting prep stream failed")
                    detail = "The briefing could not be completed. Please try again."
                    await queue.put(("error", {"status": 500, "detail": detail}))
                finally:
                    await queue.put(("done", None))

            task = asyncio.create_task(run())
            try:
                while True:
                    kind, value = await queue.get()
                    if kind == "done":
                        break
                    yield f"event: {kind}\ndata: {json.dumps(value, ensure_ascii=False)}\n\n"
            finally:
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)

        return StreamingResponse(events(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
        })

    @app.get("/v1/calendar/events/{event_id}/prep/inputs", response_model=PrepInputs)
    def get_prep_inputs(event_id: UUID, request: Request) -> PrepInputs:
        try:
            return meeting_prep.get_inputs(request.state.actor, event_id)
        except CalendarError as exc:
            raise _http_error(exc) from exc

    @app.put("/v1/calendar/events/{event_id}/prep/inputs", response_model=PrepInputs)
    def save_prep_inputs(event_id: UUID, payload: PrepInputs, request: Request) -> PrepInputs:
        try:
            return meeting_prep.save_inputs(request.state.actor, event_id, payload)
        except (CalendarError, PrepError) as exc:
            raise _http_error(exc) from exc

    @app.post("/v1/calendar/events/{event_id}/prep/whos-who", response_model=WhosWho)
    def preview_whos_who(event_id: UUID, payload: WhosWhoRequest, request: Request) -> WhosWho:
        """Read-only preview: our company vs. the target and each attendee's side (not audited)."""
        try:
            return meeting_prep.whos_who(request.state.actor, event_id, payload)
        except CalendarError as exc:
            raise _http_error(exc) from exc

    @app.get("/v1/calendar/events/{event_id}/prep/history", response_model=PrepHistory)
    def prep_history(event_id: UUID, request: Request) -> PrepHistory:
        try:
            return meeting_prep.history(request.state.actor, event_id)
        except CalendarError as exc:
            raise _http_error(exc) from exc
