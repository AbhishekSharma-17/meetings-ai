"""Normalizes provider balance readings into one status per saved key.

Pure functions only (no I/O) so every provider's wording and threshold rule is unit-tested.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

from .provider_balance_clients import ExaTeamReading, OpenRouterCredits, OpenRouterKeyReading, ProviderCallError

BalanceProvider = Literal["openrouter", "openai", "exa"]
BalanceState = Literal["ok", "low", "exhausted", "unknown", "invalid_key", "error"]
BalanceSource = Literal["provider_api", "admin_key", "our_ledger"]
SpendPeriod = Literal["this_month", "all_time"]

DEFAULT_LOW_BALANCE_USD = 5.0
LOW_LIMIT_RATIO = 0.10
EXHAUSTED_BELOW_USD = 0.005

DASHBOARD_URLS: dict[str, str] = {
    "openrouter": "https://openrouter.ai/settings/credits",
    "openai": "https://platform.openai.com/settings/organization/billing",
    "exa": "https://dashboard.exa.ai/billing",
}
PROVIDER_NAMES: dict[str, str] = {"openrouter": "OpenRouter", "openai": "OpenAI", "exa": "Exa"}


class BalanceStatus(BaseModel):
    credential_id: UUID
    provider: BalanceProvider
    label: str
    hint: str
    balance_usd: float | None = None
    limit_usd: float | None = None
    remaining_usd: float | None = None
    spent_usd: float | None = None
    spent_period: SpendPeriod | None = None
    our_tracked_spend_usd: float = 0.0
    status: BalanceState
    source: BalanceSource
    checked_at: datetime
    note: str
    dashboard_url: str


@dataclass(frozen=True)
class KeyRef:
    credential_id: UUID
    provider: BalanceProvider
    label: str
    hint: str


def classify(remaining: float | None, limit: float | None, threshold: float = DEFAULT_LOW_BALANCE_USD) -> BalanceState:
    """ok / low / exhausted from what is left; low is <= threshold dollars or <= 10% of a key limit."""
    if remaining is None:
        return "unknown"
    if remaining <= EXHAUSTED_BELOW_USD:
        return "exhausted"
    if remaining <= threshold or (limit is not None and limit > 0 and remaining <= limit * LOW_LIMIT_RATIO):
        return "low"
    return "ok"


def _base(key: KeyRef, checked_at: datetime, **fields: object) -> BalanceStatus:
    return BalanceStatus(credential_id=key.credential_id, provider=key.provider, label=key.label, hint=key.hint,
                         checked_at=checked_at, dashboard_url=DASHBOARD_URLS[key.provider], **fields)


def failed_key_status(key: KeyRef, error: ProviderCallError, checked_at: datetime) -> BalanceStatus:
    """The key itself was rejected, is out of credit, or the provider could not be read."""
    name = PROVIDER_NAMES[key.provider]
    notes = {
        "invalid_key": f"{name} rejected this key. Replace it under API keys.",
        "exhausted": f"{name} reports this account has no credit left. Top up to keep AI features working.",
        "error": f"Couldn't check {name} right now ({error}). Try again in a few minutes.",
    }
    return _base(key, checked_at, status=error.kind, source="provider_api", note=notes[error.kind])


def openrouter_status(
    key: KeyRef, reading: OpenRouterKeyReading, credits: OpenRouterCredits | ProviderCallError | None,
    checked_at: datetime, threshold: float = DEFAULT_LOW_BALANCE_USD,
) -> BalanceStatus:
    balance = credits.balance_usd if isinstance(credits, OpenRouterCredits) else None
    key_left = reading.limit_remaining_usd if reading.limit_usd is not None else None
    candidates = [value for value in (key_left, balance) if value is not None]
    remaining = min(candidates) if candidates else None
    spent, period = (reading.usage_monthly_usd, "this_month") if reading.usage_monthly_usd is not None \
        else (reading.usage_usd, "all_time" if reading.usage_usd is not None else None)
    if isinstance(credits, ProviderCallError):
        account = f"The management key couldn't read the account balance ({credits})."
    elif credits is None:
        account = "Add an OpenRouter management key to see the account balance."
    else:
        account = "Account balance from your management key."
    limit_text = "Key limit from OpenRouter." if reading.limit_usd is not None else "This key has no spending limit."
    note = f"{limit_text} {account}"
    if remaining is None and reading.is_free_tier:
        note = f"Free-tier key: only free models are available. {account}"
    return _base(key, checked_at, balance_usd=balance, limit_usd=reading.limit_usd, remaining_usd=remaining,
                 spent_usd=spent, spent_period=period, status=classify(remaining, reading.limit_usd, threshold),
                 source="admin_key" if balance is not None else "provider_api", note=note)


def openai_status(key: KeyRef, costs: float | ProviderCallError | None, checked_at: datetime) -> BalanceStatus:
    lead = "OpenAI doesn't share your remaining balance — check billing."
    if isinstance(costs, float):
        return _base(key, checked_at, spent_usd=costs, spent_period="this_month", status="unknown",
                     source="admin_key", note=f"{lead} Spend is for the whole OpenAI organization this month.")
    extra = f" The admin key couldn't read spend ({costs})." if isinstance(costs, ProviderCallError) \
        else " Add an OpenAI admin key to see official spend."
    return _base(key, checked_at, spent_period="this_month", status="unknown", source="our_ledger",
                 note=f"{lead} Showing spend this app tracked.{extra}")


def match_exa_key(key: KeyRef, secret: str, team: ExaTeamReading) -> str | None:
    """Best-effort match of a saved Exa key to the team's key list (compared locally, never sent)."""
    for item in team.keys:
        if item.id == secret:
            return item.id
    named = [item.id for item in team.keys if item.name and item.name.strip().lower() == key.label.strip().lower()]
    if len(named) == 1:
        return named[0]
    return team.keys[0].id if len(team.keys) == 1 else None


def exa_status(key: KeyRef, team: ExaTeamReading | ProviderCallError | None, matched_id: str | None,
               checked_at: datetime) -> BalanceStatus:
    lead = "Exa doesn't share your remaining credit balance — check billing."
    if not isinstance(team, ExaTeamReading):
        extra = f" The service key couldn't read spend ({team})." if isinstance(team, ProviderCallError) \
            else " Add an Exa service key to see official spend."
        return _base(key, checked_at, spent_period="this_month", status="unknown", source="our_ledger",
                     note=f"{lead} Showing spend this app tracked.{extra}")
    match = next((item for item in team.keys if item.id == matched_id), None)
    if match is None:
        return _base(key, checked_at, spent_usd=team.team_spend_usd, spent_period="this_month", status="unknown",
                     source="admin_key", note=f"{lead} Spend is team-wide this month.")
    if match.over_budget:
        return _base(key, checked_at, limit_usd=match.budget_usd, spent_usd=team.spend_by_key.get(match.id),
                     spent_period="this_month", status="exhausted", source="admin_key",
                     note="This Exa key is over its budget. Raise the budget or top up in Exa.")
    budget = " Budget set in Exa." if match.budget_usd is not None else ""
    return _base(key, checked_at, limit_usd=match.budget_usd, spent_usd=team.spend_by_key.get(match.id),
                 spent_period="this_month", status="unknown", source="admin_key", note=f"{lead}{budget}")


__all__ = [
    "BalanceProvider", "BalanceSource", "BalanceState", "BalanceStatus", "DASHBOARD_URLS",
    "DEFAULT_LOW_BALANCE_USD", "KeyRef", "PROVIDER_NAMES", "classify", "exa_status", "failed_key_status",
    "match_exa_key", "openai_status", "openrouter_status",
]
