"""Usage & cost transparency endpoints (workspace owners and admins only)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from .database import Database
from .usage import UsageLedger, UsageSummary, usage_request_scope
from .usage_events import (
    UsageCursorError,
    UsageEventFilter,
    UsageEventPage,
    export_usage_csv,
    list_usage_events,
)

_NAME = r"^[A-Za-z0-9_.:/@+-]{1,200}$"


def require_workspace_admin(request: Request) -> object:
    actor = getattr(request.state, "actor", None)
    if actor is None or not actor.is_admin:
        raise HTTPException(status_code=403, detail="workspace owner or admin access required")
    return actor


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC)


def _window(since: datetime | None, until: datetime | None) -> tuple[datetime | None, datetime | None]:
    since, until = _aware(since), _aware(until)
    if since and until and since >= until:
        raise HTTPException(status_code=400, detail="'since' must be earlier than 'until'")
    return since, until


def register_usage_routes(app: FastAPI, *, usage: UsageLedger, database: Database) -> None:
    @app.middleware("http")
    async def usage_actor_context(request: Request, call_next):
        # Outermost middleware: the auth middleware fills request.state.actor later, and the
        # ledger reads it lazily so provider calls are attributed to the signed-in person.
        with usage_request_scope(request.state):
            return await call_next(request)

    def event_filter(kind: str | None, purpose: str | None, provider: str | None, model: str | None,
                     status: str | None, meeting_id: UUID | None, since: datetime | None,
                     until: datetime | None, q: str | None) -> UsageEventFilter:
        start, end = _window(since, until)
        return UsageEventFilter(kind=kind, purpose=purpose, provider=provider, model=model, status=status,
                                meeting_id=meeting_id, since=start, until=end, q=(q or "").strip() or None)

    @app.get("/v1/workspace/usage", response_model=UsageSummary)
    def get_workspace_usage(request: Request, since: datetime | None = None,
                            until: datetime | None = None) -> UsageSummary:
        actor = require_workspace_admin(request)
        start, end = _window(since, until)
        return usage.summary(actor.organization_id, since=start, until=end)

    @app.get("/v1/workspace/usage/events", response_model=UsageEventPage)
    def get_workspace_usage_events(
        request: Request,
        kind: Annotated[str | None, Query(pattern=r"^[a-z_]{1,30}$")] = None,
        purpose: Annotated[str | None, Query(pattern=r"^[A-Za-z0-9_.:-]{1,60}$")] = None,
        provider: Annotated[str | None, Query(pattern=_NAME)] = None,
        model: Annotated[str | None, Query(pattern=_NAME)] = None,
        status: Annotated[str | None, Query(pattern=r"^[a-z_]{1,20}$")] = None,
        meeting_id: UUID | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        q: Annotated[str | None, Query(max_length=200)] = None,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        cursor: Annotated[str | None, Query(max_length=300)] = None,
    ) -> UsageEventPage:
        actor = require_workspace_admin(request)
        flt = event_filter(kind, purpose, provider, model, status, meeting_id, since, until, q)
        try:
            return list_usage_events(database, actor.organization_id, flt, limit=limit, cursor=cursor)
        except UsageCursorError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/v1/workspace/usage/export.csv")
    def export_workspace_usage(
        request: Request,
        kind: Annotated[str | None, Query(pattern=r"^[a-z_]{1,30}$")] = None,
        purpose: Annotated[str | None, Query(pattern=r"^[A-Za-z0-9_.:-]{1,60}$")] = None,
        provider: Annotated[str | None, Query(pattern=_NAME)] = None,
        model: Annotated[str | None, Query(pattern=_NAME)] = None,
        status: Annotated[str | None, Query(pattern=r"^[a-z_]{1,20}$")] = None,
        meeting_id: UUID | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        q: Annotated[str | None, Query(max_length=200)] = None,
    ) -> StreamingResponse:
        actor = require_workspace_admin(request)
        flt = event_filter(kind, purpose, provider, model, status, meeting_id, since, until, q)
        filename = f"meetings-ai-usage-{datetime.now(UTC):%Y%m%d}.csv"
        return StreamingResponse(
            export_usage_csv(database, actor.organization_id, flt), media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"},
        )
