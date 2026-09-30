"""The Research page (Apollo Explorer): search Apollo, keep profiles, see our history, ask AI, act on it.

Owners, admins and members use it (never viewers) once the workspace has an active Apollo connection.
Saved profiles are shared with the workspace; each person's research chats are private to them.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import ValidationError

from .accounts import Actor
from .apollo_integration import ApolloIntegrationService
from .apollo_parsing import parse_person
from .apollo_search_parsing import enrichment_domain, enrichment_name, pagination, parse_company_search, parse_people_search
from .research_actions import KnowledgeRequest, PrepareRequest, PrepareResult, ResearchActions
from .research_apollo import BULK_CONFIRM_OVER, ExplorerApollo, ExplorerError, company_arguments, people_arguments
from .research_chat import ResearchChat, ResearchChatRequest, ResearchChatResponse
from .research_history import CompanyHistory, PersonHistory, ResearchHistory
from .research_models import (
    CompanySearchRequest, CompanySearchResponse, LookedUpPerson, LookupRequest, LookupResponse, PeopleSearchRequest,
    PeopleSearchResponse, ProfileKind, ResearchProfilePublic, ResearchStatus, SaveProfileRequest, SaveProfileResponse,
)
from .research_store import ResearchStore


class ResearchError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message, self.status_code = message, status_code


def require_member(actor: Actor) -> None:
    if actor.role == "viewer":
        raise ResearchError("Research is available to owners, admins and members.", 403)


class ResearchService:
    def __init__(self, *, database: Any, integration: ApolloIntegrationService, usage: Any, repository: Any,
                 actions: ResearchActions, chat: ResearchChat, identities: Any) -> None:
        self.integration = integration
        self.store = ResearchStore(database)
        self.explorer = ExplorerApollo(database, lambda: integration.client, integration.cache, usage,
                                       on_failure=lambda org, error: integration.record_failure(org, error))
        self.history_finder = ResearchHistory(database, repository)
        self.actions, self.chat_engine, self.identities = actions, chat, identities

    # ----- availability ------------------------------------------------------------------------
    def status(self, actor: Actor) -> ResearchStatus:
        row = self.integration.row(actor.organization_id)
        connected = row is not None and self.integration.client.configured
        can_use = actor.role != "viewer" and connected and row.status != "invalid"
        return ResearchStatus(connected=connected, status=row.status if row else None, can_manage=actor.is_admin,
                              can_use=can_use, usage=self.explorer.usage(actor) if can_use else None,
                              bulk_confirm_over=BULK_CONFIRM_OVER)

    def _account(self, actor: Actor) -> str:
        require_member(actor)
        row = self.integration.row(actor.organization_id)
        if row is None or not self.integration.client.configured:
            raise ResearchError("Apollo isn't connected for this workspace.", 409)
        if row.status == "invalid":
            raise ResearchError("Apollo rejected the workspace connection. An admin needs to reconnect Apollo in AI providers.", 409)
        return row.connected_account_id

    # ----- search ------------------------------------------------------------------------------
    async def search_companies(self, actor: Actor, request: CompanySearchRequest) -> CompanySearchResponse:
        account = self._account(actor)
        if request.is_empty():
            raise ResearchError("Add a company name, website or at least one filter to search.", 422)
        data, cached = await self._run(self.explorer.search(actor, account, "org_search", company_arguments(request)))
        hits = parse_company_search(data)
        saved = self.store.saved_ids(actor, "company", [hit.apollo_id for hit in hits if hit.apollo_id])
        total, pages = pagination(data)
        return CompanySearchResponse(page=request.page, total=total, total_pages=pages, cached=cached,
                                     usage=self.explorer.usage(actor),
                                     items=[hit.model_copy(update={"saved_profile_id": saved.get(hit.apollo_id or "")}) for hit in hits])

    async def search_people(self, actor: Actor, request: PeopleSearchRequest) -> PeopleSearchResponse:
        account = self._account(actor)
        if request.is_empty():
            raise ResearchError("Add a company website, title, seniority, location or keyword to search.", 422)
        data, cached = await self._run(self.explorer.search(actor, account, "people_search", people_arguments(request)))
        hits = parse_people_search(data)
        saved = self.store.saved_ids(actor, "person", [hit.apollo_id for hit in hits])
        total, pages = pagination(data)
        return PeopleSearchResponse(page=request.page, total=total, total_pages=pages, cached=cached,
                                    usage=self.explorer.usage(actor),
                                    items=[hit.model_copy(update={"saved_profile_id": saved.get(hit.apollo_id)}) for hit in hits])

    async def lookup(self, actor: Actor, request: LookupRequest) -> LookupResponse:
        account = self._account(actor)
        records = await self._run(self.explorer.lookup_people(actor, account, request.apollo_ids, confirm=request.confirm,
                                                              refresh=request.refresh))
        items = [LookedUpPerson(apollo_id=apollo_id, company_domain=enrichment_domain(records.get(apollo_id)),
                                person=parse_person(records.get(apollo_id), name=enrichment_name(records.get(apollo_id)) or "Unknown",
                                                    matched_by="name"))
                 for apollo_id in request.apollo_ids]
        return LookupResponse(items=items, usage=self.explorer.usage(actor))

    # ----- profiles ----------------------------------------------------------------------------
    def list_profiles(self, actor: Actor, kind: ProfileKind | None) -> list[ResearchProfilePublic]:
        require_member(actor)
        return self.store.list(actor, kind)

    def get(self, actor: Actor, profile_id: UUID) -> ResearchProfilePublic:
        require_member(actor)
        return self.store.public(actor, self.store.get_row(actor, profile_id))

    async def save(self, actor: Actor, request: SaveProfileRequest) -> SaveProfileResponse:
        account = self._account(actor)
        existing = self.store.find(actor, request.kind, apollo_id=request.apollo_id, domain=request.domain)
        if existing is not None:
            return SaveProfileResponse(profile=self.store.public(actor, existing), created=False, usage=self.explorer.usage(actor))
        before = self.explorer.used_today(actor)
        fields = await self._fetch(actor, account, request.kind, request.apollo_id, request.domain, request.name, refresh=False)
        apollo_id = fields.pop("apollo_id") or request.apollo_id
        if apollo_id and apollo_id != request.apollo_id:
            again = self.store.find(actor, request.kind, apollo_id=apollo_id, domain=None)
            if again is not None:
                return SaveProfileResponse(profile=self.store.public(actor, again), created=False, usage=self.explorer.usage(actor))
        row = self.store.create(actor, kind=request.kind, apollo_id=apollo_id,
                                calls=max(self.explorer.used_today(actor) - before, 0), **fields)
        return SaveProfileResponse(profile=self.store.public(actor, row), created=True, usage=self.explorer.usage(actor))

    async def refresh(self, actor: Actor, profile_id: UUID) -> SaveProfileResponse:
        account = self._account(actor)
        row = self.store.get_row(actor, profile_id)
        before = self.explorer.used_today(actor)
        fields = await self._fetch(actor, account, row.kind, row.apollo_id, row.domain, row.name, refresh=True)
        fields.pop("apollo_id")
        updated = self.store.refresh(actor, profile_id, calls=max(self.explorer.used_today(actor) - before, 0), **fields)
        return SaveProfileResponse(profile=self.store.public(actor, updated), created=False, usage=self.explorer.usage(actor))

    def delete(self, actor: Actor, profile_id: UUID) -> None:
        require_member(actor)
        self.store.delete(actor, profile_id)

    async def _fetch(self, actor: Actor, account: str, kind: str, apollo_id: str | None, domain: str | None,
                     name: str | None, *, refresh: bool) -> dict[str, Any]:
        if kind == "person":
            if not apollo_id:
                raise ResearchError("Choose a person from the search results to save them.", 422)
            record = (await self._run(self.explorer.lookup_people(actor, account, [apollo_id], confirm=True,
                                                                  refresh=refresh))).get(apollo_id)
            person = parse_person(record, name=enrichment_name(record) or name or "Unknown", matched_by="name")
            if person is None:
                raise ResearchError("Apollo couldn't find details for this person.", 404)
            return {"name": person.name, "title": person.title, "company": person.company, "apollo_id": apollo_id,
                    "domain": enrichment_domain(record) or domain, "data": {"person": person.model_dump(mode="json")}}
        if not domain and not apollo_id:
            raise ResearchError("Choose a company from the search results, or search by its website.", 422)
        facts, _ = await self._run(self.explorer.company_facts(actor, account, domain=domain, apollo_id=apollo_id,
                                                                   refresh=refresh))
        company = facts.get("company") or {}
        label = company.get("name") or name or domain
        if not label:
            raise ResearchError("Apollo has no details for this company.", 404)
        return {"name": label, "title": None, "company": label, "domain": company.get("domain") or domain,
                "apollo_id": company.get("apollo_id") or apollo_id, "data": facts}

    # ----- history, chat, actions --------------------------------------------------------------
    def history(self, actor: Actor, profile_id: UUID) -> CompanyHistory | PersonHistory:
        profile = self.get(actor, profile_id)
        if profile.kind == "person":
            return self.history_finder.person(actor, name=profile.name, domain=profile.domain)
        return self.history_finder.company(actor, name=profile.name, domain=profile.domain,
                                           identity=self.identities.our_identity(actor))

    def people_at(self, actor: Actor, profile_id: UUID) -> list[ResearchProfilePublic]:
        profile = self.get(actor, profile_id)
        return self.store.people_at(actor, profile.domain) if profile.kind == "company" else []

    async def chat(self, actor: Actor, profile_id: UUID, request: ResearchChatRequest) -> ResearchChatResponse:
        profile = self.get(actor, profile_id)
        previous = self.store.history(actor, profile_id, request.conversation_id)
        answer, citations, result, searches, note = await self.chat_engine.answer(
            actor, profile, self.history(actor, profile_id), request, previous)
        conversation_id = self.store.save_exchange(actor, profile_id, request.conversation_id, request.question, answer,
                                                   [item.model_dump(mode="json") for item in citations],
                                                   result.provider, result.model)
        return ResearchChatResponse(answer=answer, citations=citations, conversation_id=conversation_id,
                                    provider=result.provider, model=result.model, web_searches=searches, note=note)

    def prepare(self, actor: Actor, profile_id: UUID, request: PrepareRequest) -> PrepareResult:
        profile = self.get(actor, profile_id)
        ids = self.actions.people_for(actor, profile, request.person_profile_ids)
        people = [self.get(actor, item) for item in ids]
        return self.actions.prepare(actor, profile, request, people)

    async def save_to_knowledge(self, actor: Actor, profile_id: UUID, request: KnowledgeRequest):
        profile = self.get(actor, profile_id)
        people = self.store.people_at(actor, profile.domain) if profile.kind == "company" else []
        return await self.actions.save_to_knowledge(actor, profile, request.knowledge_base_id, people)

    @staticmethod
    async def _run(awaitable):
        try:
            return await awaitable
        except ExplorerError as exc:
            raise ResearchError(exc.message, exc.status_code) from None
        except ValidationError:
            raise ResearchError("Apollo returned details we couldn't read.", 502) from None
