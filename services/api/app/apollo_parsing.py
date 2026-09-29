"""Defensive parsers for Apollo tool results returned through Composio (pure functions, no I/O).

Composio passes Apollo's JSON through (after ``unwrap_tool_result``). Field names follow Apollo's
REST API (https://docs.apollo.io/reference): organization enrichment ``organization{…}``, people
match ``person{…}`` / bulk match ``matches[…]``, ``news_articles[…]``, ``organization_job_postings[…]``,
``accounts[…]`` and ``contacts[…]``. Any field may be missing or null; nothing here raises on odd
shapes. Contact details (emails, phone numbers) are never read into our models.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlsplit

from .apollo_models import (
    ApolloCompany, ApolloContact, ApolloHiring, ApolloJob, ApolloNewsItem, ApolloPerson, ApolloRelationship,
    ApolloRole, CreditLine, HiringTheme, MatchedBy,
)

MAX_TECH = 12
MAX_PAST_ROLES = 3
MAX_NEWS = 5
MAX_JOBS = 10
MAX_CONTACTS = 5

_THEMES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("AI & data", ("machine learning", "ml ", " ai", "ai ", "data scien", "data engineer", "analytics", "llm")),
    ("Engineering", ("engineer", "developer", "software", "devops", "sre", "architect", "platform", "security")),
    ("Sales", ("sales", "account executive", "sdr", "bdr", "business development", "account manager")),
    ("Marketing", ("marketing", "growth", "brand", "content", "demand gen")),
    ("Customer success", ("customer", "support", "success", "implementation", "solutions")),
    ("Product & design", ("product", "design", "ux", "ui ")),
    ("Operations", ("operations", "supply", "logistics", "warehouse", "procurement")),
    ("Finance & legal", ("finance", "accounting", "controller", "legal", "counsel")),
    ("People", ("recruit", "talent", "people", "hr ", "human resources")),
)
_CREDIT_LABELS = {
    "email": "Email credits", "emails": "Email credits", "export": "Export credits", "exports": "Export credits",
    "mobile": "Mobile credits", "phone": "Mobile credits", "direct_dial": "Mobile credits", "dialer": "Dialer minutes",
    "ai": "AI credits", "data": "Data credits", "credits": "Credits",
}
_USED_KEYS = ("used", "consumed", "usage", "used_credits", "credits_used", "spent")
_LIMIT_KEYS = ("limit", "total", "allotted", "allowance", "quota", "max", "credit_limit", "total_credits", "monthly_limit")
_REMAINING_KEYS = ("remaining", "balance", "available", "left", "credits_remaining", "remaining_credits")
_TYPE_KEYS = ("credit_type", "type", "name", "key", "category")


# ----- small helpers ---------------------------------------------------------------------------
def text(value: Any, limit: int = 300) -> str | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str):
        return None
    clean = re.sub(r"\s+", " ", value).strip()
    return clean[:limit] or None


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.replace(",", "").strip())
        except ValueError:
            return None
    return None


def web_url(value: Any) -> str | None:
    """Only absolute http(s) URLs survive; anything else is dropped."""
    url = text(value, 500)
    if not url:
        return None
    if not re.match(r"^https?://", url, re.I):
        url = f"https://{url}" if re.match(r"^[\w.-]+\.[a-z]{2,}(/|$)", url, re.I) else None
    if not url:
        return None
    parts = urlsplit(url)
    return url if parts.scheme in {"http", "https"} and parts.hostname and not parts.username else None


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _join(*parts: Any) -> str | None:
    values = [value for value in (text(part, 80) for part in parts) if value]
    return ", ".join(dict.fromkeys(values)) or None


def _money(value: Any) -> str | None:
    amount = number(value)
    if amount is None or amount <= 0:
        return None
    for size, suffix in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if amount >= size:
            return f"${amount / size:.1f}{suffix}".replace(".0", "")
    return f"${amount:,.0f}"


# ----- organization ----------------------------------------------------------------------------
def parse_organization(data: dict[str, Any]) -> ApolloCompany | None:
    org = _dict(data.get("organization")) or (data if data.get("primary_domain") or data.get("name") else {})
    if not org or not (org.get("name") or org.get("primary_domain")):
        return None
    tech = [text(item.get("name"), 60) if isinstance(item, dict) else text(item, 60)
            for item in [*_list(org.get("current_technologies")), *_list(org.get("technology_names"))]]
    events = [item for item in _list(org.get("funding_events")) if isinstance(item, dict)]
    latest = max(events, key=lambda item: str(item.get("date") or ""), default={})
    employees = number(org.get("estimated_num_employees"))
    founded = number(org.get("founded_year"))
    return ApolloCompany(
        apollo_id=text(org.get("id"), 80), name=text(org.get("name"), 200),
        domain=text(org.get("primary_domain"), 200), website=web_url(org.get("website_url")),
        linkedin_url=web_url(org.get("linkedin_url")), description=text(org.get("short_description"), 600),
        industry=text(org.get("industry"), 120),
        employee_count=int(employees) if employees and employees > 0 else None,
        revenue_band=text(org.get("annual_revenue_printed") or org.get("organization_revenue_printed"), 40)
        or _money(org.get("annual_revenue") or org.get("organization_revenue")),
        total_funding=text(org.get("total_funding_printed"), 40) or _money(org.get("total_funding")),
        latest_funding_stage=text(org.get("latest_funding_stage") or latest.get("type"), 60),
        latest_funding_date=(text(org.get("latest_funding_round_date") or latest.get("date"), 40) or "")[:10] or None,
        latest_funding_amount=_money(latest.get("amount")),
        headquarters=text(org.get("raw_address"), 200) or _join(org.get("city"), org.get("state"), org.get("country")),
        founded_year=int(founded) if founded and 1600 < founded < 2200 else None,
        tech_stack=list(dict.fromkeys(item for item in tech if item))[:MAX_TECH],
    )


# ----- people ----------------------------------------------------------------------------------
def parse_person(record: Any, *, name: str, matched_by: MatchedBy) -> ApolloPerson | None:
    """One Apollo person record for the attendee ``name`` (their calendar name is kept)."""
    person = _dict(record)
    if not person or not (person.get("id") or person.get("title") or person.get("linkedin_url")):
        return None
    history = [item for item in _list(person.get("employment_history")) if isinstance(item, dict)]
    current = next((item for item in history if item.get("current")), None)
    past = [ApolloRole(company=text(item.get("organization_name"), 120), title=text(item.get("title"), 160),
                       start_date=(text(item.get("start_date"), 20) or "")[:10] or None,
                       end_date=(text(item.get("end_date"), 20) or "")[:10] or None, current=bool(item.get("current")))
            for item in history if not item.get("current")][:MAX_PAST_ROLES]
    organization = _dict(person.get("organization"))
    departments = [value for value in (text(item, 60) for item in _list(person.get("departments"))) if value]
    return ApolloPerson(
        name=name, title=text(person.get("title") or (current or {}).get("title"), 160),
        seniority=text(person.get("seniority"), 40),
        departments=[department.replace("master_", "").replace("_", " ") for department in departments][:4],
        company=text(organization.get("name") or (current or {}).get("organization_name"), 160),
        role_started=(text((current or {}).get("start_date"), 20) or "")[:10] or None,
        past_roles=past, linkedin_url=web_url(person.get("linkedin_url")),
        location=_join(person.get("city"), person.get("state"), person.get("country")), matched_by=matched_by,
    )


def bulk_matches(data: dict[str, Any]) -> list[Any]:
    """Bulk match results, index-aligned with the request ``details`` (missing entries are None)."""
    for key in ("matches", "people", "persons"):
        items = data.get(key)
        if isinstance(items, list):
            return items
    return []


def single_person(data: dict[str, Any]) -> Any:
    return data.get("person") if isinstance(data.get("person"), dict) else None


# ----- signals ---------------------------------------------------------------------------------
def parse_news(data: dict[str, Any]) -> list[ApolloNewsItem]:
    items = _list(data.get("news_articles") or data.get("articles") or data.get("news"))
    news = []
    for item in items:
        if not isinstance(item, dict):
            continue
        title = text(item.get("title"), 300)
        if title:
            news.append(ApolloNewsItem(title=title, url=web_url(item.get("url")),
                                       published_at=(text(item.get("published_at"), 40) or "")[:10] or None,
                                       snippet=text(item.get("snippet"), 400)))
    return sorted(news, key=lambda item: item.published_at or "", reverse=True)[:MAX_NEWS]


def job_theme(title: str) -> str:
    padded = f" {title.lower()} "
    return next((theme for theme, words in _THEMES if any(word in padded for word in words)), "Other")


def parse_jobs(data: dict[str, Any]) -> ApolloHiring | None:
    items = [item for item in _list(data.get("organization_job_postings") or data.get("job_postings"))
             if isinstance(item, dict) and text(item.get("title"))]
    if not items:
        return None
    jobs = [ApolloJob(title=text(item.get("title"), 160) or "", url=web_url(item.get("url")),
                      location=_join(item.get("city"), item.get("state"), item.get("country")),
                      posted_at=(text(item.get("posted_at") or item.get("last_seen_at"), 40) or "")[:10] or None)
            for item in items]
    counts = Counter(job_theme(job.title) for job in jobs)
    total = number(_dict(data.get("pagination")).get("total_entries"))
    return ApolloHiring(open_roles=int(total) if total and total >= len(jobs) else len(jobs),
                        themes=[HiringTheme(theme=theme, count=count) for theme, count in counts.most_common(5)],
                        examples=jobs[:MAX_JOBS])


# ----- CRM -------------------------------------------------------------------------------------
def _stage(item: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = item.get(key)
        if isinstance(value, dict):
            value = value.get("name") or value.get("display_name")
        found = text(value, 80)
        if found:
            return found
    return None


def parse_account(data: dict[str, Any], matches: Iterable[str]) -> ApolloRelationship | None:
    """The first account whose name or domain matches the target (``matches`` are lowercased terms)."""
    terms = {term.lower() for term in matches if term}
    for item in _list(data.get("accounts") or data.get("organizations")):
        if not isinstance(item, dict):
            continue
        name, domain = text(item.get("name"), 200), text(item.get("domain") or item.get("primary_domain"), 200)
        if not terms & {value.lower() for value in (name, domain) if value}:
            continue
        return ApolloRelationship(
            account_name=name, stage=_stage(item, "account_stage", "account_stage_name", "stage_name", "stage"),
            owner=_stage(item, "owner", "owner_name"),
            last_activity_at=(text(item.get("last_activity_date") or item.get("last_activity_at"), 40) or "")[:10] or None,
        )
    return None


def parse_contacts(data: dict[str, Any], matches: Iterable[str], exclude_names: Iterable[str] = ()) -> list[ApolloContact]:
    """CRM contacts at the target (organization name or email domain matches); names and titles only."""
    terms = {term.lower() for term in matches if term}
    excluded = {name.lower() for name in exclude_names}
    contacts = []
    for item in _list(data.get("contacts") or data.get("people")):
        if not isinstance(item, dict):
            continue
        name = text(item.get("name")) or _join(item.get("first_name"), item.get("last_name"))
        email = text(item.get("email"), 254) or ""
        company = (text(item.get("organization_name"), 200) or "").lower()
        domain = email.rsplit("@", 1)[1].lower() if "@" in email else ""
        if not name or name.replace(",", "").lower() in excluded or not (company in terms or domain in terms):
            continue
        contacts.append(ApolloContact(
            name=name.replace(", ", " "), title=text(item.get("title"), 160),
            stage=_stage(item, "contact_stage", "contact_stage_name", "stage_name"),
            last_activity_at=(text(item.get("last_activity_date"), 40) or "")[:10] or None,
        ))
    return contacts[:MAX_CONTACTS]


# ----- credit usage stats ----------------------------------------------------------------------
def _pick(item: dict[str, Any], keys: tuple[str, ...]) -> float | None:
    for key in keys:
        value = number(item.get(key))
        if value is not None:
            return value
    return None


def _credit_line(credit_type: str, item: dict[str, Any]) -> CreditLine | None:
    used, limit, remaining = _pick(item, _USED_KEYS), _pick(item, _LIMIT_KEYS), _pick(item, _REMAINING_KEYS)
    if used is None and limit is None and remaining is None:
        return None
    if remaining is None and limit is not None and used is not None:
        remaining = max(limit - used, 0.0)
    if used is None and limit is not None and remaining is not None:
        used = max(limit - remaining, 0.0)
    key = re.sub(r"[^a-z0-9]+", "_", credit_type.lower()).strip("_")[:40] or "credits"
    base = key.removesuffix("_credits").removesuffix("_credit")
    label = _CREDIT_LABELS.get(base) or f"{base.replace('_', ' ').capitalize()} credits"
    return CreditLine(credit_type=key, label=label, used=used, limit=limit, remaining=remaining,
                      unit="minutes" if "dialer" in key else "credits")


def parse_credit_stats(data: dict[str, Any]) -> list[CreditLine]:
    """Whatever per-credit-type balances Apollo reports, as a small list (at most 8 lines)."""
    container: Any = data
    for key in ("balances", "credit_balances", "credits", "usage", "team_balances", "data"):
        if isinstance(data.get(key), (dict, list)):
            container = data[key]
            break
    lines: list[CreditLine] = []
    if isinstance(container, dict):
        for credit_type, item in container.items():
            if str(credit_type).lower().endswith("id"):
                continue
            if isinstance(item, dict):
                line = _credit_line(str(credit_type), item)
            elif number(item) is not None and not isinstance(item, bool):
                line = _credit_line(str(credit_type), {"remaining": item})
            else:
                line = None
            if line:
                lines.append(line)
    elif isinstance(container, list):
        for item in container:
            if isinstance(item, dict):
                credit_type = next((str(item[key]) for key in _TYPE_KEYS if isinstance(item.get(key), str)), "credits")
                line = _credit_line(credit_type, item)
                if line:
                    lines.append(line)
    return lines[:8]
