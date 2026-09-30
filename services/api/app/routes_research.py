"""Routes for the Research page (Apollo Explorer). Owners, admins and members; never viewers.

Searches, look-ups, saves and chats spend Apollo credits or model tokens, so each is rate limited per
person on top of the daily Apollo cap. Apollo payloads and chat text are never logged.
"""

from __future__ import annotations

import re
from typing import Literal
from uuid import UUID

from fastapi import FastAPI, HTTPException, Query, Request, Response

from .documents import DocumentError, DocumentNotFoundError, KnowledgeDocument
from .rate_limit import SlidingWindowLimiter
from .research_actions import KnowledgeRequest, PrepareRequest, PrepareResult, ResearchActionError
from .research_chat import ResearchChatError, ResearchChatRequest, ResearchChatResponse
from .research_history import CompanyHistory, PersonHistory
from .research_models import (
    CompanySearchRequest, CompanySearchResponse, LookupRequest, LookupResponse, PeopleSearchRequest, PeopleSearchResponse,
    ResearchProfilePublic, ResearchStatus, SaveProfileRequest, SaveProfileResponse,
)
from .research_service import ResearchError, ResearchService
from .research_store import (
    ProfileNotFoundError, ResearchConversationPublic, ResearchConversationSummary, ResearchPermissionError,
)

WINDOW = 600
_ID = r"[0-9a-f-]{36}"
_PROFILE = rf"/v1/research/profiles/{_ID}"
_MEMBER_ROUTES = (
    ("GET", re.compile(r"/v1/research/status")),
    ("POST", re.compile(r"/v1/research/search/(?:companies|people)")),
    ("POST", re.compile(r"/v1/research/people/lookup")),
    ("GET", re.compile(r"/v1/research/profiles")),
    ("POST", re.compile(r"/v1/research/profiles")),
    ("GET", re.compile(rf"{_PROFILE}(?:/history|/people|/conversations(?:/{_ID})?)?")),
    ("POST", re.compile(rf"{_PROFILE}/(?:refresh|chat|prepare|knowledge)")),
    ("DELETE", re.compile(rf"{_PROFILE}(?:/conversations/{_ID})?")),
)


def research_route_allowed(method: str, path: str, role: str) -> bool:
    """Non-admin access for the ``require_admin`` middleware: members yes, viewers never."""
    return role == "member" and any(method == allowed and pattern.fullmatch(path) for allowed, pattern in _MEMBER_ROUTES)


def _actor(request: Request):
    actor = getattr(request.state, "actor", None)
    if actor is None:
        raise HTTPException(status_code=401, detail="sign in required")
    return actor


def _http(exc: Exception) -> HTTPException:
    if isinstance(exc, (ResearchError, ResearchChatError, ResearchActionError)):
        return HTTPException(status_code=exc.status_code, detail=exc.message)
    if isinstance(exc, (ProfileNotFoundError, DocumentNotFoundError)):
        return HTTPException(status_code=404, detail="Not found. It may have been deleted.")
    if isinstance(exc, ResearchPermissionError):
        return HTTPException(status_code=403, detail=str(exc))
    if isinstance(exc, DocumentError):
        return HTTPException(status_code=exc.status_code, detail=str(exc))
    raise exc


_HANDLED = (ResearchError, ResearchChatError, ResearchActionError, ProfileNotFoundError, DocumentNotFoundError,
            ResearchPermissionError, DocumentError)


def register_research_routes(app: FastAPI, *, research: ResearchService) -> None:
    search_limit = SlidingWindowLimiter(40, WINDOW, "Too many searches. Try again in a few minutes.")
    lookup_limit = SlidingWindowLimiter(30, WINDOW, "Too many look-ups. Try again in a few minutes.")
    save_limit = SlidingWindowLimiter(30, WINDOW, "Too many saves or refreshes. Try again in a few minutes.")
    chat_limit = SlidingWindowLimiter(20, WINDOW, "Too many questions. Try again in a few minutes.")
    action_limit = SlidingWindowLimiter(20, WINDOW, "Too many actions. Try again in a few minutes.")

    def who(request: Request, limiter: SlidingWindowLimiter | None = None):
        actor = _actor(request)
        if actor.role == "viewer":
            raise HTTPException(status_code=403, detail="Research is available to owners, admins and members.")
        if limiter is not None:
            limiter.check(f"{actor.organization_id}:{actor.user_id}")
        return actor

    @app.get("/v1/research/status", response_model=ResearchStatus)
    def research_status(request: Request) -> ResearchStatus:
        return research.status(who(request))

    @app.post("/v1/research/search/companies", response_model=CompanySearchResponse)
    async def search_companies(payload: CompanySearchRequest, request: Request) -> CompanySearchResponse:
        try:
            return await research.search_companies(who(request, search_limit), payload)
        except _HANDLED as exc:
            raise _http(exc) from None

    @app.post("/v1/research/search/people", response_model=PeopleSearchResponse)
    async def search_people(payload: PeopleSearchRequest, request: Request) -> PeopleSearchResponse:
        try:
            return await research.search_people(who(request, search_limit), payload)
        except _HANDLED as exc:
            raise _http(exc) from None

    @app.post("/v1/research/people/lookup", response_model=LookupResponse)
    async def lookup_people(payload: LookupRequest, request: Request) -> LookupResponse:
        try:
            return await research.lookup(who(request, lookup_limit), payload)
        except _HANDLED as exc:
            raise _http(exc) from None

    @app.get("/v1/research/profiles", response_model=list[ResearchProfilePublic])
    def list_profiles(request: Request, kind: Literal["company", "person"] | None = Query(default=None)) -> list[ResearchProfilePublic]:
        try:
            return research.list_profiles(who(request), kind)
        except _HANDLED as exc:
            raise _http(exc) from None

    @app.post("/v1/research/profiles", response_model=SaveProfileResponse)
    async def save_profile(payload: SaveProfileRequest, request: Request, response: Response) -> SaveProfileResponse:
        try:
            saved = await research.save(who(request, save_limit), payload)
        except _HANDLED as exc:
            raise _http(exc) from None
        response.status_code = 201 if saved.created else 200
        return saved

    @app.get("/v1/research/profiles/{profile_id}", response_model=ResearchProfilePublic)
    def get_profile(profile_id: UUID, request: Request) -> ResearchProfilePublic:
        try:
            return research.get(who(request), profile_id)
        except _HANDLED as exc:
            raise _http(exc) from None

    @app.post("/v1/research/profiles/{profile_id}/refresh", response_model=SaveProfileResponse)
    async def refresh_profile(profile_id: UUID, request: Request) -> SaveProfileResponse:
        try:
            return await research.refresh(who(request, save_limit), profile_id)
        except _HANDLED as exc:
            raise _http(exc) from None

    @app.delete("/v1/research/profiles/{profile_id}", status_code=204)
    def delete_profile(profile_id: UUID, request: Request) -> Response:
        try:
            research.delete(who(request), profile_id)
        except _HANDLED as exc:
            raise _http(exc) from None
        return Response(status_code=204)

    @app.get("/v1/research/profiles/{profile_id}/history", response_model=CompanyHistory | PersonHistory)
    def profile_history(profile_id: UUID, request: Request) -> CompanyHistory | PersonHistory:
        try:
            return research.history(who(request), profile_id)
        except _HANDLED as exc:
            raise _http(exc) from None

    @app.get("/v1/research/profiles/{profile_id}/people", response_model=list[ResearchProfilePublic])
    def profile_people(profile_id: UUID, request: Request) -> list[ResearchProfilePublic]:
        try:
            return research.people_at(who(request), profile_id)
        except _HANDLED as exc:
            raise _http(exc) from None

    @app.post("/v1/research/profiles/{profile_id}/chat", response_model=ResearchChatResponse)
    async def profile_chat(profile_id: UUID, payload: ResearchChatRequest, request: Request) -> ResearchChatResponse:
        try:
            return await research.chat(who(request, chat_limit), profile_id, payload)
        except _HANDLED as exc:
            raise _http(exc) from None

    @app.get("/v1/research/profiles/{profile_id}/conversations", response_model=list[ResearchConversationSummary])
    def list_conversations(profile_id: UUID, request: Request) -> list[ResearchConversationSummary]:
        try:
            return research.store.conversations(who(request), profile_id)
        except _HANDLED as exc:
            raise _http(exc) from None

    @app.get("/v1/research/profiles/{profile_id}/conversations/{conversation_id}", response_model=ResearchConversationPublic)
    def get_conversation(profile_id: UUID, conversation_id: UUID, request: Request) -> ResearchConversationPublic:
        try:
            return research.store.conversation(who(request), profile_id, conversation_id)
        except _HANDLED as exc:
            raise _http(exc) from None

    @app.delete("/v1/research/profiles/{profile_id}/conversations/{conversation_id}", status_code=204)
    def delete_conversation(profile_id: UUID, conversation_id: UUID, request: Request) -> Response:
        try:
            research.store.delete_conversation(who(request), profile_id, conversation_id)
        except _HANDLED as exc:
            raise _http(exc) from None
        return Response(status_code=204)

    @app.post("/v1/research/profiles/{profile_id}/prepare", response_model=PrepareResult)
    def prepare_meeting(profile_id: UUID, payload: PrepareRequest, request: Request) -> PrepareResult:
        try:
            return research.prepare(who(request, action_limit), profile_id, payload)
        except _HANDLED as exc:
            raise _http(exc) from None

    @app.post("/v1/research/profiles/{profile_id}/knowledge", response_model=KnowledgeDocument, status_code=201)
    async def save_to_knowledge(profile_id: UUID, payload: KnowledgeRequest, request: Request) -> KnowledgeDocument:
        try:
            return await research.save_to_knowledge(who(request, action_limit), profile_id, payload)
        except _HANDLED as exc:
            raise _http(exc) from None
