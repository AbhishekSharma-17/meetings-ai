"""Organization context, organizer inputs and evidence-linked meeting briefings.

Briefings are versioned: stored v1 reports (``PrepReport``) are served unchanged, new briefings
are ``PrepReportV2`` produced by the Exa-backed research pipeline in ``prep_research``.
"""

from __future__ import annotations

import io
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import httpx
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import or_, and_, select

from .accounts import Actor
from .calendar_cache import CalendarCacheService
from .database import (
    Database, KnowledgeDocumentRow, MeetingPrepInputRow, MeetingPrepRow, OrganizationBriefDocumentRow,
    OrganizationBriefRow, UsageEventRow,
)
from .exa_client import ExaClient, UsageContext
from .organization_identity import OrganizationIdentityService
from .prep_parties import OurIdentity, PartyInputs, WhosWho, resolve_parties
from .prep_report import PrepReportV2, PrepUsageTotals, compat_projection
from .prep_research import (
    OurDocument, PrepBusyError, PrepConfigError, PrepError, PrepPermissionError, PrepResearchPipeline,
    ResearchInputs, resolve_exa_key,
)
from .service import ProviderProfileService

logger = logging.getLogger(__name__)
MAX_PREP_LINKS = 12
MAX_ATTENDEE_SIDES = 100
AttendeeSides = dict[str, Literal["ours", "theirs"]]
__all__ = ["PrepBusyError", "PrepConfigError", "PrepError", "PrepPermissionError"]


def _public_url(value: str, *, https_only: bool) -> str:
    value = value.strip()
    parts = urlsplit(value)
    allowed = {"https"} if https_only else {"http", "https"}
    host = parts.hostname or ""
    if parts.scheme not in allowed or "." not in host or host == "localhost" or parts.username or parts.password \
            or len(value) > 500:
        raise ValueError("links must be valid public HTTPS URLs" if https_only else "enter a valid public website URL")
    return value


class OrganizationBrief(BaseModel):
    website: str | None = Field(default=None, max_length=500)
    overview: str = Field(default="", max_length=12000)
    services: list[str] = Field(default_factory=list, max_length=30)
    products: list[str] = Field(default_factory=list, max_length=30)
    differentiators: str = Field(default="", max_length=8000)
    positioning: str = Field(default="", max_length=8000)
    updated_at: datetime | None = None

    @field_validator("website")
    @classmethod
    def website_url(cls, value: str | None) -> str | None:
        if not value:
            return None
        parts = urlsplit(value.strip())
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
            raise ValueError("enter a valid public website URL")
        return value.strip()

    @field_validator("services", "products")
    @classmethod
    def clean_items(cls, values: list[str]) -> list[str]:
        return [value.strip()[:250] for value in values if value.strip()]


class BriefDocument(BaseModel):
    id: UUID
    filename: str
    content_type: str
    character_count: int
    uploaded_at: datetime


class PrepInputs(BaseModel):
    """What the organizer tells us before research: who, where to look, what to learn."""

    target_company: str | None = Field(default=None, max_length=200)
    company_website: str | None = Field(default=None, max_length=500)
    links: list[str] = Field(default_factory=list, max_length=MAX_PREP_LINKS)
    notes: str = Field(default="", max_length=8000)
    updated_at: datetime | None = None

    @field_validator("target_company")
    @classmethod
    def clean_company(cls, value: str | None) -> str | None:
        return value.strip() or None if value else None

    @field_validator("company_website")
    @classmethod
    def website(cls, value: str | None) -> str | None:
        return _public_url(value, https_only=False) if value and value.strip() else None

    @field_validator("links")
    @classmethod
    def https_links(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(_public_url(value, https_only=True) for value in values if value.strip()))


def _clean_sides(values: dict[str, str]) -> dict[str, str]:
    """Attendee key (lowercased email, or ``name:<words>``) → ours | theirs, bounded."""
    if len(values) > MAX_ATTENDEE_SIDES:
        raise ValueError(f"at most {MAX_ATTENDEE_SIDES} attendee corrections")
    cleaned: dict[str, str] = {}
    for key, side in values.items():
        key = key.strip().lower()
        if not key or len(key) > 320:
            raise ValueError("attendee keys must be an email address or a name key")
        cleaned[key] = side
    return cleaned


class PrepRequest(BaseModel):
    """Generate a briefing. Stored inputs are used; inline fields (legacy client) override them."""

    context: str = Field(default="", max_length=8000)
    target_company: str | None = Field(default=None, max_length=200)
    company_website: str | None = Field(default=None, max_length=500)
    profile_urls: list[str] = Field(default_factory=list, max_length=MAX_PREP_LINKS)
    text_profile_id: UUID | None = None
    research_enabled: bool = True
    # Organizer corrections from the who's-who panel (kept with the saved briefing).
    attendee_sides: AttendeeSides = Field(default_factory=dict)

    @field_validator("attendee_sides")
    @classmethod
    def sides(cls, values: dict[str, str]) -> dict[str, str]:
        return _clean_sides(values)

    @field_validator("company_website")
    @classmethod
    def website(cls, value: str | None) -> str | None:
        return _public_url(value, https_only=False) if value and value.strip() else None

    @field_validator("profile_urls")
    @classmethod
    def public_urls(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(_public_url(value, https_only=True) for value in values if value.strip()))


class WhosWhoRequest(BaseModel):
    """Preview the who's-who with the organizer's current (unsaved) inputs and corrections."""

    target_company: str | None = Field(default=None, max_length=200)
    company_website: str | None = Field(default=None, max_length=500)
    attendee_sides: AttendeeSides = Field(default_factory=dict)

    @field_validator("company_website")
    @classmethod
    def website(cls, value: str | None) -> str | None:
        """A half-typed website is ignored in a preview instead of failing it."""
        if not value or not value.strip():
            return None
        try:
            return _public_url(value, https_only=False)
        except ValueError:
            return None

    @field_validator("attendee_sides")
    @classmethod
    def sides(cls, values: dict[str, str]) -> dict[str, str]:
        return _clean_sides(values)


class PrepSource(BaseModel):
    id: str
    title: str
    url: str


class PrepFinding(BaseModel):
    statement: str
    source_ids: list[str]


class PrepReport(BaseModel):
    """Legacy (v1) briefing, still served for reports saved before report_version 2."""

    report_version: int = 1
    id: UUID
    calendar_event_id: UUID
    target_company: str | None
    executive_brief: str
    findings: list[PrepFinding]
    relevant_offerings: list[str]
    talking_points: list[str]
    questions_to_ask: list[str]
    watchouts: list[str]
    people_notes: list[str]
    sources: list[PrepSource]
    public_research_performed: bool
    generated_at: datetime
    provider: str
    model: str


class OrganizationBriefService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def get(self, actor: Actor) -> OrganizationBrief:
        with self.database.session_factory() as session:
            row = session.get(OrganizationBriefRow, str(actor.organization_id))
            return self._public(row) if row else OrganizationBrief()

    def save(self, actor: Actor, brief: OrganizationBrief) -> OrganizationBrief:
        if not actor.is_admin:
            raise PrepError("workspace administrator access required")
        with self.database.session_factory.begin() as session:
            row = session.get(OrganizationBriefRow, str(actor.organization_id))
            if row is None:
                row = OrganizationBriefRow(organization_id=str(actor.organization_id), website=None,
                    overview="", services=[], products=[], differentiators="", positioning="", updated_at=datetime.now(UTC))
                session.add(row)
            row.website = brief.website
            row.overview = brief.overview.strip()
            row.services = brief.services
            row.products = brief.products
            row.differentiators = brief.differentiators.strip()
            row.positioning = brief.positioning.strip()
            row.updated_at = datetime.now(UTC)
            return self._public(row)

    def documents(self, actor: Actor) -> list[BriefDocument]:
        with self.database.session_factory() as session:
            rows = session.execute(select(OrganizationBriefDocumentRow).where(
                OrganizationBriefDocumentRow.organization_id == str(actor.organization_id),
            ).order_by(OrganizationBriefDocumentRow.uploaded_at.desc())).scalars().all()
            return [self._document(row) for row in rows]

    def upload(self, actor: Actor, filename: str, data: bytes) -> BriefDocument:
        if not actor.is_admin:
            raise PrepError("workspace administrator access required")
        if not data or len(data) > 8 * 1024 * 1024:
            raise PrepError("document must be between 1 byte and 8 MB")
        name = Path(filename).name[:255]
        suffix = Path(name).suffix.lower()
        if suffix in {".txt", ".md"}:
            kind = "text/plain" if suffix == ".txt" else "text/markdown"
            text = data.decode("utf-8", errors="replace")
        elif suffix == ".pdf":
            from pypdf import PdfReader
            try:
                reader = PdfReader(io.BytesIO(data))
                text = "\n".join(page.extract_text() or "" for page in reader.pages[:80])
            except Exception as exc:
                raise PrepError("could not read this PDF") from exc
            kind = "application/pdf"
        elif suffix == ".docx":
            from docx import Document
            try:
                document = Document(io.BytesIO(data))
                text = "\n".join(paragraph.text for paragraph in document.paragraphs)
            except Exception as exc:
                raise PrepError("could not read this Word document") from exc
            kind = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        else:
            raise PrepError("upload a PDF, DOCX, Markdown, or text file")
        text = re.sub(r"\n{3,}", "\n\n", text).strip()[:80000]
        if len(text) < 30:
            raise PrepError("no readable text found; scanned PDFs need OCR before upload")
        with self.database.session_factory.begin() as session:
            row = OrganizationBriefDocumentRow(id=str(uuid4()), organization_id=str(actor.organization_id),
                filename=name, content_type=kind, extracted_text=text, uploaded_at=datetime.now(UTC))
            session.add(row)
            return self._document(row)

    def delete_document(self, actor: Actor, document_id: UUID) -> None:
        if not actor.is_admin:
            raise PrepError("workspace administrator access required")
        with self.database.session_factory.begin() as session:
            row = session.get(OrganizationBriefDocumentRow, str(document_id))
            if row is None or row.organization_id != str(actor.organization_id):
                raise PrepError("organization document not found")
            session.delete(row)

    def context(self, actor: Actor) -> tuple[OrganizationBrief, list[tuple[str, str]]]:
        with self.database.session_factory() as session:
            rows = session.execute(select(OrganizationBriefDocumentRow).where(
                OrganizationBriefDocumentRow.organization_id == str(actor.organization_id),
            ).order_by(OrganizationBriefDocumentRow.uploaded_at.desc()).limit(6)).scalars().all()
            return self.get(actor), [(row.filename, row.extracted_text[:12000]) for row in rows]

    @staticmethod
    def _public(row: OrganizationBriefRow) -> OrganizationBrief:
        return OrganizationBrief(website=row.website, overview=row.overview, services=row.services,
            products=row.products, differentiators=row.differentiators, positioning=row.positioning,
            updated_at=row.updated_at)

    @staticmethod
    def _document(row: OrganizationBriefDocumentRow) -> BriefDocument:
        return BriefDocument(id=UUID(row.id), filename=row.filename, content_type=row.content_type,
            character_count=len(row.extracted_text), uploaded_at=row.uploaded_at)




class PrepHistoryItem(BaseModel):
    id: UUID
    report_version: int
    target_company: str | None
    generated_at: datetime
    provider: str
    model: str
    public_research_performed: bool
    usage: PrepUsageTotals


class PrepHistory(BaseModel):
    calendar_event_id: UUID
    items: list[PrepHistoryItem]
    totals: PrepUsageTotals


def parse_report(data: dict[str, Any]) -> PrepReportV2 | PrepReport:
    """Stored rows without report_version are v1 and are served in their original shape."""
    return PrepReportV2.model_validate(data) if data.get("report_version") == 2 else PrepReport.model_validate(data)


ProgressCallback = Callable[[str, str], Awaitable[None]]


async def _no_progress(_: str, __: str) -> None:
    return None


class MeetingPrepService:
    """Organizer inputs, briefing generation (Exa research + LLM synthesis) and history.

    Collaborators from other modules are optional and duck-typed so the service works before
    they are wired: ``vault`` (CredentialVault), ``ai_settings`` (AiSettingsService),
    ``retriever`` (ChunkRetriever), ``usage`` (UsageLedger).
    """

    def __init__(self, database: Database, cache: CalendarCacheService, briefs: OrganizationBriefService,
                 providers: ProviderProfileService, *, usage: Any | None = None, vault: Any | None = None,
                 ai_settings: Any | None = None, retriever: Any | None = None,
                 exa_transport: httpx.AsyncBaseTransport | None = None, environ: dict[str, str] | None = None,
                 exa_sleep: Callable[[float], Awaitable[None]] | None = None,
                 identities: OrganizationIdentityService | None = None) -> None:
        self.database, self.cache, self.briefs, self.providers = database, cache, briefs, providers
        self.identities = identities or OrganizationIdentityService(database)
        self.usage = usage if usage is not None else getattr(providers, "usage", None)
        self.vault, self.ai_settings, self.retriever = vault, ai_settings, retriever
        self.exa_transport, self.environ, self.exa_sleep = exa_transport, environ, exa_sleep
        self.credit_alerts: Any | None = None  # set by create_app; alerts owners when Exa returns 402
        # One running briefing per user and event (single API process; see deployment notes).
        self._active: set[tuple[str, str, str]] = set()

    # ----- reports -------------------------------------------------------------------------
    def latest(self, actor: Actor, event_id: UUID) -> PrepReportV2 | PrepReport | None:
        self.cache.get_event(actor, event_id)
        with self.database.session_factory() as session:
            row = session.execute(select(MeetingPrepRow).where(
                MeetingPrepRow.organization_id == str(actor.organization_id),
                MeetingPrepRow.user_id == str(actor.user_id),
                MeetingPrepRow.calendar_event_id == str(event_id),
            ).order_by(MeetingPrepRow.created_at.desc()).limit(1)).scalar_one_or_none()
            return parse_report(row.report) if row else None

    def history(self, actor: Actor, event_id: UUID) -> PrepHistory:
        self.cache.get_event(actor, event_id)
        with self.database.session_factory() as session:
            rows = session.execute(select(MeetingPrepRow).where(
                MeetingPrepRow.organization_id == str(actor.organization_id),
                MeetingPrepRow.user_id == str(actor.user_id),
                MeetingPrepRow.calendar_event_id == str(event_id),
            ).order_by(MeetingPrepRow.created_at.desc()).limit(50)).scalars().all()
            items = []
            for row in rows:
                report = row.report
                started = _parse_time(report.get("started_at")) if report.get("report_version") == 2 else None
                usage = self._usage_totals(session, actor, event_id, started, row.created_at) if started \
                    else PrepUsageTotals()
                items.append(PrepHistoryItem(
                    id=UUID(row.id), report_version=int(report.get("report_version") or 1),
                    target_company=report.get("target_company"), generated_at=row.created_at,
                    provider=str(report.get("provider") or "unknown"), model=str(report.get("model") or "unknown"),
                    public_research_performed=bool(report.get("public_research_performed")), usage=usage,
                ))
            totals = self._usage_totals(session, actor, event_id, None, None)
        return PrepHistory(calendar_event_id=event_id, items=items, totals=totals)

    # ----- organizer inputs ----------------------------------------------------------------
    def get_inputs(self, actor: Actor, event_id: UUID) -> PrepInputs:
        self.cache.get_event(actor, event_id)
        with self.database.session_factory() as session:
            row = session.get(MeetingPrepInputRow, str(event_id))
            if row is None or row.organization_id != str(actor.organization_id):
                return PrepInputs()
            return PrepInputs(target_company=row.target_company, company_website=row.company_website,
                              links=row.links or [], notes=row.notes, updated_at=row.updated_at)

    def save_inputs(self, actor: Actor, event_id: UUID, inputs: PrepInputs) -> PrepInputs:
        _require_contributor(actor)
        self.cache.get_event(actor, event_id)
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            row = session.get(MeetingPrepInputRow, str(event_id))
            if row is not None and row.organization_id != str(actor.organization_id):
                raise PrepPermissionError("prep inputs belong to another workspace")
            if row is None:
                row = MeetingPrepInputRow(calendar_event_id=str(event_id), organization_id=str(actor.organization_id),
                                          links=[], notes="", updated_at=now)
                session.add(row)
            row.target_company = inputs.target_company
            row.company_website = inputs.company_website
            row.links = list(inputs.links)
            row.notes = inputs.notes.strip()
            row.updated_by = str(actor.user_id)
            row.updated_at = now
        return inputs.model_copy(update={"updated_at": now})

    # ----- who's who -----------------------------------------------------------------------
    def whos_who(self, actor: Actor, event_id: UUID, request: WhosWhoRequest) -> WhosWho:
        """Our company vs. the target and each attendee's side, as the next briefing would see them."""
        event = self.cache.get_event(actor, event_id)
        brief = self.briefs.get(actor)
        return self._parties(actor, event, brief, PartyInputs(request.target_company, request.company_website,
                                                               dict(request.attendee_sides)))[1]

    def _parties(self, actor: Actor, event: Any, brief: OrganizationBrief,
                 inputs: PartyInputs) -> tuple[OurIdentity, WhosWho]:
        identity = self.identities.our_identity(actor, brief_website=brief.website)
        return identity, resolve_parties(identity, inputs, event.invitees, title=event.title, agenda=event.agenda)

    # ----- generation ----------------------------------------------------------------------
    async def generate(self, actor: Actor, event_id: UUID, request: PrepRequest,
                       progress: ProgressCallback | None = None) -> PrepReportV2:
        _require_contributor(actor)
        key = (str(actor.organization_id), str(actor.user_id), str(event_id))
        if key in self._active:
            raise PrepBusyError("a briefing for this meeting is already being prepared")
        self._active.add(key)
        try:
            return await self._generate(actor, event_id, request, progress or _no_progress)
        finally:
            self._active.discard(key)

    async def _generate(self, actor: Actor, event_id: UUID, request: PrepRequest,
                        emit: ProgressCallback) -> PrepReportV2:
        event = self.cache.get_event(actor, event_id)
        stored = self.get_inputs(actor, event_id)
        inputs = ResearchInputs(
            target_company=request.target_company or stored.target_company,
            company_website=request.company_website or stored.company_website,
            links=tuple(request.profile_urls or stored.links),
            notes="\n\n".join(dict.fromkeys(text.strip() for text in (stored.notes, request.context) if text.strip())),
            research_enabled=request.research_enabled,
        )
        await emit("queued", "Preparing research")
        exa_key = resolve_exa_key(actor.organization_id, vault=self.vault, ai_settings=self.ai_settings,
                                  environ=self.environ) if inputs.research_enabled else None
        brief, _ = self.briefs.context(actor)
        identity, parties = self._parties(actor, event, brief, PartyInputs(
            inputs.target_company, inputs.company_website, dict(request.attendee_sides)))
        profile_id, model_override = self._research_model(actor, request)
        started = datetime.now(UTC)
        documents = await self._our_documents(actor, event_id, brief, inputs)
        pipeline = PrepResearchPipeline(self.providers)
        run_args = dict(organization_id=actor.organization_id, actor_user_id=actor.user_id, event=event,
                        inputs=inputs, brief=brief, our_documents=documents, identity=identity, parties=parties,
                        profile_id=profile_id, model_override=model_override, progress=emit)
        if exa_key:
            client_args: dict[str, Any] = {"ledger": self.usage, "transport": self.exa_transport, "usage": UsageContext(
                organization_id=actor.organization_id, prep_event_id=event_id, actor_user_id=actor.user_id)}
            if self.exa_sleep:
                client_args["sleep"] = self.exa_sleep
            if self.credit_alerts is not None:
                client_args["on_out_of_credit"] = self.credit_alerts.report_exa_out_of_credit
            async with ExaClient(exa_key, **client_args) as exa:
                outcome = await pipeline.run(exa=exa, **run_args)
        else:
            outcome = await pipeline.run(exa=None, **run_args)
        generated = datetime.now(UTC)
        report_id = uuid4()
        with self.database.session_factory.begin() as session:
            usage = self._usage_totals(session, actor, event_id, started, generated)
            report = PrepReportV2(
                **outcome.output.model_dump(), **compat_projection(outcome.output),
                id=report_id, calendar_event_id=event_id,
                target_company=outcome.target.name or outcome.target.domain, company_website=outcome.target.website,
                sources=outcome.sources, public_research_performed=outcome.exa_calls > 0,
                research_steps=outcome.steps, usage=usage, started_at=started, generated_at=generated,
                provider=outcome.provider, model=outcome.model, whos_who=parties,
            )
            session.add(MeetingPrepRow(id=str(report_id), organization_id=str(actor.organization_id),
                user_id=str(actor.user_id), calendar_event_id=str(event_id), context=inputs.notes,
                profile_urls=list(inputs.links), report=report.model_dump(mode="json"), created_at=generated))
        await emit("done", "Briefing ready")
        return report

    def _research_model(self, actor: Actor, request: PrepRequest) -> tuple[UUID | None, str | None]:
        """Owner-selected research model first, then the caller's choice, then the workspace default."""
        settings = None
        if self.ai_settings is not None:
            try:
                settings = self.ai_settings.get(actor.organization_id)
            except Exception:
                logger.warning("could not read AI settings for the research model", exc_info=True)
        profile = getattr(settings, "research_profile_id", None)
        if profile:
            return UUID(str(profile)), getattr(settings, "research_model", None) or None
        return request.text_profile_id, None

    async def _our_documents(self, actor: Actor, event_id: UUID, brief: OrganizationBrief,
                             inputs: ResearchInputs) -> list[OurDocument]:
        """Our side of the briefing: the organization profile, organization documents and prep uploads."""
        documents: list[OurDocument] = []
        if brief.overview or brief.services or brief.products or brief.positioning:
            documents.append(OurDocument("Our organization profile", "organization_brief",
                                         brief.model_dump_json(exclude={"updated_at"})[:6000]))
        stored = self._stored_documents(actor, event_id)
        if self.retriever is None:
            return [*documents, *(document for _, _, document in stored)]
        query = " ".join(part for part in (inputs.target_company or "", inputs.notes[:400],
                                          " ".join(brief.services[:10])) if part).strip() or "our services"
        try:
            chunks = await self.retriever.search(
                actor.organization_id, query[:1000], scopes=[("organization", None), ("prep", str(event_id))],
                limit=12, actor=actor, usage={"purpose": "meeting_prep_retrieval", "prep_event_id": str(event_id),
                                              "actor_user_id": str(actor.user_id)})
        except Exception:
            logger.warning("document retrieval failed; using stored document text", exc_info=True)
            return [*documents, *(document for _, _, document in stored)]
        retrieved: set[str] = set()
        for chunk in chunks:
            origin = "prep_upload" if getattr(chunk, "scope", "") == "prep" else "our_documents"
            text = "\n".join(part for part in (getattr(chunk, "context", ""), getattr(chunk, "content", "")) if part)
            documents.append(OurDocument(str(getattr(chunk, "title", "Document"))[:300], origin, text[:4000]))
            retrieved.add(str(getattr(chunk, "document_id", "") or ""))
        # This meeting's own uploads always inform its briefing, even when retrieval ranks them low
        # or they are not indexed yet; organization documents are added only while unindexed.
        documents.extend(document for document_id, indexed, document in stored
                         if document_id not in retrieved and (document.origin == "prep_upload" or not indexed))
        return documents

    def _stored_documents(self, actor: Actor, event_id: UUID) -> list[tuple[str, bool, OurDocument]]:
        """Stored extracted text (document id, indexed?, excerpt), newest first."""
        org = str(actor.organization_id)
        with self.database.session_factory() as session:
            rows = session.execute(select(KnowledgeDocumentRow).where(
                KnowledgeDocumentRow.organization_id == org,
                or_(KnowledgeDocumentRow.scope == "organization",
                    and_(KnowledgeDocumentRow.scope == "prep", KnowledgeDocumentRow.scope_id == str(event_id))),
            ).order_by(KnowledgeDocumentRow.created_at.desc()).limit(8)).scalars().all()
            found = [(row.id, row.status == "indexed", OurDocument(
                row.filename, "prep_upload" if row.scope == "prep" else "our_documents", row.extracted_text[:4000],
            )) for row in rows if row.extracted_text.strip()]
            if not any(row.scope == "organization" for row in rows):
                legacy = session.execute(select(OrganizationBriefDocumentRow).where(
                    OrganizationBriefDocumentRow.organization_id == org,
                ).order_by(OrganizationBriefDocumentRow.uploaded_at.desc()).limit(6)).scalars().all()
                found.extend((row.id, False, OurDocument(row.filename, "our_documents", row.extracted_text[:4000]))
                             for row in legacy)
        return found

    @staticmethod
    def _usage_totals(session: Any, actor: Actor, event_id: UUID, start: datetime | None,
                      end: datetime | None) -> PrepUsageTotals:
        query = select(UsageEventRow).where(
            UsageEventRow.organization_id == str(actor.organization_id),
            UsageEventRow.prep_event_id == str(event_id),
        )
        if start is not None:
            query = query.where(UsageEventRow.created_at >= start, UsageEventRow.actor_user_id == str(actor.user_id))
        if end is not None:
            query = query.where(UsageEventRow.created_at <= end + timedelta(seconds=1))
        totals = PrepUsageTotals()
        for row in session.execute(query.limit(2000)).scalars():
            totals = totals.model_copy(update={
                "exa_calls": totals.exa_calls + (row.kind in {"search", "contents"}),
                "llm_calls": totals.llm_calls + (row.kind == "llm"),
                "input_tokens": totals.input_tokens + (row.input_tokens or 0),
                "output_tokens": totals.output_tokens + (row.output_tokens or 0),
                "estimated_usd": round(totals.estimated_usd + (row.estimated_usd or 0.0), 6),
                "unpriced_calls": totals.unpriced_calls + (row.estimated_usd is None and row.status == "succeeded"),
            })
        return totals


def _require_contributor(actor: Actor) -> None:
    if actor.role == "viewer":
        raise PrepPermissionError("viewers cannot prepare meeting briefings")


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
