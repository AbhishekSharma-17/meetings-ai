"""Metered Exa web-search client for meeting-prep research.

API reference (verified 2026-09-26):
- POST https://api.exa.ai/search  -- https://exa.ai/docs/reference/search
  body: query, type ("auto" | "fast" | "instant" | "deep-lite" | "deep" | "deep-reasoning"),
  numResults (1-100, default 10), category ("company" | "publication" | "news" | "personal site" |
  "financial report" | "people"), includeDomains, startPublishedDate (ISO 8601), contents
  {text: {maxCharacters}, highlights: {query, maxCharacters}, maxAgeHours}.
  "company" and "people" do NOT accept startPublishedDate/endPublishedDate/excludeDomains (400),
  and "people" only accepts LinkedIn domains in includeDomains (the former "linkedin profile"
  category was replaced by "people": https://exa.ai/docs/changelog/people-search-launch).
  Response: requestId, results[{id, url, title, publishedDate, author, text, highlights, summary}],
  costDollars{total, ...}.
- POST https://api.exa.ai/contents -- https://exa.ai/docs/reference/get-contents
  body: urls (or ids), text, highlights, maxAgeHours, livecrawlTimeout.
  Response: results[...], statuses[{id, status, error}], costDollars{total}.
- Auth header: ``x-api-key`` (``Authorization: Bearer`` is also accepted).

Pricing (https://exa.ai/pricing, read 2026-09-26): Search $7 / 1k requests including up to 10
results, +$1 / 1k for each result above 10; deep-lite and deep $12 / 1k, deep-reasoning $15 / 1k;
Contents $1 / 1k pages per content type (text, highlights and summary billed separately).
We prefer the provider-reported ``costDollars.total`` from each response and fall back to
these list prices only when it is absent. Estimates are not invoices.

The API key is never logged, returned, or stored in usage details.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import httpx

logger = logging.getLogger(__name__)

EXA_BASE_URL = "https://api.exa.ai"
EXA_PRICING_URL = "https://exa.ai/pricing"
SEARCH_TYPES = frozenset({"auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"})
CATEGORIES = frozenset({"company", "publication", "news", "personal site", "financial report", "people"})
# Categories with the restricted filter set documented on /search.
_RESTRICTED_CATEGORIES = frozenset({"company", "people"})
# USD per request (<= 10 results) by search type, from https://exa.ai/pricing.
_SEARCH_BASE_USD = {"auto": 0.007, "fast": 0.007, "instant": 0.007,
                    "deep-lite": 0.012, "deep": 0.012, "deep-reasoning": 0.015}
_EXTRA_RESULT_USD = 0.001
_CONTENT_PAGE_USD = 0.001
_RETRY_STATUS = frozenset({429, 500, 502, 503, 504})
MISSING_KEY_MESSAGE = "Add an Exa key in AI providers to run public research, or turn off public research."


class ExaError(RuntimeError):
    """A sanitized Exa failure; never includes the API key or response bodies."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class ExaKeyMissingError(ExaError):
    pass


@dataclass(frozen=True)
class ExaResult:
    url: str
    title: str
    id: str | None = None
    published_date: str | None = None
    author: str | None = None
    text: str = ""
    highlights: tuple[str, ...] = ()
    summary: str | None = None


@dataclass(frozen=True)
class ExaResponse:
    results: tuple[ExaResult, ...]
    cost_usd: float | None
    request_id: str | None = None


@dataclass
class UsageContext:
    """Attribution attached to every metered Exa call."""

    organization_id: UUID
    prep_event_id: UUID | None = None
    actor_user_id: UUID | None = None
    purpose: str = "meeting_prep_research"


@dataclass
class ExaCallLog:
    calls: int = 0
    estimated_usd: float = 0.0
    unpriced: int = 0
    failures: list[str] = field(default_factory=list)


def estimate_search_usd(search_type: str, results: int, content_types: int) -> float | None:
    base = _SEARCH_BASE_USD.get(search_type)
    if base is None:
        return None
    extra = max(0, results - 10) * _EXTRA_RESULT_USD
    return round(base + extra + results * content_types * _CONTENT_PAGE_USD, 8)


def estimate_contents_usd(pages: int, content_types: int) -> float:
    return round(pages * content_types * _CONTENT_PAGE_USD, 8)


class ExaClient:
    def __init__(
        self, api_key: str, *, ledger: Any | None = None, usage: UsageContext | None = None,
        transport: httpx.AsyncBaseTransport | None = None, base_url: str = EXA_BASE_URL,
        timeout: float = 30.0, max_retries: int = 2, backoff_seconds: float = 0.75,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        on_out_of_credit: Callable[[UUID], None] | None = None,
    ) -> None:
        if not api_key:
            raise ExaKeyMissingError(MISSING_KEY_MESSAGE)
        self._key = api_key
        self._ledger = ledger
        self._usage = usage
        self._transport = transport
        self._base_url = base_url.rstrip("/")
        self._timeout = httpx.Timeout(timeout, connect=10.0)
        self._max_retries = max_retries
        self._backoff = backoff_seconds
        self._sleep = sleep
        self._on_out_of_credit = on_out_of_credit
        self._client: httpx.AsyncClient | None = None
        self.log = ExaCallLog()

    def __repr__(self) -> str:  # never expose the key through debugging output
        return f"ExaClient(base_url={self._base_url!r})"

    async def __aenter__(self) -> "ExaClient":
        self._client = httpx.AsyncClient(base_url=self._base_url, timeout=self._timeout, transport=self._transport,
            headers={"x-api-key": self._key, "Content-Type": "application/json", "Accept": "application/json"})
        return self

    async def __aexit__(self, *_: object) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    async def search(
        self, query: str, *, purpose: str, search_type: str = "auto", category: str | None = None,
        num_results: int = 5, include_domains: list[str] | None = None,
        start_published_date: str | None = None, text_max_characters: int | None = None,
        highlights_max_characters: int | None = 1200, highlights_query: str | None = None,
    ) -> ExaResponse:
        if search_type not in SEARCH_TYPES:
            raise ValueError(f"unsupported Exa search type {search_type}")
        if category is not None and category not in CATEGORIES:
            raise ValueError(f"unsupported Exa category {category}")
        body: dict[str, Any] = {"query": query[:500], "type": search_type, "numResults": max(1, min(num_results, 25))}
        if category:
            body["category"] = category
        if include_domains and category != "people":
            body["includeDomains"] = include_domains[:20]
        if start_published_date and category not in _RESTRICTED_CATEGORIES:
            body["startPublishedDate"] = start_published_date
        contents, content_types = _contents_options(text_max_characters, highlights_max_characters, highlights_query)
        if contents:
            body["contents"] = contents
        started = time.monotonic()
        details = {"query_purpose": purpose, "num_results": body["numResults"], "category": category}
        try:
            data = await self._post("/search", body)
        except ExaError:
            self._record("search", search_type, 0, "results", None, started, details, status="failed")
            raise
        response = _parse(data)
        estimated = response.cost_usd if response.cost_usd is not None else \
            estimate_search_usd(search_type, len(response.results), content_types)
        source = "exa_reported_cost" if response.cost_usd is not None else "exa_list_price" if estimated is not None else None
        self._record("search", search_type, len(response.results), "results", estimated, started,
                     {**details, "returned": len(response.results)}, price_source=source)
        return response

    async def contents(
        self, urls: list[str], *, purpose: str, text_max_characters: int = 4000,
        highlights_max_characters: int | None = None, highlights_query: str | None = None,
    ) -> ExaResponse:
        urls = list(dict.fromkeys(urls))[:12]
        if not urls:
            return ExaResponse(results=(), cost_usd=0.0)
        options, content_types = _contents_options(text_max_characters, highlights_max_characters, highlights_query)
        body: dict[str, Any] = {"urls": urls, **options, "livecrawlTimeout": 10000}
        started = time.monotonic()
        details = {"query_purpose": purpose, "num_results": len(urls), "category": None}
        try:
            data = await self._post("/contents", body)
        except ExaError:
            self._record("contents", "contents", 0, "pages", None, started, details, status="failed")
            raise
        response = _parse(data)
        pages = len(response.results)
        estimated = response.cost_usd if response.cost_usd is not None else estimate_contents_usd(pages, content_types)
        source = "exa_reported_cost" if response.cost_usd is not None else "exa_list_price"
        self._record("contents", "contents", pages, "pages", estimated, started, {**details, "returned": pages},
                     price_source=source)
        return response

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        if self._client is None:
            raise RuntimeError("use ExaClient as an async context manager")
        attempt = 0
        while True:
            try:
                response = await self._client.post(path, json=body)
            except httpx.TimeoutException as exc:
                if attempt < self._max_retries:
                    attempt += 1
                    await self._sleep(self._backoff * 2 ** (attempt - 1))
                    continue
                raise ExaError("Exa research timed out") from exc
            except httpx.HTTPError as exc:
                raise ExaError("Exa research could not be reached") from exc
            if response.status_code in _RETRY_STATUS and attempt < self._max_retries:
                attempt += 1
                retry_after = _retry_after(response)
                await self._sleep(retry_after if retry_after is not None else self._backoff * 2 ** (attempt - 1))
                continue
            if response.status_code in {401, 403}:
                raise ExaError("Exa rejected the API key; update the Exa key in AI providers", response.status_code)
            if response.status_code == 402:
                if self._on_out_of_credit is not None and self._usage is not None:
                    self._on_out_of_credit(self._usage.organization_id)
                raise ExaError("Exa reports the account has no remaining credits", response.status_code)
            if response.status_code == 429:
                raise ExaError("Exa rate limit reached; try again shortly", response.status_code)
            if response.status_code >= 400:
                raise ExaError(f"Exa research failed (HTTP {response.status_code})", response.status_code)
            try:
                data = response.json()
            except ValueError as exc:
                raise ExaError("Exa returned an unreadable response") from exc
            if not isinstance(data, dict):
                raise ExaError("Exa returned an unexpected response")
            return data

    def _record(self, kind: str, model: str, units: int, unit_type: str, estimated: float | None,
                started: float, details: dict[str, Any], *, status: str = "succeeded",
                price_source: str | None = None) -> None:
        self.log.calls += 1
        if status != "succeeded":
            self.log.failures.append(str(details.get("query_purpose")))
        if estimated is None:
            self.log.unpriced += status == "succeeded"
        else:
            self.log.estimated_usd = round(self.log.estimated_usd + estimated, 8)
        if not self._ledger or not self._usage:
            return
        self._ledger.record_event(
            kind=kind, purpose=self._usage.purpose, provider="exa", model=model, units=units, unit_type=unit_type,
            estimated_usd=estimated, price_source=price_source, duration_ms=int((time.monotonic() - started) * 1000),
            status=status, prep_event_id=self._usage.prep_event_id, actor_user_id=self._usage.actor_user_id,
            organization_id=self._usage.organization_id, details=details,
        )


def _contents_options(text_max: int | None, highlights_max: int | None,
                      highlights_query: str | None) -> tuple[dict[str, Any], int]:
    options: dict[str, Any] = {}
    if text_max:
        options["text"] = {"maxCharacters": text_max}
    if highlights_max:
        highlights: dict[str, Any] = {"maxCharacters": highlights_max}
        if highlights_query:
            highlights["query"] = highlights_query[:300]
        options["highlights"] = highlights
    return options, len(options)


def _retry_after(response: httpx.Response) -> float | None:
    try:
        value = float(response.headers.get("retry-after", ""))
    except ValueError:
        return None
    return min(max(value, 0.0), 10.0)


def _parse(data: dict[str, Any]) -> ExaResponse:
    results: list[ExaResult] = []
    for item in data.get("results") or []:
        if not isinstance(item, dict) or not isinstance(item.get("url"), str):
            continue
        highlights = item.get("highlights") if isinstance(item.get("highlights"), list) else []
        results.append(ExaResult(
            url=item["url"], title=str(item.get("title") or item["url"])[:300],
            id=str(item["id"]) if item.get("id") else None,
            published_date=str(item["publishedDate"])[:40] if item.get("publishedDate") else None,
            author=str(item["author"])[:200] if item.get("author") else None,
            text=str(item.get("text") or "")[:20000],
            highlights=tuple(str(value)[:2000] for value in highlights[:8]),
            summary=str(item["summary"])[:4000] if item.get("summary") else None,
        ))
    cost = data.get("costDollars")
    total = cost.get("total") if isinstance(cost, dict) else None
    cost_usd = float(total) if isinstance(total, (int, float)) and not isinstance(total, bool) and total >= 0 else None
    return ExaResponse(results=tuple(results), cost_usd=cost_usd,
                       request_id=str(data["requestId"]) if data.get("requestId") else None)
