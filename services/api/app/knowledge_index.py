"""Knowledge-base indexing on ``knowledge_chunks``; live evidence stays the authority.

Chunks are built from canonical, permission-checked sources (completed, opted-in
meetings: finalized transcript turns and approved/sent MOM facts). At query time
a semantic hit only counts when its fingerprint still matches a chunk rebuilt
from the current canonical sources, so stale, opted-out or inaccessible evidence
is never returned.
"""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

from meetings_contracts import Capability, EmbeddingRequest
from pydantic import BaseModel
from sqlalchemy import func, or_, select

from .accounts import Actor
from .adapters.base import ProviderExecutionError
from .chunk_store import ChunkStore, EmbeddingUnavailableError, UnitKey
from .database import Database, KnowledgeChunkRow, KnowledgeIndexJobRow
from .knowledge_service import KnowledgeQuery, KnowledgeSource
from .meeting_chunks import meeting_drafts
from .repository import ProfileNotFoundError
from .retrieval import ChunkRetriever
from .service import ProviderProfileService, ProviderSelectionError
from .tenant import current_organization_id, tenant_scope

logger = logging.getLogger(__name__)

KB_SCOPE = "knowledge_base"
KB_SOURCE_TYPES = ("transcript", "mom")
MAX_SOURCES = 2000
MIN_SIMILARITY = 0.2


class KnowledgeIndexError(RuntimeError):
    pass


class KnowledgeIndexStatus(BaseModel):
    knowledge_base_id: UUID
    indexed_sources: int
    profile_id: UUID | None = None
    model: str | None = None
    last_indexed_at: datetime | None = None
    job_status: str | None = None
    requested_at: datetime | None = None
    next_retry_at: datetime | None = None
    last_error: str | None = None


class KnowledgeIndexService:
    def __init__(
        self, database: Database, knowledge: object, bases: object, providers: ProviderProfileService,
        store: ChunkStore | None = None, retriever: ChunkRetriever | None = None,
    ) -> None:
        self.database = database
        self.knowledge = knowledge
        self.bases = bases
        self.providers = providers
        self.store = store or ChunkStore(database, providers)
        self.retriever = retriever or ChunkRetriever(database, self.store)

    @staticmethod
    def _unit(organization_id: str, base_id: UUID) -> UnitKey:
        return UnitKey(organization_id=organization_id, scope=KB_SCOPE, scope_id=str(base_id),
                       source_types=KB_SOURCE_TYPES)

    def status(self, base_id: UUID, actor: Actor | None = None) -> KnowledgeIndexStatus:
        self.bases.get(base_id, actor)
        organization_id = str(actor.organization_id if actor else current_organization_id())
        with self.database.session_factory() as session:
            conditions = [*self._unit(organization_id, base_id).conditions(), KnowledgeChunkRow.embedding.is_not(None)]
            count = session.execute(select(func.count(KnowledgeChunkRow.id)).where(*conditions)).scalar_one()
            first = session.execute(select(KnowledgeChunkRow.profile_id, KnowledgeChunkRow.model,
                                           KnowledgeChunkRow.embedded_at).where(*conditions)
                                    .order_by(KnowledgeChunkRow.embedded_at.desc()).limit(1)).first()
            job = session.get(KnowledgeIndexJobRow, str(base_id))
            return KnowledgeIndexStatus(
                knowledge_base_id=base_id, indexed_sources=count,
                profile_id=UUID(first.profile_id) if first and first.profile_id else None,
                model=first.model if first else None,
                last_indexed_at=first.embedded_at if first else None,
                job_status=job.status if job else None,
                requested_at=job.requested_at if job else None,
                next_retry_at=job.next_retry_at if job else None,
                last_error=job.last_error if job else None,
            )

    async def reindex(self, base_id: UUID, actor: Actor | None = None) -> KnowledgeIndexStatus:
        base = self.bases.get(base_id, actor)
        if actor is not None and not actor.is_admin and base.created_by != actor.user_id:
            raise KnowledgeIndexError("only the creator or an admin can index this knowledge base")
        with self.database.session_factory() as session:
            starting_job = session.get(KnowledgeIndexJobRow, str(base_id))
            starting_request = starting_job.requested_at if starting_job else None
        sources, truncated = self.knowledge.candidate_sources(
            KnowledgeQuery(query="all", knowledge_base_id=base_id), actor,
        )
        if truncated or len(sources) > MAX_SOURCES:
            raise KnowledgeIndexError("knowledge base exceeds the synchronous index limit; no index was changed")
        sources = list({source.source_id: source for source in sources}.values())
        organization_id = str(actor.organization_id if actor else current_organization_id())
        drafts = [draft for draft, _ in meeting_drafts(sources)]
        summary = f"Meeting knowledge base “{base.name}”." + (f" {base.description}" if base.description else "")
        try:
            await self.store.sync(
                self._unit(organization_id, base_id), drafts, summary=summary,
                usage={"purpose": "knowledge_index", "knowledge_base_id": str(base_id)},
                require_embeddings=True,
            )
        except (EmbeddingUnavailableError, ProviderExecutionError, ProviderSelectionError, ProfileNotFoundError) as exc:
            raise KnowledgeIndexError(f"indexing failed; existing index preserved: {exc}") from exc
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            job = session.get(KnowledgeIndexJobRow, str(base_id))
            if job is None:
                session.add(KnowledgeIndexJobRow(
                    knowledge_base_id=str(base_id), organization_id=organization_id,
                    status="succeeded", attempts=0, requested_at=now,
                    started_at=now, completed_at=now, next_retry_at=None, last_error=None,
                ))
            elif job.requested_at == starting_request:
                job.status = "succeeded"
                job.completed_at = now
                job.next_retry_at = None
                job.last_error = None
        return self.status(base_id, actor)

    def pending_scopes(self, limit: int = 1) -> list[tuple[UUID, UUID]]:
        now = datetime.now(UTC)
        stale = now - timedelta(minutes=15)
        with self.database.session_factory() as session:
            rows = session.execute(select(KnowledgeIndexJobRow).where(or_(
                KnowledgeIndexJobRow.status == "pending",
                (KnowledgeIndexJobRow.status == "failed") & (KnowledgeIndexJobRow.next_retry_at <= now),
                (KnowledgeIndexJobRow.status == "running") & (KnowledgeIndexJobRow.started_at <= stale),
            )).order_by(KnowledgeIndexJobRow.requested_at).limit(limit)).scalars().all()
            return [(UUID(row.organization_id), UUID(row.knowledge_base_id)) for row in rows]

    async def process_pending(self) -> None:
        for organization_id, base_id in self.pending_scopes():
            with tenant_scope(organization_id):
                now = datetime.now(UTC)
                with self.database.session_factory.begin() as session:
                    job = session.get(KnowledgeIndexJobRow, str(base_id))
                    if job is None:
                        continue
                    requested_at = job.requested_at
                    job.status = "running"
                    job.started_at = now
                    job.attempts += 1
                    attempts = job.attempts
                try:
                    await self.reindex(base_id)
                except Exception as exc:
                    with self.database.session_factory.begin() as session:
                        job = session.get(KnowledgeIndexJobRow, str(base_id))
                        if job is not None and job.requested_at == requested_at:
                            job.status = "failed"
                            job.last_error = str(exc)[:1000]
                            job.next_retry_at = datetime.now(UTC) + timedelta(seconds=min(60 * 2 ** min(attempts, 8), 3600))
                    logger.warning("knowledge indexing failed for %s: %s", base_id, exc)

    async def run(self, interval_seconds: int = 20) -> None:
        while True:
            try:
                await self.process_pending()
            except Exception:
                logger.exception("knowledge index reconciliation failed")
            await asyncio.sleep(interval_seconds)

    async def rank(
        self, request: KnowledgeQuery, candidates: list[KnowledgeSource], actor: Actor | None = None,
    ) -> list[KnowledgeSource]:
        """Semantic ranking over indexed chunks, restricted to live canonical candidates."""
        if request.knowledge_base_id is None or not candidates:
            return []
        self.bases.get(request.knowledge_base_id, actor)
        organization_id = str(actor.organization_id if actor else current_organization_id())
        live = {draft.fingerprint(KB_SCOPE, str(request.knowledge_base_id)): citation
                for draft, citation in meeting_drafts(list({item.source_id: item for item in candidates}.values()))}
        unit = self._unit(organization_id, request.knowledge_base_id)
        with self.database.session_factory() as session:
            indexed = session.execute(select(
                KnowledgeChunkRow.fingerprint, KnowledgeChunkRow.profile_id,
                KnowledgeChunkRow.model, KnowledgeChunkRow.dimensions,
            ).where(*unit.conditions(), KnowledgeChunkRow.embedding.is_not(None))).all()
        matching = [row for row in indexed if row.fingerprint in live]
        if not matching:
            return []
        first = matching[0]
        selected = self.providers.repository.get_default(Capability.EMBEDDINGS)
        if selected is None or UUID(first.profile_id) not in selected.ordered_profile_ids():
            return []
        try:
            profile, result = await self.providers.embed(
                EmbeddingRequest(inputs=[request.query], metadata={
                    "purpose": "knowledge_search", "knowledge_base_id": str(request.knowledge_base_id),
                }), profile_id=UUID(first.profile_id),
            )
        except (ProviderExecutionError, ProviderSelectionError, ProfileNotFoundError):
            return []
        if profile.id != UUID(first.profile_id) or result.model != first.model or result.dimensions != first.dimensions:
            return []
        ranked = self.retriever.vector_search(
            [*unit.conditions(), KnowledgeChunkRow.profile_id == first.profile_id, KnowledgeChunkRow.model == first.model],
            result.vectors[0], result.dimensions, max(60, request.limit * 3),
        )
        if not ranked:
            return []
        with self.database.session_factory() as session:
            fingerprints = dict(session.execute(select(KnowledgeChunkRow.id, KnowledgeChunkRow.fingerprint).where(
                KnowledgeChunkRow.id.in_([chunk_id for chunk_id, _ in ranked]),
                KnowledgeChunkRow.organization_id == organization_id,
            )).all())
        ordered: list[KnowledgeSource] = []
        for chunk_id, score in ranked:
            citation = live.get(fingerprints.get(chunk_id, ""))
            if citation is not None and score >= MIN_SIMILARITY and citation not in ordered:
                ordered.append(citation)
        return ordered[:max(20, request.limit)]
