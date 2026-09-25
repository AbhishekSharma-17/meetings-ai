import os
import asyncio
import logging
import re
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
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
    MeetingKnowledgeUpdate,
    MeetingDeliverySettings,
    MeetingListResponse,
    MeetingMinutesDraft,
    MeetingMinutesPublic,
    MeetingPublic,
    MeetingStatus,
    MeetingParticipantsResponse,
    MeetingTranscriptResponse,
    SpeakerCorrectionRequest,
    SpeakerIdentityRequest,
    SpeakerIdentityPublic,
    MinutesEmailRequest,
    ProfileCreate,
    ProfilePublic,
    ProfileUpdate,
)

from .adapters.vexa import VexaAPIError, VexaCaptureAdapter
from .adapters.resend import EmailDeliveryError, ResendAdapter
from .adapters.base import ProviderExecutionError
from .composio_calendar import CalendarConnection, CalendarConnectResponse, CalendarEventsResponse, CalendarError, CalendarProvider, CalendarRange, ComposioCalendar
from .calendar_schedule import CalendarScheduleError, CalendarSchedulePublic, CalendarScheduleService, ScheduleCreate
from .database import Database, SchemaVersionRow, LEGACY_ADMIN_USER_ID, LEGACY_ORGANIZATION_ID
from .accounts import AccountError, AccountPublic, AccountService, Actor, ChangePasswordRequest, InviteRequest, InviteResult, MemberRolePatch, OrganizationCreateRequest, OrganizationOption, ProfilePatch
from .meeting_service import MeetingConflictError, MeetingService, MeetingValidationError
from .knowledge_service import KnowledgeAccessError, KnowledgeAnswerError, KnowledgeChatResponse, KnowledgeMapResponse, KnowledgeQuery, KnowledgeSearchResponse, KnowledgeService
from .knowledge_index import KnowledgeIndexError, KnowledgeIndexService, KnowledgeIndexStatus
from .knowledge_bases import KnowledgeBaseConflictError, KnowledgeBaseCreate, KnowledgeBaseNotFoundError, KnowledgeBasePatch, KnowledgeBasePublic, KnowledgeBaseService, KnowledgeConversationPublic, KnowledgeShareRequest, KnowledgeWikiOverview
from .minutes_service import MinutesConflictError, MinutesGenerationError, MinutesService
from .post_meeting_worker import PostMeetingJobConflictError, PostMeetingWorker
from .auth import AdminSession
from .operations import AuditEventPublic, AuditService, LoginRateLimiter, WorkspaceOperationsPublic, workspace_operations
from .repository import MeetingNotFoundError, MinutesNotFoundError, ProfileNotFoundError
from .runtime_config import validate_runtime_config
from .retention import RetentionPolicy, RetentionService
from .security import CredentialCipher
from .service import ProfileValidationError, ProviderProfileService, ProviderSelectionError
from .stt_route import STTRouteError
from .tenant import tenant_scope
from .workspace_service import WorkspacePatch, WorkspacePublic, WorkspaceMemberPublic, WorkspaceService
from .sqlalchemy_repository import SQLAlchemyRepository, TranscriptSegmentNotFoundError, TranscriptReviewConflictError, SpeakerIdentityConflictError, MinutesDeletionConflictError


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if key.lower() in {"api_key", "token", "secret", "password"} else _redact(item)
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
    calendar_adapter: ComposioCalendar | None = None,
) -> FastAPI:
    resolved_database_url = database_url or os.getenv(
        "DATABASE_URL", "sqlite+pysqlite:///:memory:"
    )
    resolved_credential_key = credential_key or os.getenv(
        "PROVIDER_CREDENTIAL_KEY", "development-only-change-me"
    )
    admin_password = os.getenv("MEETINGS_AI_ADMIN_PASSWORD", "")
    session_secret = os.getenv("MEETINGS_AI_SESSION_SECRET", "")
    validate_runtime_config(
        app_env=os.getenv("APP_ENV", "development"),
        database_url=resolved_database_url,
        credential_key=resolved_credential_key,
        admin_password=admin_password,
        session_secret=session_secret,
        web_origin=os.getenv("WEB_ORIGIN", "http://localhost:3020"),
        vexa_api_key=os.getenv("VEXA_API_KEY") or os.getenv("VEXA_ADMIN_TOKEN", ""),
        stt_override_secret=os.getenv("VEXA_STT_OVERRIDE_SECRET", ""),
    )
    database = Database(resolved_database_url)
    database.migrate()
    accounts = AccountService(database)
    accounts.bootstrap_owner(os.getenv("MEETINGS_AI_ADMIN_EMAIL", "developer@genaiprotos.com"), admin_password)
    audit = AuditService(database)
    login_limiter = LoginRateLimiter(database, session_secret or resolved_credential_key)
    cipher = CredentialCipher(resolved_credential_key)
    repository = SQLAlchemyRepository(database, cipher)
    workspace_service = WorkspaceService(database)
    service = ProviderProfileService(repository)
    knowledge_bases = KnowledgeBaseService(database, repository)
    vexa = vexa_adapter or VexaCaptureAdapter(
        os.getenv("VEXA_BASE_URL", "http://localhost:8056"),
        os.getenv("VEXA_API_KEY") or os.getenv("VEXA_ADMIN_TOKEN") or None,
    )
    meeting_service = MeetingService(
        repository, vexa, service,
        stt_signing_key=os.getenv("VEXA_STT_OVERRIDE_SECRET", ""),
        knowledge_bases=knowledge_bases,
    )
    knowledge_service = KnowledgeService(repository, service, knowledge_bases)
    knowledge_index = KnowledgeIndexService(database, knowledge_service, knowledge_bases, service)
    knowledge_service.index = knowledge_index
    resend_from = os.getenv("RESEND_FROM_EMAIL", "").strip()
    resend_name = os.getenv("RESEND_FROM_NAME") or "Meetings AI"
    resend = resend_adapter or ResendAdapter(
        os.getenv("RESEND_API_KEY") or None,
        (resend_from if "<" in resend_from else f"{resend_name} <{resend_from}>")
        if resend_from else None,
    )
    minutes_service = MinutesService(repository, service, resend)
    worker = PostMeetingWorker(repository, meeting_service, minutes_service)
    retention = RetentionService(database, meeting_service, audit)
    calendar = calendar_adapter or ComposioCalendar()
    calendar_schedule = CalendarScheduleService(database, calendar, meeting_service)
    if bool(admin_password) != bool(session_secret):
        raise RuntimeError("admin password and session secret must both be configured")
    admin = AdminSession(session_secret) if admin_password else None

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        task = asyncio.create_task(worker.run()) if os.getenv("AUTO_MOM_ENABLED") == "1" else None
        index_task = asyncio.create_task(knowledge_index.run()) if os.getenv("AUTO_KNOWLEDGE_INDEX_ENABLED") == "1" else None
        retention_task = asyncio.create_task(retention.run()) if os.getenv("AUTO_RETENTION_ENABLED") == "1" else None
        schedule_task = asyncio.create_task(calendar_schedule.run()) if os.getenv("AUTO_CALENDAR_SCHEDULE_ENABLED") == "1" else None
        try:
            yield
        finally:
            for running in (task, index_task, retention_task, schedule_task):
                if running:
                    running.cancel()
                    try:
                        await running
                    except asyncio.CancelledError:
                        pass
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
    app.state.workspace_service = workspace_service
    app.state.accounts = accounts
    app.state.audit = audit
    app.state.profile_service = service
    app.state.meeting_service = meeting_service
    app.state.knowledge_service = knowledge_service
    app.state.knowledge_index = knowledge_index
    app.state.knowledge_bases = knowledge_bases
    app.state.minutes_service = minutes_service
    app.state.post_meeting_worker = worker
    app.state.retention = retention
    app.state.calendar = calendar
    app.state.calendar_schedule = calendar_schedule

    @app.middleware("http")
    async def require_admin(request: Request, call_next):
        actor = None
        if admin:
            decoded = admin.decode(request.cookies.get("meetings_ai_session"))
            actor = accounts.from_session(*decoded) if decoded else None
        else:
            actor = Actor(
                user_id=LEGACY_ADMIN_USER_ID, organization_id=LEGACY_ORGANIZATION_ID,
                email=None, display_name="Local administrator", role="owner",
                must_change_password=False, session_version=0,
            )
        request.state.actor = actor
        path = request.url.path
        with tenant_scope(actor.organization_id if actor else LEGACY_ORGANIZATION_ID):
            if path.startswith("/v1/") and path not in {
                "/v1/auth/login", "/v1/auth/session", "/v1/auth/logout",
            }:
                if actor is None:
                    return JSONResponse(status_code=401, content={"detail": "sign in required"})
                if actor.must_change_password and path not in {"/v1/auth/change-password", "/v1/auth/me"}:
                    return JSONResponse(status_code=403, content={"detail": "change your temporary password first"})
                if not actor.is_admin:
                    method = request.method
                    allowed = (
                        path == "/v1/auth/change-password"
                        or (method == "GET" and path in {"/v1/workspace", "/v1/workspace/members", "/v1/workspaces"})
                        or (method == "POST" and (path == "/v1/workspaces" or re.fullmatch(r"/v1/workspaces/[0-9a-f-]+/switch", path)))
                        or (path.startswith("/v1/knowledge-bases") and method in {"GET", "POST", "PATCH"})
                        or (method == "DELETE" and re.fullmatch(r"/v1/knowledge-bases/[0-9a-f-]+", path))
                        or (method == "DELETE" and re.fullmatch(r"/v1/knowledge-bases/[0-9a-f-]+/conversations/[0-9a-f-]+", path))
                        or (method == "PUT" and re.fullmatch(r"/v1/knowledge-bases/[0-9a-f-]+/sharing", path))
                        or (path in {"/v1/knowledge/search", "/v1/knowledge/chat"} and method == "POST")
                        or path == "/v1/auth/me"
                        or (path == "/v1/calendar/connections" and method == "GET")
                        or (re.fullmatch(r"/v1/calendar/connect/(googlecalendar|outlook)", path) and method == "POST")
                        or (path == "/v1/calendar/events" and method == "GET")
                        or (method == "GET" and re.fullmatch(r"/v1/meetings/[0-9a-f-]+(?:/transcript)?", path))
                    )
                    if not allowed:
                        return JSONResponse(status_code=403, content={"detail": "workspace role does not permit this action"})
                    if actor.role == "viewer" and path == "/v1/knowledge-bases" and method == "POST":
                        return JSONResponse(status_code=403, content={"detail": "viewers cannot create knowledge bases"})
                    match = re.fullmatch(r"/v1/meetings/([0-9a-f-]+)(?:/transcript)?", path)
                    if match:
                        try:
                            meeting = repository.get_meeting(UUID(match.group(1)))
                            if meeting.status is not MeetingStatus.COMPLETED or not meeting.knowledge_enabled or not meeting.knowledge_base_id:
                                raise ValueError("meeting is not shared")
                            knowledge_bases.get(meeting.knowledge_base_id, actor)
                        except (ValueError, MeetingNotFoundError, KnowledgeBaseNotFoundError):
                            return JSONResponse(status_code=404, content={"detail": "meeting not found"})
                # Every resource endpoint, including exports and delivery, first
                # resolves the product meeting inside the authenticated tenant.
                meeting_path = re.match(r"^/v1/meetings/([0-9a-f-]{36})(?:/|$)", path)
                if meeting_path:
                    try:
                        repository.get_meeting(UUID(meeting_path.group(1)))
                    except (ValueError, MeetingNotFoundError):
                        return JSONResponse(status_code=404, content={"detail": "meeting not found"})
            response = await call_next(request)
            if request.method in {"POST", "PUT", "PATCH", "DELETE"} and path.startswith("/v1/") \
                    and path not in {"/v1/auth/login", "/v1/auth/logout"} and response.status_code < 400:
                route = request.scope.get("route")
                template = getattr(route, "path", path)
                match = re.search(r"/([0-9a-f]{8}-[0-9a-f-]{27,})", path)
                resource_id = UUID(match.group(1)) if match else None
                try:
                    audit.append(actor, f"{request.method} {template}", template, response.status_code, resource_id)
                except SQLAlchemyError:
                    logging.getLogger(__name__).exception("could not record workspace audit event")
            return response

    class LoginPayload(BaseModel):
        password: str
        email: str | None = None

    @app.post("/v1/auth/login")
    def login(payload: LoginPayload, request: Request, response: Response) -> dict[str, bool]:
        if not admin:
            return {"authenticated": True}
        ip = request.client.host if request.client else "unknown"
        retry_after = login_limiter.retry_after(payload.email, ip)
        if retry_after:
            audit.append(None, "auth.login.throttled", "/v1/auth/login", 429)
            raise HTTPException(status_code=429, detail="too many sign-in attempts; try again later",
                                headers={"Retry-After": str(retry_after)})
        try:
            actor = accounts.login(payload.email, payload.password)
        except AccountError as exc:
            login_limiter.failed(payload.email, ip)
            audit.append(None, "auth.login.denied", "/v1/auth/login", 401)
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        login_limiter.succeeded(payload.email)
        audit.append(actor, "auth.login.succeeded", "/v1/auth/login", 200)
        response.set_cookie(
            "meetings_ai_session", admin.issue(actor.user_id, actor.organization_id, actor.session_version), httponly=True,
            secure=os.getenv("APP_ENV") == "production", samesite="strict",
            max_age=60 * 60 * 12, path="/",
        )
        return {"authenticated": True}

    @app.get("/v1/auth/session")
    def auth_session(request: Request) -> dict[str, bool]:
        return {"authenticated": request.state.actor is not None}

    @app.post("/v1/auth/logout")
    def logout(response: Response) -> dict[str, bool]:
        response.delete_cookie("meetings_ai_session", path="/")
        return {"authenticated": False}

    @app.get("/v1/auth/me")
    def auth_me(request: Request) -> dict[str, object]:
        return accounts.public(request.state.actor).model_dump(mode="json")

    @app.patch("/v1/auth/me", response_model=AccountPublic)
    def update_auth_profile(payload: ProfilePatch, request: Request) -> AccountPublic:
        try:
            return accounts.public(accounts.update_profile(request.state.actor, payload))
        except AccountError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/v1/auth/change-password")
    def change_password(payload: ChangePasswordRequest, request: Request, response: Response) -> dict[str, bool]:
        if not admin:
            raise HTTPException(status_code=409, detail="account login is not configured")
        try:
            updated = accounts.change_password(
                request.state.actor, payload.current_password, payload.new_password,
            )
        except AccountError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        response.set_cookie(
            "meetings_ai_session", admin.issue(updated.user_id, updated.organization_id, updated.session_version),
            httponly=True, secure=os.getenv("APP_ENV") == "production",
            samesite="strict", max_age=60 * 60 * 12, path="/",
        )
        return {"changed": True}

    @app.post("/v1/workspace/invite", response_model=InviteResult, status_code=201)
    def invite_member(payload: InviteRequest, request: Request) -> InviteResult:
        try:
            return accounts.invite(request.state.actor, payload)
        except AccountError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    def set_workspace_session(response: Response, actor: Actor) -> None:
        if not admin:
            return
        response.set_cookie(
            "meetings_ai_session", admin.issue(actor.user_id, actor.organization_id, actor.session_version),
            httponly=True, secure=os.getenv("APP_ENV") == "production",
            samesite="strict", max_age=60 * 60 * 12, path="/",
        )

    @app.get("/v1/workspaces", response_model=list[OrganizationOption])
    def list_workspaces(request: Request) -> list[OrganizationOption]:
        return accounts.list_organizations(request.state.actor)

    @app.post("/v1/workspaces", response_model=AccountPublic, status_code=201)
    def create_workspace(payload: OrganizationCreateRequest, request: Request, response: Response) -> AccountPublic:
        if not admin:
            raise HTTPException(status_code=409, detail="account login is not configured")
        actor = accounts.create_organization(request.state.actor, payload)
        set_workspace_session(response, actor)
        return accounts.public(actor)

    @app.post("/v1/workspaces/{organization_id}/switch", response_model=AccountPublic)
    def switch_workspace(organization_id: UUID, request: Request, response: Response) -> AccountPublic:
        if not admin:
            raise HTTPException(status_code=409, detail="account login is not configured")
        try:
            actor = accounts.select_organization(request.state.actor, organization_id)
        except AccountError as exc:
            raise HTTPException(status_code=404, detail="workspace not found") from exc
        set_workspace_session(response, actor)
        return accounts.public(actor)

    @app.post("/v1/workspace/members/{user_id}/temporary-password", response_model=InviteResult)
    def reset_member_password(user_id: UUID, request: Request) -> InviteResult:
        try:
            return accounts.reset_temporary_password(request.state.actor, user_id)
        except AccountError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.patch("/v1/workspace/members/{user_id}/role", response_model=AccountPublic)
    def change_member_role(user_id: UUID, payload: MemberRolePatch, request: Request) -> AccountPublic:
        try:
            return accounts.change_member_role(request.state.actor, user_id, payload)
        except AccountError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.delete("/v1/workspace/members/{user_id}", status_code=204)
    def remove_member(user_id: UUID, request: Request) -> Response:
        try:
            accounts.remove_member(request.state.actor, user_id)
        except AccountError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return Response(status_code=204)

    @app.get("/v1/workspace", response_model=WorkspacePublic)
    def get_workspace() -> WorkspacePublic:
        return workspace_service.get()

    @app.patch("/v1/workspace", response_model=WorkspacePublic)
    def update_workspace(patch: WorkspacePatch) -> WorkspacePublic:
        try:
            return workspace_service.update(patch)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/v1/workspace/members", response_model=list[WorkspaceMemberPublic])
    def list_workspace_members() -> list[WorkspaceMemberPublic]:
        return workspace_service.list_members()

    @app.get("/v1/workspace/audit", response_model=list[AuditEventPublic])
    def list_workspace_audit(request: Request, limit: int = 50) -> list[AuditEventPublic]:
        return audit.list(request.state.actor.organization_id, max(1, min(limit, 200)))

    @app.get("/v1/workspace/operations", response_model=WorkspaceOperationsPublic)
    def get_workspace_operations(request: Request) -> WorkspaceOperationsPublic:
        return workspace_operations(database, request.state.actor.organization_id)

    @app.get("/v1/workspace/retention", response_model=RetentionPolicy)
    def get_workspace_retention(request: Request) -> RetentionPolicy:
        return retention.get(request.state.actor.organization_id)

    @app.put("/v1/workspace/retention", response_model=RetentionPolicy)
    def save_workspace_retention(payload: RetentionPolicy, request: Request) -> RetentionPolicy:
        return retention.save(request.state.actor.organization_id, payload)

    @app.get("/v1/knowledge-bases", response_model=list[KnowledgeBasePublic])
    def list_knowledge_bases(request: Request) -> list[KnowledgeBasePublic]:
        return knowledge_bases.list(request.state.actor)

    @app.post("/v1/knowledge-bases", response_model=KnowledgeBasePublic, status_code=201)
    def create_knowledge_base(payload: KnowledgeBaseCreate, request: Request) -> KnowledgeBasePublic:
        try:
            return knowledge_bases.create(payload, request.state.actor)
        except KnowledgeBaseConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/v1/knowledge-bases/{base_id}", response_model=KnowledgeBasePublic)
    def get_knowledge_base(base_id: UUID, request: Request) -> KnowledgeBasePublic:
        try:
            return knowledge_bases.get(base_id, request.state.actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="knowledge base not found") from exc

    @app.delete("/v1/knowledge-bases/{base_id}", status_code=204)
    def delete_knowledge_base(base_id: UUID, request: Request) -> Response:
        try:
            knowledge_bases.delete_base(base_id, request.state.actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="knowledge base not found") from exc
        except KnowledgeBaseConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return Response(status_code=204)

    @app.get("/v1/knowledge-bases/{base_id}/overview", response_model=KnowledgeWikiOverview)
    def get_knowledge_overview(base_id: UUID, request: Request) -> KnowledgeWikiOverview:
        try:
            return knowledge_bases.overview(base_id, request.state.actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="knowledge base not found") from exc

    @app.get("/v1/knowledge-bases/{base_id}/map", response_model=KnowledgeMapResponse)
    def get_knowledge_map(base_id: UUID, request: Request) -> KnowledgeMapResponse:
        try:
            return knowledge_service.evidence_map(base_id, request.state.actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="knowledge base not found") from exc

    @app.get("/v1/knowledge-bases/{base_id}/index", response_model=KnowledgeIndexStatus)
    def get_knowledge_index(base_id: UUID, request: Request) -> KnowledgeIndexStatus:
        try:
            return knowledge_index.status(base_id, request.state.actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="knowledge base not found") from exc

    @app.post("/v1/knowledge-bases/{base_id}/reindex", response_model=KnowledgeIndexStatus)
    async def reindex_knowledge(base_id: UUID, request: Request) -> KnowledgeIndexStatus:
        try:
            return await knowledge_index.reindex(base_id, request.state.actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="knowledge base not found") from exc
        except KnowledgeIndexError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.patch("/v1/knowledge-bases/{base_id}", response_model=KnowledgeBasePublic)
    def update_knowledge_base(base_id: UUID, payload: KnowledgeBasePatch, request: Request) -> KnowledgeBasePublic:
        try:
            return knowledge_bases.update(base_id, payload, request.state.actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="knowledge base not found") from exc
        except KnowledgeBaseConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.put("/v1/knowledge-bases/{base_id}/sharing", response_model=KnowledgeBasePublic)
    def share_knowledge_base(base_id: UUID, payload: KnowledgeShareRequest, request: Request) -> KnowledgeBasePublic:
        try:
            return knowledge_bases.share(base_id, payload, request.state.actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="knowledge base not found") from exc
        except KnowledgeBaseConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/v1/knowledge-bases/{base_id}/conversations", response_model=list[KnowledgeConversationPublic])
    def list_knowledge_conversations(base_id: UUID, request: Request) -> list[KnowledgeConversationPublic]:
        try:
            return knowledge_bases.list_conversations(base_id, request.state.actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="knowledge base not found") from exc

    @app.get("/v1/knowledge-bases/{base_id}/conversations/{conversation_id}", response_model=KnowledgeConversationPublic)
    def get_knowledge_conversation(base_id: UUID, conversation_id: UUID, request: Request) -> KnowledgeConversationPublic:
        try:
            return knowledge_bases.get_conversation(base_id, conversation_id, request.state.actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="conversation not found") from exc

    @app.delete("/v1/knowledge-bases/{base_id}/conversations/{conversation_id}", status_code=204)
    def delete_knowledge_conversation(base_id: UUID, conversation_id: UUID, request: Request) -> Response:
        try:
            knowledge_bases.delete_conversation(base_id, conversation_id, request.state.actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="conversation not found") from exc
        return Response(status_code=204)

    @app.post("/v1/knowledge/search", response_model=KnowledgeSearchResponse)
    async def search_knowledge(payload: KnowledgeQuery, request: Request) -> KnowledgeSearchResponse:
        try:
            return await knowledge_service.hybrid_search(payload, request.state.actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="knowledge base not found") from exc
        except KnowledgeAccessError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc

    @app.post("/v1/knowledge/chat", response_model=KnowledgeChatResponse)
    async def chat_knowledge(payload: KnowledgeQuery, request: Request) -> KnowledgeChatResponse:
        try:
            return await knowledge_service.chat(payload, request.state.actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="knowledge base not found") from exc
        except KnowledgeAccessError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except KnowledgeAnswerError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.patch("/v1/meetings/{meeting_id}/knowledge", response_model=MeetingPublic)
    def update_meeting_knowledge(
        meeting_id: UUID, update: MeetingKnowledgeUpdate,
    ) -> MeetingPublic:
        try:
            return meeting_service.to_public(meeting_service.update_knowledge(meeting_id, update))
        except (MeetingNotFoundError, KnowledgeBaseNotFoundError) as exc:
            raise api_error(exc) from exc

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
        if isinstance(exc, KnowledgeBaseNotFoundError):
            return HTTPException(status_code=404, detail="knowledge base not found")
        if isinstance(exc, MeetingNotFoundError):
            return HTTPException(status_code=404, detail="meeting not found")
        if isinstance(exc, MinutesNotFoundError):
            return HTTPException(status_code=404, detail="MOM has not been generated")
        if isinstance(exc, TranscriptSegmentNotFoundError):
            return HTTPException(status_code=404, detail="transcript segment not found")
        if isinstance(exc, TranscriptReviewConflictError):
            return HTTPException(status_code=409, detail=str(exc))
        if isinstance(exc, SpeakerIdentityConflictError):
            return HTTPException(status_code=409, detail=str(exc))
        if isinstance(exc, MinutesDeletionConflictError):
            return HTTPException(status_code=409, detail=str(exc))
        if isinstance(exc, (MeetingConflictError, MinutesConflictError, PostMeetingJobConflictError, STTRouteError, ProviderSelectionError)):
            return HTTPException(status_code=409, detail=str(exc))
        if isinstance(exc, (MinutesGenerationError, ProviderExecutionError)):
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

    @app.get("/ready")
    def ready() -> dict[str, str | int]:
        """Readiness checks the database, unlike the process-only liveness route."""
        try:
            with database.engine.connect() as connection:
                version = connection.execute(
                    select(SchemaVersionRow.version)
                    .order_by(SchemaVersionRow.version.desc()).limit(1)
                ).scalar_one_or_none()
        except SQLAlchemyError as exc:
            raise HTTPException(status_code=503, detail="database is unavailable") from exc
        if version != database.SCHEMA_VERSION:
            raise HTTPException(status_code=503, detail="database schema is not current")
        return {"status": "ready", "schema_version": version}

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

    @app.get("/v1/integrations/resend/status")
    def resend_status() -> dict[str, object]:
        """Local configuration check; domain acceptance is confirmed by an actual send."""
        return resend.configuration()

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

    @app.delete("/v1/provider-profiles/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_profile(profile_id: UUID) -> Response:
        try:
            service.delete(profile_id)
        except ProfileNotFoundError as exc:
            raise api_error(exc) from exc
        return Response(status_code=status.HTTP_204_NO_CONTENT)

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
        ProviderSelectionError,
        STTRouteError,
    )

    @app.get("/v1/calendar/connections", response_model=list[CalendarConnection])
    async def calendar_connections(request: Request) -> list[CalendarConnection]:
        try:
            return await calendar.connections(request.state.actor)
        except CalendarError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.post("/v1/calendar/connect/{provider}", response_model=CalendarConnectResponse)
    async def calendar_connect(provider: CalendarProvider, request: Request) -> CalendarConnectResponse:
        callback_url = os.getenv("APP_BASE_URL", "http://localhost:3020").rstrip("/") + "/?calendar=connected"
        try:
            return await calendar.connect(request.state.actor, provider, callback_url)
        except CalendarError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.get("/v1/calendar/events", response_model=CalendarEventsResponse)
    async def calendar_events(request: Request, connection_id: str, period: CalendarRange = "today", timezone: str = "UTC") -> CalendarEventsResponse:
        try:
            return await calendar.events(request.state.actor, connection_id, period, timezone)
        except CalendarError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/v1/calendar/schedules", response_model=list[CalendarSchedulePublic])
    def calendar_schedules(request: Request) -> list[CalendarSchedulePublic]:
        return calendar_schedule.list(request.state.actor)

    @app.get("/v1/calendar/schedules/{meeting_id}", response_model=CalendarSchedulePublic)
    def calendar_schedule_get(meeting_id: UUID, request: Request) -> CalendarSchedulePublic:
        scheduled = calendar_schedule.get(request.state.actor, meeting_id)
        if scheduled is None:
            raise HTTPException(status_code=404, detail="scheduled meeting not found")
        return scheduled

    @app.post("/v1/calendar/schedules", status_code=201)
    async def calendar_schedule_create(payload: ScheduleCreate, request: Request) -> dict[str, object]:
        try:
            scheduled, meeting = await calendar_schedule.create(request.state.actor, payload)
            return {"schedule": scheduled.model_dump(mode="json"), "meeting": meeting.model_dump(mode="json")}
        except (CalendarScheduleError, CalendarError, MeetingValidationError, KnowledgeBaseNotFoundError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/v1/calendar/schedules/{meeting_id}/cancel", response_model=CalendarSchedulePublic)
    def calendar_schedule_cancel(meeting_id: UUID, request: Request) -> CalendarSchedulePublic:
        try:
            return calendar_schedule.cancel(request.state.actor, meeting_id)
        except CalendarScheduleError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post(
        "/v1/meetings", response_model=MeetingPublic, status_code=status.HTTP_201_CREATED
    )
    def create_meeting(payload: MeetingCreate) -> MeetingPublic:
        try:
            return meeting_service.to_public(meeting_service.create(payload))
        except (MeetingValidationError, KnowledgeBaseNotFoundError) as exc:
            raise api_error(exc) from exc

    @app.get("/v1/meetings/{meeting_id}/delivery-settings", response_model=MeetingDeliverySettings)
    def get_delivery_settings(meeting_id: UUID) -> MeetingDeliverySettings:
        try:
            return repository.get_delivery_settings(meeting_id)
        except MeetingNotFoundError as exc:
            raise api_error(exc) from exc

    @app.get("/v1/meetings/{meeting_id}/transcription-route")
    def get_transcription_route(meeting_id: UUID) -> dict[str, object]:
        try:
            meeting = repository.get_meeting(meeting_id)
        except MeetingNotFoundError as exc:
            raise api_error(exc) from exc
        selected = repository.get_transcription_route(meeting_id)
        if selected:
            return {"mode": "profile", **selected}
        return {
            "mode": "vexa_deployment" if meeting.vexa_meeting_id is not None else "pending",
            "profile_id": None, "profile_name": None, "provider_type": None,
            "model": None, "endpoint_host": None, "selected_at": None,
        }

    @app.put("/v1/meetings/{meeting_id}/delivery-settings", response_model=MeetingDeliverySettings)
    def save_delivery_settings(meeting_id: UUID, payload: MeetingDeliverySettings) -> MeetingDeliverySettings:
        try:
            return repository.save_delivery_settings(meeting_id, payload)
        except MeetingNotFoundError as exc:
            raise api_error(exc) from exc

    @app.get("/v1/meetings/{meeting_id}/post-meeting-job")
    def get_post_meeting_job(meeting_id: UUID) -> dict[str, object]:
        try:
            repository.get_meeting(meeting_id)
        except MeetingNotFoundError as exc:
            raise api_error(exc) from exc
        return post_meeting_job_response(repository.get_post_meeting_job(meeting_id))

    def post_meeting_job_response(job: object | None) -> dict[str, object]:
        return {
            "enabled": job is not None,
            "attempts": job.attempts if job else 0,
            "next_retry_at": job.next_retry_at if job else None,
            "last_error": job.last_error if job else None,
            "completed_at": job.completed_at if job else None,
            "exhausted": bool(job and job.attempts >= 5),
        }

    @app.post("/v1/meetings/{meeting_id}/post-meeting-job/retry")
    async def retry_post_meeting_job(meeting_id: UUID) -> dict[str, object]:
        try:
            return post_meeting_job_response(await worker.retry(meeting_id))
        except (MeetingNotFoundError, PostMeetingJobConflictError) as exc:
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

    @app.delete("/v1/meetings/{meeting_id}", status_code=204)
    async def delete_meeting(meeting_id: UUID) -> Response:
        try:
            await meeting_service.delete(meeting_id)
        except MEETING_EXCEPTIONS as exc:
            raise api_error(exc) from exc
        return Response(status_code=204)

    @app.post("/v1/meetings/{meeting_id}/join", response_model=MeetingPublic)
    async def join_meeting(meeting_id: UUID, request: Request) -> MeetingPublic:
        try:
            scheduled = calendar_schedule.get(request.state.actor, meeting_id)
            if scheduled and scheduled.status in {"pending", "joining"}:
                raise HTTPException(status_code=409, detail="this event is scheduled; cancel its automatic join before joining manually")
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

    @app.get("/v1/meetings/{meeting_id}/participants", response_model=MeetingParticipantsResponse)
    async def get_meeting_participants(meeting_id: UUID) -> MeetingParticipantsResponse:
        try:
            return await meeting_service.participants(meeting_id)
        except MEETING_EXCEPTIONS as exc:
            raise api_error(exc) from exc

    @app.put(
        "/v1/meetings/{meeting_id}/transcript/segments/{segment_id}/speaker",
        response_model=MeetingTranscriptResponse,
    )
    def correct_transcript_speaker(
        meeting_id: UUID, segment_id: str, payload: SpeakerCorrectionRequest
    ) -> MeetingTranscriptResponse:
        try:
            meeting = repository.get_meeting(meeting_id)
            if meeting.vexa_meeting_id is None:
                raise MeetingConflictError("meeting has no transcript")
            repository.correct_speaker(
                meeting_id, segment_id,
                (payload.display_name.strip() or None) if payload.display_name else None,
                payload.apply_to_raw_label,
            )
            segments = repository.get_transcript(meeting_id)
            return MeetingTranscriptResponse(
                meeting_id=meeting_id, vexa_meeting_id=meeting.vexa_meeting_id,
                status=meeting.status, segments=segments, segment_count=len(segments),
            )
        except (MeetingNotFoundError, MeetingConflictError, TranscriptSegmentNotFoundError, TranscriptReviewConflictError) as exc:
            raise api_error(exc) from exc

    @app.get("/v1/meetings/{meeting_id}/speaker-identities", response_model=list[SpeakerIdentityPublic])
    def list_speaker_identities(meeting_id: UUID) -> list[SpeakerIdentityPublic]:
        try:
            return repository.list_speaker_identities(meeting_id)
        except MeetingNotFoundError as exc:
            raise api_error(exc) from exc

    @app.put("/v1/meetings/{meeting_id}/speaker-identities", response_model=list[SpeakerIdentityPublic])
    def save_speaker_identity(
        meeting_id: UUID, payload: SpeakerIdentityRequest
    ) -> list[SpeakerIdentityPublic]:
        try:
            return repository.save_speaker_identity(meeting_id, payload.speaker, payload.email)
        except (MeetingNotFoundError, SpeakerIdentityConflictError) as exc:
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

    @app.delete("/v1/meetings/{meeting_id}/minutes", status_code=204)
    def delete_meeting_minutes(meeting_id: UUID) -> Response:
        try:
            repository.delete_minutes(meeting_id)
        except (MeetingNotFoundError, MinutesNotFoundError, MinutesDeletionConflictError) as exc:
            raise api_error(exc) from exc
        return Response(status_code=204)

    @app.post(
        "/v1/meetings/{meeting_id}/minutes/generate",
        response_model=MeetingMinutesPublic,
    )
    async def generate_meeting_minutes(meeting_id: UUID) -> MeetingMinutesPublic:
        try:
            minutes_service.require_not_sent(meeting_id)
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

    @app.post("/v1/meetings/{meeting_id}/minutes/send-configured", response_model=EmailDeliveryPublic)
    async def send_configured_minutes(meeting_id: UUID) -> EmailDeliveryPublic:
        try:
            settings = repository.get_delivery_settings(meeting_id)
            if not settings.internal_recipients:
                raise MinutesConflictError("configure at least one internal recipient before sending")
            recipients = list(settings.internal_recipients)
            if settings.send_to_participants:
                recipients.extend(settings.participant_recipients)
            payload = MinutesEmailRequest(
                recipients=list(dict.fromkeys(recipients)),
                include_transcript=settings.include_transcript,
            )
            return minutes_service.delivery_to_public(await minutes_service.send(meeting_id, payload))
        except MINUTES_EXCEPTIONS as exc:
            raise api_error(exc) from exc

    return app


app = create_app()
