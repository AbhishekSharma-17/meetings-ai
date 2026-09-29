"""The Apollo stage of meeting-prep research (runs before Exa when the workspace has Apollo connected).

Privacy rules (enforced here, covered by tests):
- Apollo is only asked about the TARGET company (by its domain / name) and THEIR or third-party
  attendees. Our own company, our domains and our colleagues are never sent; any query that would
  carry one of our domains is dropped before the call.
- Bulk people enrichment never sets ``reveal_personal_emails`` or ``reveal_phone_number``; contact
  details in responses are not read.
- Personal (free-mail) addresses are not sent; such people are matched by name + company domain.

Budget and cost: at most ``max_calls`` Apollo tool calls per briefing (``APOLLO_MAX_CALLS_PER_PREP``,
default 15). Every result is cached per workspace for 30 days and reused unless the organizer asks to
refresh from Apollo. Every real call is recorded in the usage ledger (kind ``apollo``).

Failures never break a briefing: invalid key, no credits, rate limit and timeouts stop the Apollo
stage (with a notice) and research continues with Exa; plan-restricted CRM tools are skipped silently.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from .apollo_cache import ApolloCache, CacheKind
from .apollo_composio import ApolloComposio, ApolloError
from .apollo_models import ApolloPerson, ApolloRelationship, ApolloSnapshot, MatchedBy
from .apollo_parsing import (
    bulk_matches, parse_account, parse_contacts, parse_jobs, parse_news, parse_organization, parse_person,
    single_person,
)
from .prep_parties import FREE_MAIL_DOMAINS, OurIdentity, company_key
from .prep_report import ResearchStep

logger = logging.getLogger(__name__)

DEFAULT_MAX_CALLS = 15
MAX_CALLS_CEILING = 50
BULK_SIZE = 10
MAX_PEOPLE = 30
NEWS_DAYS = 90
TOOLS = {
    "org": "APOLLO_ORGANIZATION_ENRICHMENT", "bulk": "APOLLO_BULK_PEOPLE_ENRICHMENT",
    "person": "APOLLO_PEOPLE_ENRICHMENT", "news": "APOLLO_SEARCH_NEWS_ARTICLES",
    "jobs": "APOLLO_GET_ORGANIZATION_JOB_POSTINGS", "account": "APOLLO_SEARCH_ACCOUNTS",
    "contact": "APOLLO_SEARCH_CONTACTS",
}


def max_calls_from_env(environ: dict[str, str] | None = None) -> int:
    raw = (environ if environ is not None else os.environ).get("APOLLO_MAX_CALLS_PER_PREP", "").strip()
    try:
        value = int(raw) if raw else DEFAULT_MAX_CALLS
    except ValueError:
        return DEFAULT_MAX_CALLS
    return max(1, min(value, MAX_CALLS_CEILING))


@dataclass(frozen=True)
class ApolloPersonQuery:
    """One attendee Apollo may look up: theirs or a third party, never ours."""

    name: str
    email: str | None
    domain: str | None
    company: str | None


@dataclass(frozen=True)
class ApolloTargetQuery:
    name: str | None
    domain: str | None


@dataclass(frozen=True)
class ApolloContext:
    organization_id: UUID
    connected_account_id: str
    prep_event_id: UUID | None = None
    actor_user_id: UUID | None = None
    refresh: bool = False
    max_calls: int = DEFAULT_MAX_CALLS
    purpose: str = "meeting_prep_research"


class _Stop(Exception):
    """A fatal Apollo error: skip the rest of the Apollo stage for this briefing."""

    def __init__(self, error: ApolloError) -> None:
        super().__init__(str(error))
        self.error = error


@dataclass
class _Run:
    steps: list[ResearchStep] = field(default_factory=list)
    calls: int = 0
    cached: int = 0


class ApolloResearch:
    def __init__(self, client: ApolloComposio, cache: ApolloCache, ledger: Any | None, context: ApolloContext, *,
                 on_failure: Callable[[ApolloError], None] | None = None) -> None:
        self.client, self.cache, self.ledger, self.context = client, cache, ledger, context
        self.on_failure = on_failure

    async def run(self, target: ApolloTargetQuery, people: Iterable[ApolloPersonQuery],
                  identity: OurIdentity) -> tuple[ApolloSnapshot, list[ResearchStep]]:
        run = _Run()
        snapshot = ApolloSnapshot(fetched_at=datetime.now(UTC))
        domain = target.domain if target.domain and not identity.owns_domain(target.domain) else None
        name = target.name if target.name and not identity.is_us(target.name) else None
        queries = [query for query in people if _allowed(query, identity)][:MAX_PEOPLE]
        try:
            if domain:
                snapshot.company = parse_organization(await self._tool(run, "org", domain, {"domain": domain}, "organization"))
            snapshot.people = await self._people(run, queries)
            org_id = snapshot.company.apollo_id if snapshot.company else None
            if org_id:
                snapshot.news = parse_news(await self._tool(run, "news", org_id, {
                    "organization_ids": [org_id], "per_page": 5,
                    "published_at_min": (datetime.now(UTC) - timedelta(days=NEWS_DAYS)).date().isoformat(),
                }, "news"))
                snapshot.hiring = parse_jobs(await self._tool(run, "jobs", org_id,
                                                              {"organization_id": org_id, "per_page": 10}, "jobs"))
            snapshot.relationship = await self._crm(run, name or (snapshot.company.name if snapshot.company else None),
                                                    domain, queries)
        except _Stop as stop:
            snapshot.notice = f"Apollo unavailable: {stop.error}"
            run.steps.append(ResearchStep(stage="apollo", purpose="unavailable", status="failed", note=snapshot.notice))
            if self.on_failure is not None:
                self.on_failure(stop.error)
        snapshot.calls, snapshot.cached_results = run.calls, run.cached
        return snapshot, run.steps

    # ----- people ------------------------------------------------------------------------------
    async def _people(self, run: _Run, queries: list[ApolloPersonQuery]) -> list[ApolloPerson]:
        found: list[ApolloPerson] = []
        misses: list[tuple[ApolloPersonQuery, dict[str, str], str]] = []
        for query in queries:
            detail = _detail(query)
            if detail is None:
                continue
            key = _person_key(detail)
            cached = None if self.context.refresh else self.cache.get(self.context.organization_id, "person", key)
            if cached is not None:
                run.cached += 1
                person = parse_person(cached.get("person"), name=query.name, matched_by=_matched_by(detail))
                if person:
                    found.append(person)
            else:
                misses.append((query, detail, key))
        if len(misses) == 1:
            found.extend(await self._single(run, *misses[0]))
            return found
        for index in range(0, len(misses), BULK_SIZE):
            batch = misses[index:index + BULK_SIZE]
            found.extend(await self._bulk(run, batch))
        return found

    async def _bulk(self, run: _Run, batch: list[tuple[ApolloPersonQuery, dict[str, str], str]]) -> list[ApolloPerson]:
        # Never add reveal_personal_emails / reveal_phone_number: work details only.
        arguments = {"details": [detail for _, detail, _ in batch]}
        data = await self._call(run, "bulk", arguments, "people")
        if data is None:
            return []
        matches = bulk_matches(data)
        people = []
        for index, (query, detail, key) in enumerate(batch):
            record = matches[index] if index < len(matches) and isinstance(matches[index], dict) else None
            self.cache.put(self.context.organization_id, "person", key, {"person": record})
            person = parse_person(record, name=query.name, matched_by=_matched_by(detail))
            if person:
                people.append(person)
        return people

    async def _single(self, run: _Run, query: ApolloPersonQuery, detail: dict[str, str], key: str) -> list[ApolloPerson]:
        data = await self._call(run, "person", dict(detail), "people")
        if data is None:
            return []
        record = single_person(data)
        self.cache.put(self.context.organization_id, "person", key, {"person": record})
        person = parse_person(record, name=query.name, matched_by=_matched_by(detail))
        return [person] if person else []

    # ----- CRM ---------------------------------------------------------------------------------
    async def _crm(self, run: _Run, company: str | None, domain: str | None,
                   queries: list[ApolloPersonQuery]) -> ApolloRelationship | None:
        if not company and not domain:
            return None
        terms = [term.lower() for term in (company, domain) if term]
        account_data = await self._tool(run, "account", company_key(company) or domain or "",
                                        {"q_organization_name": company or domain}, "crm_accounts", optional=True)
        relationship = parse_account(account_data, terms) if account_data else None
        contact_data = await self._tool(run, "contact", domain or company_key(company),
                                        {"q_keywords": domain or company}, "crm_contacts", optional=True)
        contacts = parse_contacts(contact_data, terms) if contact_data else []
        if relationship is None and not contacts:
            return None
        base = relationship or ApolloRelationship(account_name=company)
        return base.model_copy(update={"contacts": contacts})

    # ----- plumbing ----------------------------------------------------------------------------
    async def _tool(self, run: _Run, kind: CacheKind, key: str, arguments: dict[str, Any], purpose: str,
                    *, optional: bool = False) -> dict[str, Any]:
        """A cached single-result tool: the cache first, then (budget permitting) Apollo."""
        cached = None if self.context.refresh else self.cache.get(self.context.organization_id, kind, key)
        if cached is not None:
            run.cached += 1
            run.steps.append(ResearchStep(stage="apollo", purpose=purpose, results=_count(cached), note="cached"))
            return cached
        data = await self._call(run, kind, arguments, purpose, optional=optional)
        if data is None:
            return {}
        self.cache.put(self.context.organization_id, kind, key, data)
        return data

    async def _call(self, run: _Run, kind: str, arguments: dict[str, Any], purpose: str,
                    *, optional: bool = False) -> dict[str, Any] | None:
        tool = TOOLS[kind]
        if run.calls >= self.context.max_calls:
            run.steps.append(ResearchStep(stage="apollo", purpose=purpose, status="skipped",
                                          note="Apollo call limit for this briefing reached"))
            return None
        run.calls += 1
        started = time.monotonic()
        try:
            data = await self.client.execute(self.context.organization_id, self.context.connected_account_id,
                                             tool, arguments)
        except ApolloError as error:
            self._record(tool, 0, started, "failed", {"error_kind": error.kind})
            if error.fatal:
                raise _Stop(error) from None
            silent = optional and error.kind == "plan"
            run.steps.append(ResearchStep(stage="apollo", purpose=purpose, status="skipped" if silent else "failed",
                                          note=None if silent else str(error)))
            return None
        records = _count(data)
        self._record(tool, records, started, "succeeded", {})
        run.steps.append(ResearchStep(stage="apollo", purpose=purpose, results=records))
        return data

    def _record(self, tool: str, records: int, started: float, status: str, details: dict[str, Any]) -> None:
        if self.ledger is None:
            return
        self.ledger.record_event(
            kind="apollo", purpose=self.context.purpose, provider="apollo", model=tool.lower(), units=records,
            unit_type="records", estimated_usd=None, duration_ms=int((time.monotonic() - started) * 1000),
            status=status, prep_event_id=self.context.prep_event_id, actor_user_id=self.context.actor_user_id,
            organization_id=self.context.organization_id, details={"tool": tool, **details},
        )


# ----- helpers ---------------------------------------------------------------------------------
def _allowed(query: ApolloPersonQuery, identity: OurIdentity) -> bool:
    """Never our colleagues: nobody on our domains and nobody whose company is us."""
    email_domain = query.email.rsplit("@", 1)[1].lower() if query.email and "@" in query.email else None
    if identity.owns_domain(email_domain) or identity.owns_domain(query.domain):
        return False
    return not (query.company and identity.is_us(query.company))


def _detail(query: ApolloPersonQuery) -> dict[str, str] | None:
    email = (query.email or "").strip().lower()
    domain = email.rsplit("@", 1)[1] if "@" in email else ""
    if email and domain and domain not in FREE_MAIL_DOMAINS:
        return {"email": email}
    words = [word for word in query.name.replace(",", " ").split() if word]
    if len(words) < 2 or "@" in query.name or not query.domain:
        return None
    detail = {"first_name": words[0], "last_name": words[-1], "domain": query.domain}
    if query.company:
        detail["organization_name"] = query.company
    return detail


def _person_key(detail: dict[str, str]) -> str:
    if "email" in detail:
        return f"email:{detail['email']}"
    return f"name:{detail['first_name'].lower()} {detail['last_name'].lower()}|{detail['domain'].lower()}"


def _matched_by(detail: dict[str, str]) -> MatchedBy:
    return "email" if "email" in detail else "name"


def _count(data: dict[str, Any]) -> int:
    for key in ("organization", "person"):
        if isinstance(data.get(key), dict):
            return 1
    for key in ("matches", "news_articles", "organization_job_postings", "accounts", "contacts", "people"):
        items = data.get(key)
        if isinstance(items, list):
            return sum(1 for item in items if isinstance(item, dict))
    return 0

