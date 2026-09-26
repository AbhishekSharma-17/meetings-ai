"""Document ingestion: validate, sniff, extract (with vision OCR), store, queue indexing.

Uploads never persist the original bytes: text is extracted during ingest (scanned
pages are OCR'd through the owner's vision route) and stored as
``knowledge_documents.extracted_text`` with form-feed page separators. The
background indexer then summarizes, chunks, enriches and embeds it.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel
from sqlalchemy import delete, func, select

from .accounts import Actor
from .chunk_store import ChunkStore, UnitKey
from .chunking import PAGE_SEPARATOR
from .database import (
    CalendarEventCacheRow, Database, KnowledgeBaseAccessRow, KnowledgeBaseRow, KnowledgeChunkRow,
    KnowledgeDocumentRow, OrganizationBriefDocumentRow,
)
from .document_extraction import (
    CONTENT_TYPES, IMAGE_KINDS, ExtractedDocument, ExtractionError, extract, prepare_image,
    render_pdf_page, sniff_kind,
)
from .document_vision import VisionError, VisionRoute, VisionService

logger = logging.getLogger(__name__)

MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
MAX_OCR_PAGES = 40
OCR_CONCURRENCY = 4
MAX_EXTRACTED_CHARS = 2_000_000
LEGACY_BRIEF_TEXT_CHARS = 80_000
SCOPES = ("organization", "prep", "knowledge_base")
Scope = Literal["organization", "prep", "knowledge_base"]
OCR_UNAVAILABLE = "[Page {page}: scanned content not read — OCR unavailable: {reason}]"


class DocumentError(ValueError):
    """Invalid input; safe to show. ``status_code`` guides the HTTP mapping."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


class DocumentNotFoundError(LookupError):
    pass


class DocumentAccessError(PermissionError):
    pass


class KnowledgeDocument(BaseModel):
    id: UUID
    scope: Scope
    scope_id: UUID | None
    filename: str
    content_type: str
    source_url: str | None
    size_bytes: int
    page_count: int | None
    ocr_page_count: int
    status: str
    error: str | None
    summary: str | None
    chunk_count: int
    character_count: int
    created_by: UUID | None
    created_at: datetime
    indexed_at: datetime | None
    text_preview: str | None = None


@dataclass(frozen=True)
class _Extraction:
    text: str
    page_count: int | None
    ocr_pages: int
    content_type: str
    title: str | None


class DocumentService:
    def __init__(self, database: Database, vision: VisionService, store: ChunkStore, *,
                 max_bytes: int = MAX_DOCUMENT_BYTES, max_ocr_pages: int = MAX_OCR_PAGES) -> None:
        self.database = database
        self.vision = vision
        self.store = store
        self.max_bytes = max_bytes
        self.max_ocr_pages = max_ocr_pages
        self.on_queued: Any | None = None  # IndexingWorker.wake, set at wiring time

    # ----- access -------------------------------------------------------------------------
    def authorize(self, actor: Actor, scope: str, scope_id: UUID | None, *, write: bool) -> None:
        """organization: read all / write admin+owner; prep: the event's owner (not viewers);
        knowledge_base: read = can read the base, write = creator or admin."""
        if scope not in SCOPES:
            raise DocumentError("scope must be organization, prep or knowledge_base")
        if scope == "organization":
            if scope_id is not None:
                raise DocumentError("organization documents do not take a scope_id")
            if write and not actor.is_admin:
                raise DocumentAccessError("only workspace admins can manage organization documents")
            return
        if scope_id is None:
            raise DocumentError(f"{scope} documents require a scope_id")
        with self.database.session_factory() as session:
            if scope == "prep":
                if actor.role == "viewer":
                    raise DocumentAccessError("viewers cannot use meeting preparation")
                event = session.get(CalendarEventCacheRow, str(scope_id))
                if event is None or event.organization_id != str(actor.organization_id) \
                        or event.user_id != str(actor.user_id):
                    raise DocumentNotFoundError("calendar event not found")
                return
            base = session.get(KnowledgeBaseRow, str(scope_id))
            readable = base is not None and base.organization_id == str(actor.organization_id) and (
                actor.is_admin or base.created_by == str(actor.user_id) or base.visibility == "organization"
                or session.get(KnowledgeBaseAccessRow, (base.id, str(actor.user_id))) is not None)
            if not readable:
                raise DocumentNotFoundError("knowledge base not found")
            if write and not actor.is_admin and base.created_by != str(actor.user_id):
                raise DocumentAccessError("only the creator or an admin can manage this knowledge base")

    def authorize_document(self, actor: Actor, document_id: UUID, *, write: bool) -> KnowledgeDocument:
        document = self.get(actor.organization_id, document_id)
        try:
            self.authorize(actor, document.scope, document.scope_id, write=write)
        except DocumentNotFoundError as exc:
            raise DocumentNotFoundError("document not found") from exc
        return document

    # ----- ingest -------------------------------------------------------------------------
    async def ingest(
        self, organization_id: UUID, scope: str, scope_id: UUID | None, filename: str,
        content_type: str | None, data: bytes, actor_user_id: UUID | None, source_url: str | None = None,
    ) -> KnowledgeDocument:
        if scope not in SCOPES:
            raise DocumentError("scope must be organization, prep or knowledge_base")
        if not data:
            raise DocumentError("the file is empty")
        if len(data) > self.max_bytes:
            raise DocumentError(f"documents are limited to {self.max_bytes // (1024 * 1024)} MB", 413)
        self._check_scope_target(organization_id, scope, scope_id)
        name = (Path(filename or "document").name or "document")[:255]
        try:
            # CPU-bound parsing runs off the event loop so large uploads do not stall other requests.
            extracted = await asyncio.to_thread(lambda: extract(data, sniff_kind(data, name, content_type)))
        except ExtractionError as exc:
            raise DocumentError(str(exc), 415 if "unsupported" in str(exc) or "only Word" in str(exc) else 400) from exc
        usage = {
            "actor_user_id": str(actor_user_id) if actor_user_id else None,
            "prep_event_id": str(scope_id) if scope == "prep" else None,
            "knowledge_base_id": str(scope_id) if scope == "knowledge_base" else None,
        }
        result = await self._read_pages(organization_id, data, extracted, name, usage)
        if not _has_real_text(result.text):
            raise DocumentError(
                "no readable text was found; for scanned documents or images the workspace owner "
                "must choose a vision model in AI settings", 422)
        document_id = str(uuid4())
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            session.add(KnowledgeDocumentRow(
                id=document_id, organization_id=str(organization_id), scope=scope,
                scope_id=str(scope_id) if scope_id else None, filename=name,
                content_type=result.content_type, source_url=source_url, size_bytes=len(data),
                page_count=result.page_count, ocr_page_count=result.ocr_pages,
                extracted_text=result.text, summary=None, status="pending", error=None,
                created_by=str(actor_user_id) if actor_user_id else None, created_at=now, indexed_at=None,
            ))
            if scope == "organization":
                # Legacy consumers (meeting prep context) still read organization_brief_documents.
                session.add(OrganizationBriefDocumentRow(
                    id=document_id, organization_id=str(organization_id), filename=name,
                    content_type=result.content_type,
                    extracted_text=result.text.replace(PAGE_SEPARATOR, "\n\n")[:LEGACY_BRIEF_TEXT_CHARS],
                    uploaded_at=now,
                ))
        self._notify()
        return self.get(organization_id, UUID(document_id))

    def _check_scope_target(self, organization_id: UUID, scope: str, scope_id: UUID | None) -> None:
        if scope == "organization":
            if scope_id is not None:
                raise DocumentError("organization documents do not take a scope_id")
            return
        if scope_id is None:
            raise DocumentError(f"{scope} documents require a scope_id")
        model = CalendarEventCacheRow if scope == "prep" else KnowledgeBaseRow
        with self.database.session_factory() as session:
            row = session.get(model, str(scope_id))
            if row is None or row.organization_id != str(organization_id):
                raise DocumentNotFoundError(f"{'calendar event' if scope == 'prep' else 'knowledge base'} not found")

    async def _read_pages(self, organization_id: UUID, data: bytes, extracted: ExtractedDocument,
                          filename: str, usage: dict[str, Any]) -> _Extraction:
        wanted = [index for index, page in enumerate(extracted.pages) if page.needs_vision]
        route: VisionRoute | None = await self.vision.resolve(organization_id) if wanted else None
        selected = wanted[:self.max_ocr_pages] if route is not None else []
        vision_text: dict[int, str | None] = {}
        if selected:
            semaphore = asyncio.Semaphore(OCR_CONCURRENCY)
            is_image = extracted.kind in IMAGE_KINDS

            async def run(index: int) -> tuple[int, str | None]:
                page = extracted.pages[index]
                async with semaphore:
                    try:
                        image = await (asyncio.to_thread(prepare_image, data) if is_image
                                       else asyncio.to_thread(render_pdf_page, data, page.number or 1))
                        label = f"the image “{filename}”" if is_image else f"page {page.number} of “{filename}”"
                        return index, await self.vision.read_image(
                            route, image, label=label, usage={**usage, "purpose": "document_ocr"})
                    except (VisionError, ExtractionError) as exc:
                        logger.warning("vision OCR failed for a document page: %s", str(exc)[:200])
                        return index, None

            vision_text = dict(await asyncio.gather(*(run(index) for index in selected)))
        parts: list[str] = []
        for index, page in enumerate(extracted.pages):
            body = page.text.strip()
            if page.needs_vision:
                read = vision_text.get(index)
                if read:
                    body = read.strip()  # the model transcribes the page's text layer too
                elif not body:
                    reason = ("no vision model is configured" if route is None
                              else "page limit reached" if index not in selected else "the vision model failed")
                    body = OCR_UNAVAILABLE.format(page=page.number or 1, reason=reason)
            parts.append(body)
        text = PAGE_SEPARATOR.join(parts) if extracted.kind == "pdf" else "\n\n".join(parts)
        if extracted.title and extracted.kind in {"docx", "html"} and not text.lstrip().startswith("#"):
            text = f"# {extracted.title}\n\n{text}"
        return _Extraction(
            text=text[:MAX_EXTRACTED_CHARS],
            page_count=len(extracted.pages) if extracted.kind == "pdf" else (1 if extracted.kind in IMAGE_KINDS else None),
            ocr_pages=sum(1 for value in vision_text.values() if value),
            content_type=CONTENT_TYPES[extracted.kind], title=extracted.title,
        )

    # ----- read / delete / reindex --------------------------------------------------------
    def list(self, organization_id: UUID, scope: str, scope_id: UUID | None) -> list[KnowledgeDocument]:
        if scope not in SCOPES:
            raise DocumentError("scope must be organization, prep or knowledge_base")
        with self.database.session_factory() as session:
            rows = session.execute(select(KnowledgeDocumentRow).where(
                KnowledgeDocumentRow.organization_id == str(organization_id),
                KnowledgeDocumentRow.scope == scope,
                (KnowledgeDocumentRow.scope_id == str(scope_id)) if scope_id else KnowledgeDocumentRow.scope_id.is_(None),
            ).order_by(KnowledgeDocumentRow.created_at.desc()).limit(500)).scalars().all()
            counts = self._chunk_counts(session, [row.id for row in rows])
            return [self._public(row, counts.get(row.id, 0)) for row in rows]

    def get(self, organization_id: UUID, document_id: UUID, *, preview: bool = False) -> KnowledgeDocument:
        with self.database.session_factory() as session:
            row = session.get(KnowledgeDocumentRow, str(document_id))
            if row is None or row.organization_id != str(organization_id):
                raise DocumentNotFoundError("document not found")
            counts = self._chunk_counts(session, [row.id])
            return self._public(row, counts.get(row.id, 0), preview=preview)

    def delete(self, organization_id: UUID, document_id: UUID) -> None:
        with self.database.session_factory.begin() as session:
            row = session.get(KnowledgeDocumentRow, str(document_id))
            if row is None or row.organization_id != str(organization_id):
                raise DocumentNotFoundError("document not found")
            session.execute(delete(KnowledgeChunkRow).where(
                KnowledgeChunkRow.organization_id == str(organization_id),
                KnowledgeChunkRow.document_id == row.id,
            ))
            legacy = session.get(OrganizationBriefDocumentRow, row.id)
            if legacy is not None and legacy.organization_id == row.organization_id:
                session.delete(legacy)
            session.delete(row)

    def request_reindex(self, organization_id: UUID, document_id: UUID) -> KnowledgeDocument:
        with self.database.session_factory.begin() as session:
            row = session.get(KnowledgeDocumentRow, str(document_id))
            if row is None or row.organization_id != str(organization_id):
                raise DocumentNotFoundError("document not found")
            row.status, row.error = "pending", None
        self._notify()
        return self.get(organization_id, document_id)

    def _notify(self) -> None:
        if self.on_queued is not None:
            try:
                self.on_queued()
            except RuntimeError:  # no running loop (e.g. sync tests)
                pass

    @staticmethod
    def _chunk_counts(session, ids: list[str]) -> dict[str, int]:
        if not ids:
            return {}
        return dict(session.execute(select(KnowledgeChunkRow.document_id, func.count(KnowledgeChunkRow.id)).where(
            KnowledgeChunkRow.document_id.in_(ids)).group_by(KnowledgeChunkRow.document_id)).all())

    @staticmethod
    def _public(row: KnowledgeDocumentRow, chunks: int, *, preview: bool = False) -> KnowledgeDocument:
        return KnowledgeDocument(
            id=UUID(row.id), scope=row.scope, scope_id=UUID(row.scope_id) if row.scope_id else None,
            filename=row.filename, content_type=row.content_type, source_url=row.source_url,
            size_bytes=row.size_bytes, page_count=row.page_count, ocr_page_count=row.ocr_page_count or 0,
            status=row.status, error=row.error, summary=row.summary, chunk_count=chunks,
            character_count=len(row.extracted_text or ""),
            created_by=UUID(row.created_by) if row.created_by else None, created_at=row.created_at,
            indexed_at=row.indexed_at,
            text_preview=(row.extracted_text or "").replace(PAGE_SEPARATOR, "\n\n")[:1500] if preview else None,
        )

    def unit_key(self, row: KnowledgeDocumentRow) -> UnitKey:
        return UnitKey(organization_id=row.organization_id, scope=row.scope, scope_id=row.scope_id,
                       source_types=("document",), document_id=row.id)


def _has_real_text(text: str) -> bool:
    cleaned = re.sub(r"\[Page \d+: scanned content not read — OCR unavailable: [^\]]*\]", "", text)
    return len(re.sub(r"\s+", "", cleaned)) >= 20
