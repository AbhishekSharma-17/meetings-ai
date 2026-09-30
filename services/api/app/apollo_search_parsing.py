"""Defensive parsers for Apollo search results used by the Research page (pure functions, no I/O).

Shapes follow Apollo's REST API as passed through Composio:
- organization search (``mixed_companies/search``): ``organizations[…]`` plus ``accounts[…]`` for
  companies already in the team's Apollo, and ``pagination{page, per_page, total_entries, total_pages}``.
- people search (``mixed_people/search`` / ``api_search``): ``people[…]`` (last names may come back
  obfuscated as ``last_name_obfuscated``), ``contacts[…]`` already in the team's Apollo, and either
  ``pagination`` or a top-level ``total_entries``.
Emails, phone numbers and photos in these payloads are never read.
"""

from __future__ import annotations

from typing import Any

from .apollo_parsing import number, text, web_url
from .research_models import CompanyHit, PersonHit

MAX_ITEMS = 50


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _place(item: dict[str, Any]) -> str | None:
    parts = [text(item.get(key), 80) for key in ("city", "state", "country")]
    joined = ", ".join(dict.fromkeys(part for part in parts if part))
    return joined or text(item.get("raw_address") or item.get("organization_raw_address"), 200)


def _domain(item: dict[str, Any]) -> str | None:
    domain = text(item.get("primary_domain") or item.get("domain"), 200)
    return domain.lower().removeprefix("www.") if domain else None


def https_image(value: Any) -> str | None:
    """A logo is shown only from an absolute https URL (never data:, http or relative links)."""
    url = web_url(value)
    return url if url and url.lower().startswith("https://") else None


def pagination(data: dict[str, Any]) -> tuple[int | None, int | None]:
    """(total entries, total pages) from ``pagination`` or top-level fields, when Apollo reports them."""
    block = _dict(data.get("pagination"))
    total = number(block.get("total_entries") if block else data.get("total_entries"))
    pages = number(block.get("total_pages") if block else data.get("total_pages"))
    return (int(total) if total is not None and total >= 0 else None, int(pages) if pages is not None and pages >= 0 else None)


def _company(item: dict[str, Any], apollo_id: str | None, in_account: bool) -> CompanyHit | None:
    name = text(item.get("name"), 200)
    if not name:
        return None
    employees = number(item.get("estimated_num_employees"))
    return CompanyHit(
        apollo_id=apollo_id, name=name, domain=_domain(item), website=web_url(item.get("website_url")),
        linkedin_url=web_url(item.get("linkedin_url")), logo_url=https_image(item.get("logo_url")),
        industry=text(item.get("industry"), 120), employee_count=int(employees) if employees and employees > 0 else None,
        headquarters=_place(item), in_apollo_account=in_account,
    )


def parse_company_search(data: dict[str, Any]) -> list[CompanyHit]:
    """Apollo's organizations in order; saved accounts mark them, and accounts Apollo listed alone come first."""
    accounts = _list(data.get("accounts"))
    account_orgs = {str(item.get("organization_id")) for item in accounts if item.get("organization_id")}
    account_domains = {domain for domain in (_domain(item) for item in accounts) if domain}
    hits: list[CompanyHit] = []
    for item in _list(data.get("organizations")):
        apollo_id, domain = text(item.get("id"), 80), _domain(item)
        hit = _company(item, apollo_id, apollo_id in account_orgs or (domain in account_domains if domain else False))
        if hit and not any((apollo_id and apollo_id == other.apollo_id) or (domain and domain == other.domain) for other in hits):
            hits.append(hit)
    extra = []
    for item in accounts:
        apollo_id, domain = text(item.get("organization_id"), 80), _domain(item)
        if any((apollo_id and apollo_id == other.apollo_id) or (domain and domain == other.domain) for other in [*hits, *extra]):
            continue
        hit = _company(item, apollo_id, True)
        if hit:
            extra.append(hit)
    return [*extra, *hits][:MAX_ITEMS]


def _person_name(item: dict[str, Any]) -> tuple[str | None, bool]:
    first = text(item.get("first_name"), 80)
    last = text(item.get("last_name"), 80)
    if first and last:
        return f"{first} {last}", False
    full = text(item.get("name"), 160)
    if full and not item.get("last_name_obfuscated"):
        return full, False
    hidden = text(item.get("last_name_obfuscated"), 80)
    if first:
        return (f"{first} {hidden}" if hidden else first), True
    return full, bool(hidden)


def parse_people_search(data: dict[str, Any]) -> list[PersonHit]:
    contacts = _list(data.get("contacts"))
    contact_people = {str(item.get("person_id")) for item in contacts if item.get("person_id")}
    hits: list[PersonHit] = []
    seen: set[str] = set()
    for item, is_contact in [*((row, True) for row in contacts), *((row, False) for row in _list(data.get("people")))]:
        apollo_id = text(item.get("person_id") if is_contact and item.get("person_id") else item.get("id"), 80)
        name, partial = _person_name(item)
        if not apollo_id or not name or apollo_id in seen:
            continue
        seen.add(apollo_id)
        organization = _dict(item.get("organization"))
        hits.append(PersonHit(
            apollo_id=apollo_id, name=name, name_partial=partial, title=text(item.get("title"), 160),
            seniority=text(item.get("seniority"), 40),
            company=text(organization.get("name") or item.get("organization_name"), 160),
            company_domain=_domain(organization), location=_place(item), linkedin_url=web_url(item.get("linkedin_url")),
            in_apollo_contacts=is_contact or apollo_id in contact_people,
        ))
    return hits[:MAX_ITEMS]


def enrichment_domain(record: Any) -> str | None:
    """The current employer's domain from a people-enrichment record (used to link people to companies)."""
    return _domain(_dict(_dict(record).get("organization")))


def enrichment_name(record: Any) -> str | None:
    item = _dict(record)
    name, _ = _person_name(item)
    return name
