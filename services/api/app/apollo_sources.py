"""Turns an Apollo snapshot into labelled briefing sources (``A1``, ``A2``…, origin ``apollo``).

The synthesis model cites these like web sources; each excerpt spells out the structured facts and
says they come from Apollo, so conflicts with web pages can be shown with both sources and dates.
"""

from __future__ import annotations

from typing import Protocol

from .apollo_models import ApolloCompany, ApolloHiring, ApolloNewsItem, ApolloPerson, ApolloRelationship, ApolloSnapshot

APOLLO_APP = "https://app.apollo.io/#/organizations/"


class SourceBook(Protocol):
    def add(self, *, prefix: str, title: str, url: str | None, origin: str, excerpt: str,
            published_date: str | None = None, dedupe: bool = True) -> str: ...


def add_apollo_sources(book: SourceBook, snapshot: ApolloSnapshot, target_label: str | None) -> ApolloSnapshot:
    """Adds one source per Apollo fact group and returns the snapshot with those ``source_id``s set."""
    fetched = snapshot.fetched_at.date().isoformat() if snapshot.fetched_at else None

    def add(title: str, url: str | None, excerpt: str, published: str | None = None) -> str:
        return book.add(prefix="A", title=f"Apollo · {title}", url=url, origin="apollo",
                        excerpt=f"Apollo structured B2B data (retrieved {fetched or 'recently'}). {excerpt}",
                        published_date=published or fetched, dedupe=False)

    company = snapshot.company
    if company is not None:
        name = company.name or target_label or company.domain or "company"
        url = company.linkedin_url or (f"{APOLLO_APP}{company.apollo_id}" if company.apollo_id else company.website)
        company = company.model_copy(update={"source_id": add(f"{name} company profile", url, _company_text(company))})
    people = [person.model_copy(update={"source_id": add(_person_title(person), person.linkedin_url, _person_text(person))})
              for person in snapshot.people]
    news = [item.model_copy(update={"source_id": add(f"News: {item.title}", item.url, _news_text(item), item.published_at)})
            for item in snapshot.news]
    hiring = snapshot.hiring
    if hiring is not None:
        label = (company.name if company and company.name else target_label) or "company"
        hiring = hiring.model_copy(update={"source_id": add(f"{label} open roles", None, _hiring_text(hiring))})
    relationship = snapshot.relationship
    if relationship is not None:
        label = relationship.account_name or target_label or "account"
        relationship = relationship.model_copy(update={
            "source_id": add(f"{label} in your Apollo CRM", None, _relationship_text(relationship))})
    return snapshot.model_copy(update={"company": company, "people": people, "news": news, "hiring": hiring,
                                       "relationship": relationship})


def _facts(pairs: list[tuple[str, object]]) -> str:
    return "; ".join(f"{label}: {value}" for label, value in pairs if value not in (None, "", []))


def _company_text(company: ApolloCompany) -> str:
    round_parts = [part for part in (company.latest_funding_stage, company.latest_funding_date,
                                     company.latest_funding_amount) if part]
    return _facts([
        ("Company", company.name), ("Domain", company.domain), ("Industry", company.industry),
        ("Employees (estimated)", f"{company.employee_count:,}" if company.employee_count else None),
        ("Annual revenue", company.revenue_band), ("Total funding", company.total_funding),
        ("Latest funding round", ", ".join(round_parts) or None), ("Headquarters", company.headquarters),
        ("Founded", company.founded_year), ("Technologies", ", ".join(company.tech_stack) or None),
        ("Description", company.description),
    ])


def _person_title(person: ApolloPerson) -> str:
    return f"{person.name} ({person.title})" if person.title else person.name


def _person_text(person: ApolloPerson) -> str:
    past = [f"{role.title or 'role'} at {role.company or 'unknown'}"
            + (f" ({role.start_date or '?'} to {role.end_date or '?'})" if role.start_date or role.end_date else "")
            for role in person.past_roles]
    return _facts([
        ("Person", person.name), ("Current title", person.title), ("Company", person.company),
        ("Seniority", person.seniority), ("Departments", ", ".join(person.departments) or None),
        ("In current role since", person.role_started), ("Previous roles", "; ".join(past) or None),
        ("Location", person.location), ("Matched by", "work email" if person.matched_by == "email" else "name and company"),
    ])


def _news_text(item: ApolloNewsItem) -> str:
    return _facts([("Headline", item.title), ("Published", item.published_at), ("Summary", item.snippet)])


def _hiring_text(hiring: ApolloHiring) -> str:
    themes = ", ".join(f"{theme.theme} {theme.count}" for theme in hiring.themes)
    examples = "; ".join(job.title + (f" ({job.location})" if job.location else "") for job in hiring.examples[:10])
    return _facts([("Open job postings", hiring.open_roles), ("By theme", themes or None), ("Examples", examples or None)])


def _relationship_text(relationship: ApolloRelationship) -> str:
    contacts = "; ".join(contact.name + (f", {contact.title}" if contact.title else "") for contact in relationship.contacts)
    return _facts([
        ("CRM account", relationship.account_name), ("Stage", relationship.stage), ("Owner", relationship.owner),
        ("Last activity", relationship.last_activity_at), ("Contacts in CRM", contacts or None),
    ])
