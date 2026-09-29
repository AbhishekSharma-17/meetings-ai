"""Read-only balance and spend calls to OpenRouter, OpenAI and Exa, plus their response parsers.

Only fixed provider hosts are ever called (no user-supplied URLs), with short timeouts. Keys are
passed in headers and never logged or included in exceptions. What each provider can tell us:

* OpenRouter ``GET /api/v1/key`` (the ordinary key): the key's own limit, remaining limit and
  spend. ``GET /api/v1/credits`` returns the account's purchased credits and usage, but only for a
  *management* key. Values can be about a minute stale.
  Docs: https://openrouter.ai/docs/api-reference/limits
* OpenAI has no official endpoint for the prepaid credit balance. With an *admin* key the
  official Costs API (``GET /v1/organization/costs``) returns daily spend buckets.
* Exa has no balance endpoint. With a *service* key the team-management API
  (https://exa.ai/docs/team-management-spec.yaml, server ``https://admin-api.exa.ai/team-management``)
  lists the team's keys (budget, over-budget flag) and each key's spend for a period.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

import httpx

logger = logging.getLogger(__name__)

OPENROUTER_API = "https://openrouter.ai/api/v1"
OPENAI_API = "https://api.openai.com/v1"
EXA_TEAM_API = "https://admin-api.exa.ai/team-management"

TIMEOUT = httpx.Timeout(8.0, connect=4.0)
MAX_OPENAI_COST_PAGES = 3
OPENAI_COST_BUCKETS = 31  # one page covers a whole calendar month of daily buckets
MAX_EXA_KEYS = 10  # bounds the per-key usage calls against the team API
EXA_KEY_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")  # ids go into a URL path, so only plain tokens are used

FailureKind = Literal["invalid_key", "exhausted", "error"]


class ProviderCallError(Exception):
    """A provider call that did not produce a reading. ``kind`` is the friendly state to show."""

    def __init__(self, kind: FailureKind, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.kind = kind
        self.status_code = status_code


@dataclass(frozen=True)
class OpenRouterKeyReading:
    label: str | None
    limit_usd: float | None
    limit_remaining_usd: float | None
    usage_usd: float | None
    usage_monthly_usd: float | None
    is_free_tier: bool | None


@dataclass(frozen=True)
class OpenRouterCredits:
    total_credits_usd: float
    total_usage_usd: float

    @property
    def balance_usd(self) -> float:
        return round(self.total_credits_usd - self.total_usage_usd, 6)


@dataclass(frozen=True)
class ExaKey:
    id: str
    name: str | None
    budget_usd: float | None
    over_budget: bool


@dataclass(frozen=True)
class ExaTeamReading:
    keys: tuple[ExaKey, ...]
    spend_by_key: dict[str, float]

    @property
    def team_spend_usd(self) -> float:
        return round(sum(self.spend_by_key.values()), 6)


# ----- parsers (pure; unit-tested with recorded shapes) -----------------------------------------
def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _data(payload: Any) -> dict[str, Any]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise ProviderCallError("error", "the provider returned an unexpected response")
    return data


def parse_openrouter_key(payload: Any) -> OpenRouterKeyReading:
    data = _data(payload)
    free = data.get("is_free_tier")
    label = data.get("label")
    return OpenRouterKeyReading(
        label=label if isinstance(label, str) else None,
        limit_usd=_number(data.get("limit")),  # null means no limit on this key
        limit_remaining_usd=_number(data.get("limit_remaining")),
        usage_usd=_number(data.get("usage")),
        usage_monthly_usd=_number(data.get("usage_monthly")),
        is_free_tier=free if isinstance(free, bool) else None,
    )


def parse_openrouter_credits(payload: Any) -> OpenRouterCredits:
    data = _data(payload)
    credits, usage = _number(data.get("total_credits")), _number(data.get("total_usage"))
    if credits is None or usage is None:
        raise ProviderCallError("error", "OpenRouter returned an unexpected credits response")
    return OpenRouterCredits(credits, usage)


def parse_openai_costs(page: Any) -> float:
    """Sum USD amounts across every bucket and result of one Costs API page."""
    if not isinstance(page, dict) or not isinstance(page.get("data"), list):
        raise ProviderCallError("error", "OpenAI returned an unexpected costs response")
    total = 0.0
    for bucket in page["data"]:
        for result in (bucket.get("results") or []) if isinstance(bucket, dict) else []:
            amount = result.get("amount") if isinstance(result, dict) else None
            if not isinstance(amount, dict) or str(amount.get("currency", "usd")).lower() != "usd":
                continue
            value = _number(amount.get("value"))
            total += value or 0.0
    return round(total, 6)


def parse_exa_keys(payload: Any) -> tuple[ExaKey, ...]:
    items = payload.get("apiKeys") if isinstance(payload, dict) else None
    if items is None and isinstance(payload, dict) and isinstance(payload.get("apiKey"), dict):
        items = [payload["apiKey"]]
    if not isinstance(items, list):
        raise ProviderCallError("error", "Exa returned an unexpected key list")
    keys: list[ExaKey] = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not EXA_KEY_ID.fullmatch(item["id"]):
            continue
        cents = _number(item.get("budgetCents"))
        name = item.get("name")
        keys.append(ExaKey(id=item["id"], name=name if isinstance(name, str) else None,
                           budget_usd=round(cents / 100, 2) if cents is not None else None,
                           over_budget=item.get("isOverBudget") is True))
    return tuple(keys)


def parse_exa_usage(payload: Any) -> float:
    total = _number(payload.get("total_cost_usd")) if isinstance(payload, dict) else None
    if total is None:
        raise ProviderCallError("error", "Exa returned an unexpected usage response")
    return round(total, 6)


# ----- HTTP ------------------------------------------------------------------------------------------
def failure_for_status(provider: str, status_code: int) -> ProviderCallError:
    if status_code in {401, 403}:
        return ProviderCallError("invalid_key", f"{provider} rejected the key", status_code)
    if status_code == 402:
        return ProviderCallError("exhausted", f"{provider} reports no remaining credit", status_code)
    if status_code == 429:
        return ProviderCallError("error", f"{provider} is rate limiting balance checks; try again shortly", status_code)
    return ProviderCallError("error", f"{provider} returned HTTP {status_code}", status_code)


async def _get_json(client: httpx.AsyncClient, provider: str, url: str, headers: dict[str, str],
                    params: dict[str, Any] | None = None) -> Any:
    try:
        response = await client.get(url, headers=headers, params=params)
    except httpx.TimeoutException as exc:
        raise ProviderCallError("error", f"{provider} did not answer in time") from exc
    except httpx.HTTPError as exc:
        raise ProviderCallError("error", f"{provider} could not be reached") from exc
    if response.status_code >= 400:
        raise failure_for_status(provider, response.status_code)
    try:
        return response.json()
    except ValueError as exc:
        raise ProviderCallError("error", f"{provider} returned an unreadable response") from exc


def new_client(transport: httpx.AsyncBaseTransport | None = None) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=TIMEOUT, transport=transport, follow_redirects=False)


async def fetch_openrouter_key(client: httpx.AsyncClient, secret: str) -> OpenRouterKeyReading:
    payload = await _get_json(client, "OpenRouter", f"{OPENROUTER_API}/key", {"Authorization": f"Bearer {secret}"})
    return parse_openrouter_key(payload)


async def fetch_openrouter_credits(client: httpx.AsyncClient, management_key: str) -> OpenRouterCredits:
    payload = await _get_json(client, "OpenRouter", f"{OPENROUTER_API}/credits",
                              {"Authorization": f"Bearer {management_key}"})
    return parse_openrouter_credits(payload)


async def check_openai_key(client: httpx.AsyncClient, secret: str) -> None:
    """Free call that only proves the key is accepted; OpenAI does not expose remaining credit."""
    await _get_json(client, "OpenAI", f"{OPENAI_API}/models", {"Authorization": f"Bearer {secret}"})


async def fetch_openai_costs(client: httpx.AsyncClient, admin_key: str, since: datetime) -> float:
    params: dict[str, Any] = {"start_time": int(since.timestamp()), "bucket_width": "1d", "limit": OPENAI_COST_BUCKETS}
    total = 0.0
    for _ in range(MAX_OPENAI_COST_PAGES):
        page = await _get_json(client, "OpenAI", f"{OPENAI_API}/organization/costs",
                               {"Authorization": f"Bearer {admin_key}"}, params)
        total += parse_openai_costs(page)
        cursor = page.get("next_page") if page.get("has_more") else None
        if not isinstance(cursor, str) or not cursor:
            break
        params = {**params, "page": cursor}
    return round(total, 6)


async def fetch_exa_team(client: httpx.AsyncClient, service_key: str, since: datetime) -> ExaTeamReading:
    headers = {"x-api-key": service_key}
    keys = parse_exa_keys(await _get_json(client, "Exa", f"{EXA_TEAM_API}/api-keys", headers))[:MAX_EXA_KEYS]
    spend: dict[str, float] = {}
    params = {"start_date": since.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")}
    for key in keys:
        # The id comes from Exa's own response and was checked to be a plain token; the host stays fixed.
        payload = await _get_json(client, "Exa", f"{EXA_TEAM_API}/api-keys/{key.id}/usage", headers, params)
        spend[key.id] = parse_exa_usage(payload)
    return ExaTeamReading(keys=keys, spend_by_key=spend)


async def probe_billing_key(provider_type: str, secret: str, *,
                            transport: httpx.AsyncBaseTransport | None = None) -> int | None:
    """HTTP status of the read-only call a billing key is for, or None when the provider was unreachable."""
    now = datetime.now(UTC)
    requests: dict[str, tuple[str, dict[str, str], dict[str, Any] | None]] = {
        "openrouter_management": (f"{OPENROUTER_API}/credits", {"Authorization": f"Bearer {secret}"}, None),
        "openai_admin": (f"{OPENAI_API}/organization/costs", {"Authorization": f"Bearer {secret}"},
                         {"start_time": int(now.timestamp()) - 86_400, "bucket_width": "1d", "limit": 1}),
        "exa_service": (f"{EXA_TEAM_API}/api-keys", {"x-api-key": secret}, None),
    }
    if provider_type not in requests:
        raise ValueError(f"not a billing key type: {provider_type}")
    url, headers, params = requests[provider_type]
    try:
        async with new_client(transport) as client:
            response = await client.get(url, headers=headers, params=params)
    except httpx.HTTPError:
        logger.warning("billing key check could not reach %s", httpx.URL(url).host)
        return None
    return response.status_code


__all__ = [
    "EXA_TEAM_API", "OPENAI_API", "OPENROUTER_API", "ExaKey", "ExaTeamReading", "OpenRouterCredits",
    "OpenRouterKeyReading", "ProviderCallError", "check_openai_key", "failure_for_status", "fetch_exa_team",
    "fetch_openai_costs", "fetch_openrouter_credits", "fetch_openrouter_key", "new_client", "parse_exa_keys",
    "parse_exa_usage", "parse_openai_costs", "parse_openrouter_credits", "parse_openrouter_key",
    "probe_billing_key",
]
