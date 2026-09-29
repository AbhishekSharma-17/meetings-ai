import os
import asyncio
import json
import logging
import re
from datetime import date
from dataclasses import replace
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, File, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
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
    MomGuidance,
    MeetingListResponse,
    MeetingMinutesDraft,
    MeetingMinutesPublic,
    MeetingPublic,
    MeetingStatus,
    MeetingParticipantsResponse,
    MeetingParticipant,
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
from .composio_calendar import CalendarConnection, WorkspaceCalendarConnection, CalendarConnectRequest, CalendarAliasRequest, CalendarConnectResponse, CalendarEvent, CalendarEventsResponse, CalendarError, CalendarProvider, CalendarRange, ComposioCalendar, calendar_callback_url
from .calendar_schedule import CalendarScheduleError, CalendarSchedulePublic, CalendarScheduleService, ManualScheduleCreate, ScheduleCreate
from .calendar_cache import CalendarCacheService, CalendarSyncRequest, CalendarSyncResponse, CachedCalendarResponse
from .calendar_watch import CalendarWatchService, WatchSettings
from .calendar_watch_apply import CalendarChangeApplier
from .routes_calendar_changes import register_calendar_change_routes
from .meeting_prep import OrganizationBriefService, OrganizationBrief, BriefDocument, MeetingPrepService, PrepError
from .routes_prep import register_prep_routes
from .organization_identity import OrganizationIdentityService
from .routes_identity import register_identity_routes
from .background_wiring import install_background_services, leadership_callbacks, stop_background_services
from .routes_people import register_people_routes
from .recipient_groups import RecipientGroupService
from .routes_teams import register_team_routes
from .routes_preferences import register_preference_routes
from .user_preferences import UserPreferenceService
from .repository import RecipientGroupNotFoundError
from .routes_speakers import register_speaker_routes
from .leader import LeaderElection, leader_lock_for
from .leave_notices import LeaveNotices
from .leave_service import LeaveService
from .leave_store import LeavePolicyService, MeetingLeaveStore, service_max_hours_from_env
from .leave_watchdog import LeaveWatchdog
from .routes_leave import register_leave_routes
from .call_coordination import CallCoordinationService
from .coordination_notices import CoordinationNotices
from .routes_call_coordination import member_route_allowed, register_call_coordination_routes
from .profile_photos import ProfilePhotoService
from .database import Database, SchemaVersionRow, LEGACY_ADMIN_USER_ID, LEGACY_ORGANIZATION_ID
from .accounts import AccountError, AccountPublic, AccountService, Actor, ChangePasswordRequest, MemberRolePatch, OrganizationCreateRequest, OrganizationOption, ProfilePatch
from .routes_account_links import PUBLIC_ACCOUNT_LINK_PATHS, register_account_link_routes
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
from .service import ProfilePermissionError, ProfileValidationError, ProviderProfileService, ProviderSelectionError
from .credential_vault import CredentialVault
from .ai_settings import AiSettingsService
from .routes_ai import register_ai_routes
from .routes_models import register_model_catalog_routes
from .chunk_store import ChunkStore
from .retrieval import ChunkRetriever
from .document_vision import VisionService
from .documents import DocumentService
from .indexing_worker import IndexingWorker
from .routes_documents import register_document_routes
from .model_catalog import ModelCatalogError, ModelCatalogService, TextModelCatalog
from .usage import UsageLedger
from .routes_usage import register_usage_routes
from .storage import StorageService
from .storage_purge import StoragePurgeService
from .routes_storage import register_storage_routes
from .provider_balances import ProviderBalanceService
from .routes_balances import register_balance_routes
from .stt_route import STTRouteError
from .tenant import tenant_scope
from .workspace_service import WorkspacePatch, WorkspacePublic, WorkspaceMemberPublic, WorkspaceService
from .sqlalchemy_repository import SQLAlchemyRepository, TranscriptSegmentNotFoundError, TranscriptReviewConflictError, SpeakerIdentityConflictError, MinutesDeletionConflictError
from .rate_limit import provider_defaults_limiter, provider_test_limiter

logger = logging.getLogger(__name__)
# Graceful shutdown must hand background leadership on within Railway's 10 s drain window.
SHUTDOWN_SECONDS = 8.0


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if key.lower() in {"api_key", "token", "secret", "password"} else _redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def _viewer_timezone(request: Request, requested: str | None) -> str:
    """The zone the browser asked for, else the signed-in person's effective time zone."""
    if requested:
        return requested
    actor = request.state.actor
    return request.app.state.user_preferences.time_preferences(actor.user_id).timezone if actor else "UTC"


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
    model_catalog = ModelCatalogService()
    usage = UsageLedger(database, model_catalog)
    vault = CredentialVault(database, cipher, usage)
    service = ProviderProfileService(repository, usage, vault)
    ai_settings = AiSettingsService(database, repository, vault, model_catalog)
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
    knowledge_service = KnowledgeService(repository, service, knowledge_bases, ai_settings=ai_settings)
    chunk_store = ChunkStore(database, service)
    chunk_retriever = ChunkRetriever(database, chunk_store)
    knowledge_index = KnowledgeIndexService(database, knowledge_service, knowledge_bases, service, chunk_store, chunk_retriever)
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
    calendar_cache = CalendarCacheService(database, calendar)
    organization_brief = OrganizationBriefService(database)
    organization_identity = OrganizationIdentityService(database)
    meeting_prep = MeetingPrepService(database, calendar_cache, organization_brief, service,
                                      usage=usage, vault=vault, ai_settings=ai_settings,
                                      retriever=chunk_retriever, identities=organization_identity)
    calendar_schedule = CalendarScheduleService(database, calendar, meeting_service)
    calendar_changes = CalendarChangeApplier(database)
    calendar_watch = CalendarWatchService(database, calendar, calendar_changes, WatchSettings.from_env())
    # Scheduled joins re-verify with the calendar first; manual syncs report moved events.
    calendar_schedule.watcher = calendar_watch
    calendar_cache.changes = calendar_watch
    document_service = DocumentService(database, VisionService(database, service, ai_settings), chunk_store)
    ai_settings.vision = document_service.vision
    indexing_worker = IndexingWorker(database, document_service, chunk_store, knowledge_index, service)
    if bool(admin_password) != bool(session_secret):
        raise RuntimeError("admin password and session secret must both be configured")
    admin = AdminSession(session_secret) if admin_password else None

    def start_loops() -> list[asyncio.Task[None]]:
        tasks = []
        if os.getenv("AUTO_MOM_ENABLED") == "1":
            tasks.append(asyncio.create_task(worker.run()))
        if os.getenv("AUTO_KNOWLEDGE_INDEX_ENABLED") == "1":
            tasks.append(asyncio.create_task(indexing_worker.run()))
        if os.getenv("AUTO_RETENTION_ENABLED") == "1":
            tasks.append(asyncio.create_task(retention.run()))
        if os.getenv("AUTO_CALENDAR_SCHEDULE_ENABLED") == "1":
            tasks.append(asyncio.create_task(calendar_schedule.run()))
            if calendar_watch.enabled:
                tasks.append(asyncio.create_task(calendar_watch.run()))
        # On by default: an assistant that never leaves a call is worse than any other failure here.
        if os.getenv("AUTO_LEAVE_ENABLED", "1") != "0":
            tasks.append(asyncio.create_task(leave_watchdog.run()))
        # Every PROVIDER_BALANCE_CHECK_HOURS (default 6, 0 = off): low-credit alerts for saved keys.
        if balances.interval_seconds > 0:
            tasks.append(asyncio.create_task(balances.run()))
        return tasks

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        # Background loops and job recovery assume they are alone, so only the process holding the
        # leader lock runs them; during a deploy the new process waits for the old one to exit
        # before taking over (see leader.py). Every process serves requests.
        lead, step_down = leadership_callbacks(app, start_loops)
        election = LeaderElection(leader_lock_for(database), start=lead, stop=step_down)
        await election.try_lead_now()  # a lone process recovers before it serves requests
        leader_task = asyncio.create_task(election.run())
        try:
            yield
        finally:
            # Cancel this process's jobs first, then hand leadership on, so the next leader's
            # recovery sees their final state. Bounded so shutdown fits Railway's drain window.
            await stop_background_services(app)
            leader_task.cancel()
            try:
                await asyncio.wait_for(asyncio.gather(leader_task, return_exceptions=True), SHUTDOWN_SECONDS)
            except TimeoutError:
                logger.warning("background leadership did not hand over cleanly before shutdown")
            await vexa.close()
            database.engine.dispose()

    app = FastAPI(title="Meetings AI API", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[os.getenv("WEB_ORIGIN", "http://localhost:3020")],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "Idempotency-Key", "X-Provider-Key"],
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
    app.state.calendar_cache = calendar_cache
    app.state.organization_brief = organization_brief
    app.state.meeting_prep = meeting_prep
    app.state.calendar_schedule = calendar_schedule
    app.state.calendar_watch = calendar_watch
    register_calendar_change_routes(app, database=database, calendar_schedule=calendar_schedule,
                                    calendar_cache=calendar_cache)
    storage = StorageService(database, vexa)
    app.state.storage = storage
    register_usage_routes(app, usage=usage, database=database)
    register_storage_routes(app, storage=storage, purger=StoragePurgeService(
        database, storage, meeting_service, knowledge_bases, audit))
    app.state.credential_vault = vault
    app.state.ai_settings = ai_settings
    register_ai_routes(app, vault=vault, ai_settings=ai_settings)
    register_model_catalog_routes(app, model_catalog=model_catalog, repository=repository, vault=vault)
    app.state.chunk_retriever = chunk_retriever
    app.state.document_service = document_service
    app.state.indexing_worker = indexing_worker
    register_document_routes(app, documents=document_service)
    register_prep_routes(app, meeting_prep=meeting_prep)
    app.state.organization_identity = organization_identity
    register_identity_routes(app, identities=organization_identity)
    profile_photos = ProfilePhotoService(database)
    register_people_routes(app, accounts=accounts, photos=profile_photos)
    teams = RecipientGroupService(database)
    app.state.teams = teams
    register_team_routes(app, teams=teams)
    user_preferences = UserPreferenceService(database)
    app.state.user_preferences = user_preferences
    register_preference_routes(app, preferences=user_preferences)
    register_speaker_routes(app, repository=repository, meeting_service=meeting_service,
                            calendar_schedule=calendar_schedule, workspace_service=workspace_service)
    install_background_services(
        app, database=database, meeting_prep=meeting_prep, repository=repository, meeting_service=meeting_service,
        minutes_service=minutes_service, post_meeting_worker=worker, calendar_schedule=calendar_schedule,
        knowledge_index=knowledge_index, knowledge_bases=knowledge_bases, indexing_worker=indexing_worker,
    )
    calendar_changes.events = app.state.notification_events
    # Vexa ends every call after BOT_MAX_ACTIVE_MS (4 h unless raised); never promise longer than that.
    leave_policies = LeavePolicyService(database, service_max_hours_from_env(os.getenv("VEXA_MAX_BOT_HOURS")))
    leave_notices = LeaveNotices(app.state.notifications)
    leave_service = LeaveService(database, repository, leave_policies, MeetingLeaveStore(database), leave_notices)
    meeting_service.leave = leave_service
    leave_watchdog = LeaveWatchdog(database, meeting_service, leave_service, leave_notices)
    app.state.leave_service = leave_service
    app.state.leave_watchdog = leave_watchdog
    register_leave_routes(app, policies=leave_policies, leave=leave_service)
    # Call coordination: teammates who set an assistant for the same call decide who brings it.
    call_coordination = CallCoordinationService(database, CoordinationNotices(app.state.notifications), repository)
    calendar_schedule.coordination = meeting_service.coordination = calendar_cache.coordination = call_coordination
    app.state.call_coordination = call_coordination
    register_call_coordination_routes(app, coordination=call_coordination, minutes_service=minutes_service)
    balances = ProviderBalanceService(database, vault, app.state.notifications)
    app.state.provider_balances = balances
    service.credit_alerts = balances  # out-of-credit model calls raise an alert (see ProfileService)
    meeting_prep.credit_alerts = balances  # and so do Exa 402s during research
    register_balance_routes(app, balances=balances)

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
                "/v1/auth/login", "/v1/auth/session", "/v1/auth/logout", *PUBLIC_ACCOUNT_LINK_PATHS,
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
                        or (method == "GET" and re.fullmatch(r"/v1/workspace/teams(?:/[0-9a-f-]{36})?", path))
                        or (method == "POST" and (path == "/v1/workspaces" or re.fullmatch(r"/v1/workspaces/[0-9a-f-]+/switch", path)))
                        or (path.startswith("/v1/knowledge-bases") and method in {"GET", "POST", "PATCH"})
                        or (method == "DELETE" and re.fullmatch(r"/v1/knowledge-bases/[0-9a-f-]+", path))
                        or (method == "DELETE" and re.fullmatch(r"/v1/knowledge-bases/[0-9a-f-]+/conversations/[0-9a-f-]+", path))
                        or (method == "PUT" and re.fullmatch(r"/v1/knowledge-bases/[0-9a-f-]+/sharing", path))
                        or (path in {"/v1/knowledge/search", "/v1/knowledge/chat", "/v1/knowledge/chat/stream"} and method == "POST")
                        or (method == "GET" and path == "/v1/knowledge/text-profiles")
                        or (method == "GET" and path == "/v1/ai/settings")
                        or path == "/v1/auth/me"
                        or (method in {"GET", "PUT"} and path == "/v1/me/preferences")
                        or (method == "POST" and path == "/v1/me/preferences/detected")
                        or (method in {"PUT", "DELETE"} and path == "/v1/auth/me/photo")
                        or (method == "PUT" and path == "/v1/workspaces/default")
                        or (method == "GET" and re.fullmatch(r"/v1/users/[0-9a-f-]{36}/photo", path))
                        or (path == "/v1/calendar/connections" and method == "GET")
                        or (method == "DELETE" and re.fullmatch(r"/v1/calendar/connections/[^/]+", path))
                        or (method == "PATCH" and re.fullmatch(r"/v1/calendar/connections/[^/]+", path))
                        or (re.fullmatch(r"/v1/calendar/connect/(googlecalendar|outlook|calendly|zoom)", path) and method == "POST")
                        or (path == "/v1/calendar/events" and method == "GET")
                        or (path == "/v1/calendar/synced" and method == "GET")
                        or (path == "/v1/calendar/sync" and method == "POST")
                        or (method in {"GET", "POST"} and re.fullmatch(r"/v1/calendar/events/[0-9a-f-]+/prep(?:/stream)?", path))
                        or (method in {"GET", "PUT"} and re.fullmatch(r"/v1/calendar/events/[0-9a-f-]+/prep/inputs", path))
                        or (method == "GET" and re.fullmatch(r"/v1/calendar/events/[0-9a-f-]+/prep/history", path))
                        or (method == "GET" and re.fullmatch(r"/v1/calendar/events/[0-9a-f-]+/changes", path))
                        or (method == "POST" and re.fullmatch(r"/v1/calendar/events/[0-9a-f-]+/prep/whos-who", path))
                        or (method == "GET" and path == "/v1/workspace/identity")
                        or (method == "GET" and path == "/v1/workspace/leave-policy")
                        or (method == "POST" and re.fullmatch(r"/v1/calendar/events/[0-9a-f-]+/prep/jobs", path))
                        or (method == "GET" and re.fullmatch(r"/v1/background-jobs(?:/[0-9a-f-]{36})?", path))
                        or (method == "POST" and re.fullmatch(r"/v1/background-jobs/[0-9a-f-]{36}/cancel", path))
                        or (method == "GET" and path in {"/v1/notifications", "/v1/notifications/unread-count"})
                        or (method == "POST" and re.fullmatch(r"/v1/notifications/(?:read-all|[0-9a-f-]{36}/read)", path))
                        or (method == "DELETE" and re.fullmatch(r"/v1/notifications(?:/[0-9a-f-]{36})?", path))
                        or (method == "GET" and path in {"/v1/workspace/brief", "/v1/workspace/brief/documents"})
                        or (method in {"GET", "POST", "DELETE"} and re.fullmatch(r"/v1/documents(?:/url|/[0-9a-f-]{36}(?:/reindex)?)?", path))
                        or (method == "GET" and re.fullmatch(r"/v1/meetings/[0-9a-f-]+(?:/transcript|/leave)?", path))
                        or member_route_allowed(method, path)
                    )
                    if not allowed:
                        return JSONResponse(status_code=403, content={"detail": "workspace role does not permit this action"})
                    if actor.role == "viewer" and path == "/v1/knowledge-bases" and method == "POST":
                        return JSONResponse(status_code=403, content={"detail": "viewers cannot create knowledge bases"})
                    match = re.fullmatch(r"/v1/meetings/([0-9a-f-]+)(?:/transcript|/leave)?", path)
                    # A meeting whose assistant covers this person (owner or sharing) is readable at any status.
                    if match and not (method == "GET" and call_coordination.can_read(actor, match.group(1))):
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
                    and path not in {"/v1/auth/login", "/v1/auth/logout", *PUBLIC_ACCOUNT_LINK_PATHS} and response.status_code < 400 \
                    and not path.startswith("/v1/notifications") and not path.endswith("/prep/whos-who") \
                    and path != "/v1/me/preferences/detected":  # reading notifications / browser zone reports are not activity
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
        actor = request.state.actor
        return accounts.public(actor).model_copy(update={"photo_url": profile_photos.url_for(actor.user_id)}).model_dump(mode="json")

    @app.patch("/v1/auth/me", response_model=AccountPublic)
    def update_auth_profile(payload: ProfilePatch, request: Request) -> AccountPublic:
        try:
            updated = accounts.public(accounts.update_profile(request.state.actor, payload))
            return updated.model_copy(update={"photo_url": profile_photos.url_for(updated.user_id)})
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

    def set_workspace_session(response: Response, actor: Actor) -> None:
        if not admin:
            return
        response.set_cookie(
            "meetings_ai_session", admin.issue(actor.user_id, actor.organization_id, actor.session_version),
            httponly=True, secure=os.getenv("APP_ENV") == "production",
            samesite="strict", max_age=60 * 60 * 12, path="/",
        )

    register_account_link_routes(
        app, accounts=accounts, resend=resend, audit=audit, database=database,
        signing_key=session_secret or resolved_credential_key, sessions_enabled=admin is not None,
        set_session=set_workspace_session, web_origin=os.getenv("WEB_ORIGIN", "http://localhost:3020"),
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
        except ProfileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="text provider not found") from exc
        except ModelCatalogError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.post("/v1/knowledge/chat/stream")
    async def stream_knowledge_chat(payload: KnowledgeQuery, request: Request) -> StreamingResponse:
        actor = request.state.actor
        try:
            # Provider/model come from the owner's workspace AI settings; any
            # client-sent text_profile_id/model_id is ignored by KnowledgeService.
            if payload.knowledge_base_id:
                knowledge_bases.get(payload.knowledge_base_id, actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="knowledge base not found") from exc
        except KnowledgeAccessError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except ProfileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="text provider not found") from exc
        except ModelCatalogError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        async def events():
            queue: asyncio.Queue[tuple[str, object]] = asyncio.Queue()

            async def emit(delta: str) -> None:
                await queue.put(("delta", delta))

            async def run_chat() -> None:
                try:
                    with tenant_scope(actor.organization_id):
                        result = await knowledge_service.chat(payload, actor, emit)
                    await queue.put(("final", result.model_dump(mode="json")))
                except (KnowledgeAnswerError, KnowledgeBaseNotFoundError, KnowledgeAccessError, ProfileNotFoundError) as exc:
                    await queue.put(("error", str(exc)))
                except Exception:
                    logging.exception("Knowledge chat stream failed")
                    await queue.put(("error", "The answer could not be completed. Please try again."))
                finally:
                    await queue.put(("done", None))

            task = asyncio.create_task(run_chat())
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

    @app.get("/v1/knowledge/text-profiles", response_model=list[ProfilePublic])
    def list_knowledge_text_profiles() -> list[ProfilePublic]:
        return [service.to_public(profile) for profile in repository.list_profiles()
                if profile.supports(Capability.TEXT_GENERATION)]

    @app.get("/v1/knowledge/text-profiles/{profile_id}/models", response_model=TextModelCatalog)
    async def list_knowledge_models(profile_id: UUID) -> TextModelCatalog:
        try:
            return await model_catalog.list_for(repository.get_profile(profile_id))
        except ProfileNotFoundError as exc:
            raise api_error(exc) from exc
        except ModelCatalogError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.post(
        "/v1/provider-profiles",
        response_model=ProfilePublic,
        status_code=status.HTTP_201_CREATED,
    )
    def create_profile(payload: ProfileCreate, request: Request) -> ProfilePublic:
        try:
            return service.to_public(service.create(payload, request.state.actor))
        except (ProfileNotFoundError, ProfileValidationError) as exc:
            raise api_error(exc) from exc
        except ProfilePermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc

    @app.patch("/v1/provider-profiles/{profile_id}", response_model=ProfilePublic)
    def update_profile(profile_id: UUID, payload: ProfileUpdate, request: Request) -> ProfilePublic:
        try:
            return service.to_public(service.update(profile_id, payload, request.state.actor))
        except (ProfileNotFoundError, ProfileValidationError) as exc:
            raise api_error(exc) from exc
        except ProfilePermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc

    @app.delete("/v1/provider-profiles/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_profile(profile_id: UUID) -> Response:
        try:
            service.delete(profile_id)
        except ProfileNotFoundError as exc:
            raise api_error(exc) from exc
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    profile_test_limit = provider_test_limiter()
    defaults_limit = provider_defaults_limiter()

    @app.post(
        "/v1/provider-profiles/{profile_id}/test", response_model=AdapterTestResult
    )
    async def test_profile(profile_id: UUID, request: Request) -> AdapterTestResult:
        profile_test_limit.check(request.state.actor.user_id)
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
        capability: Capability, payload: DefaultSelectionRequest, request: Request
    ) -> DefaultSelectionResponse:
        defaults_limit.check(request.state.actor.user_id)
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

    @app.delete("/v1/calendar/connections/{connection_id}", status_code=204)
    async def calendar_disconnect(connection_id: str, request: Request) -> Response:
        try:
            await calendar.disconnect(request.state.actor, connection_id)
        except CalendarError as exc:
            code = 404 if "not found for your account" in str(exc) else 503
            raise HTTPException(status_code=code, detail=str(exc)) from exc
        # The account's meetings disappear from the calendar immediately, not on the next sync.
        calendar_cache.forget_connection(request.state.actor, connection_id)
        return Response(status_code=204)

    @app.patch("/v1/calendar/connections/{connection_id}", response_model=CalendarConnection)
    async def calendar_rename(connection_id: str, payload: CalendarAliasRequest, request: Request) -> CalendarConnection:
        try:
            return await calendar.rename(request.state.actor, connection_id, payload.alias)
        except CalendarError as exc:
            code = 404 if "not found for your account" in str(exc) else 409 if "alias already in use" in str(exc) else 503
            raise HTTPException(status_code=code, detail=str(exc)) from exc

    @app.get("/v1/workspace/calendar-connections", response_model=list[WorkspaceCalendarConnection])
    async def workspace_calendar_connections(request: Request) -> list[WorkspaceCalendarConnection]:
        actor = request.state.actor
        if not actor.is_admin:
            raise HTTPException(status_code=403, detail="workspace administrator access required")
        members = workspace_service.list_members()
        gate = asyncio.Semaphore(5)

        async def for_member(member):
            async with gate:
                member_actor = replace(actor, user_id=member.user_id)
                connections = await calendar.connections(member_actor)
                return [WorkspaceCalendarConnection(**connection.model_dump(), user_id=str(member.user_id),
                                                    user_name=member.display_name, user_email=member.email)
                        for connection in connections]

        try:
            batches = await asyncio.gather(*(for_member(member) for member in members))
        except CalendarError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return [connection for batch in batches for connection in batch]

    @app.get("/v1/workspace/brief", response_model=OrganizationBrief)
    def get_organization_brief(request: Request) -> OrganizationBrief:
        return organization_brief.get(request.state.actor)

    @app.put("/v1/workspace/brief", response_model=OrganizationBrief)
    def save_organization_brief(payload: OrganizationBrief, request: Request) -> OrganizationBrief:
        try:
            return organization_brief.save(request.state.actor, payload)
        except PrepError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc

    # /v1/workspace/brief/documents routes live in routes_documents.py (DocumentService).

    @app.post("/v1/calendar/connect/{provider}", response_model=CalendarConnectResponse)
    async def calendar_connect(provider: CalendarProvider, request: Request, payload: CalendarConnectRequest | None = None) -> CalendarConnectResponse:
        try:
            callback_url = calendar_callback_url(
                payload.callback_origin if payload else None,
                os.getenv("APP_BASE_URL", "http://localhost:3020"),
                os.getenv("APP_ENV", "development"),
                popup=bool(payload and payload.popup),
            )
            return await calendar.connect(request.state.actor, provider, callback_url, payload.alias if payload else None)
        except CalendarError as exc:
            code = 400 if "callback origin" in str(exc) else 409 if "alias already in use" in str(exc) else 503
            raise HTTPException(status_code=code, detail=str(exc)) from exc

    @app.get("/v1/calendar/events", response_model=CalendarEventsResponse)
    async def calendar_events(request: Request, connection_id: str, period: CalendarRange = "today", timezone: str | None = None) -> CalendarEventsResponse:
        try:
            return await calendar.events(request.state.actor, connection_id, period, _viewer_timezone(request, timezone))
        except CalendarError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/v1/calendar/synced", response_model=CachedCalendarResponse)
    def saved_calendar_events(request: Request, start_date: date, end_date: date, timezone: str | None = None) -> CachedCalendarResponse:
        try:
            return calendar_cache.list(request.state.actor, start_date, end_date, _viewer_timezone(request, timezone))
        except CalendarError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/v1/calendar/sync", response_model=CalendarSyncResponse)
    async def sync_calendar_events(payload: CalendarSyncRequest, request: Request) -> CalendarSyncResponse:
        try:
            if not payload.timezone:
                payload = payload.model_copy(update={"timezone": _viewer_timezone(request, None)})
            return await calendar_cache.sync(request.state.actor, payload)
        except CalendarError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/v1/calendar/schedules", response_model=list[CalendarSchedulePublic])
    def calendar_schedules(request: Request) -> list[CalendarSchedulePublic]:
        return calendar_schedule.list(request.state.actor)

    @app.post("/v1/calendar/meetings", status_code=201)
    async def calendar_create_now(payload: ScheduleCreate, request: Request) -> dict[str, object]:
        try:
            meeting = await calendar_schedule.create_now(request.state.actor, payload)
            return {"meeting": meeting.model_dump(mode="json")}
        except (CalendarScheduleError, CalendarError, MeetingValidationError, KnowledgeBaseNotFoundError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

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

    @app.post("/v1/meetings/schedules", status_code=201)
    def manual_schedule_create(payload: ManualScheduleCreate, request: Request) -> dict[str, object]:
        try:
            scheduled, meeting = calendar_schedule.create_manual(request.state.actor, payload)
            return {"schedule": scheduled.model_dump(mode="json"), "meeting": meeting.model_dump(mode="json")}
        except (CalendarScheduleError, MeetingValidationError, KnowledgeBaseNotFoundError) as exc:
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

    @app.get("/v1/meetings/{meeting_id}/mom-guidance", response_model=MomGuidance)
    def get_mom_guidance(meeting_id: UUID) -> MomGuidance:
        try:
            return repository.get_mom_guidance(meeting_id)
        except MeetingNotFoundError as exc:
            raise api_error(exc) from exc

    @app.put("/v1/meetings/{meeting_id}/mom-guidance", response_model=MomGuidance)
    def save_mom_guidance(meeting_id: UUID, payload: MomGuidance) -> MomGuidance:
        try:
            minutes_service.require_not_sent(meeting_id)
            return repository.save_mom_guidance(meeting_id, payload)
        except MeetingNotFoundError as exc:
            raise api_error(exc) from exc
        except MinutesConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

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
        except RecipientGroupNotFoundError as exc:
            raise HTTPException(status_code=422, detail="one of the selected teams no longer exists") from exc

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
    async def join_meeting(meeting_id: UUID, request: Request, coordination: str | None = None) -> MeetingPublic:
        # coordination=own: send my own assistant although a teammate's is set for this call.
        if coordination not in {None, "own"}:
            raise HTTPException(status_code=422, detail="coordination must be 'own' when given")
        try:
            scheduled = calendar_schedule.get(request.state.actor, meeting_id)
            if scheduled and scheduled.status in {"pending", "joining"}:
                raise HTTPException(status_code=409, detail="this event is scheduled; cancel its automatic join before joining manually")
            actor = request.state.actor
            call_coordination.record_owner(actor.organization_id, meeting_id, actor.user_id)
            joined = await meeting_service.join(meeting_id)
            call_coordination.announce(actor, meeting_id, coordination)
            return meeting_service.to_public(joined)
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
    async def get_meeting_participants(meeting_id: UUID, request: Request) -> MeetingParticipantsResponse:
        try:
            response = await meeting_service.participants(meeting_id)
            source = calendar_schedule.source(request.state.actor, meeting_id)
            if source:
                known = {(person.email or "").lower() for person in response.participants if person.source == "invite"}
                response.participants = [
                    MeetingParticipant(name=person.name, email=person.email, source="invite", response_status=person.response_status)
                    for person in source.invitees if not person.email or person.email.lower() not in known
                ] + response.participants
            return response
        except MEETING_EXCEPTIONS as exc:
            raise api_error(exc) from exc

    @app.get("/v1/meetings/{meeting_id}/source", response_model=CalendarEvent)
    def get_meeting_source(meeting_id: UUID, request: Request) -> CalendarEvent:
        try:
            repository.get_meeting(meeting_id)
            source = calendar_schedule.source(request.state.actor, meeting_id)
            if source is None:
                raise HTTPException(status_code=404, detail="meeting has no connected source")
            return source
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

    MAX_RECAP_RECIPIENTS = 50  # MinutesEmailRequest's limit

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
            # Teams are expanded to their current members now, at send time.
            expansion = teams.expand(settings.internal_group_ids)
            internal = list(dict.fromkeys([*settings.internal_recipients, *expansion.emails]))
            # Internal recipients are optional: participants alone are a valid audience
            # (teammates are often already among them). Only an empty audience is refused.
            recipients = list(internal)
            if settings.send_to_participants:
                recipients.extend(settings.participant_recipients)
            recipients = list(dict.fromkeys(recipients))
            if not recipients:
                raise MinutesConflictError("choose at least one recipient — a teammate, a team or the meeting participants")
            if len(recipients) > MAX_RECAP_RECIPIENTS:
                raise MinutesConflictError(
                    f"this recap would go to {len(recipients)} addresses; the limit is {MAX_RECAP_RECIPIENTS} per send")
            payload = MinutesEmailRequest(recipients=recipients, include_transcript=settings.include_transcript)
            return minutes_service.delivery_to_public(
                await minutes_service.send(meeting_id, payload, groups=expansion.groups))
        except RecipientGroupNotFoundError as exc:
            # A targeted team was deleted between reading the settings and sending.
            raise HTTPException(status_code=422, detail="a selected team no longer exists; review the recipients and send again") from exc
        except MINUTES_EXCEPTIONS as exc:
            raise api_error(exc) from exc

    return app


app = create_app()
