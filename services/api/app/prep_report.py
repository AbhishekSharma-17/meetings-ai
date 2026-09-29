"""Versioned meeting-prep report schemas and citation enforcement.

Report versions:
- v1 (legacy, ``PrepReport`` in meeting_prep.py): findings / people_notes lists. Stored rows
  without ``report_version`` are v1 and are still served unchanged.
- v2 (``PrepReportV2``): structured company, developments, AI landscape, alignment with our
  services, attendee personas and a meeting narrative. Every factual statement carries
  ``source_ids`` that must resolve to ``sources``; uncited claims are dropped by
  ``enforce_citations``. Each source records its origin (public web vs. our own documents).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from typing import Annotated

from pydantic import BaseModel, BeforeValidator, Field

from .apollo_models import ApolloPerson, ApolloSnapshot
from .prep_parties import WhosWho

SourceOrigin = Literal["web", "provided_link", "our_documents", "prep_upload", "organization_brief", "apollo"]
DevelopmentType = Literal["deal", "mou", "partnership", "funding", "product", "hiring", "news"]
Persona = Literal["technical", "business", "sales", "executive", "unknown"]
MatchConfidence = Literal["confirmed", "likely", "unconfirmed"]
WEB_ORIGINS = frozenset({"web", "provided_link"})
INTERNAL_ORIGINS = frozenset({"our_documents", "prep_upload", "organization_brief"})


def _clipped(limit: int) -> Any:
    """A string trimmed (not rejected) at ``limit`` so one verbose model field cannot fail a report."""
    return Annotated[str, BeforeValidator(lambda value: value.strip()[:limit] if isinstance(value, str) else value)]


class PrepSourceV2(BaseModel):
    id: str
    title: str
    url: str | None = None
    publisher: str | None = None
    published_date: str | None = None
    origin: SourceOrigin = "web"


class CitedClaim(BaseModel):
    statement: _clipped(1200)
    source_ids: list[str] = Field(default_factory=list)


class CompanyProfile(BaseModel):
    name: str | None = None
    website: str | None = None
    what_they_do: str = ""
    industry: str = ""
    size_signals: str = ""
    headquarters: str = ""
    source_ids: list[str] = Field(default_factory=list)


class Development(BaseModel):
    title: _clipped(300)
    date: str | None = None
    type: DevelopmentType = "news"
    summary: _clipped(1500) = ""
    source_ids: list[str] = Field(default_factory=list)


class AiLandscape(BaseModel):
    summary: str = ""
    initiatives: list[CitedClaim] = Field(default_factory=list)
    vendors: list[CitedClaim] = Field(default_factory=list)
    end_clients: list[CitedClaim] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)


class ServiceFit(BaseModel):
    service: _clipped(250)
    why: str = ""
    talking_point: str = ""
    source_ids: list[str] = Field(default_factory=list)


class Alignment(BaseModel):
    fit_summary: str = ""
    relevant_services: list[ServiceFit] = Field(default_factory=list)


class AttendeeBrief(BaseModel):
    name: str
    email: str | None = None
    title: str | None = None
    linkedin_url: str | None = None
    match_confidence: MatchConfidence = "unconfirmed"
    background: str = ""
    likely_interests: list[str] = Field(default_factory=list)
    persona: Persona = "unknown"
    angle: str = ""
    source_ids: list[str] = Field(default_factory=list)
    # Set by our resolver (never the model): theirs | other_external | unknown.
    side: Literal["theirs", "other_external", "unknown"] | None = None
    # Verified work profile from Apollo (attached by our matcher, never the model).
    apollo: ApolloPerson | None = None


class PersonaFocus(BaseModel):
    persona: Persona
    focus: str


class MeetingNarrative(BaseModel):
    recommended_focus: str = ""
    by_persona: list[PersonaFocus] = Field(default_factory=list)
    opening: str = ""
    agenda_suggestions: list[str] = Field(default_factory=list)


class PrepUsageTotals(BaseModel):
    exa_calls: int = 0
    llm_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    estimated_usd: float = 0.0
    unpriced_calls: int = 0
    apollo_calls: int = 0


class ResearchStep(BaseModel):
    stage: str
    purpose: str
    query: str | None = None
    category: str | None = None
    results: int = 0
    status: Literal["succeeded", "failed", "skipped"] = "succeeded"
    # Short plain-language detail, e.g. "Apollo unavailable: Apollo rejected the API key" or "cached".
    note: str | None = None


class PrepFindingCompat(BaseModel):
    statement: str
    source_ids: list[str]


class SynthesisOutput(BaseModel):
    """What the research model must return; validated before it becomes a report."""

    executive_brief: str
    company: CompanyProfile
    recent_developments: list[Development] = Field(default_factory=list)
    ai_landscape: AiLandscape = Field(default_factory=AiLandscape)
    alignment: Alignment = Field(default_factory=Alignment)
    attendees: list[AttendeeBrief] = Field(default_factory=list)
    meeting_narrative: MeetingNarrative = Field(default_factory=MeetingNarrative)
    talking_points: list[str] = Field(default_factory=list)
    questions_to_ask: list[str] = Field(default_factory=list)
    watchouts: list[str] = Field(default_factory=list)


class PrepReportV2(SynthesisOutput):
    report_version: Literal[2] = 2
    id: UUID
    calendar_event_id: UUID
    target_company: str | None
    company_website: str | None = None
    sources: list[PrepSourceV2]
    public_research_performed: bool
    research_steps: list[ResearchStep] = Field(default_factory=list)
    usage: PrepUsageTotals = Field(default_factory=PrepUsageTotals)
    started_at: datetime | None = None
    generated_at: datetime
    provider: str
    model: str
    # Who's who used for this briefing (our company vs. the target, attendee sides, warnings).
    whos_who: WhosWho | None = None
    # Structured Apollo facts (company snapshot, people, signals, CRM) when Apollo is connected.
    apollo: ApolloSnapshot | None = None
    # v1-compatible projections so clients written for v1 keep rendering.
    findings: list[PrepFindingCompat] = Field(default_factory=list)
    relevant_offerings: list[str] = Field(default_factory=list)
    people_notes: list[str] = Field(default_factory=list)


def enforce_citations(output: SynthesisOutput, sources: list[PrepSourceV2],
                      our_services: list[str]) -> SynthesisOutput:
    """Drop factual claims whose citations are missing or unknown.

    Recommendations (narrative, talking points, questions, watch-outs) are advice rather than
    facts and are kept. A relevant service must be one of our listed services/products or cite
    one of our own documents.
    """
    known = {source.id for source in sources}
    internal = {source.id for source in sources if source.origin in INTERNAL_ORIGINS}

    def valid(ids: list[str]) -> list[str]:
        return list(dict.fromkeys(item for item in ids if item in known))

    def claims(items: list[CitedClaim]) -> list[CitedClaim]:
        return [item.model_copy(update={"source_ids": valid(item.source_ids)})
                for item in items if item.statement and valid(item.source_ids)]

    company_ids = valid(output.company.source_ids)
    company = output.company.model_copy(update={"source_ids": company_ids} if company_ids else {
        "source_ids": [], "what_they_do": "", "industry": "", "size_signals": "", "headquarters": ""})
    developments = [item.model_copy(update={"source_ids": valid(item.source_ids)})
                    for item in output.recent_developments if valid(item.source_ids)]
    landscape_ids = valid(output.ai_landscape.source_ids)
    landscape = AiLandscape(
        summary=output.ai_landscape.summary if landscape_ids else "",
        initiatives=claims(output.ai_landscape.initiatives), vendors=claims(output.ai_landscape.vendors),
        end_clients=claims(output.ai_landscape.end_clients), source_ids=landscape_ids,
    )
    catalog = {item.strip().lower() for item in our_services if item.strip()}
    services = []
    for item in output.alignment.relevant_services:
        ids = valid(item.source_ids)
        if item.service.strip().lower() in catalog or any(source_id in internal for source_id in ids):
            services.append(item.model_copy(update={"source_ids": ids}))
    attendees = []
    for person in output.attendees:
        ids = valid(person.source_ids)
        attendees.append(person.model_copy(update={
            "source_ids": ids, "background": person.background if ids else "",
            "title": person.title if ids else None,
        }))
    return output.model_copy(update={
        "company": company, "recent_developments": developments, "ai_landscape": landscape,
        "alignment": output.alignment.model_copy(update={"relevant_services": services}),
        "attendees": attendees,
    })


def compat_projection(output: SynthesisOutput) -> dict[str, list[Any]]:
    """Derive the v1 fields (findings, relevant_offerings, people_notes) from a v2 synthesis."""
    findings: list[PrepFindingCompat] = []
    if output.company.what_they_do and output.company.source_ids:
        findings.append(PrepFindingCompat(statement=output.company.what_they_do, source_ids=output.company.source_ids))
    for item in output.recent_developments:
        findings.append(PrepFindingCompat(statement=f"{item.title}: {item.summary}".strip(": "), source_ids=item.source_ids))
    for claim in [*output.ai_landscape.initiatives, *output.ai_landscape.vendors, *output.ai_landscape.end_clients]:
        findings.append(PrepFindingCompat(statement=claim.statement, source_ids=claim.source_ids))
    people = []
    for person in output.attendees:
        role = f" — {person.title}" if person.title else ""
        people.append(f"{person.name}{role} ({person.persona}, profile {person.match_confidence}): {person.angle}".strip())
    return {
        "findings": findings[:20],
        "relevant_offerings": [item.service for item in output.alignment.relevant_services],
        "people_notes": people,
    }


def _nullable(kind: str) -> dict[str, Any]:
    return {"type": [kind, "null"]}


_STR = {"type": "string"}
_STRS = {"type": "array", "items": _STR}
_CLAIM = {"type": "object", "additionalProperties": False, "required": ["statement", "source_ids"],
          "properties": {"statement": _STR, "source_ids": _STRS}}


def _object(properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": False, "properties": properties, "required": list(properties)}


# Strict JSON schema (all keys required, nullable via type unions) for OpenAI-style
# structured outputs; providers without schema support still get it as guidance.
SYNTHESIS_SCHEMA: dict[str, Any] = _object({
    "executive_brief": _STR,
    "company": _object({"name": _nullable("string"), "website": _nullable("string"), "what_they_do": _STR,
                        "industry": _STR, "size_signals": _STR, "headquarters": _STR, "source_ids": _STRS}),
    "recent_developments": {"type": "array", "items": _object({
        "title": _STR, "date": _nullable("string"),
        "type": {"type": "string", "enum": ["deal", "mou", "partnership", "funding", "product", "hiring", "news"]},
        "summary": _STR, "source_ids": _STRS})},
    "ai_landscape": _object({"summary": _STR, "initiatives": {"type": "array", "items": _CLAIM},
                             "vendors": {"type": "array", "items": _CLAIM},
                             "end_clients": {"type": "array", "items": _CLAIM}, "source_ids": _STRS}),
    "alignment": _object({"fit_summary": _STR, "relevant_services": {"type": "array", "items": _object({
        "service": _STR, "why": _STR, "talking_point": _STR, "source_ids": _STRS})}}),
    "attendees": {"type": "array", "items": _object({
        "name": _STR, "email": _nullable("string"), "title": _nullable("string"),
        "linkedin_url": _nullable("string"),
        "match_confidence": {"type": "string", "enum": ["confirmed", "likely", "unconfirmed"]},
        "background": _STR, "likely_interests": _STRS,
        "persona": {"type": "string", "enum": ["technical", "business", "sales", "executive", "unknown"]},
        "angle": _STR, "source_ids": _STRS})},
    "meeting_narrative": _object({"recommended_focus": _STR, "by_persona": {"type": "array", "items": _object({
        "persona": {"type": "string", "enum": ["technical", "business", "sales", "executive", "unknown"]},
        "focus": _STR})}, "opening": _STR, "agenda_suggestions": _STRS}),
    "talking_points": _STRS, "questions_to_ask": _STRS, "watchouts": _STRS,
})

PLAN_SCHEMA: dict[str, Any] = _object({
    "queries": {"type": "array", "items": _object({
        "purpose": {"type": "string", "enum": ["overview", "news", "deals", "ai", "clients", "other"]},
        "query": _STR})},
    "learning_goals": _STRS,
})
