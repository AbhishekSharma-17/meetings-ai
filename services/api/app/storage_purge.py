"""Owner/admin deletion of workspace data by storage category. Tenant-scoped and idempotent.

Meetings go through ``MeetingService.delete`` so Vexa capture artifacts are erased first, and
knowledge bases through ``KnowledgeBaseService.delete_base`` so sharing, jobs and chats follow.
Every purge is audited after the deletion (so a log purge never removes its own audit entry).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, or_, select, update

from .database import Database
from .storage import (
    PURGEABLE,
    StorageService,
    T,
    org_bases,
    org_conversations,
    org_meetings,
)

logger = logging.getLogger(__name__)

CONFIRMATION = "DELETE"
MEETING_BATCH = 100
LOG_KEYS = frozenset({"usage", "audit"})
INDEX_SCOPES = frozenset({"organization", "prep"})


class StoragePurgeRequest(BaseModel):
    category: Literal["meetings", "meeting_preps", "documents", "search_index", "knowledge_bases",
                      "ai_chats", "calendar_cache", "logs"]
    ids: list[str] | None = Field(default=None, max_length=500)
    older_than_days: int | None = Field(default=None, ge=0, le=3650)
    reindex: bool = False
    confirm: str = Field(max_length=20)

    @field_validator("ids")
    @classmethod
    def clean_ids(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        cleaned = list(dict.fromkeys(value.strip() for value in values if value and value.strip()))
        if any(len(value) > 160 for value in cleaned):
            raise ValueError("storage item ids are at most 160 characters")
        return cleaned


class PurgeSkip(BaseModel):
    id: str
    reason: str


class StoragePurgeResult(BaseModel):
    category: str
    deleted: dict[str, int]
    skipped: list[PurgeSkip]
    remaining: int = 0
    reindex_queued: int = 0
    kept: dict[str, int] = {}
    bytes_before: int
    bytes_after: int
    bytes_freed_estimate: int


class StoragePurgeError(ValueError):
    pass


def _uuid_ids(ids: list[str] | None, *, allowed: frozenset[str] = frozenset()) -> list[str] | None:
    if ids is None:
        return None
    valid = []
    for value in ids:
        if value in allowed:
            valid.append(value)
            continue
        try:
            valid.append(str(UUID(value)))
        except ValueError as exc:
            raise StoragePurgeError(f"invalid item id: {value[:40]}") from exc
    return valid


class StoragePurgeService:
    def __init__(self, database: Database, storage: StorageService, meetings: Any, knowledge_bases: Any,
                 audit: Any) -> None:
        self.database = database
        self.storage = storage
        self.meetings = meetings
        self.knowledge_bases = knowledge_bases
        self.audit = audit

    async def purge(self, actor: Any, request: StoragePurgeRequest) -> StoragePurgeResult:
        if request.confirm != CONFIRMATION:
            raise StoragePurgeError(f"type {CONFIRMATION} to confirm permanent deletion")
        if request.category not in PURGEABLE:
            raise StoragePurgeError("this storage category cannot be deleted")
        if request.ids is not None and not request.ids:
            raise StoragePurgeError("select at least one item, or omit ids to delete the whole category")
        org = str(actor.organization_id)
        cutoff = datetime.now(UTC) - timedelta(days=request.older_than_days) \
            if request.older_than_days is not None else None
        before = await asyncio.to_thread(self.storage.total_bytes, actor.organization_id)
        result = StoragePurgeResult(category=request.category, deleted={}, skipped=[], bytes_before=before,
                                    bytes_after=before, bytes_freed_estimate=0)
        handler = getattr(self, f"_purge_{request.category}")
        await handler(actor, org, request, cutoff, result)
        after = await asyncio.to_thread(self.storage.total_bytes, actor.organization_id)
        result.bytes_after = after
        result.bytes_freed_estimate = max(before - after, 0)
        self.audit.append(actor, f"storage.purge.{request.category}", "/v1/workspace/storage/purge", 200)
        return result

    # --- meetings ---------------------------------------------------------------------------
    async def _purge_meetings(self, actor: Any, org: str, request: StoragePurgeRequest,
                              cutoff: datetime | None, result: StoragePurgeResult) -> None:
        from .adapters.vexa import VexaAPIError
        from .meeting_service import MeetingConflictError
        from .repository import MeetingNotFoundError
        ids = _uuid_ids(request.ids)
        meetings = T["meetings"]
        where = [meetings.c.id.in_(org_meetings(org))]
        if ids is not None:
            where.append(meetings.c.id.in_(ids))
        if cutoff is not None:
            where.append(meetings.c.created_at < cutoff)
        with self.database.session_factory() as session:
            targets = session.execute(select(meetings.c.id).where(*where)
                                      .order_by(meetings.c.created_at)).scalars().all()
        deleted: list[str] = []
        for meeting_id in targets[:MEETING_BATCH]:
            try:
                await self.meetings.delete(UUID(meeting_id))
                deleted.append(meeting_id)
            except MeetingNotFoundError:
                continue  # Already gone: purges are idempotent.
            except (MeetingConflictError, VexaAPIError) as exc:
                result.skipped.append(PurgeSkip(id=meeting_id, reason=str(exc)[:300]))
        result.remaining = max(len(targets) - MEETING_BATCH, 0)
        chunks = T["knowledge_chunks"]
        with self.database.session_factory.begin() as session:
            removed = session.execute(delete(chunks).where(
                chunks.c.organization_id == org, chunks.c.meeting_id.in_(deleted))).rowcount if deleted else 0
        result.deleted = {"meetings": len(deleted), "search_chunks": removed or 0}

    # --- meeting preps ----------------------------------------------------------------------
    async def _purge_meeting_preps(self, actor: Any, org: str, request: StoragePurgeRequest,
                                   cutoff: datetime | None, result: StoragePurgeResult) -> None:
        ids = _uuid_ids(request.ids)
        preps, inputs, documents, chunks = (T["meeting_preps"], T["meeting_prep_inputs"],
                                            T["knowledge_documents"], T["knowledge_chunks"])
        with self.database.session_factory.begin() as session:
            if cutoff is not None:
                recent = select(preps.c.calendar_event_id).where(preps.c.organization_id == org,
                                                                 preps.c.created_at >= cutoff)
                old = select(preps.c.calendar_event_id).where(preps.c.organization_id == org,
                                                              preps.c.created_at < cutoff)
                stale_inputs = select(inputs.c.calendar_event_id).where(inputs.c.organization_id == org,
                                                                        inputs.c.updated_at < cutoff)
                events = set(session.execute(old.union(stale_inputs)).scalars().all()) \
                    - set(session.execute(recent).scalars().all())
                ids = sorted(events if ids is None else events & set(ids))
            counts = {
                "briefings": self._delete(session, preps, preps.c.organization_id == org,
                                          preps.c.calendar_event_id, ids),
                "prep_inputs": self._delete(session, inputs, inputs.c.organization_id == org,
                                            inputs.c.calendar_event_id, ids),
                "search_chunks": self._delete(session, chunks, (chunks.c.organization_id == org)
                                              & (chunks.c.scope == "prep"), chunks.c.scope_id, ids),
                "documents": self._delete(session, documents, (documents.c.organization_id == org)
                                          & (documents.c.scope == "prep"), documents.c.scope_id, ids),
            }
        result.deleted = counts

    @staticmethod
    def _delete(session: Any, table: Any, scope: Any, key: Any, ids: list[str] | None) -> int:
        if ids is not None and not ids:
            return 0
        where = [scope] if ids is None else [scope, key.in_(ids)]
        return int(session.execute(delete(table).where(*where)).rowcount or 0)

    # --- documents --------------------------------------------------------------------------
    async def _purge_documents(self, actor: Any, org: str, request: StoragePurgeRequest,
                               cutoff: datetime | None, result: StoragePurgeResult) -> None:
        ids = _uuid_ids(request.ids)
        documents, briefs, chunks = T["knowledge_documents"], T["organization_brief_documents"], T["knowledge_chunks"]
        doc_where = [documents.c.organization_id == org, documents.c.scope != "prep"]
        brief_where = [briefs.c.organization_id == org]
        if ids is not None:
            doc_where.append(documents.c.id.in_(ids))
            brief_where.append(briefs.c.id.in_(ids))
        if cutoff is not None:
            doc_where.append(documents.c.created_at < cutoff)
            brief_where.append(briefs.c.uploaded_at < cutoff)
        with self.database.session_factory.begin() as session:
            doc_ids = session.execute(select(documents.c.id).where(*doc_where)).scalars().all()
            brief_ids = session.execute(select(briefs.c.id).where(*brief_where)).scalars().all()
            targets = sorted(set(doc_ids) | set(brief_ids))
            removed_chunks = session.execute(delete(chunks).where(
                chunks.c.organization_id == org, chunks.c.document_id.in_(targets))).rowcount if targets else 0
            removed_docs = session.execute(delete(documents).where(
                documents.c.organization_id == org, documents.c.id.in_(targets))).rowcount if targets else 0
            removed_briefs = session.execute(delete(briefs).where(
                briefs.c.organization_id == org, briefs.c.id.in_(targets))).rowcount if targets else 0
        result.deleted = {"documents": len(targets), "document_rows": int(removed_docs or 0),
                          "profile_document_rows": int(removed_briefs or 0), "search_chunks": int(removed_chunks or 0)}

    # --- knowledge bases --------------------------------------------------------------------
    async def _purge_knowledge_bases(self, actor: Any, org: str, request: StoragePurgeRequest,
                                     cutoff: datetime | None, result: StoragePurgeResult) -> None:
        from .knowledge_bases import KnowledgeBaseNotFoundError
        ids = _uuid_ids(request.ids)
        bases, chunks, documents = T["knowledge_bases"], T["knowledge_chunks"], T["knowledge_documents"]
        where = [bases.c.organization_id == org]
        if ids is not None:
            where.append(bases.c.id.in_(ids))
        if cutoff is not None:
            where.append(bases.c.created_at < cutoff)
        with self.database.session_factory() as session:
            targets = session.execute(select(bases.c.id).where(*where)).scalars().all()
        deleted = 0
        counts = {"search_chunks": 0, "documents": 0}
        for base_id in targets:
            with self.database.session_factory.begin() as session:
                counts["search_chunks"] += int(session.execute(delete(chunks).where(
                    chunks.c.organization_id == org, chunks.c.scope == "knowledge_base",
                    chunks.c.scope_id == base_id)).rowcount or 0)
                doc_ids = select(documents.c.id).where(documents.c.organization_id == org,
                                                       documents.c.scope == "knowledge_base",
                                                       documents.c.scope_id == base_id)
                counts["search_chunks"] += int(session.execute(delete(chunks).where(
                    chunks.c.organization_id == org, chunks.c.document_id.in_(doc_ids))).rowcount or 0)
                counts["documents"] += int(session.execute(delete(documents).where(
                    documents.c.organization_id == org, documents.c.scope == "knowledge_base",
                    documents.c.scope_id == base_id)).rowcount or 0)
            try:
                self.knowledge_bases.delete_base(UUID(base_id), actor)
                deleted += 1
            except KnowledgeBaseNotFoundError:
                continue
        result.deleted = {"knowledge_bases": deleted, **counts}

    # --- search index -----------------------------------------------------------------------
    async def _purge_search_index(self, actor: Any, org: str, request: StoragePurgeRequest,
                                  cutoff: datetime | None, result: StoragePurgeResult) -> None:
        ids = _uuid_ids(request.ids, allowed=INDEX_SCOPES)
        chunks, embeddings = T["knowledge_chunks"], T["knowledge_embeddings"]
        base_ids = None if ids is None else [value for value in ids if value not in INDEX_SCOPES]
        scopes = None if ids is None else [value for value in ids if value in INDEX_SCOPES]
        chunk_where: list[Any] = [chunks.c.organization_id == org]
        embed_where: list[Any] = [embeddings.c.organization_id == org]
        if ids is not None:
            chunk_where.append(or_(chunks.c.scope.in_(scopes),
                                   (chunks.c.scope == "knowledge_base") & chunks.c.scope_id.in_(base_ids)))
            embed_where.append(embeddings.c.knowledge_base_id.in_(base_ids))
        if cutoff is not None:
            chunk_where.append(chunks.c.created_at < cutoff)
            embed_where.append(embeddings.c.updated_at < cutoff)
        with self.database.session_factory.begin() as session:
            removed_chunks = session.execute(delete(chunks).where(*chunk_where)).rowcount
            removed_vectors = session.execute(delete(embeddings).where(*embed_where)).rowcount
            queued = self._queue_reindex(session, org, base_ids, scopes) if request.reindex else 0
        result.deleted = {"search_chunks": int(removed_chunks or 0), "embeddings": int(removed_vectors or 0)}
        result.reindex_queued = queued

    @staticmethod
    def _queue_reindex(session: Any, org: str, base_ids: list[str] | None, scopes: list[str] | None) -> int:
        """Queue meeting re-embedding per base and mark affected documents for re-indexing."""
        bases, jobs, documents = T["knowledge_bases"], T["knowledge_index_jobs"], T["knowledge_documents"]
        where = [bases.c.organization_id == org] + ([bases.c.id.in_(base_ids)] if base_ids is not None else [])
        targets = session.execute(select(bases.c.id).where(*where)).scalars().all()
        now = datetime.now(UTC)
        existing = set(session.execute(select(jobs.c.knowledge_base_id).where(
            jobs.c.knowledge_base_id.in_(targets))).scalars().all()) if targets else set()
        for base_id in targets:
            values = {"status": "pending", "attempts": 0, "requested_at": now, "started_at": None,
                      "completed_at": None, "next_retry_at": None, "last_error": None}
            if base_id in existing:
                session.execute(update(jobs).where(jobs.c.knowledge_base_id == base_id).values(**values))
            else:
                session.execute(jobs.insert().values(knowledge_base_id=base_id, organization_id=org, **values))
        doc_scope = or_(
            (documents.c.scope == "knowledge_base") & documents.c.scope_id.in_(targets),
            documents.c.scope.in_(scopes if scopes is not None else sorted(INDEX_SCOPES)),
        )
        documents_queued = session.execute(update(documents).where(
            documents.c.organization_id == org, documents.c.status == "indexed", doc_scope,
        ).values(status="pending", indexed_at=None)).rowcount
        return len(targets) + int(documents_queued or 0)

    # --- AI chats ---------------------------------------------------------------------------
    async def _purge_ai_chats(self, actor: Any, org: str, request: StoragePurgeRequest,
                              cutoff: datetime | None, result: StoragePurgeResult) -> None:
        ids = _uuid_ids(request.ids)
        conversations, messages = T["knowledge_conversations"], T["knowledge_messages"]
        where = [conversations.c.knowledge_base_id.in_(org_bases(org))]
        if ids is not None:
            where.append(conversations.c.id.in_(ids))
        if cutoff is not None:
            where.append(conversations.c.updated_at < cutoff)
        with self.database.session_factory.begin() as session:
            targets = session.execute(select(conversations.c.id).where(*where)).scalars().all()
            removed_messages = session.execute(delete(messages).where(
                messages.c.conversation_id.in_(targets),
                messages.c.conversation_id.in_(org_conversations(org)))).rowcount if targets else 0
            removed = session.execute(delete(conversations).where(
                conversations.c.id.in_(targets))).rowcount if targets else 0
        result.deleted = {"conversations": int(removed or 0), "messages": int(removed_messages or 0)}

    # --- calendar cache ---------------------------------------------------------------------
    async def _purge_calendar_cache(self, actor: Any, org: str, request: StoragePurgeRequest,
                                    cutoff: datetime | None, result: StoragePurgeResult) -> None:
        events, state = T["calendar_event_cache"], T["calendar_sync_state"]
        preps, inputs, documents = T["meeting_preps"], T["meeting_prep_inputs"], T["knowledge_documents"]
        chunks = T["knowledge_chunks"]
        where = [events.c.organization_id == org]
        if request.ids is not None:
            where.append(events.c.connection_id.in_(request.ids))
        if cutoff is not None:
            where.append(events.c.ends_at < cutoff)
        # Briefings, organizer inputs (foreign key) and prep uploads/index reference their calendar
        # event; keep those snapshots so preps stay readable. Delete them via "meeting_preps".
        referenced = or_(
            events.c.id.in_(select(preps.c.calendar_event_id).where(preps.c.organization_id == org)),
            events.c.id.in_(select(inputs.c.calendar_event_id).where(inputs.c.organization_id == org)),
            events.c.id.in_(select(documents.c.scope_id).where(documents.c.organization_id == org,
                                                                documents.c.scope == "prep")),
            events.c.id.in_(select(chunks.c.scope_id).where(chunks.c.organization_id == org,
                                                             chunks.c.scope == "prep")),
        )
        with self.database.session_factory.begin() as session:
            kept = session.execute(select(func.count()).select_from(events).where(*where, referenced)).scalar_one()
            removed = session.execute(delete(events).where(*where, ~referenced)).rowcount
            reset = 0
            if cutoff is None:  # A full clear forces the next sync to rescan these accounts.
                state_where = [state.c.organization_id == org]
                if request.ids is not None:
                    state_where.append(state.c.connection_id.in_(request.ids))
                reset = session.execute(delete(state).where(*state_where)).rowcount
        result.deleted = {"events": int(removed or 0), "sync_states": int(reset or 0)}
        result.kept = {"events_with_preps": int(kept)}

    # --- logs -------------------------------------------------------------------------------
    async def _purge_logs(self, actor: Any, org: str, request: StoragePurgeRequest,
                          cutoff: datetime | None, result: StoragePurgeResult) -> None:
        which = set(request.ids) if request.ids is not None else set(LOG_KEYS)
        if which - LOG_KEYS:
            raise StoragePurgeError("log ids must be 'usage' and/or 'audit'")
        counts: dict[str, int] = {}
        tables = {"usage": ("usage_events", "model_usage"), "audit": ("audit_events",)}
        with self.database.session_factory.begin() as session:
            for key in sorted(which):
                for name in tables[key]:
                    table = T[name]
                    where = [table.c.organization_id == org]
                    if cutoff is not None:
                        where.append(table.c.created_at < cutoff)
                    counts[name] = int(session.execute(delete(table).where(*where)).rowcount or 0)
        result.deleted = counts
