"""Credit / balance status for every saved OpenRouter, OpenAI and Exa key in a workspace.

* Provider readings are cached in memory for ``ttl_seconds`` (10 min) per key; a manual refresh
  bypasses the cache and is rate limited per workspace by the route.
* Keys are decrypted server-side only for the call, without marking them as "used".
* Owners and admins are notified (deduped per key per day) when a key is low or out of credit,
  either from a balance check or when a real call fails with 402 / insufficient_quota.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from pydantic import BaseModel
from sqlalchemy import select

from .credential_vault import BILLING_PROVIDER_TYPES, CredentialPublic, CredentialVault
from .database import Database, ProviderCredentialRow
from .provider_balance_clients import (
    ExaTeamReading,
    OpenRouterCredits,
    ProviderCallError,
    check_openai_key,
    fetch_exa_team,
    fetch_openai_costs,
    fetch_openrouter_credits,
    fetch_openrouter_key,
    new_client,
)
from .provider_balance_ledger import month_start, research_key_id, tracked_spend_by_credential
from .tenant import current_organization_id
from .provider_balance_status import (
    DASHBOARD_URLS,
    DEFAULT_LOW_BALANCE_USD,
    PROVIDER_NAMES,
    BalanceProvider,
    BalanceStatus,
    KeyRef,
    exa_status,
    failed_key_status,
    match_exa_key,
    openai_status,
    openrouter_status,
)

logger = logging.getLogger(__name__)

CACHE_TTL_SECONDS = 600
CALL_SIGNAL_SECONDS = 86_400
DEFAULT_CHECK_HOURS = 6.0
INITIAL_CHECK_DELAY_SECONDS = 120
ADMIN_ROLES = ("owner", "admin")
OPENROUTER_HOST = "openrouter.ai"

BILLING_UNLOCKS: dict[str, tuple[BalanceProvider, str]] = {
    "openrouter_management": ("openrouter", "Shows your OpenRouter account balance (credits bought minus used)."),
    "openai_admin": ("openai", "Shows official OpenAI spend this month. OpenAI never shares the remaining balance."),
    "exa_service": ("exa", "Shows official Exa spend and key budgets. Exa never shares the remaining balance."),
}


class BillingKeyInfo(BaseModel):
    provider_type: Literal["openrouter_management", "openai_admin", "exa_service"]
    provider: BalanceProvider
    configured: bool
    credential_id: UUID | None = None
    label: str | None = None
    hint: str | None = None
    unlocks: str


class BalanceOverview(BaseModel):
    items: list[BalanceStatus]
    billing_keys: list[BillingKeyInfo]
    low_balance_threshold_usd: float
    checked_at: datetime | None = None


@dataclass
class _Shared:
    """Account-wide readings made once per check with the optional billing keys."""

    credits: OpenRouterCredits | ProviderCallError | None = None
    openai_costs: float | ProviderCallError | None = None
    exa_team: ExaTeamReading | ProviderCallError | None = None


def balance_provider(credential: CredentialPublic) -> BalanceProvider | None:
    """Which balance API a saved model/research key belongs to (openrouter.ai endpoints count as OpenRouter)."""
    if credential.provider_type in {"openai", "openrouter", "exa"}:
        return credential.provider_type  # type: ignore[return-value]
    if credential.provider_type == "openai_compatible" and credential.base_url:
        host = (urlsplit(credential.base_url).hostname or "").lower()
        if host == OPENROUTER_HOST or host.endswith(f".{OPENROUTER_HOST}"):
            return "openrouter"
    return None


def profile_balance_provider(profile: Any) -> BalanceProvider | None:
    """OpenAI profiles, and OpenAI-compatible profiles pointed at openrouter.ai, have a balance to check."""
    kind = getattr(getattr(profile, "provider_type", None), "value", None)
    if kind == "openai":
        return "openai"
    host = (urlsplit(getattr(profile, "base_url", None) or "").hostname or "").lower()
    if kind == "openai_compatible" and (host == OPENROUTER_HOST or host.endswith(f".{OPENROUTER_HOST}")):
        return "openrouter"
    return None


def is_out_of_credit_error(error: BaseException) -> bool:
    """Provider errors that mean "no credit left" (OpenRouter/Exa 402, OpenAI insufficient_quota)."""
    status = getattr(error, "status_code", None)
    text = str(error)
    return status == 402 or "(402)" in text or "insufficient_quota" in text


def check_interval_from_env(environ: dict[str, str] | None = None) -> float:
    """Seconds between background checks; 0 disables them (``PROVIDER_BALANCE_CHECK_HOURS``)."""
    raw = (environ if environ is not None else os.environ).get("PROVIDER_BALANCE_CHECK_HOURS", "")
    try:
        hours = float(raw) if raw.strip() else DEFAULT_CHECK_HOURS
    except ValueError:
        logger.warning("PROVIDER_BALANCE_CHECK_HOURS is not a number; using %s", DEFAULT_CHECK_HOURS)
        hours = DEFAULT_CHECK_HOURS
    return max(hours, 0.0) * 3600


def threshold_from_env(environ: dict[str, str] | None = None) -> float:
    raw = (environ if environ is not None else os.environ).get("PROVIDER_LOW_BALANCE_USD", "")
    try:
        value = float(raw) if raw.strip() else DEFAULT_LOW_BALANCE_USD
    except ValueError:
        return DEFAULT_LOW_BALANCE_USD
    return value if value >= 0 else DEFAULT_LOW_BALANCE_USD


class ProviderBalanceService:
    def __init__(
        self, database: Database, vault: CredentialVault, notifications: Any | None = None, *,
        transport: httpx.AsyncBaseTransport | None = None, ttl_seconds: float = CACHE_TTL_SECONDS,
        threshold_usd: float | None = None, interval_seconds: float | None = None,
        clock: Callable[[], float] = time.monotonic, now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.database = database
        self.vault = vault
        self.notifications = notifications
        self.transport = transport
        self.ttl_seconds = ttl_seconds
        self.threshold_usd = threshold_from_env() if threshold_usd is None else threshold_usd
        self.interval_seconds = check_interval_from_env() if interval_seconds is None else interval_seconds
        self._clock = clock
        self._now = now
        self._cache: dict[tuple[str, str], tuple[float, str, BalanceStatus]] = {}
        self._signals: dict[tuple[str, str], datetime] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    # ----- public ----------------------------------------------------------------------------------
    async def overview(self, organization_id: UUID, *, force: bool = False,
                       credential_id: UUID | None = None) -> BalanceOverview:
        org = str(organization_id)
        async with self._locks.setdefault(org, asyncio.Lock()):
            credentials = self.vault.list(organization_id)
            keys = [(item, provider) for item in credentials if (provider := balance_provider(item)) is not None]
            billing = self._billing(credentials)
            fingerprint = "|".join(f"{item.id}:{item.updated_at.isoformat()}" for item in billing.values())
            stale = [(item, provider) for item, provider in keys
                     if self._needs_check(org, item, fingerprint, force and (credential_id in {None, item.id}))]
            fresh = await self._check(organization_id, stale, billing) if stale else []
            for item, status in fresh:
                self._cache[(org, str(item.id))] = (self._clock(), self._fingerprint(item, fingerprint), status)
            # Snapshot now: an out-of-credit report may drop a cache entry while this request finishes.
            current = {str(item.id): self._cache[(org, str(item.id))][2] for item, _ in keys}
            tracked = tracked_spend_by_credential(self.database, organization_id, month_start(self._now()))
            items = [self._finish(org, current[str(item.id)], tracked) for item, _ in keys]
        for status in (status for _, status in fresh):
            self._alert(organization_id, status)
        return BalanceOverview(
            items=items, billing_keys=self._billing_info(billing), low_balance_threshold_usd=self.threshold_usd,
            checked_at=max((item.checked_at for item in items), default=None),
        )

    def report_call_failure(self, organization_id: UUID | str, *, provider: BalanceProvider,
                            credential_id: UUID | str | None, context: str) -> None:
        """A real model or research call failed because the account is out of credit. Never raises."""
        try:
            org = str(organization_id)
            if credential_id is not None:
                self._cache.pop((org, str(credential_id)), None)
                self._signals[(org, str(credential_id))] = self._now()
            label = self._label(organization_id, credential_id)
            name = PROVIDER_NAMES[provider]
            subject = f"{name} key “{label}”" if label else name
            self._notify(org, key=f"provider-credit-call:{credential_id or provider}:{self._today()}",
                         severity="danger", title=f"{subject} is out of credit",
                         body=f"A {context} call failed because {name} reports no credit left. Top up at "
                              f"{DASHBOARD_URLS[provider]} or switch to another key under AI providers.")
        except Exception:  # noqa: BLE001 - alerts must never break the failing call's own handling
            logger.exception("could not record an out-of-credit alert")

    def report_exa_out_of_credit(self, organization_id: UUID) -> None:
        """Hook for Exa research calls that got HTTP 402 (the key research resolves to is the one out of credit)."""
        try:
            with self.database.session_factory() as session:
                credential_id = research_key_id(session, str(organization_id))
        except Exception:  # noqa: BLE001
            logger.exception("could not resolve the research key for an Exa credit alert")
            credential_id = None
        self.report_call_failure(organization_id, provider="exa", credential_id=credential_id, context="web research")

    def observe_profile_failure(self, profile: Any, error: BaseException, kind: str) -> None:
        """Hook for failed model calls: alert only when the provider says the account has no credit."""
        if not is_out_of_credit_error(error):
            return
        provider = profile_balance_provider(profile)
        if provider is None:
            return
        try:
            organization_id = current_organization_id()
        except LookupError:
            return
        context = {"llm": "text generation", "embedding": "embedding"}.get(kind, kind)
        self.report_call_failure(organization_id, provider=provider,
                                 credential_id=getattr(profile, "credential_id", None),
                                 context=f"{context} (profile “{getattr(profile, 'name', '')}”)")

    async def check_all_workspaces(self) -> int:
        """Background check of every workspace that has a balance-capable key; returns workspaces checked."""
        with self.database.session_factory() as session:
            orgs = session.execute(select(ProviderCredentialRow.organization_id).where(
                ProviderCredentialRow.provider_type.in_(("openai", "openrouter", "exa", "openai_compatible")),
            ).distinct()).scalars().all()
        checked = 0
        for org in orgs:
            try:
                await self.overview(UUID(org))
                checked += 1
            except Exception:  # noqa: BLE001 - one workspace must not stop the others
                logger.exception("balance check failed for a workspace")
        return checked

    async def run(self) -> None:
        if self.interval_seconds <= 0:
            return
        await asyncio.sleep(INITIAL_CHECK_DELAY_SECONDS)
        while True:
            await self.check_all_workspaces()
            await asyncio.sleep(self.interval_seconds)

    # ----- checking --------------------------------------------------------------------------------
    def _needs_check(self, org: str, item: CredentialPublic, billing: str, forced: bool) -> bool:
        cached = self._cache.get((org, str(item.id)))
        if forced or cached is None:
            return True
        stored_at, fingerprint, _ = cached
        return fingerprint != self._fingerprint(item, billing) or self._clock() - stored_at >= self.ttl_seconds

    @staticmethod
    def _fingerprint(item: CredentialPublic, billing: str) -> str:
        return f"{item.updated_at.isoformat()}|{billing}"

    async def _check(self, organization_id: UUID, stale: list[tuple[CredentialPublic, BalanceProvider]],
                     billing: dict[str, CredentialPublic]) -> list[tuple[CredentialPublic, BalanceStatus]]:
        needed = {provider for _, provider in stale}
        async with new_client(self.transport) as client:
            shared = await self._shared(client, organization_id, billing, needed)
            statuses = await asyncio.gather(*(
                self._read_key(client, organization_id, item, provider, shared) for item, provider in stale))
        return list(zip((item for item, _ in stale), statuses, strict=True))

    async def _shared(self, client: httpx.AsyncClient, organization_id: UUID, billing: dict[str, CredentialPublic],
                      needed: set[str]) -> _Shared:
        since = month_start(self._now())
        jobs = {
            "credits": ("openrouter", "openrouter_management", lambda key: fetch_openrouter_credits(client, key)),
            "openai_costs": ("openai", "openai_admin", lambda key: fetch_openai_costs(client, key, since)),
            "exa_team": ("exa", "exa_service", lambda key: fetch_exa_team(client, key, since)),
        }
        shared = _Shared()
        for field, (provider, billing_type, fetch) in jobs.items():
            credential = billing.get(billing_type)
            if provider not in needed or credential is None:
                continue
            try:
                secret = self.vault.secret_for_balance_check(organization_id, credential.id)
                setattr(shared, field, await fetch(secret))
            except ProviderCallError as exc:
                setattr(shared, field, exc)
            except LookupError:
                logger.info("billing key disappeared during a balance check")
        return shared

    async def _read_key(self, client: httpx.AsyncClient, organization_id: UUID, item: CredentialPublic,
                        provider: BalanceProvider, shared: _Shared) -> BalanceStatus:
        key = KeyRef(credential_id=item.id, provider=provider, label=item.label, hint=item.hint)
        checked_at = self._now()
        try:
            secret = self.vault.secret_for_balance_check(organization_id, item.id)
            if provider == "openrouter":
                reading = await fetch_openrouter_key(client, secret)
                return openrouter_status(key, reading, shared.credits, checked_at, self.threshold_usd)
            if provider == "openai":
                await check_openai_key(client, secret)
                return openai_status(key, shared.openai_costs, checked_at)
            team = shared.exa_team
            matched = match_exa_key(key, secret, team) if isinstance(team, ExaTeamReading) else None
            return exa_status(key, team, matched, checked_at)
        except ProviderCallError as exc:
            return failed_key_status(key, exc, checked_at)
        except LookupError:
            return failed_key_status(key, ProviderCallError("error", "the key was just removed"), checked_at)
        except Exception:  # noqa: BLE001 - one odd response must not hide every other key's status
            logger.exception("unexpected error reading a %s balance", provider)
            return failed_key_status(key, ProviderCallError("error", "unexpected response"), checked_at)

    # ----- output ------------------------------------------------------------------------------------
    def _finish(self, org: str, status: BalanceStatus, tracked: dict[str, float]) -> BalanceStatus:
        key_id = str(status.credential_id)
        ours = tracked.get(key_id, 0.0)
        update: dict[str, Any] = {"our_tracked_spend_usd": ours}
        if status.source == "our_ledger":
            update["spent_usd"] = ours
        signal = self._signals.get((org, key_id))
        recent = signal is not None and (self._now() - signal).total_seconds() < CALL_SIGNAL_SECONDS
        # OpenAI and Exa never report a balance, so a real call failing with "no credit" is the best signal.
        if recent and status.status == "unknown":
            update.update(status="exhausted", note=f"A recent {PROVIDER_NAMES[status.provider]} call failed: "
                                                   f"no credit left. {status.note}")
        return status.model_copy(update=update)

    @staticmethod
    def _billing(credentials: list[CredentialPublic]) -> dict[str, CredentialPublic]:
        found: dict[str, CredentialPublic] = {}
        for item in credentials:  # oldest first, as the vault lists them
            if item.provider_type in BILLING_PROVIDER_TYPES:
                found.setdefault(item.provider_type, item)
        return found

    @staticmethod
    def _billing_info(billing: dict[str, CredentialPublic]) -> list[BillingKeyInfo]:
        return [BillingKeyInfo(
            provider_type=billing_type, provider=provider, configured=billing_type in billing,
            credential_id=billing[billing_type].id if billing_type in billing else None,
            label=billing[billing_type].label if billing_type in billing else None,
            hint=billing[billing_type].hint if billing_type in billing else None, unlocks=unlocks,
        ) for billing_type, (provider, unlocks) in BILLING_UNLOCKS.items()]

    # ----- alerts ------------------------------------------------------------------------------------
    def _alert(self, organization_id: UUID, status: BalanceStatus) -> None:
        if status.status not in {"low", "exhausted"}:
            return
        name = PROVIDER_NAMES[status.provider]
        if status.status == "low" and status.remaining_usd is not None:
            title = f"{name} key “{status.label}” has ${status.remaining_usd:,.2f} left"
            body = f"Top up at {status.dashboard_url} before AI features stop working."
        else:
            title = f"{name} key “{status.label}” is out of credit"
            body = f"AI features using this key will fail until you top up at {status.dashboard_url}."
        self._notify(str(organization_id), key=f"provider-credit:{status.credential_id}:{status.status}:{self._today()}",
                     severity="warning" if status.status == "low" else "danger", title=title, body=body)

    def _notify(self, org: str, *, key: str, severity: str, title: str, body: str) -> None:
        if self.notifications is None:
            return
        self.notifications.notify(org, roles=ADMIN_ROLES, kind="provider_credit", severity=severity,
                                  title=title, body=body, link_view="providers", dedupe_key=key)

    def _label(self, organization_id: UUID | str, credential_id: UUID | str | None) -> str | None:
        if credential_id is None:
            return None
        try:
            return self.vault.get(UUID(str(organization_id)), UUID(str(credential_id))).label
        except (LookupError, ValueError):
            return None

    def _today(self) -> str:
        return self._now().astimezone(UTC).date().isoformat()


__all__ = [
    "BalanceOverview", "BillingKeyInfo", "ProviderBalanceService", "balance_provider",
    "check_interval_from_env", "is_out_of_credit_error", "profile_balance_provider", "threshold_from_env",
]
