"""Explicit knowledge indexing; live evidence remains the authority at query time."""

import hashlib
import json
import math
from datetime import UTC, datetime
from uuid import UUID, uuid4

from meetings_contracts import Capability, EmbeddingRequest
from pydantic import BaseModel
from sqlalchemy import delete, select

from .accounts import Actor
from .adapters.base import ProviderExecutionError
from .database import Database, KnowledgeEmbeddingRow
from .knowledge_service import KnowledgeQuery, KnowledgeSource
from .repository import ProfileNotFoundError
from .service import ProviderProfileService, ProviderSelectionError
from .tenant import current_organization_id


class KnowledgeIndexError(RuntimeError):
    pass


class KnowledgeIndexStatus(BaseModel):
    knowledge_base_id: UUID
    indexed_sources: int
    profile_id: UUID | None = None
    model: str | None = None
    last_indexed_at: datetime | None = None


def _fingerprint(source: KnowledgeSource) -> str:
    payload = json.dumps(source.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _embedding_text(source: KnowledgeSource) -> str:
    return (
        f"Meeting: {source.meeting_title}\n"
        f"Speaker: {source.speaker or 'Unidentified'}\n"
        f"Type: {source.kind}\n"
        f"Content: {source.text[:3500]}"
    )


def _cosine(first: list[float], second: list[float]) -> float:
    if len(first) != len(second) or not first:
        return 0.0
    try:
        dot = sum(a * b for a, b in zip(first, second))
        size_a = math.sqrt(sum(a * a for a in first))
        size_b = math.sqrt(sum(b * b for b in second))
        return dot / (size_a * size_b) if size_a and size_b else 0.0
    except (TypeError, ValueError, OverflowError, ZeroDivisionError):
        return 0.0


class KnowledgeIndexService:
    def __init__(self, database: Database, knowledge: object, bases: object, providers: ProviderProfileService) -> None:
        self.database = database
        self.knowledge = knowledge
        self.bases = bases
        self.providers = providers

    def status(self, base_id: UUID, actor: Actor | None = None) -> KnowledgeIndexStatus:
        self.bases.get(base_id, actor)
        with self.database.session_factory() as session:
            rows = session.execute(select(KnowledgeEmbeddingRow).where(
                KnowledgeEmbeddingRow.organization_id == str(actor.organization_id if actor else current_organization_id()),
                KnowledgeEmbeddingRow.knowledge_base_id == str(base_id),
            ).order_by(KnowledgeEmbeddingRow.updated_at.desc())).scalars().all()
            first = rows[0] if rows else None
            return KnowledgeIndexStatus(
                knowledge_base_id=base_id, indexed_sources=len(rows),
                profile_id=UUID(first.profile_id) if first else None,
                model=first.model if first else None,
                last_indexed_at=first.updated_at if first else None,
            )

    async def reindex(self, base_id: UUID, actor: Actor | None = None) -> KnowledgeIndexStatus:
        base = self.bases.get(base_id, actor)
        if actor is not None and not actor.is_admin and base.created_by != actor.user_id:
            raise KnowledgeIndexError("only the creator or an admin can index this knowledge base")
        sources, truncated = self.knowledge.candidate_sources(
            KnowledgeQuery(query="all", knowledge_base_id=base_id), actor,
        )
        if truncated or len(sources) > 2000:
            raise KnowledgeIndexError("knowledge base exceeds the synchronous index limit; no index was changed")
        sources = list({source.source_id: source for source in sources}.values())
        vectors: list[list[float]] = []
        profile_id: UUID | None = None
        model: str | None = None
        dimensions: int | None = None
        for start in range(0, len(sources), 32):
            batch = sources[start:start + 32]
            try:
                profile, result = await self.providers.embed(
                    EmbeddingRequest(inputs=[_embedding_text(source) for source in batch]),
                    profile_id=profile_id,
                )
            except (ProviderExecutionError, ProviderSelectionError, ProfileNotFoundError) as exc:
                raise KnowledgeIndexError(f"indexing failed; existing index preserved: {exc}") from exc
            if profile_id is None:
                profile_id, model, dimensions = profile.id, result.model, result.dimensions
            if profile.id != profile_id or result.model != model or result.dimensions != dimensions:
                raise KnowledgeIndexError("embedding provider changed during indexing; existing index preserved")
            if len(result.vectors) != len(batch):
                raise KnowledgeIndexError("embedding count changed during indexing; existing index preserved")
            vectors.extend(result.vectors)
        now = datetime.now(UTC)
        organization_id = str(actor.organization_id if actor else current_organization_id())
        with self.database.session_factory.begin() as session:
            session.execute(delete(KnowledgeEmbeddingRow).where(
                KnowledgeEmbeddingRow.organization_id == organization_id,
                KnowledgeEmbeddingRow.knowledge_base_id == str(base_id),
            ))
            for source, vector in zip(sources, vectors):
                session.add(KnowledgeEmbeddingRow(
                    id=str(uuid4()), organization_id=organization_id,
                    knowledge_base_id=str(base_id), meeting_id=str(source.meeting_id),
                    source_id=source.source_id, fingerprint=_fingerprint(source),
                    profile_id=str(profile_id), model=model,
                    dimensions=dimensions, vector=vector, updated_at=now,
                ))
        return self.status(base_id, actor)

    async def rank(
        self, request: KnowledgeQuery, candidates: list[KnowledgeSource], actor: Actor | None = None,
    ) -> list[KnowledgeSource]:
        if request.knowledge_base_id is None or not candidates:
            return []
        self.bases.get(request.knowledge_base_id, actor)
        org_id = str(actor.organization_id if actor else current_organization_id())
        with self.database.session_factory() as session:
            rows = session.execute(select(KnowledgeEmbeddingRow).where(
                KnowledgeEmbeddingRow.organization_id == org_id,
                KnowledgeEmbeddingRow.knowledge_base_id == str(request.knowledge_base_id),
            )).scalars().all()
        if not rows:
            return []
        by_id = {source.source_id: source for source in candidates}
        matching = [row for row in rows if row.source_id in by_id
                    and row.fingerprint == _fingerprint(by_id[row.source_id])]
        if not matching:
            return []
        first = matching[0]
        selected = self.providers.repository.get_default(Capability.EMBEDDINGS)
        if selected is None or UUID(first.profile_id) not in selected.ordered_profile_ids():
            return []
        try:
            profile, result = await self.providers.embed(
                EmbeddingRequest(inputs=[request.query]), profile_id=UUID(first.profile_id),
            )
        except (ProviderExecutionError, ProviderSelectionError, ProfileNotFoundError):
            return []
        if profile.id != UUID(first.profile_id) or result.model != first.model or result.dimensions != first.dimensions:
            return []
        scored = [(_cosine(result.vectors[0], row.vector), by_id[row.source_id]) for row in matching
                  if row.profile_id == first.profile_id and row.model == first.model
                  and row.dimensions == first.dimensions]
        scored.sort(key=lambda item: item[0], reverse=True)
        return [source for score, source in scored if score >= 0.2][:max(20, request.limit)]
