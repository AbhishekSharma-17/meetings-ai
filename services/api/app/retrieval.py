"""Hybrid chunk retrieval: pgvector cosine + lexical scoring, fused with RRF.

PostgreSQL uses the partial HNSW expression indexes
(``embedding::vector(N) <=> CAST(:q AS vector(N))`` with ``dimensions = N``) and
full-text ranking; SQLite (tests, local) scores the same rows in Python. Every
query is scoped by organization and by the explicit scopes the caller asked for,
and results are re-checked against live access rules before they are returned.
"""

from __future__ import annotations

import logging
import math
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from meetings_contracts import MeetingStatus
from sqlalchemy import Float, String, and_, bindparam, cast, func, literal_column, or_, select, text
from sqlalchemy.types import UserDefinedType

from .accounts import Actor
from .adapters.base import ProviderExecutionError
from .chunk_store import ChunkStore
from .database import (
    CalendarEventCacheRow, Database, KnowledgeBaseAccessRow, KnowledgeBaseRow, KnowledgeChunkRow,
    KnowledgeDocumentRow, MeetingKnowledgeBaseRow, MeetingKnowledgeSettingsRow, MeetingRow, MeetingTenantRow,
)
from .repository import ProfileNotFoundError
from .service import ProviderSelectionError
from .tenant import tenant_scope
from .vector_type import vector_literal

logger = logging.getLogger(__name__)

SCOPES = ("organization", "prep", "knowledge_base")
RRF_K = 60
CANDIDATES_PER_RANKER = 60
PYTHON_SCAN_LIMIT = 20000
# Filtered slices up to this size use an exact scan; larger ones use the partial HNSW index.
EXACT_SEARCH_MAX_ROWS = 5000
MAX_QUERY_TERMS = 16
_STOPWORDS = frozenset(
    "a about an and are as at be by did do for from how i in is it me of on or our the to was were what "
    "when where which who why will with you your".split()
)


class _SizedVector(UserDefinedType):
    """``vector(N)``: the cast target matching the per-dimension partial HNSW indexes."""

    cache_ok = True

    def __init__(self, dimensions: int) -> None:
        self.dimensions = int(dimensions)

    def get_col_spec(self, **kw: Any) -> str:
        return f"vector({self.dimensions})"


@dataclass(frozen=True)
class RetrievedChunk:
    chunk_id: str
    scope: str
    scope_id: str | None
    source_type: str
    source_id: str
    document_id: str | None
    meeting_id: str | None
    title: str
    context: str
    content: str
    score: float
    details: dict[str, Any] = field(default_factory=dict)


def query_terms(query: str) -> list[str]:
    words = [word for word in re.findall(r"\w+", query.lower()) if len(word) >= 2 and word not in _STOPWORDS]
    return list(dict.fromkeys(words))[:MAX_QUERY_TERMS]


def lexical_score(terms: list[str], title: str, context: str, content: str, idf: dict[str, float]) -> float:
    """BM25-flavoured: saturating term frequency, weighted title/context, idf."""
    if not terms:
        return 0.0
    body = content.lower()
    heading = f"{title} {context}".lower()
    length = max(1.0, len(body) / 2000)
    score = 0.0
    for term in terms:
        tf = body.count(term) + 2 * heading.count(term)
        if tf:
            score += idf.get(term, 1.0) * (tf * 2.2) / (tf + 1.2 * length)
    return score


def cosine(first: list[float], second: list[float]) -> float:
    if not first or len(first) != len(second):
        return 0.0
    dot = sum(a * b for a, b in zip(first, second, strict=True))
    size = math.sqrt(sum(a * a for a in first)) * math.sqrt(sum(b * b for b in second))
    return dot / size if size else 0.0


class ChunkRetriever:
    def __init__(self, database: Database, store: ChunkStore) -> None:
        self.database = database
        self.store = store

    async def search(
        self, organization_id: UUID, query: str, *, scopes: list[tuple[str, str | None]],
        limit: int = 12, source_types: list[str] | None = None, actor: Actor | None = None,
        usage: dict[str, Any] | None = None,
    ) -> list[RetrievedChunk]:
        """Hybrid search inside ``scopes`` of one organization.

        ``actor`` (optional) additionally enforces per-user access: knowledge bases
        the user can read and prep events the user owns. Internal callers that
        already authorized the scopes may omit it.
        """
        query = query.strip()[:2000]
        if not query or not scopes:
            return []
        with tenant_scope(organization_id):
            return await self._search(organization_id, query, scopes, limit, source_types, actor, usage)

    async def _search(self, organization_id, query, scopes, limit, source_types, actor, usage) -> list[RetrievedChunk]:
        scope_filter = self._scope_filter(scopes)
        organization = str(organization_id)
        base = [KnowledgeChunkRow.organization_id == organization, scope_filter]
        if source_types:
            base.append(KnowledgeChunkRow.source_type.in_(list(source_types)))
        limit = max(1, min(limit, 50))
        vector_ranked = await self._vector_candidates(organization_id, query, base, usage or {})
        lexical_ranked = self._lexical_candidates(query, base)
        fused: dict[str, float] = {}
        for ranking in (vector_ranked, lexical_ranked):
            for rank, (chunk_id, _) in enumerate(ranking):
                fused[chunk_id] = fused.get(chunk_id, 0.0) + 1 / (RRF_K + rank + 1)
        if not fused:
            return []
        vector_scores = dict(vector_ranked)
        lexical_scores = dict(lexical_ranked)
        ordered = sorted(fused, key=fused.get, reverse=True)[:limit * 3]
        with self.database.session_factory() as session:
            rows = {row.id: row for row in session.execute(select(KnowledgeChunkRow).where(
                KnowledgeChunkRow.id.in_(ordered), KnowledgeChunkRow.organization_id == organization,
            )).scalars().all()}
            allowed = self._allowed(session, organization, [rows[item] for item in ordered if item in rows], actor)
            results = [RetrievedChunk(
                chunk_id=row.id, scope=row.scope, scope_id=row.scope_id, source_type=row.source_type,
                source_id=row.source_id, document_id=row.document_id, meeting_id=row.meeting_id,
                title=row.title, context=row.context, content=row.content, score=round(fused[row.id], 6),
                details={**(row.details or {}), "retrieval": {
                    "vector": round(vector_scores[row.id], 6) if row.id in vector_scores else None,
                    "lexical": round(lexical_scores[row.id], 6) if row.id in lexical_scores else None,
                }},
            ) for row in allowed]
        return results[:limit]

    @staticmethod
    def _scope_filter(scopes: list[tuple[str, str | None]]):
        clauses = []
        for scope, scope_id in scopes:
            if scope not in SCOPES:
                raise ValueError(f"unknown scope: {scope}")
            if scope == "organization":
                clauses.append(and_(KnowledgeChunkRow.scope == scope, KnowledgeChunkRow.scope_id.is_(None)))
            elif not scope_id:
                raise ValueError(f"{scope} scope requires a scope_id")
            else:
                clauses.append(and_(KnowledgeChunkRow.scope == scope, KnowledgeChunkRow.scope_id == str(scope_id)))
        return or_(*clauses)

    async def _vector_candidates(self, organization_id: UUID, query: str, base: list, usage: dict[str, Any]) -> list[tuple[str, float]]:
        route = self.store.embedding_route()
        if route is None:
            return []
        try:
            vectors, dimensions = await self.store.embed(route, [query], {
                **usage, "purpose": usage.get("purpose", "retrieval_query"),
            })
        except (ProviderExecutionError, ProviderSelectionError, ProfileNotFoundError) as exc:
            logger.info("query embedding unavailable, lexical retrieval only: %s", str(exc)[:200])
            return []
        conditions = [*base, KnowledgeChunkRow.profile_id == str(route.profile.id), KnowledgeChunkRow.model == route.model]
        return self.vector_search(conditions, vectors[0], dimensions, CANDIDATES_PER_RANKER)

    def vector_search(self, conditions: list, vector: list[float], dimensions: int, limit: int) -> list[tuple[str, float]]:
        """Nearest chunks by cosine similarity among rows matching ``conditions``."""
        conditions = [*conditions, KnowledgeChunkRow.dimensions == int(dimensions)]
        with self.database.session_factory() as session:
            if session.bind.dialect.name == "postgresql":
                return self._pg_vector(session, vector, int(dimensions), conditions, limit)
            rows = session.execute(select(KnowledgeChunkRow.id, KnowledgeChunkRow.embedding).where(
                *conditions, KnowledgeChunkRow.embedding.is_not(None),
            ).limit(PYTHON_SCAN_LIMIT)).all()
        scored = sorted(((row_id, cosine(vector, embedding or [])) for row_id, embedding in rows),
                        key=lambda item: item[1], reverse=True)
        return [item for item in scored if item[1] > 0][:limit]

    @staticmethod
    def _pg_vector(session, vector: list[float], dimensions: int, conditions: list, limit: int) -> list[tuple[str, float]]:
        # Renders (embedding)::vector(N) <=> CAST(:q AS vector(N)); CAST(x AS t) and x::t are the
        # same expression to PostgreSQL, so the partial HNSW index on (embedding::vector(N)) applies.
        target = _SizedVector(dimensions)
        distance = cast(KnowledgeChunkRow.embedding, target).op("<=>", return_type=Float)(
            cast(bindparam("query_vector", vector_literal(vector), type_=String), target))
        with session.begin():
            matching = session.execute(select(func.count(KnowledgeChunkRow.id)).where(*conditions)).scalar_one()
            if matching <= EXACT_SEARCH_MAX_ROWS:
                # Small tenant slice: an exact scan is cheap and has perfect recall. "+ 0" keeps the
                # planner from using the ANN index, whose filtered results are approximate.
                exact = (distance + 0).label("distance")
                rows = session.execute(select(KnowledgeChunkRow.id, exact).where(*conditions)
                                       .order_by(exact).limit(limit)).all()
                return [(row_id, 1 - float(value)) for row_id, value in rows if value is not None]
            session.execute(text("SELECT set_config('hnsw.ef_search', '100', true)"))
            try:
                with session.begin_nested():
                    # pgvector >= 0.8: keep scanning the graph until filtered rows fill the LIMIT.
                    session.execute(text("SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)"))
            except Exception:  # older pgvector: plain HNSW scan still works
                logger.debug("hnsw.iterative_scan is not available")
            statement = (select(KnowledgeChunkRow.id, distance.label("distance"))
                         .where(*conditions).order_by(distance).limit(limit))
            rows = session.execute(statement).all()
        return [(row_id, 1 - float(value)) for row_id, value in rows if value is not None]

    def _lexical_candidates(self, query: str, base: list) -> list[tuple[str, float]]:
        terms = query_terms(query)
        if not terms:
            return []
        with self.database.session_factory() as session:
            if session.bind.dialect.name == "postgresql":
                return self._pg_lexical(session, terms, base)
            rows = session.execute(select(
                KnowledgeChunkRow.id, KnowledgeChunkRow.title, KnowledgeChunkRow.context, KnowledgeChunkRow.content,
            ).where(*base).order_by(KnowledgeChunkRow.created_at.desc()).limit(PYTHON_SCAN_LIMIT)).all()
        documents = Counter()
        lowered = [(row_id, title.lower(), context.lower(), content.lower()) for row_id, title, context, content in rows]
        for _, title, context, content in lowered:
            for term in terms:
                if term in content or term in title or term in context:
                    documents[term] += 1
        total = max(1, len(lowered))
        idf = {term: math.log(1 + (total - documents[term] + 0.5) / (documents[term] + 0.5)) for term in terms}
        scored = [(row_id, lexical_score(terms, title, context, content, idf))
                  for row_id, title, context, content in lowered]
        scored = [item for item in scored if item[1] > 0]
        scored.sort(key=lambda item: item[1], reverse=True)
        return scored[:CANDIDATES_PER_RANKER]

    @staticmethod
    def _pg_lexical(session, terms: list[str], base: list) -> list[tuple[str, float]]:
        # 'simple' config: no stemming, but safe for multilingual workspace content.
        document = func.to_tsvector(literal_column("'simple'"), KnowledgeChunkRow.title + " " + KnowledgeChunkRow.context
                                    + " " + KnowledgeChunkRow.content)
        # Terms are \w+ tokens only, so the OR-query cannot inject tsquery operators.
        query = func.to_tsquery(literal_column("'simple'"), bindparam("lexical_query", " | ".join(terms), type_=String))
        rank = func.ts_rank_cd(document, query, type_=Float).label("rank")
        statement = (select(KnowledgeChunkRow.id, rank).where(*base, document.op("@@")(query))
                     .order_by(rank.desc()).limit(CANDIDATES_PER_RANKER))
        return [(row_id, float(value)) for row_id, value in session.execute(statement).all()]

    @staticmethod
    def _allowed(session, organization: str, rows: list[KnowledgeChunkRow], actor: Actor | None) -> list[KnowledgeChunkRow]:
        """Re-check live access: opt-in meetings, existing documents, readable bases, owned prep events."""
        documents = {row.document_id for row in rows if row.document_id}
        live_documents = set(session.execute(select(KnowledgeDocumentRow.id).where(
            KnowledgeDocumentRow.id.in_(documents), KnowledgeDocumentRow.organization_id == organization,
        )).scalars().all()) if documents else set()
        meetings = {row.meeting_id for row in rows if row.meeting_id}
        live_meetings: dict[str, str] = {}
        if meetings:
            for meeting_id, base_id in session.execute(
                select(MeetingRow.id, MeetingKnowledgeBaseRow.knowledge_base_id)
                .join(MeetingTenantRow, MeetingTenantRow.meeting_id == MeetingRow.id)
                .join(MeetingKnowledgeSettingsRow, MeetingKnowledgeSettingsRow.meeting_id == MeetingRow.id)
                .join(MeetingKnowledgeBaseRow, MeetingKnowledgeBaseRow.meeting_id == MeetingRow.id)
                .where(MeetingRow.id.in_(meetings), MeetingTenantRow.organization_id == organization,
                       MeetingKnowledgeSettingsRow.knowledge_enabled.is_(True),
                       MeetingRow.status == MeetingStatus.COMPLETED.value)
            ).all():
                live_meetings[meeting_id] = base_id
        readable_bases: dict[str, bool] = {}
        owned_events: dict[str, bool] = {}

        def base_readable(base_id: str) -> bool:
            if base_id not in readable_bases:
                row = session.get(KnowledgeBaseRow, base_id)
                readable_bases[base_id] = row is not None and row.organization_id == organization and (
                    actor is None or actor.is_admin or row.created_by == str(actor.user_id)
                    or row.visibility == "organization"
                    or session.get(KnowledgeBaseAccessRow, (row.id, str(actor.user_id))) is not None)
            return readable_bases[base_id]

        def event_owned(event_id: str) -> bool:
            if event_id not in owned_events:
                row = session.get(CalendarEventCacheRow, event_id)
                owned_events[event_id] = row is not None and row.organization_id == organization and (
                    actor is None or row.user_id == str(actor.user_id))
            return owned_events[event_id]

        allowed = []
        for row in rows:
            if row.document_id and row.document_id not in live_documents:
                continue
            if row.source_type in {"transcript", "mom"} and live_meetings.get(row.meeting_id or "") != row.scope_id:
                continue
            if row.scope == "knowledge_base" and not base_readable(row.scope_id or ""):
                continue
            if row.scope == "prep" and not event_owned(row.scope_id or ""):
                continue
            allowed.append(row)
        return allowed
