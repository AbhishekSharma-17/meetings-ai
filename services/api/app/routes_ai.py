"""HTTP routes for the workspace key vault and owner-controlled AI settings.

Role gates: the ``require_admin`` middleware already limits /v1/credentials to
owners and admins (and allowlists GET /v1/ai/settings for every role). Anything
that writes, rotates, deletes or spends a secret is additionally owner-only here.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, Response, status

from .rate_limit import provider_test_limiter
from .ai_settings import (
    AiSettingsPermissionError,
    AiSettingsPublic,
    AiSettingsService,
    AiSettingsUnavailableError,
    AiSettingsUpdate,
    AiSettingsValidationError,
)
from .credential_vault import (
    CredentialCreate,
    CredentialInUseError,
    CredentialNotFoundError,
    CredentialPatch,
    CredentialPublic,
    CredentialTestResult,
    CredentialValidationError,
    CredentialVault,
)

OWNER_ONLY_DETAIL = "only the workspace owner can manage saved keys"


def _actor(request: Request) -> object:
    actor = getattr(request.state, "actor", None)
    if actor is None:
        raise HTTPException(status_code=401, detail="sign in required")
    return actor


def _require_owner(request: Request, detail: str = OWNER_ONLY_DETAIL) -> object:
    actor = _actor(request)
    if getattr(actor, "role", None) != "owner":
        raise HTTPException(status_code=403, detail=detail)
    return actor


def _require_admin(request: Request) -> object:
    actor = _actor(request)
    if not getattr(actor, "is_admin", False):
        raise HTTPException(status_code=403, detail="workspace role does not permit this action")
    return actor


def register_ai_routes(app: FastAPI, *, vault: CredentialVault, ai_settings: AiSettingsService) -> None:
    test_limit = provider_test_limiter()

    @app.get("/v1/credentials", response_model=list[CredentialPublic])
    def list_credentials(
        request: Request,
        provider_type: Literal["openai", "openrouter", "openai_compatible", "exa"] | None = None,
    ) -> list[CredentialPublic]:
        actor = _require_admin(request)
        return vault.list(actor.organization_id, provider_type)

    @app.post("/v1/credentials", response_model=CredentialPublic, status_code=status.HTTP_201_CREATED)
    def create_credential(payload: CredentialCreate, request: Request) -> CredentialPublic:
        actor = _require_owner(request)
        try:
            return vault.create(actor.organization_id, payload, actor.user_id)
        except CredentialValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.patch("/v1/credentials/{credential_id}", response_model=CredentialPublic)
    def update_credential(credential_id: UUID, payload: CredentialPatch, request: Request) -> CredentialPublic:
        actor = _require_owner(request)
        try:
            return vault.update(actor.organization_id, credential_id, payload)
        except CredentialNotFoundError as exc:
            raise HTTPException(status_code=404, detail="saved key not found") from exc
        except CredentialValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.delete("/v1/credentials/{credential_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_credential(credential_id: UUID, request: Request) -> Response:
        actor = _require_owner(request)
        try:
            vault.delete(actor.organization_id, credential_id)
        except CredentialNotFoundError as exc:
            raise HTTPException(status_code=404, detail="saved key not found") from exc
        except CredentialInUseError as exc:
            raise HTTPException(status_code=409, detail={
                "message": "remove this key from the listed uses before deleting it",
                "used_by": exc.usages,
            }) from exc
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.post("/v1/credentials/{credential_id}/test", response_model=CredentialTestResult)
    async def test_credential(credential_id: UUID, request: Request) -> CredentialTestResult:
        actor = _require_owner(request)
        test_limit.check(actor.user_id)
        try:
            return await vault.test(actor.organization_id, credential_id, actor.user_id)
        except CredentialNotFoundError as exc:
            raise HTTPException(status_code=404, detail="saved key not found") from exc

    @app.get("/v1/ai/settings", response_model=AiSettingsPublic)
    async def get_ai_settings(request: Request) -> AiSettingsPublic:
        actor = _actor(request)
        return await ai_settings.public_view(actor.organization_id, actor)

    @app.put("/v1/ai/settings", response_model=AiSettingsPublic)
    async def put_ai_settings(payload: AiSettingsUpdate, request: Request) -> AiSettingsPublic:
        actor = _require_owner(request, "only the workspace owner can change AI settings")
        try:
            await ai_settings.update(actor.organization_id, payload, actor)
        except AiSettingsPermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except AiSettingsValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except AiSettingsUnavailableError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return await ai_settings.public_view(actor.organization_id, actor)
