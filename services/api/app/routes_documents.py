"""Document endpoints (upload, URL fetch, list, detail, delete, reindex) and the
legacy /v1/workspace/brief/documents endpoints, which now delegate to DocumentService.

Roles (enforced in DocumentService.authorize): organization scope — everyone reads,
admins/owner write; prep scope — the calendar event's owner, not viewers;
knowledge_base scope — readers of the base read, its creator or an admin writes.
"""

from __future__ import annotations

from collections import deque
from time import monotonic
from typing import Literal
from uuid import UUID

from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field

from .documents import DocumentAccessError, DocumentError, DocumentNotFoundError, DocumentService, KnowledgeDocument
from .meeting_prep import BriefDocument
from .url_fetch import SafeFetcher, UrlFetchError

INGESTS_PER_WINDOW = 30
INGEST_WINDOW_SECONDS = 600


class UrlDocumentRequest(BaseModel):
    scope: Literal["organization", "prep", "knowledge_base"]
    scope_id: UUID | None = None
    url: str = Field(min_length=8, max_length=2000)


class _IngestLimiter:
    """Per-user sliding window: uploads can trigger paid vision/LLM calls."""

    def __init__(self) -> None:
        self._events: dict[str, deque[float]] = {}

    def check(self, user_id: UUID) -> None:
        now = monotonic()
        events = self._events.setdefault(str(user_id), deque())
        while events and events[0] <= now - INGEST_WINDOW_SECONDS:
            events.popleft()
        if len(events) >= INGESTS_PER_WINDOW:
            raise HTTPException(status_code=429, detail="too many document uploads; try again in a few minutes")
        events.append(now)


def _http_error(exc: Exception) -> HTTPException:
    if isinstance(exc, DocumentError):
        return HTTPException(status_code=exc.status_code, detail=str(exc))
    if isinstance(exc, DocumentAccessError):
        return HTTPException(status_code=403, detail=str(exc))
    if isinstance(exc, DocumentNotFoundError):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, UrlFetchError):
        return HTTPException(status_code=400, detail=str(exc))
    raise exc


def _optional_uuid(value: str | None) -> UUID | None:
    if value is None or not value.strip():
        return None
    try:
        return UUID(value.strip())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="scope_id must be a UUID") from exc


def _brief(document: KnowledgeDocument) -> BriefDocument:
    return BriefDocument(id=document.id, filename=document.filename, content_type=document.content_type,
                         character_count=document.character_count, uploaded_at=document.created_at)


def register_document_routes(app: FastAPI, *, documents: DocumentService, fetcher: SafeFetcher | None = None) -> None:
    # Held on app.state so operators/tests can swap the resolver or transport.
    app.state.document_fetcher = fetcher or SafeFetcher()
    limiter = _IngestLimiter()
    handled = (DocumentError, DocumentAccessError, DocumentNotFoundError, UrlFetchError)

    @app.post("/v1/documents", response_model=KnowledgeDocument, status_code=201)
    async def upload_document(
        request: Request, scope: str = Form(...), scope_id: str | None = Form(None), file: UploadFile = File(...),
    ) -> KnowledgeDocument:
        actor = request.state.actor
        target = _optional_uuid(scope_id)
        try:
            documents.authorize(actor, scope, target, write=True)
            limiter.check(actor.user_id)
            data = await file.read(documents.max_bytes + 1)
            return await documents.ingest(actor.organization_id, scope, target, file.filename or "document",
                                          file.content_type, data, actor.user_id)
        except handled as exc:
            raise _http_error(exc) from exc

    @app.post("/v1/documents/url", response_model=KnowledgeDocument, status_code=201)
    async def fetch_document(payload: UrlDocumentRequest, request: Request) -> KnowledgeDocument:
        actor = request.state.actor
        try:
            documents.authorize(actor, payload.scope, payload.scope_id, write=True)
            limiter.check(actor.user_id)
            resource = await app.state.document_fetcher.fetch(payload.url)
            return await documents.ingest(actor.organization_id, payload.scope, payload.scope_id, resource.filename,
                                          resource.content_type, resource.data, actor.user_id, source_url=resource.url)
        except handled as exc:
            raise _http_error(exc) from exc

    @app.get("/v1/documents", response_model=list[KnowledgeDocument])
    def list_documents(request: Request, scope: str, scope_id: str | None = None) -> list[KnowledgeDocument]:
        actor = request.state.actor
        target = _optional_uuid(scope_id)
        try:
            documents.authorize(actor, scope, target, write=False)
            return documents.list(actor.organization_id, scope, target)
        except handled as exc:
            raise _http_error(exc) from exc

    @app.get("/v1/documents/{document_id}", response_model=KnowledgeDocument)
    def get_document(document_id: UUID, request: Request) -> KnowledgeDocument:
        actor = request.state.actor
        try:
            documents.authorize_document(actor, document_id, write=False)
            return documents.get(actor.organization_id, document_id, preview=True)
        except handled as exc:
            raise _http_error(exc) from exc

    @app.delete("/v1/documents/{document_id}", status_code=204)
    def delete_document(document_id: UUID, request: Request) -> Response:
        actor = request.state.actor
        try:
            documents.authorize_document(actor, document_id, write=True)
            documents.delete(actor.organization_id, document_id)
        except handled as exc:
            raise _http_error(exc) from exc
        return Response(status_code=204)

    @app.post("/v1/documents/{document_id}/reindex", response_model=KnowledgeDocument, status_code=202)
    def reindex_document(document_id: UUID, request: Request) -> KnowledgeDocument:
        actor = request.state.actor
        try:
            documents.authorize_document(actor, document_id, write=True)
            return documents.request_reindex(actor.organization_id, document_id)
        except handled as exc:
            raise _http_error(exc) from exc

    # ----- legacy organization brief documents (same shapes as before) ---------------------
    @app.get("/v1/workspace/brief/documents", response_model=list[BriefDocument])
    def list_organization_documents(request: Request) -> list[BriefDocument]:
        actor = request.state.actor
        return [_brief(item) for item in documents.list(actor.organization_id, "organization", None)]

    @app.post("/v1/workspace/brief/documents", response_model=BriefDocument, status_code=201)
    async def upload_organization_document(request: Request, file: UploadFile = File(...)) -> BriefDocument:
        actor = request.state.actor
        try:
            documents.authorize(actor, "organization", None, write=True)
            limiter.check(actor.user_id)
            data = await file.read(documents.max_bytes + 1)
            return _brief(await documents.ingest(actor.organization_id, "organization", None,
                                                 file.filename or "document", file.content_type, data, actor.user_id))
        except DocumentAccessError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except handled as exc:
            raise _http_error(exc) from exc

    @app.delete("/v1/workspace/brief/documents/{document_id}", status_code=204)
    def delete_organization_document(document_id: UUID, request: Request) -> Response:
        actor = request.state.actor
        try:
            document = documents.get(actor.organization_id, document_id)
            if document.scope != "organization":
                raise DocumentNotFoundError("organization document not found")
            documents.authorize(actor, "organization", None, write=True)
            documents.delete(actor.organization_id, document_id)
        except (DocumentNotFoundError, DocumentAccessError) as exc:
            raise HTTPException(status_code=404, detail="organization document not found") from exc
        return Response(status_code=204)
