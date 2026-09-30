"""Apollo calls made from the Research page: searches, person look-ups and company facts.

Tool request shapes (Composio ``POST /tools/execute/{TOOL}``; argument names follow Apollo's REST API):
* ``APOLLO_ORGANIZATION_SEARCH`` {page, per_page: 25, q_organization_name?, q_organization_domains_list?,
  q_organization_keyword_tags?, organization_locations?, organization_num_employees_ranges? ("1,10"…)}.
* ``APOLLO_PEOPLE_SEARCH`` {page, per_page: 25, q_organization_domains?, person_titles?,
  person_seniorities?, person_locations?, q_keywords?}. Search results are shown as returned (never enriched).
* ``APOLLO_PEOPLE_ENRICHMENT`` {id} for one person and ``APOLLO_BULK_PEOPLE_ENRICHMENT`` {details: [{id}…]}
  (at most 10 per call). ``reveal_personal_emails`` / ``reveal_phone_number`` are never sent, and emails
  or phone numbers in responses are never read or stored.
* ``APOLLO_ORGANIZATION_ENRICHMENT`` {domain}, ``APOLLO_SEARCH_NEWS_ARTICLES`` and
  ``APOLLO_GET_ORGANIZATION_JOB_POSTINGS`` exactly as meeting prep uses them (and sharing its cache).

Budget: each person may make ``APOLLO_DAILY_CALLS_PER_USER`` (default 100) Apollo calls per UTC day in a
workspace, counted from the usage ledger (kind ``apollo``, any purpose). Looking up more than 10 people at
once needs an explicit confirmation. Cached answers (searches 24 h, enrichment 30 days) cost nothing.
Every real call is written to the ledger with purpose ``research_explorer`` and the person who made it.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import func, select

from .accounts import Actor
from .apollo_cache import ApolloCache, CacheKind
from .apollo_composio import ApolloComposio, ApolloError
from .apollo_parsing import bulk_matches, parse_jobs, parse_news, parse_organization, single_person
from .apollo_research import NEWS_DAYS
from .apollo_search_parsing import https_image
from .database import Database, UsageEventRow
from .research_models import EMPLOYEE_RANGES, PER_PAGE, ApolloUsage, CompanySearchRequest, PeopleSearchRequest

logger = logging.getLogger(__name__)

PURPOSE = "research_explorer"
DEFAULT_DAILY_CALLS = 100
DAILY_CALLS_CEILING = 5000
BULK_CONFIRM_OVER = 10
BULK_SIZE = 10
COMPANY_CALLS = 3  # organization enrichment, news, job postings
TOOLS = {
    "org_search": "APOLLO_ORGANIZATION_SEARCH", "people_search": "APOLLO_PEOPLE_SEARCH",
    "person": "APOLLO_PEOPLE_ENRICHMENT", "bulk": "APOLLO_BULK_PEOPLE_ENRICHMENT",
    "org": "APOLLO_ORGANIZATION_ENRICHMENT", "news": "APOLLO_SEARCH_NEWS_ARTICLES",
    "jobs": "APOLLO_GET_ORGANIZATION_JOB_POSTINGS",
}
_MESSAGES = {
    "invalid_key": "Apollo rejected the workspace connection. An admin needs to reconnect Apollo in AI providers.",
    "out_of_credit": "Apollo reports no credits left for this workspace. Try again when credits renew.",
    "rate_limited": "Apollo is busy right now. Try again in a minute.",
    "plan": "This isn't available on the workspace's Apollo plan.",
    "timeout": "Apollo didn't answer in time. Try again.",
    "not_configured": "Apollo isn't available on this server right now.",
    "error": "Apollo couldn't complete this request. Try again shortly.",
}
_STATUS = {"invalid_key": 409, "out_of_credit": 402, "rate_limited": 429, "plan": 409, "timeout": 504,
           "not_configured": 503, "error": 502}


class ExplorerError(Exception):
    """A user-facing Research failure; ``message`` is safe to show."""

    def __init__(self, message: str, status_code: int = 400, *, code: str = "error",
                 error: ApolloError | None = None) -> None:
        super().__init__(message)
        self.message, self.status_code, self.code, self.error = message, status_code, code, error


def daily_limit_from_env(environ: dict[str, str] | None = None) -> int:
    raw = (environ if environ is not None else os.environ).get("APOLLO_DAILY_CALLS_PER_USER", "").strip()
    try:
        value = int(raw) if raw else DEFAULT_DAILY_CALLS
    except ValueError:
        return DEFAULT_DAILY_CALLS
    return max(1, min(value, DAILY_CALLS_CEILING))


def _key(payload: dict[str, Any]) -> str:
    """A stable, normalized cache key for a search (lists sorted, text lowercased)."""
    def norm(value: Any) -> Any:
        if isinstance(value, str):
            return value.strip().lower()
        if isinstance(value, list):
            return sorted(norm(item) for item in value)
        return value
    canonical = json.dumps({key: norm(value) for key, value in payload.items() if value not in (None, [], "")},
                           sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


def company_arguments(request: CompanySearchRequest) -> dict[str, Any]:
    arguments: dict[str, Any] = {"page": request.page, "per_page": PER_PAGE}
    if request.name:
        arguments["q_organization_name"] = request.name
    if request.domains:
        arguments["q_organization_domains_list"] = list(request.domains)
    if request.industry_keywords:
        arguments["q_organization_keyword_tags"] = list(request.industry_keywords)
    if request.locations:
        arguments["organization_locations"] = list(request.locations)
    if request.employee_ranges:
        arguments["organization_num_employees_ranges"] = [EMPLOYEE_RANGES[item] for item in request.employee_ranges]
    return arguments


def people_arguments(request: PeopleSearchRequest) -> dict[str, Any]:
    arguments: dict[str, Any] = {"page": request.page, "per_page": PER_PAGE}
    if request.domains:
        arguments["q_organization_domains"] = list(request.domains)
    if request.titles:
        arguments["person_titles"] = list(request.titles)
    if request.seniorities:
        arguments["person_seniorities"] = list(request.seniorities)
    if request.locations:
        arguments["person_locations"] = list(request.locations)
    if request.keywords:
        arguments["q_keywords"] = request.keywords
    return arguments


class ExplorerApollo:
    def __init__(self, database: Database, client: Callable[[], ApolloComposio], cache: ApolloCache, ledger: Any | None, *,
                 on_failure: Callable[[UUID, ApolloError], None] | None = None,
                 environ: dict[str, str] | None = None, now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        # ``client`` is read on every call so the workspace integration's client can be swapped (tests, config).
        self.database, self._client, self.cache, self.ledger = database, client, cache, ledger
        self.on_failure = on_failure
        self.environ = environ
        self._now = now
        # One Apollo call at a time per person: the daily-budget check, the call and its ledger row
        # happen under this lock, so parallel tabs or requests can't all pass the check and overshoot.
        # (The API runs as a single process; see docs/deployment/railway.md.)
        self._budget_locks: dict[tuple[str, str], asyncio.Lock] = {}

    @property
    def client(self) -> ApolloComposio:
        return self._client()

    # ----- budget ------------------------------------------------------------------------------
    @property
    def daily_limit(self) -> int:
        return daily_limit_from_env(self.environ)

    def used_today(self, actor: Actor) -> int:
        start = self._now().astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
        with self.database.session_factory() as session:
            return int(session.execute(select(func.count(UsageEventRow.id)).where(
                UsageEventRow.organization_id == str(actor.organization_id), UsageEventRow.kind == "apollo",
                UsageEventRow.actor_user_id == str(actor.user_id), UsageEventRow.created_at >= start,
            )).scalar_one())

    def usage(self, actor: Actor) -> ApolloUsage:
        return ApolloUsage(used_today=self.used_today(actor), daily_limit=self.daily_limit)

    def require_budget(self, actor: Actor, calls: int) -> None:
        limit = self.daily_limit
        used = self.used_today(actor)
        if used + calls > limit:
            left = max(limit - used, 0)
            detail = f"You have {left} left today." if left else "It resets at midnight UTC."
            raise ExplorerError(f"You've reached today's limit of {limit} Apollo lookups. {detail}", 429, code="capped")

    # ----- searches ----------------------------------------------------------------------------
    async def search(self, actor: Actor, account_id: str, kind: CacheKind,
                     arguments: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        """(Apollo's response, served from cache?) for an organization or people search."""
        key = _key(arguments)
        cached = self.cache.get(actor.organization_id, kind, key)
        if cached is not None:
            return cached, True
        data = await self.call(actor, account_id, kind, arguments)
        self.cache.put(actor.organization_id, kind, key, data)
        return data, False

    # ----- people ------------------------------------------------------------------------------
    async def lookup_people(self, actor: Actor, account_id: str, ids: list[str], *, confirm: bool,
                            refresh: bool) -> dict[str, Any]:
        """Apollo person records by id (None when Apollo has no match). Cached 30 days per workspace."""
        if len(ids) > BULK_CONFIRM_OVER and not confirm:
            raise ExplorerError(f"Looking up {len(ids)} people uses up to {len(ids)} Apollo lookups. Confirm to continue.",
                                409, code="confirm")
        found: dict[str, Any] = {}
        misses: list[str] = []
        for apollo_id in ids:
            cached = None if refresh else self.cache.get(actor.organization_id, "person", f"id:{apollo_id}")
            if cached is not None:
                found[apollo_id] = cached.get("person")
            else:
                misses.append(apollo_id)
        if not misses:
            return found
        if len(misses) == 1:
            self.require_budget(actor, 1)
            record = single_person(await self.call(actor, account_id, "person", {"id": misses[0]}))
            found[misses[0]] = self._remember(actor, misses[0], record)
            return found
        self.require_budget(actor, -(-len(misses) // BULK_SIZE))
        for index in range(0, len(misses), BULK_SIZE):
            batch = misses[index:index + BULK_SIZE]
            matches = bulk_matches(await self.call(actor, account_id, "bulk", {"details": [{"id": item} for item in batch]}))
            by_id = {str(item.get("id")): item for item in matches if isinstance(item, dict) and item.get("id")}
            for position, apollo_id in enumerate(batch):
                aligned = matches[position] if position < len(matches) and isinstance(matches[position], dict) else None
                found[apollo_id] = self._remember(actor, apollo_id, by_id.get(apollo_id) or aligned)
        return found

    def _remember(self, actor: Actor, apollo_id: str, record: Any) -> Any:
        self.cache.put(actor.organization_id, "person", f"id:{apollo_id}", {"person": _without_contact(record)})
        return _without_contact(record)

    # ----- companies ---------------------------------------------------------------------------
    async def company_facts(self, actor: Actor, account_id: str, *, domain: str | None, apollo_id: str | None,
                            refresh: bool) -> tuple[dict[str, Any], int]:
        """Organization profile, 90-day news and open roles; returns (parsed facts, Apollo calls made)."""
        wanted = [domain and ("org", domain), apollo_id and ("news", apollo_id), apollo_id and ("jobs", apollo_id)]
        uncached = [item for item in wanted if item and (refresh or self.cache.get(actor.organization_id, *item) is None)]
        if uncached:
            self.require_budget(actor, COMPANY_CALLS if domain and not apollo_id else len(uncached))
        calls = 0

        async def cached_call(kind: CacheKind, key: str, arguments: dict[str, Any]) -> dict[str, Any]:
            nonlocal calls
            hit = None if refresh else self.cache.get(actor.organization_id, kind, key)
            if hit is not None:
                return hit
            calls += 1
            data = await self.call(actor, account_id, kind, arguments)
            self.cache.put(actor.organization_id, kind, key, data)
            return data

        raw = await cached_call("org", domain, {"domain": domain}) if domain else {}
        company = parse_organization(raw) if raw else None
        organization = raw.get("organization") if isinstance(raw.get("organization"), dict) else {}
        org_id = (company.apollo_id if company else None) or apollo_id
        news, hiring = [], None
        if org_id:
            since = (self._now() - timedelta(days=NEWS_DAYS)).date().isoformat()
            news = parse_news(await cached_call("news", org_id, {"organization_ids": [org_id], "per_page": 10,
                                                                 "published_at_min": since}))
            hiring = parse_jobs(await cached_call("jobs", org_id, {"organization_id": org_id, "per_page": 25}))
        facts = {"company": company.model_dump(mode="json") if company else None,
                 "logo_url": https_image(organization.get("logo_url")),
                 "news": [item.model_dump(mode="json") for item in news],
                 "hiring": hiring.model_dump(mode="json") if hiring else None}
        return facts, calls

    # ----- plumbing ----------------------------------------------------------------------------
    async def call(self, actor: Actor, account_id: str, kind: str, arguments: dict[str, Any]) -> dict[str, Any]:
        key = (str(actor.organization_id), str(actor.user_id))
        lock = self._budget_locks.setdefault(key, asyncio.Lock())
        async with lock:
            return await self._call(actor, account_id, kind, arguments)

    async def _call(self, actor: Actor, account_id: str, kind: str, arguments: dict[str, Any]) -> dict[str, Any]:
        tool = TOOLS[kind]
        self.require_budget(actor, 1)
        started = time.monotonic()
        try:
            data = await self.client.execute(actor.organization_id, account_id, tool, arguments)
        except ApolloError as error:
            self._record(actor, tool, 0, started, "failed", {"error_kind": error.kind})
            if self.on_failure is not None and error.kind in {"invalid_key", "out_of_credit"}:
                self.on_failure(actor.organization_id, error)
            raise ExplorerError(_MESSAGES.get(error.kind, _MESSAGES["error"]), _STATUS.get(error.kind, 502),
                                code=error.kind, error=error) from None
        self._record(actor, tool, _count(data), started, "succeeded", {})
        return data

    def _record(self, actor: Actor, tool: str, records: int, started: float, status: str,
                details: dict[str, Any]) -> None:
        if self.ledger is None:
            return
        self.ledger.record_event(
            kind="apollo", purpose=PURPOSE, provider="apollo", model=tool.lower(), units=records, unit_type="records",
            estimated_usd=None, duration_ms=int((time.monotonic() - started) * 1000), status=status,
            actor_user_id=actor.user_id, organization_id=actor.organization_id, details={"tool": tool, **details},
        )


_CONTACT_KEYS = frozenset({"email", "emails", "personal_emails", "phone_numbers", "phone_number", "mobile_phone",
                           "sanitized_phone", "contact", "email_status", "extrapolated_email_confidence",
                           "contact_emails", "corporate_phone", "direct_phone", "home_phone", "other_phone"})


def _without_contact(record: Any) -> Any:
    """A person record with every email / phone field removed before it is cached or parsed."""
    if not isinstance(record, dict):
        return None
    cleaned = {key: value for key, value in record.items() if key not in _CONTACT_KEYS and "phone" not in key
               and "email" not in key}
    organization = cleaned.get("organization")
    if isinstance(organization, dict):
        cleaned["organization"] = {key: value for key, value in organization.items() if "phone" not in key
                                   and "email" not in key}
    return cleaned


def _count(data: dict[str, Any]) -> int:
    for key in ("organization", "person"):
        if isinstance(data.get(key), dict):
            return 1
    for key in ("organizations", "people", "matches", "news_articles", "organization_job_postings", "accounts",
                "contacts"):
        items = data.get(key)
        if isinstance(items, list):
            return sum(1 for item in items if isinstance(item, dict))
    return 0
