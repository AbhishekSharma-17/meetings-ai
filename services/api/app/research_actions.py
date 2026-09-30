"""Actions on a saved research profile: prepare one of my meetings with it, or save it to a knowledge base."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select

from .accounts import Actor
from .composio_calendar import CalendarError
from .database import Database, ResearchProfileRow
from .documents import DocumentAccessError, DocumentNotFoundError, DocumentService, KnowledgeDocument
from .meeting_prep import MAX_PREP_LINKS, MeetingPrepService, PrepInputs
from .prep_parties import attendee_key, email_domain
from .research_history import domain_matches, name_matches
from .research_models import ResearchProfilePublic

MAX_PEOPLE = 20
NOTES_LIMIT = 8000


class ResearchActionError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message, self.status_code = message, status_code


class PrepareRequest(BaseModel):
    calendar_event_id: UUID
    person_profile_ids: list[UUID] = Field(default_factory=list, max_length=MAX_PEOPLE)


class PrepareResult(BaseModel):
    calendar_event_id: UUID
    target_company: str | None
    company_website: str | None
    attendee_sides: dict[str, str]
    matched_people: list[str]
    unmatched_people: list[str]


class KnowledgeRequest(BaseModel):
    knowledge_base_id: UUID


def _website(profile: ResearchProfilePublic) -> str | None:
    if profile.kind == "company" and profile.company_facts and profile.company_facts.website:
        return profile.company_facts.website
    return f"https://{profile.domain}" if profile.domain else None


class ResearchActions:
    def __init__(self, database: Database, meeting_prep: MeetingPrepService, documents: DocumentService) -> None:
        self.database, self.meeting_prep, self.documents = database, meeting_prep, documents

    # ----- prepare a meeting ---------------------------------------------------------------------
    def prepare(self, actor: Actor, profile: ResearchProfilePublic, request: PrepareRequest,
                people: list[ResearchProfilePublic]) -> PrepareResult:
        """Pre-fill prep inputs for one of the viewer's OWN synced events and mark the chosen people as theirs."""
        if actor.role == "viewer":
            raise ResearchActionError("Viewers can't prepare meetings.", 403)
        try:
            event = self.meeting_prep.cache.get_event(actor, request.calendar_event_id)
            current = self.meeting_prep.get_inputs(actor, request.calendar_event_id)
        except CalendarError:
            raise ResearchActionError("That meeting isn't on your synced calendar.", 404) from None
        target = profile.name if profile.kind == "company" else profile.company
        website = _website(profile)
        names = ", ".join(person.name + (f" ({person.title})" if person.title else "") for person in people)
        line = f"From Research: {names} will be on their side." if names else ""
        notes = current.notes if not line or line in current.notes else "\n\n".join(item for item in (current.notes, line) if item)
        values = {"target_company": (target or current.target_company or "")[:200] or None,
                  "company_website": website or current.company_website,
                  "links": list(current.links)[:MAX_PREP_LINKS], "notes": notes[:NOTES_LIMIT]}
        try:
            inputs = PrepInputs(**values)
        except ValidationError:  # a website prep won't research (e.g. not public) is left for the organizer
            inputs = PrepInputs(**{**values, "company_website": current.company_website})
        self.meeting_prep.save_inputs(actor, request.calendar_event_id, inputs)
        sides: dict[str, str] = {}
        matched: list[str] = []
        for person in people:
            hits = [invitee for invitee in event.invitees if name_matches(person.name, invitee.name) and (
                not email_domain(invitee.email) or not person.domain or domain_matches(email_domain(invitee.email), person.domain))]
            for invitee in hits:
                sides[attendee_key(invitee.name, invitee.email)] = "theirs"
            if hits:
                matched.append(person.name)
        return PrepareResult(calendar_event_id=request.calendar_event_id, target_company=inputs.target_company,
                             company_website=inputs.company_website, attendee_sides=sides, matched_people=matched,
                             unmatched_people=[person.name for person in people if person.name not in matched])

    def people_for(self, actor: Actor, profile: ResearchProfilePublic, ids: list[UUID]) -> list[UUID]:
        """Saved person profiles in this workspace among ``ids`` (plus the profile itself when it is a person)."""
        wanted = list(dict.fromkeys([*ids, *([profile.id] if profile.kind == "person" else [])]))[:MAX_PEOPLE]
        if not wanted:
            return []
        with self.database.session_factory() as session:
            found = set(session.execute(select(ResearchProfileRow.id).where(
                ResearchProfileRow.organization_id == str(actor.organization_id), ResearchProfileRow.kind == "person",
                ResearchProfileRow.id.in_([str(item) for item in wanted]))).scalars())
        if len(found) != len(wanted):
            raise ResearchActionError("Some of the chosen people aren't saved in this workspace.", 404)
        return wanted

    # ----- save to knowledge ---------------------------------------------------------------------
    async def save_to_knowledge(self, actor: Actor, profile: ResearchProfilePublic, base_id: UUID,
                                people: list[ResearchProfilePublic]) -> KnowledgeDocument:
        try:
            self.documents.authorize(actor, "knowledge_base", base_id, write=True)
        except DocumentNotFoundError:
            raise ResearchActionError("That knowledge base wasn't found.", 404) from None
        except DocumentAccessError:
            raise ResearchActionError("You can add to knowledge bases you created; admins can add to any.", 403) from None
        text = profile_markdown(profile, people)
        filename = f"{profile.name[:120]} — Apollo research.md"
        return await self.documents.ingest(actor.organization_id, "knowledge_base", base_id, filename, "text/markdown",
                                           text.encode("utf-8"), actor.user_id)


def _facts(pairs: list[tuple[str, Any]]) -> list[str]:
    return [f"- **{label}:** {value}" for label, value in pairs if value not in (None, "", [])]


def profile_markdown(profile: ResearchProfilePublic, people: list[ResearchProfilePublic]) -> str:
    fetched = profile.fetched_at.date().isoformat()
    lines = [f"# {profile.name} — {'company' if profile.kind == 'company' else 'person'} research",
             f"Source: Apollo, fetched {fetched}.", ""]
    company = profile.company_facts
    if company is not None:
        stage = ", ".join(part for part in (company.latest_funding_stage, company.latest_funding_date,
                                            company.latest_funding_amount) if part)
        lines += ["## Company facts", *_facts([
            ("Website", company.website), ("Domain", company.domain), ("Industry", company.industry),
            ("Employees (estimated)", f"{company.employee_count:,}" if company.employee_count else None),
            ("Revenue", company.revenue_band), ("Total funding", company.total_funding), ("Latest round", stage or None),
            ("Headquarters", company.headquarters), ("Founded", company.founded_year),
            ("Technologies", ", ".join(company.tech_stack) or None), ("LinkedIn", company.linkedin_url),
            ("About", company.description)]), ""]
    person = profile.person
    if person is not None:
        lines += ["## Person facts", *_facts([
            ("Title", person.title), ("Company", person.company), ("Seniority", person.seniority),
            ("Departments", ", ".join(person.departments) or None), ("In role since", person.role_started),
            ("Location", person.location), ("LinkedIn", person.linkedin_url)]), ""]
        if person.past_roles:
            lines += ["## Earlier roles", *[f"- {role.title or 'Role'} at {role.company or 'unknown'}"
                                            + (f" ({role.start_date or '?'} – {role.end_date or '?'})" if role.start_date or role.end_date else "")
                                            for role in person.past_roles], ""]
    if profile.news:
        lines += ["## News (last 90 days)", *[f"- {item.published_at or 'Undated'} — {item.title}" + (f" ({item.url})" if item.url else "")
                                              for item in profile.news], ""]
    if profile.hiring:
        themes = ", ".join(f"{theme.theme} {theme.count}" for theme in profile.hiring.themes)
        lines += ["## Hiring", f"- {profile.hiring.open_roles} open roles" + (f" ({themes})" if themes else ""),
                  *[f"- {job.title}" + (f", {job.location}" if job.location else "") for job in profile.hiring.examples], ""]
    if people:
        lines += ["## People saved at this company", *[f"- {item.name}" + (f" — {item.title}" if item.title else "") for item in people], ""]
    lines.append(f"_Source: Apollo, fetched {fetched}. Saved from Research in Meetings AI._")
    return "\n".join(lines)
