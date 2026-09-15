import os
from contextlib import asynccontextmanager
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
    EmailDeliveryPublic,
    MeetingCreate,
    MeetingListResponse,
    MeetingMinutesDraft,
    MeetingMinutesPublic,
    MeetingPublic,
    MeetingTranscriptResponse,
    MinutesEmailRequest,
    ProfileCreate,
    ProfilePublic,
    ProfileUpdate,
)

from .adapters.vexa import VexaAPIError, VexaCaptureAdapter
from .adapters.resend import EmailDeliveryError, ResendAdapter
from .adapters.base import ProviderExecutionError
from .database import Database
from .meeting_service import MeetingConflictError, MeetingService, MeetingValidationError
from .minutes_service import MinutesConflictError, MinutesGenerationError, MinutesService
from .repository import MeetingNotFoundError, MinutesNotFoundError, ProfileNotFoundError
from .security import CredentialCipher
from .service import ProfileValidationError, ProviderProfileService, ProviderSelectionError
from .sqlalchemy_repository import SQLAlchemyRepository


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if key.lower() in {"api_key", "token", "secret"} else _redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def create_app(
    *,
    database_url: str | None = None,
    credential_key: str | None = None,
    vexa_adapter: VexaCaptureAdapter | None = None,
    resend_adapter: ResendAdapter | None = None,
) -> FastAPI:
    database = Database(
        database_url
        or os.getenv("DATABASE_URL", "sqlite+pysqlite:///:memory:")
    )
    database.migrate()
    cipher = CredentialCipher(
        credential_key
        or os.getenv("PROVIDER_CREDENTIAL_KEY", "development-only-change-me")
    )
    repository = SQLAlchemyRepository(database, cipher)
    service = ProviderProfileService(repository)
    vexa = vexa_adapter or VexaCaptureAdapter(
        os.getenv("VEXA_BASE_URL", "http://localhost:8056"),
        os.getenv("VEXA_API_KEY") or os.getenv("VEXA_ADMIN_TOKEN") or None,
    )
    meeting_service = MeetingService(repository, vexa)
    resend_from = os.getenv("RESEND_FROM_EMAIL") or "onboarding@resend.dev"
    resend_name = os.getenv("RESEND_FROM_NAME") or "Meetings AI"
    resend = resend_adapter or ResendAdapter(
        os.getenv("RESEND_API_KEY") or None,
        resend_from if "<" in resend_from else f"{resend_name} <{resend_from}>",
    )
    minutes_service = MinutesService(repository, service, resend)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        try:
            yield
        finally:
            await vexa.close()
            database.engine.dispose()

    app = FastAPI(title="Meetings AI API", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[os.getenv("WEB_ORIGIN", "http://localhost:3020")],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "Idempotency-Key"],
    )
    app.state.database = database
    app.state.repository = repository
    app.state.profile_service = service
    app.state.meeting_service = meeting_service
    app.state.minutes_service = minutes_service

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
        if isinstance(exc, MeetingNotFoundError):
            return HTTPException(status_code=404, detail="meeting not found")
        if isinstance(exc, MinutesNotFoundError):
            return HTTPException(status_code=404, detail="MOM has not been generated")
        if isinstance(exc, (MeetingConflictError, MinutesConflictError)):
            return HTTPException(status_code=409, detail=str(exc))
        if isinstance(exc, (MinutesGenerationError, ProviderSelectionError, ProviderExecutionError)):
            return HTTPException(status_code=502, detail=str(exc))
        if isinstance(exc, EmailDeliveryError):
            return HTTPException(status_code=502, detail=str(exc))
        if isinstance(exc, VexaAPIError):
            safe_upstream_codes = {401, 403, 409, 422, 429, 502, 503}
            code = exc.status_code if exc.status_code in safe_upstream_codes else 502
            return HTTPException(status_code=code, detail=str(exc))
        return HTTPException(status_code=422, detail=str(exc))

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "meetings-ai-api"}

    @app.get("/v1/integrations/vexa/health")
    async def vexa_health() -> dict[str, object]:
        """Check Vexa connectivity and key scopes without launching a meeting bot."""
        try:
            identity = await vexa.preflight()
        except VexaAPIError as exc:
            raise api_error(exc) from exc
        return {
            "status": "ready",
            "integration": "vexa",
            "scopes": identity.get("scopes", []),
            "max_concurrent": identity.get("max_concurrent"),
        }

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

    MEETING_EXCEPTIONS = (
        MeetingNotFoundError,
        MeetingValidationError,
        MeetingConflictError,
        VexaAPIError,
    )

    @app.post(
        "/v1/meetings", response_model=MeetingPublic, status_code=status.HTTP_201_CREATED
    )
    def create_meeting(payload: MeetingCreate) -> MeetingPublic:
        try:
            return meeting_service.to_public(meeting_service.create(payload))
        except MeetingValidationError as exc:
            raise api_error(exc) from exc

    @app.get("/v1/meetings", response_model=MeetingListResponse)
    def list_meetings() -> MeetingListResponse:
        return meeting_service.list()

    @app.get("/v1/meetings/{meeting_id}", response_model=MeetingPublic)
    async def get_meeting(meeting_id: UUID) -> MeetingPublic:
        try:
            return meeting_service.to_public(await meeting_service.get(meeting_id))
        except MEETING_EXCEPTIONS as exc:
            raise api_error(exc) from exc

    @app.post("/v1/meetings/{meeting_id}/join", response_model=MeetingPublic)
    async def join_meeting(meeting_id: UUID) -> MeetingPublic:
        try:
            return meeting_service.to_public(await meeting_service.join(meeting_id))
        except MEETING_EXCEPTIONS as exc:
            raise api_error(exc) from exc

    @app.post("/v1/meetings/{meeting_id}/stop", response_model=MeetingPublic)
    async def stop_meeting(meeting_id: UUID) -> MeetingPublic:
        try:
            return meeting_service.to_public(await meeting_service.stop(meeting_id))
        except MEETING_EXCEPTIONS as exc:
            raise api_error(exc) from exc

    @app.post("/v1/meetings/{meeting_id}/refresh", response_model=MeetingPublic)
    async def refresh_meeting(meeting_id: UUID) -> MeetingPublic:
        try:
            return meeting_service.to_public(await meeting_service.refresh(meeting_id))
        except MEETING_EXCEPTIONS as exc:
            raise api_error(exc) from exc

    @app.get(
        "/v1/meetings/{meeting_id}/transcript",
        response_model=MeetingTranscriptResponse,
    )
    async def get_meeting_transcript(meeting_id: UUID) -> MeetingTranscriptResponse:
        try:
            return await meeting_service.transcript(meeting_id)
        except MEETING_EXCEPTIONS as exc:
            raise api_error(exc) from exc

    MINUTES_EXCEPTIONS = (
        MeetingNotFoundError,
        MinutesNotFoundError,
        MinutesConflictError,
        MinutesGenerationError,
        ProviderSelectionError,
        ProviderExecutionError,
        EmailDeliveryError,
        VexaAPIError,
    )

    @app.get(
        "/v1/meetings/{meeting_id}/minutes", response_model=MeetingMinutesPublic
    )
    def get_meeting_minutes(meeting_id: UUID) -> MeetingMinutesPublic:
        try:
            return minutes_service.to_public(minutes_service.get(meeting_id))
        except MINUTES_EXCEPTIONS as exc:
            raise api_error(exc) from exc

    @app.post(
        "/v1/meetings/{meeting_id}/minutes/generate",
        response_model=MeetingMinutesPublic,
    )
    async def generate_meeting_minutes(meeting_id: UUID) -> MeetingMinutesPublic:
        try:
            meeting = repository.get_meeting(meeting_id)
            if meeting.vexa_meeting_id is not None:
                # Pull the final upstream snapshot before freezing the MOM input.
                await meeting_service.transcript(meeting_id)
            return minutes_service.to_public(await minutes_service.generate(meeting_id))
        except MINUTES_EXCEPTIONS as exc:
            raise api_error(exc) from exc

    @app.put(
        "/v1/meetings/{meeting_id}/minutes", response_model=MeetingMinutesPublic
    )
    def update_meeting_minutes(
        meeting_id: UUID, payload: MeetingMinutesDraft
    ) -> MeetingMinutesPublic:
        try:
            return minutes_service.to_public(minutes_service.update(meeting_id, payload))
        except MINUTES_EXCEPTIONS as exc:
            raise api_error(exc) from exc

    @app.post(
        "/v1/meetings/{meeting_id}/minutes/approve",
        response_model=MeetingMinutesPublic,
    )
    def approve_meeting_minutes(meeting_id: UUID) -> MeetingMinutesPublic:
        try:
            return minutes_service.to_public(minutes_service.approve(meeting_id))
        except MINUTES_EXCEPTIONS as exc:
            raise api_error(exc) from exc

    @app.post(
        "/v1/meetings/{meeting_id}/minutes/send",
        response_model=EmailDeliveryPublic,
    )
    async def send_meeting_minutes(
        meeting_id: UUID, payload: MinutesEmailRequest
    ) -> EmailDeliveryPublic:
        try:
            delivery = await minutes_service.send(meeting_id, payload)
            return minutes_service.delivery_to_public(delivery)
        except MINUTES_EXCEPTIONS as exc:
            raise api_error(exc) from exc

    return app


app = create_app()
