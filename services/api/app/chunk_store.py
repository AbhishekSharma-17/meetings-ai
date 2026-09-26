"""Synchronize the stored chunks of one index unit with freshly built drafts.

An index unit is one document, one organization brief, or one knowledge base.
Unchanged chunks (same fingerprint) keep their LLM context note and, when the
embedding route is unchanged, their vector: nothing is re-enriched or
re-embedded. Changed chunks are enriched in batches and embedded with the
workspace's default embeddings profile.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from meetings_contracts import Capability, EmbeddingRequest, ProviderProfile
from sqlalchemy import delete, select

from .adapters.base import ProviderExecutionError
from .chunk_enrichment import CONTEXT_LLM, ChunkEnricher
from .chunking import ChunkDraft
from .database import Database, KnowledgeChunkRow
from .repository import ProfileNotFoundError
from .service import ProviderProfileService, ProviderSelectionError

logger = logging.getLogger(__name__)

EMBED_BATCH = 32
EMBED_TEXT_CHARS = 12000


class EmbeddingUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class UnitKey:
    organization_id: str
    scope: str
    scope_id: str | None
    source_types: tuple[str, ...]
    document_id: str | None = None
    source_id: str | None = None

    def conditions(self) -> list[Any]:
        conditions = [
            KnowledgeChunkRow.organization_id == self.organization_id,
            KnowledgeChunkRow.scope == self.scope,
            KnowledgeChunkRow.source_type.in_(self.source_types),
            (KnowledgeChunkRow.scope_id == self.scope_id) if self.scope_id is not None
            else KnowledgeChunkRow.scope_id.is_(None),
        ]
        if self.document_id is not None:
            conditions.append(KnowledgeChunkRow.document_id == self.document_id)
        if self.source_id is not None:
            conditions.append(KnowledgeChunkRow.source_id == self.source_id)
        return conditions


@dataclass(frozen=True)
class SyncResult:
    chunks: int
    embedded: int
    reused_embeddings: int
    enriched_by_llm: int
    profile_id: str | None
    model: str | None
    dimensions: int | None
    embedding_error: str | None = None


@dataclass(frozen=True)
class EmbeddingRoute:
    profile: ProviderProfile
    model: str


def embedding_text(title: str, heading_path: list[str], context: str, content: str) -> str:
    path = " › ".join(heading_path)
    return "\n".join(part for part in (title, path, context, "", content) if part is not None)[:EMBED_TEXT_CHARS].strip()


class ChunkStore:
    def __init__(self, database: Database, providers: ProviderProfileService, enricher: ChunkEnricher | None = None) -> None:
        self.database = database
        self.providers = providers
        self.enricher = enricher or ChunkEnricher(providers)
        self._locks: dict[UnitKey, asyncio.Lock] = {}

    def embedding_route(self) -> EmbeddingRoute | None:
        """The first usable profile of the workspace embeddings default (current tenant)."""
        selection = self.providers.repository.get_default(Capability.EMBEDDINGS)
        for profile_id in selection.ordered_profile_ids() if selection else []:
            try:
                profile = self.providers.repository.get_profile(profile_id)
            except ProfileNotFoundError:
                continue
            model = profile.models.get(Capability.EMBEDDINGS)
            if model:
                return EmbeddingRoute(profile, model)
        return None

    async def embed(self, route: EmbeddingRoute, texts: list[str], usage: dict[str, Any]) -> tuple[list[list[float]], int]:
        vectors: list[list[float]] = []
        dimensions: int | None = None
        for start in range(0, len(texts), EMBED_BATCH):
            batch = texts[start:start + EMBED_BATCH]
            profile, result = await self.providers.embed(
                EmbeddingRequest(inputs=batch, metadata={k: v for k, v in usage.items() if v is not None}),
                profile_id=route.profile.id,
            )
            if profile.id != route.profile.id or result.model != route.model:
                raise ProviderExecutionError("embedding provider changed during indexing")
            if len(result.vectors) != len(batch) or (dimensions is not None and result.dimensions != dimensions):
                raise ProviderExecutionError("embedding count or dimensions changed during indexing")
            dimensions = result.dimensions
            vectors.extend(result.vectors)
        return vectors, dimensions or 0

    async def sync(
        self, key: UnitKey, drafts: list[ChunkDraft], *, summary: str | None,
        usage: dict[str, Any], require_embeddings: bool,
    ) -> SyncResult:
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            return await self._sync(key, drafts, summary=summary, usage=usage, require_embeddings=require_embeddings)

    async def _sync(
        self, key: UnitKey, drafts: list[ChunkDraft], *, summary: str | None,
        usage: dict[str, Any], require_embeddings: bool,
    ) -> SyncResult:
        fingerprints = [draft.fingerprint(key.scope, key.scope_id) for draft in drafts]
        existing = self._existing(key)
        by_fingerprint: dict[str, list[KnowledgeChunkRow]] = {}
        for row in existing:
            by_fingerprint.setdefault(row.fingerprint, []).append(row)
        cached = {
            index: rows[0].context for index, fingerprint in enumerate(fingerprints)
            if (rows := by_fingerprint.get(fingerprint)) and (rows[0].details or {}).get("context_source") == CONTEXT_LLM
        }
        enrichments = await self.enricher.enrich(drafts, summary=summary, cached=cached, usage=usage) if drafts else []
        route = self.embedding_route()
        if route is None and require_embeddings and drafts:
            raise EmbeddingUnavailableError("no default embedding provider is selected")
        vectors: list[list[float] | None] = [None] * len(drafts)
        dimensions: int | None = None
        reused = 0
        to_embed: list[int] = []
        for index, fingerprint in enumerate(fingerprints):
            row = (by_fingerprint.get(fingerprint) or [None])[0]
            if (route is not None and row is not None and row.embedding is not None
                    and row.profile_id == str(route.profile.id) and row.model == route.model
                    and row.context == enrichments[index].context):
                vectors[index] = row.embedding
                dimensions = row.dimensions
                reused += 1
            else:
                to_embed.append(index)
        error: str | None = None
        if route is None:
            error = "no default embedding provider is selected" if drafts else None
        elif to_embed:
            texts = [embedding_text(drafts[i].title, drafts[i].heading_path, enrichments[i].context, drafts[i].content)
                     for i in to_embed]
            try:
                fresh, fresh_dimensions = await self.embed(route, texts, usage)
                if dimensions is not None and fresh_dimensions != dimensions:
                    # The model's output width changed: re-embed everything for a consistent unit.
                    return await self._reembed_all(key, drafts, fingerprints, enrichments, route, usage, existing)
                dimensions = fresh_dimensions
                for index, vector in zip(to_embed, fresh, strict=True):
                    vectors[index] = vector
            except (ProviderExecutionError, ProviderSelectionError, ProfileNotFoundError) as exc:
                if require_embeddings:
                    raise
                error = f"embedding failed: {str(exc)[:300]}"
                vectors = [None] * len(drafts)
                dimensions = None
        self._write(key, drafts, fingerprints, enrichments, vectors, route if dimensions else None, dimensions, existing)
        return SyncResult(
            chunks=len(drafts), embedded=sum(1 for vector in vectors if vector is not None),
            reused_embeddings=reused if dimensions else 0,
            enriched_by_llm=sum(1 for item in enrichments if item.source == CONTEXT_LLM) - len(cached),
            profile_id=str(route.profile.id) if route and dimensions else None,
            model=route.model if route and dimensions else None, dimensions=dimensions, embedding_error=error,
        )

    async def _reembed_all(self, key, drafts, fingerprints, enrichments, route, usage, existing) -> SyncResult:
        texts = [embedding_text(d.title, d.heading_path, e.context, d.content) for d, e in zip(drafts, enrichments, strict=True)]
        vectors, dimensions = await self.embed(route, texts, usage)
        self._write(key, drafts, fingerprints, enrichments, list(vectors), route, dimensions, existing)
        return SyncResult(len(drafts), len(drafts), 0, sum(1 for e in enrichments if e.source == CONTEXT_LLM),
                          str(route.profile.id), route.model, dimensions)

    def _existing(self, key: UnitKey) -> list[KnowledgeChunkRow]:
        with self.database.session_factory() as session:
            rows = session.execute(select(KnowledgeChunkRow).where(*key.conditions())).scalars().all()
            session.expunge_all()
            return list(rows)

    def _write(self, key, drafts, fingerprints, enrichments, vectors, route, dimensions, existing) -> None:
        now = datetime.now(UTC)
        reusable: dict[str, list[str]] = {}
        for row in existing:
            reusable.setdefault(row.fingerprint, []).append(row.id)
        with self.database.session_factory.begin() as session:
            kept: set[str] = set()
            for index, draft in enumerate(drafts):
                ids = reusable.get(fingerprints[index]) or []
                row = session.get(KnowledgeChunkRow, ids.pop(0)) if ids else None
                if row is None:
                    row = KnowledgeChunkRow(id=str(uuid4()), organization_id=key.organization_id, created_at=now)
                    session.add(row)
                kept.add(row.id)
                vector = vectors[index]
                row.scope, row.scope_id = key.scope, key.scope_id
                row.source_type, row.source_id = draft.source_type, draft.source_id[:120]
                row.document_id, row.meeting_id = draft.document_id, draft.meeting_id
                row.position, row.title = draft.position, draft.title[:300]
                row.context, row.content = enrichments[index].context, draft.content
                row.token_count = draft.token_count
                row.details = {**draft.details, "context_source": enrichments[index].source}
                row.fingerprint = fingerprints[index]
                if vector is None or route is None:
                    row.embedding, row.profile_id, row.model, row.dimensions, row.embedded_at = None, None, None, None, None
                elif row.embedding is None or row.profile_id != str(route.profile.id) or row.embedding != vector:
                    row.embedding, row.profile_id, row.model = vector, str(route.profile.id), route.model
                    row.dimensions, row.embedded_at = dimensions, now
            stale = [row.id for row in existing if row.id not in kept]
            if stale:
                session.execute(delete(KnowledgeChunkRow).where(KnowledgeChunkRow.id.in_(stale)))

    def delete_unit(self, key: UnitKey) -> None:
        with self.database.session_factory.begin() as session:
            session.execute(delete(KnowledgeChunkRow).where(*key.conditions()))


def organization_uuid(value: object) -> UUID:
    return value if isinstance(value, UUID) else UUID(str(value))
