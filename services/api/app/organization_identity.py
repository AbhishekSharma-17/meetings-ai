"""Who WE are: company name, aliases and email domains (``organization_identities``, schema v25).

Every member can read it; owners and admins edit it. Meeting prep combines it with member email
domains, the brief website and the contact email (``OurIdentity``) so our own company is never
researched or described as the client.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from .accounts import Actor
from .database import (
    Database, OrganizationBriefRow, OrganizationIdentityRow, OrganizationMembershipRow, OrganizationRow, UserRow,
)
from .prep_parties import FREE_MAIL_DOMAINS, SYSTEM_DOMAIN_SUFFIXES, OurIdentity, email_domain, host_of

MAX_ALIASES = 20
MAX_DOMAINS = 30
MAX_MEMBER_EMAILS = 500
_DOMAIN = re.compile(r"^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")


class IdentityPermissionError(PermissionError):
    pass


def normalize_domain(value: str) -> str:
    """'https://www.Acme.io/about', '@acme.io' and 'ACME.IO' all become 'acme.io'."""
    text = value.strip().lower().lstrip("@")
    host = host_of(text) or ""
    return host.strip(".")


def _clean_names(values: list[str], limit: int) -> list[str]:
    seen: set[str] = set()
    cleaned: list[str] = []
    for value in values:
        text = re.sub(r"\s+", " ", value or "").strip()[:120]
        if text and text.lower() not in seen:
            seen.add(text.lower())
            cleaned.append(text)
    return cleaned[:limit]


class OrganizationIdentityInput(BaseModel):
    company_name: str | None = Field(default=None, max_length=200)
    aliases: list[str] = Field(default_factory=list, max_length=MAX_ALIASES)
    domains: list[str] = Field(default_factory=list, max_length=MAX_DOMAINS)

    @field_validator("company_name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        text = re.sub(r"\s+", " ", value or "").strip()
        return text or None

    @field_validator("aliases")
    @classmethod
    def clean_aliases(cls, values: list[str]) -> list[str]:
        return _clean_names(values, MAX_ALIASES)

    @field_validator("domains")
    @classmethod
    def clean_domains(cls, values: list[str]) -> list[str]:
        domains: list[str] = []
        for value in values:
            if not value or not value.strip():
                continue
            domain = normalize_domain(value)
            if not _DOMAIN.fullmatch(domain):
                raise ValueError(f"“{value.strip()[:80]}” is not a valid email domain, e.g. yourcompany.com")
            if domain in FREE_MAIL_DOMAINS:
                raise ValueError(f"{domain} is a personal email provider; add your company's own domain")
            if any(domain == suffix or domain.endswith(f".{suffix}") for suffix in SYSTEM_DOMAIN_SUFFIXES):
                raise ValueError(f"{domain} is a calendar system domain, not your company's")
            if domain not in domains:
                domains.append(domain)
        return domains


class IdentitySuggestions(BaseModel):
    company_name: str | None = None
    domains: list[str] = Field(default_factory=list)


class OrganizationIdentityView(BaseModel):
    company_name: str | None = None
    aliases: list[str] = Field(default_factory=list)
    domains: list[str] = Field(default_factory=list)
    configured: bool = False
    can_edit: bool = False
    updated_at: datetime | None = None
    suggestions: IdentitySuggestions = Field(default_factory=IdentitySuggestions)


class OrganizationIdentityService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def get(self, actor: Actor) -> OrganizationIdentityView:
        """Saved identity, or (before anyone saved it) the suggestions as a prefilled starting point."""
        suggestions = self.suggestions(actor)
        with self.database.session_factory() as session:
            row = session.get(OrganizationIdentityRow, str(actor.organization_id))
            if row is None:
                return OrganizationIdentityView(company_name=suggestions.company_name, domains=suggestions.domains,
                                                can_edit=actor.is_admin, suggestions=suggestions)
            return OrganizationIdentityView(
                company_name=row.company_name, aliases=list(row.aliases or []), domains=list(row.domains or []),
                configured=True, can_edit=actor.is_admin, updated_at=row.updated_at, suggestions=suggestions,
            )

    def save(self, actor: Actor, payload: OrganizationIdentityInput) -> OrganizationIdentityView:
        if not actor.is_admin:
            raise IdentityPermissionError("only workspace owners and admins can change your company identity")
        aliases = [alias for alias in payload.aliases if alias.lower() != (payload.company_name or "").lower()]
        with self.database.session_factory.begin() as session:
            row = session.get(OrganizationIdentityRow, str(actor.organization_id))
            if row is None:
                row = OrganizationIdentityRow(organization_id=str(actor.organization_id), aliases=[], domains=[],
                                              updated_at=datetime.now(UTC))
                session.add(row)
            row.company_name = payload.company_name
            row.aliases = aliases
            row.domains = payload.domains
            row.updated_by = str(actor.user_id)
            row.updated_at = datetime.now(UTC)
        return self.get(actor)

    def suggestions(self, actor: Actor) -> IdentitySuggestions:
        org = str(actor.organization_id)
        with self.database.session_factory() as session:
            organization = session.get(OrganizationRow, org)
            brief = session.get(OrganizationBriefRow, org)
            emails = self._member_emails(session, org)
        domains = [host_of(brief.website) if brief and brief.website else None,
                   email_domain(organization.contact_email if organization else None),
                   *sorted({email_domain(email) for email in emails if email_domain(email)})]
        return IdentitySuggestions(
            company_name=organization.display_name if organization else None,
            domains=list(dict.fromkeys(domain for domain in domains if _is_company_domain(domain)))[:MAX_DOMAINS],
        )

    def our_identity(self, actor: Actor, *, brief_website: str | None = None) -> OurIdentity:
        """Our side for meeting prep: saved identity ∪ member domains ∪ brief website ∪ contact email."""
        org = str(actor.organization_id)
        with self.database.session_factory() as session:
            row = session.get(OrganizationIdentityRow, org)
            organization = session.get(OrganizationRow, org)
            emails = self._member_emails(session, org)
            if brief_website is None:
                brief = session.get(OrganizationBriefRow, org)
                brief_website = brief.website if brief else None
        domains = {*(row.domains if row else []), email_domain(actor.email), host_of(brief_website),
                   email_domain(organization.contact_email if organization else None),
                   *(email_domain(email) for email in emails)}
        name = row.company_name if row and row.company_name else (organization.display_name if organization else None)
        return OurIdentity(
            name=name, aliases=tuple(row.aliases or []) if row else (),
            domains=frozenset(domain for domain in domains if _is_company_domain(domain)),
            name_source="identity" if row and row.company_name else ("workspace" if name else "none"),
            configured=row is not None,
        )

    @staticmethod
    def _member_emails(session, organization_id: str) -> list[str]:
        return list(session.execute(select(UserRow.email).join(
            OrganizationMembershipRow, OrganizationMembershipRow.user_id == UserRow.id,
        ).where(OrganizationMembershipRow.organization_id == organization_id).limit(MAX_MEMBER_EMAILS)).scalars())


def _is_company_domain(domain: str | None) -> bool:
    return bool(domain) and "." in domain and domain not in FREE_MAIL_DOMAINS \
        and not any(domain == suffix or domain.endswith(f".{suffix}") for suffix in SYSTEM_DOMAIN_SUFFIXES)


__all__ = [
    "IdentityPermissionError", "IdentitySuggestions", "OrganizationIdentityInput", "OrganizationIdentityService",
    "OrganizationIdentityView", "normalize_domain",
]
