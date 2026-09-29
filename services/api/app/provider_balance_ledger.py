"""This month's spend that Meetings AI itself recorded, attributed to saved vault keys.

Attribution, most specific first:
1. ``details.credential_id`` on the usage event (e.g. an Exa key test);
2. ``details.profile_id`` -> the vault key that profile is linked to *now* (``provider_profile_credentials``);
   a profile that uses its own pasted key is not attributed to any saved key;
3. Exa research calls -> the workspace's research key, resolved the same way research does
   (the key picked in AI settings, else the oldest saved Exa key).
Only priced events count (``estimated_usd`` set); amounts are list-price estimates, not invoices.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import select

from .database import (
    Database,
    OrganizationAiSettingsRow,
    ProviderCredentialRow,
    ProviderProfileCredentialRow,
    ProviderTenantRow,
    UsageEventRow,
)


def month_start(now: datetime | None = None) -> datetime:
    current = (now or datetime.now(UTC)).astimezone(UTC)
    return current.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def research_key_id(session: Any, organization_id: str) -> str | None:
    """The Exa key research uses: the one picked in AI settings, else the oldest saved Exa key."""
    settings = session.get(OrganizationAiSettingsRow, organization_id)
    if settings is not None and settings.research_credential_id:
        return settings.research_credential_id
    return session.execute(select(ProviderCredentialRow.id).where(
        ProviderCredentialRow.organization_id == organization_id, ProviderCredentialRow.provider_type == "exa",
    ).order_by(ProviderCredentialRow.created_at).limit(1)).scalar_one_or_none()


def _attribute(provider: str, details: dict[str, Any], by_profile: dict[str, str], known: set[str],
               research_key: str | None) -> str | None:
    credential = details.get("credential_id")
    if isinstance(credential, str) and credential in known:
        return credential
    profile = details.get("profile_id")
    if isinstance(profile, str) and profile in by_profile:
        return by_profile[profile]
    if provider == "exa":
        return research_key
    return None


def tracked_spend_by_credential(database: Database, organization_id: UUID, since: datetime) -> dict[str, float]:
    org = str(organization_id)
    with database.session_factory() as session:
        known = set(session.execute(select(ProviderCredentialRow.id).where(
            ProviderCredentialRow.organization_id == org)).scalars().all())
        by_profile = dict(session.execute(select(
            ProviderProfileCredentialRow.profile_id, ProviderProfileCredentialRow.credential_id,
        ).join(ProviderTenantRow, ProviderTenantRow.provider_id == ProviderProfileCredentialRow.profile_id).where(
            ProviderTenantRow.organization_id == org)).all())
        research_key = research_key_id(session, org)
        rows = session.execute(select(UsageEventRow.provider, UsageEventRow.details, UsageEventRow.estimated_usd).where(
            UsageEventRow.organization_id == org, UsageEventRow.created_at >= since,
            UsageEventRow.estimated_usd.is_not(None),
        )).all()
    totals: dict[str, float] = {}
    for provider, details, amount in rows:
        credential = _attribute(provider, details if isinstance(details, dict) else {}, by_profile, known, research_key)
        if credential is not None:
            totals[credential] = totals.get(credential, 0.0) + float(amount)
    return {key: round(value, 6) for key, value in totals.items()}


__all__ = ["month_start", "research_key_id", "tracked_spend_by_credential"]
