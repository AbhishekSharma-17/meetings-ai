"""Our history with a researched company or person, limited to what the viewer can already see.

Company: meetings whose calendar invitees or confirmed speakers use the company's domain (or whose title
names it), the viewer's own briefings and prep inputs that target it, and documents in knowledge bases
the viewer can read that mention it. Our own domains never match (that would be every meeting).

Person: meetings where a calendar invitee or a confirmed speaker has the person's name at the person's
company domain. "What they said" quotes come only from transcripts where that speaker was APPROVED
(a confirmed speaker identity), never from unreviewed labels.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from uuid import UUID

from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from .accounts import Actor
from .database import (
    CalendarEventCacheRow, Database, KnowledgeBaseRow, KnowledgeDocumentRow, MeetingPrepInputRow, MeetingPrepRow,
    MeetingRow, MeetingSourceRow, MeetingSpeakerIdentityRow, MeetingTenantRow,
)
from .prep_parties import OurIdentity, _words, company_key, email_domain
from .research_access import readable_base_ids, readable_meeting_ids
from .tenant import tenant_scope

MAX_SCAN = 2000
MAX_MEETINGS = 25
MAX_DOCUMENTS = 10
MAX_QUOTES = 3
QUOTE_CHARS = 280
MIN_QUOTE_CHARS = 30


class HistoryMeeting(BaseModel):
    meeting_id: UUID
    title: str
    date: datetime
    status: str
    reasons: list[str] = Field(default_factory=list)


class SaidQuote(BaseModel):
    segment_id: str | None
    start_seconds: float
    text: str


class PersonMeeting(HistoryMeeting):
    speaker: str | None = None
    quotes: list[SaidQuote] = Field(default_factory=list)


class HistoryBriefing(BaseModel):
    calendar_event_id: UUID
    title: str
    starts_at: datetime
    briefing_at: datetime | None = None
    executive_brief: str | None = None
    reasons: list[str] = Field(default_factory=list)


class HistoryDocument(BaseModel):
    document_id: UUID
    knowledge_base_id: UUID
    knowledge_base_name: str
    filename: str
    summary: str | None = None


class CompanyHistory(BaseModel):
    meetings: list[HistoryMeeting] = Field(default_factory=list)
    briefings: list[HistoryBriefing] = Field(default_factory=list)
    documents: list[HistoryDocument] = Field(default_factory=list)
    our_company: bool = False


class PersonHistory(BaseModel):
    meetings: list[PersonMeeting] = Field(default_factory=list)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def domain_matches(candidate: str | None, domain: str | None) -> bool:
    candidate = (candidate or "").lower().strip(".")
    return bool(domain and candidate) and (candidate == domain or candidate.endswith(f".{domain}"))


def _contains(words: list[str], phrase: list[str]) -> bool:
    size = len(phrase)
    return bool(size) and any(words[index:index + size] == phrase for index in range(len(words) - size + 1))


def name_matches(person: str | None, candidate: str | None) -> bool:
    """First and last name both present in the candidate (any order: "Patel, Asha" matches "Asha Patel")."""
    wanted = _words(person or "")
    words = set(_words(candidate or ""))
    return len(wanted) >= 2 and wanted[0] in words and wanted[-1] in words


class ResearchHistory:
    def __init__(self, database: Database, repository: object) -> None:
        self.database = database
        self.repository = repository

    # ----- company ------------------------------------------------------------------------------
    def company(self, actor: Actor, *, name: str | None, domain: str | None, identity: OurIdentity) -> CompanyHistory:
        if (domain and identity.owns_domain(domain)) or (name and identity.is_us(name)):
            return CompanyHistory(our_company=True)
        phrase = _words(name or "") if len(company_key(name)) >= 3 else []
        reasons: dict[str, list[str]] = {}
        with self.database.session_factory() as session:
            self._source_matches(session, actor, domain, phrase, reasons)
            self._identity_domain_matches(session, actor, domain, reasons)
            meetings = self._meetings(session, actor, reasons)
            briefings = self._briefings(session, actor, domain, name)
            documents = self._documents(session, actor, domain, name)
        return CompanyHistory(meetings=meetings, briefings=briefings, documents=documents)

    def _source_matches(self, session, actor: Actor, domain: str | None, phrase: list[str],
                        reasons: dict[str, list[str]]) -> None:
        sources = session.execute(select(MeetingSourceRow.meeting_id, MeetingSourceRow.title, MeetingSourceRow.invitees).where(
            MeetingSourceRow.organization_id == str(actor.organization_id)).order_by(MeetingSourceRow.starts_at.desc())
            .limit(MAX_SCAN)).all()
        for meeting_id, title, invitees in sources:
            emails = [item.get("email") for item in invitees or [] if isinstance(item, dict)]
            if domain and any(domain_matches(email_domain(email), domain) for email in emails):
                reasons.setdefault(meeting_id, []).append(f"Invitee from {domain}")
            elif phrase and _contains(_words(title or ""), phrase):
                reasons.setdefault(meeting_id, []).append("Title mentions the company")
        if phrase:
            titled = session.execute(select(MeetingRow.id, MeetingRow.title).join(
                MeetingTenantRow, MeetingTenantRow.meeting_id == MeetingRow.id).where(
                MeetingTenantRow.organization_id == str(actor.organization_id), MeetingRow.title.is_not(None))
                .order_by(MeetingRow.created_at.desc()).limit(MAX_SCAN)).all()
            for meeting_id, title in titled:
                if meeting_id not in reasons and _contains(_words(title or ""), phrase):
                    reasons.setdefault(meeting_id, []).append("Title mentions the company")

    def _identity_domain_matches(self, session, actor: Actor, domain: str | None, reasons: dict[str, list[str]]) -> None:
        if not domain:
            return
        rows = session.execute(select(MeetingSpeakerIdentityRow.meeting_id, MeetingSpeakerIdentityRow.email).join(
            MeetingTenantRow, MeetingTenantRow.meeting_id == MeetingSpeakerIdentityRow.meeting_id).where(
            MeetingTenantRow.organization_id == str(actor.organization_id)).limit(MAX_SCAN)).all()
        for meeting_id, email in rows:
            if domain_matches(email_domain(email), domain) and "Confirmed speaker from the company" not in reasons.get(meeting_id, []):
                reasons.setdefault(meeting_id, []).append("Confirmed speaker from the company")

    def _meetings(self, session, actor: Actor, reasons: dict[str, list[str]]) -> list[HistoryMeeting]:
        allowed = readable_meeting_ids(session, actor, reasons)
        if not allowed:
            return []
        rows = session.execute(select(MeetingRow).where(MeetingRow.id.in_(list(allowed)))).scalars().all()
        starts = dict(session.execute(select(MeetingSourceRow.meeting_id, MeetingSourceRow.starts_at).where(
            MeetingSourceRow.meeting_id.in_(list(allowed)))).all())
        items = [HistoryMeeting(meeting_id=UUID(row.id), title=row.title or "Untitled meeting",
                                date=_aware(starts.get(row.id) or row.joined_at or row.created_at), status=row.status,
                                reasons=reasons[row.id]) for row in rows]
        return sorted(items, key=lambda item: item.date, reverse=True)[:MAX_MEETINGS]

    def _briefings(self, session, actor: Actor, domain: str | None, name: str | None) -> list[HistoryBriefing]:
        """The viewer's own prep only: briefings and prep inputs live on their own calendar events."""
        key = company_key(name)
        found: dict[str, HistoryBriefing] = {}

        def targets(company: str | None, website: str | None, *domains: str | None) -> bool:
            host = re.sub(r"^[a-z]+://", "", (website or "").lower()).split("/", 1)[0].removeprefix("www.")
            return bool((key and company and company_key(company) == key)
                        or any(domain_matches(item, domain) for item in (host, *domains)))

        events = {row.id: row for row in session.execute(select(CalendarEventCacheRow).where(
            CalendarEventCacheRow.organization_id == str(actor.organization_id),
            CalendarEventCacheRow.user_id == str(actor.user_id)).order_by(CalendarEventCacheRow.starts_at.desc())
            .limit(MAX_SCAN)).scalars()}
        for prep in session.execute(select(MeetingPrepRow).where(
                MeetingPrepRow.organization_id == str(actor.organization_id), MeetingPrepRow.user_id == str(actor.user_id))
                .order_by(MeetingPrepRow.created_at.desc()).limit(200)).scalars():
            report = prep.report or {}
            whos = (report.get("whos_who") or {}).get("target") or {}
            apollo = ((report.get("apollo") or {}).get("company") or {})
            if prep.calendar_event_id in events and prep.calendar_event_id not in found and targets(
                    report.get("target_company") or whos.get("name"), report.get("company_website") or whos.get("website"),
                    apollo.get("domain"), *(whos.get("domains") or [])):
                found[prep.calendar_event_id] = self._briefing(events[prep.calendar_event_id], "Briefing",
                                                               prep.created_at, report.get("executive_brief"))
        for inputs in session.execute(select(MeetingPrepInputRow).where(
                MeetingPrepInputRow.organization_id == str(actor.organization_id),
                MeetingPrepInputRow.calendar_event_id.in_(list(events) or [""]))).scalars():
            if inputs.calendar_event_id not in found and targets(inputs.target_company, inputs.company_website):
                found[inputs.calendar_event_id] = self._briefing(events[inputs.calendar_event_id], "Prep notes", None, None)
        return sorted(found.values(), key=lambda item: item.starts_at, reverse=True)[:MAX_MEETINGS]

    @staticmethod
    def _briefing(event: CalendarEventCacheRow, reason: str, generated: datetime | None,
                  brief: str | None) -> HistoryBriefing:
        title = str((event.payload or {}).get("title") or "Calendar event")[:200]
        return HistoryBriefing(calendar_event_id=UUID(event.id), title=title, starts_at=_aware(event.starts_at),
                               briefing_at=_aware(generated) if generated else None,
                               executive_brief=(brief or None) and str(brief)[:600], reasons=[reason])

    def _documents(self, session, actor: Actor, domain: str | None, name: str | None) -> list[HistoryDocument]:
        terms = [term for term in (domain, name if name and len(name) >= 3 else None) if term]
        bases = readable_base_ids(session, actor)
        if not terms or not bases:
            return []
        clauses = []
        for term in terms:
            pattern = "%" + term.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            clauses += [func.lower(KnowledgeDocumentRow.filename).like(pattern, escape="\\"),
                        func.lower(KnowledgeDocumentRow.extracted_text).like(pattern, escape="\\")]
        rows = session.execute(select(KnowledgeDocumentRow, KnowledgeBaseRow.name).join(
            KnowledgeBaseRow, KnowledgeBaseRow.id == KnowledgeDocumentRow.scope_id).where(
            KnowledgeDocumentRow.organization_id == str(actor.organization_id),
            KnowledgeDocumentRow.scope == "knowledge_base", KnowledgeDocumentRow.scope_id.in_(list(bases)),
            or_(*clauses)).order_by(KnowledgeDocumentRow.created_at.desc()).limit(MAX_DOCUMENTS)).all()
        return [HistoryDocument(document_id=UUID(row.id), knowledge_base_id=UUID(row.scope_id), knowledge_base_name=base,
                                filename=row.filename, summary=(row.summary or None) and row.summary[:400])
                for row, base in rows]

    # ----- person -------------------------------------------------------------------------------
    def person(self, actor: Actor, *, name: str, domain: str | None) -> PersonHistory:
        if not domain or len(_words(name)) < 2:
            return PersonHistory()
        reasons: dict[str, list[str]] = {}
        speakers: dict[str, str] = {}
        with self.database.session_factory() as session:
            for meeting_id, invitees in session.execute(select(MeetingSourceRow.meeting_id, MeetingSourceRow.invitees).where(
                    MeetingSourceRow.organization_id == str(actor.organization_id)).order_by(
                    MeetingSourceRow.starts_at.desc()).limit(MAX_SCAN)).all():
                if any(isinstance(item, dict) and name_matches(name, item.get("name"))
                       and domain_matches(email_domain(item.get("email")), domain) for item in invitees or []):
                    reasons.setdefault(meeting_id, []).append("Invited")
            for meeting_id, speaker, email in session.execute(select(
                    MeetingSpeakerIdentityRow.meeting_id, MeetingSpeakerIdentityRow.speaker, MeetingSpeakerIdentityRow.email)
                    .join(MeetingTenantRow, MeetingTenantRow.meeting_id == MeetingSpeakerIdentityRow.meeting_id).where(
                    MeetingTenantRow.organization_id == str(actor.organization_id)).limit(MAX_SCAN)).all():
                if domain_matches(email_domain(email), domain) and (name_matches(name, speaker)
                                                                     or name_matches(name, (email or "").split("@")[0])):
                    reasons.setdefault(meeting_id, []).append("Confirmed speaker")
                    speakers[meeting_id] = speaker
            meetings = self._meetings(session, actor, reasons)
        return PersonHistory(meetings=[self._person_meeting(actor, item, speakers.get(str(item.meeting_id)))
                                       for item in meetings])

    def _person_meeting(self, actor: Actor, meeting: HistoryMeeting, speaker: str | None) -> PersonMeeting:
        if not speaker:
            return PersonMeeting(**meeting.model_dump())
        return PersonMeeting(**meeting.model_dump(), speaker=speaker, quotes=self.quotes(actor, meeting.meeting_id, speaker))

    def quotes(self, actor: Actor, meeting_id: UUID, speaker: str) -> list[SaidQuote]:
        """Up to three substantive turns by an APPROVED speaker identity (re-checked against the transcript)."""
        with tenant_scope(actor.organization_id):
            approved = {item.speaker for item in self.repository.list_speaker_identities(meeting_id)}
            if speaker not in approved:
                return []
            segments = self.repository.get_transcript(meeting_id)
        picked = [segment for segment in segments if segment.speaker == speaker and len(segment.text.strip()) >= MIN_QUOTE_CHARS]
        return [SaidQuote(segment_id=segment.segment_id, start_seconds=segment.start_seconds,
                          text=segment.text.strip()[:QUOTE_CHARS]) for segment in picked[:MAX_QUOTES]]
