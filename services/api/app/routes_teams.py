"""Internal team (recipient group) endpoints under /v1/workspace/teams.

Everyone in the workspace can read teams (they appear as recap recipients);
only owners and admins create, edit or delete them. Writes are recorded by the
audit middleware as e.g. ``POST /v1/workspace/teams``.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, Response

from .recipient_groups import (
    RecipientGroupConflictError,
    RecipientGroupError,
    RecipientGroupPermissionError,
    RecipientGroupService,
    TeamCreate,
    TeamPatch,
    TeamPublic,
)
from .repository import RecipientGroupNotFoundError


def _http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, RecipientGroupNotFoundError):
        return HTTPException(status_code=404, detail="team not found")
    if isinstance(exc, RecipientGroupPermissionError):
        return HTTPException(status_code=403, detail=str(exc))
    if isinstance(exc, RecipientGroupConflictError):
        return HTTPException(status_code=409, detail=str(exc))
    return HTTPException(status_code=422, detail=str(exc))


_ERRORS = (RecipientGroupNotFoundError, RecipientGroupPermissionError, RecipientGroupConflictError, RecipientGroupError)


def register_team_routes(app: FastAPI, *, teams: RecipientGroupService) -> None:
    @app.get("/v1/workspace/teams", response_model=list[TeamPublic])
    def list_teams() -> list[TeamPublic]:
        return teams.list()

    @app.post("/v1/workspace/teams", response_model=TeamPublic, status_code=201)
    def create_team(payload: TeamCreate, request: Request) -> TeamPublic:
        try:
            return teams.create(payload, request.state.actor)
        except _ERRORS as exc:
            raise _http_error(exc) from exc

    @app.get("/v1/workspace/teams/{team_id}", response_model=TeamPublic)
    def get_team(team_id: UUID) -> TeamPublic:
        try:
            return teams.get(team_id)
        except _ERRORS as exc:
            raise _http_error(exc) from exc

    @app.patch("/v1/workspace/teams/{team_id}", response_model=TeamPublic)
    def update_team(team_id: UUID, payload: TeamPatch, request: Request) -> TeamPublic:
        try:
            return teams.update(team_id, payload, request.state.actor)
        except _ERRORS as exc:
            raise _http_error(exc) from exc

    @app.delete("/v1/workspace/teams/{team_id}", status_code=204)
    def delete_team(team_id: UUID, request: Request) -> Response:
        try:
            teams.delete(team_id, request.state.actor)
        except _ERRORS as exc:
            raise _http_error(exc) from exc
        return Response(status_code=204)
