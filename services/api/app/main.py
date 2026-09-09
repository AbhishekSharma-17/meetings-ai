import os
from typing import Any
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from meetings_contracts import (
    AdapterTestResult,
    Capability,
    DefaultSelectionRequest,
    DefaultSelectionResponse,
    ProfileCreate,
    ProfilePublic,
    ProfileUpdate,
)

from .repository import InMemoryProviderRepository, ProfileNotFoundError
from .service import ProfileValidationError, ProviderProfileService


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if key.lower() in {"api_key", "token", "secret"} else _redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def create_app() -> FastAPI:
    app = FastAPI(title="Meetings AI API", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[os.getenv("WEB_ORIGIN", "http://localhost:3020")],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "Idempotency-Key"],
    )
    repository = InMemoryProviderRepository()
    service = ProviderProfileService(repository)
    app.state.repository = repository
    app.state.profile_service = service

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        del request
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content=jsonable_encoder({"detail": _redact(exc.errors())}),
        )

    def api_error(exc: Exception) -> HTTPException:
        if isinstance(exc, ProfileNotFoundError):
            return HTTPException(status_code=404, detail="provider profile not found")
        return HTTPException(status_code=422, detail=str(exc))

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "meetings-ai-api"}

    @app.get("/v1/provider-profiles", response_model=list[ProfilePublic])
    def list_profiles() -> list[ProfilePublic]:
        return [service.to_public(profile) for profile in repository.list_profiles()]

    @app.post(
        "/v1/provider-profiles",
        response_model=ProfilePublic,
        status_code=status.HTTP_201_CREATED,
    )
    def create_profile(payload: ProfileCreate) -> ProfilePublic:
        return service.to_public(service.create(payload))

    @app.patch("/v1/provider-profiles/{profile_id}", response_model=ProfilePublic)
    def update_profile(profile_id: UUID, payload: ProfileUpdate) -> ProfilePublic:
        try:
            return service.to_public(service.update(profile_id, payload))
        except (ProfileNotFoundError, ProfileValidationError) as exc:
            raise api_error(exc) from exc

    @app.post(
        "/v1/provider-profiles/{profile_id}/test", response_model=AdapterTestResult
    )
    async def test_profile(profile_id: UUID) -> AdapterTestResult:
        try:
            return await service.test(profile_id)
        except ProfileNotFoundError as exc:
            raise api_error(exc) from exc

    @app.get("/v1/provider-defaults", response_model=list[DefaultSelectionResponse])
    def list_defaults() -> list[DefaultSelectionResponse]:
        return [service.to_default_response(item) for item in repository.list_defaults()]

    @app.put(
        "/v1/provider-defaults/{capability}", response_model=DefaultSelectionResponse
    )
    def select_default(
        capability: Capability, payload: DefaultSelectionRequest
    ) -> DefaultSelectionResponse:
        try:
            return service.select_default(capability, payload)
        except (ProfileNotFoundError, ProfileValidationError) as exc:
            raise api_error(exc) from exc

    return app


app = create_app()
