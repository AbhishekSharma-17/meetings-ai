"""Shapes and Apollo-response parsing for "Save to Apollo" on the Research page.

Only names, titles, company names, domains and Apollo ids are read from Apollo's CRM responses; emails and
phone numbers (contacts, users) are never read, stored or returned.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from .apollo_parsing import text
from .research_models import ApolloUsage, RecordType

APOLLO_ID_PATTERN = r"^[A-Za-z0-9_-]{1,80}$"
MAX_MATCHES = 5
MAX_OPTIONS = 100


class CrmField(BaseModel):
    label: str
    value: str


class CrmOption(BaseModel):
    id: str
    name: str


class CrmMatch(BaseModel):
    id: str
    name: str
    detail: str | None = None
    url: str


class ApolloSavePreview(BaseModel):
    """Exactly what "Save to Apollo" would write, what it leaves out, and any likely duplicates already in Apollo."""

    record_type: RecordType
    fields: list[CrmField]
    not_sent: list[str] = Field(default_factory=list)
    matches: list[CrmMatch] = Field(default_factory=list)
    stages: list[CrmOption] = Field(default_factory=list)
    stages_note: str | None = None
    owners: list[CrmOption] = Field(default_factory=list)
    owners_note: str | None = None
    usage: ApolloUsage


class ApolloSaveRequest(BaseModel):
    action: Literal["create", "link"]
    record_id: str | None = Field(default=None, pattern=APOLLO_ID_PATTERN)
    create_anyway: bool = False
    stage_id: str | None = Field(default=None, pattern=APOLLO_ID_PATTERN)
    owner_id: str | None = Field(default=None, pattern=APOLLO_ID_PATTERN)


def _list(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _id(item: dict[str, Any]) -> str | None:
    value = text(item.get("id"), 80)
    return value if value and value.replace("-", "").replace("_", "").isalnum() else None


def parse_options(data: dict[str, Any], *keys: str) -> list[CrmOption]:
    """Stages (``contact_stages`` / ``account_stages``) or users, ordered as Apollo shows them; names only."""
    items: list[dict[str, Any]] = []
    for key in keys:
        items = _list(data.get(key))
        if items:
            break
    items = sorted(items, key=lambda item: item.get("display_order") if isinstance(item.get("display_order"), int) else 0)
    options: list[CrmOption] = []
    for item in items:
        if item.get("deleted") is True:
            continue
        name = text(item.get("display_name"), 120) or text(item.get("name"), 120) or " ".join(
            part for part in (text(item.get("first_name"), 60), text(item.get("last_name"), 60)) if part)
        option_id = _id(item)
        if option_id and name:
            options.append(CrmOption(id=option_id, name=name))
    return options[:MAX_OPTIONS]


def contact_candidates(data: dict[str, Any]) -> list[dict[str, str | None]]:
    """Contacts from ``APOLLO_SEARCH_CONTACTS``: id, name, title and company only."""
    found = []
    for item in _list(data.get("contacts")):
        name = text(item.get("name"), 200) or " ".join(
            part for part in (text(item.get("first_name"), 100), text(item.get("last_name"), 100)) if part)
        account = item.get("account") if isinstance(item.get("account"), dict) else {}
        company = text(item.get("organization_name"), 200) or text(account.get("name"), 200)
        if _id(item) and name:
            found.append({"id": _id(item), "name": name, "title": text(item.get("title"), 200), "company": company})
    return found


def account_candidates(data: dict[str, Any]) -> list[dict[str, str | None]]:
    """Accounts from ``APOLLO_SEARCH_ACCOUNTS``: id, name and domain only."""
    found = []
    for item in _list(data.get("accounts")):
        name, domain = text(item.get("name"), 200), text(item.get("domain"), 200)
        if _id(item) and name:
            found.append({"id": _id(item), "name": name, "domain": (domain or "").lower().removeprefix("www.") or None})
    return found


def created_id(data: dict[str, Any], record_type: RecordType) -> str | None:
    """The new record's id from ``{"contact": {...}}`` / ``{"account": {...}}``."""
    record = data.get(record_type)
    return _id(record) if isinstance(record, dict) else None
