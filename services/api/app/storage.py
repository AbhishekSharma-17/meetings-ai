"""Per-workspace storage accounting by category, with per-item sizes for choosing what to delete.

Sizes are measured in the product database only:
- PostgreSQL: the sum of ``pg_column_size`` of every column (stored, possibly compressed/TOASTed
  size) plus a 24-byte heap tuple header per row. Indexes, free space and bloat are not attributed
  to a workspace, so the whole-database size is reported separately as context.
- SQLite (tests/local): ``length(CAST(column AS BLOB))`` per column, an approximation.

Capture artifacts (audio/video recordings) and Vexa's own transcript copies live in the separate
Vexa service and database. Recording sizes can be measured on request through Vexa's
``GET /recordings?meeting_id=`` API; Vexa's database rows are never counted here.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import operator
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import LargeBinary, Table, cast, func, or_, select, text
from sqlalchemy.orm import Session

from .database import Base, Database

logger = logging.getLogger(__name__)

T = Base.metadata.tables
PG_TUPLE_HEADER_BYTES = 24
CAPTURE_MEETING_LIMIT = 100
CAPTURE_CONCURRENCY = 5
ITEM_LIMIT_MAX = 200

CategoryKey = Literal[
    "meetings", "meeting_preps", "documents", "search_index", "knowledge_bases", "ai_chats",
    "calendar_cache", "logs",
]
PURGEABLE: tuple[str, ...] = CategoryKey.__args__  # type: ignore[attr-defined]


# --- tenant scopes ------------------------------------------------------------------------
def _org(name: str, *extra: Callable[[Table], Any]) -> Callable[[str], Any]:
    def scope(org: str) -> Any:
        table = T[name]
        return functools.reduce(operator.and_, [table.c.organization_id == org, *(item(table) for item in extra)])
    return scope


def org_meetings(org: str) -> Any:
    tenants = T["meeting_tenants"]
    return select(tenants.c.meeting_id).where(tenants.c.organization_id == org)


def org_bases(org: str) -> Any:
    bases = T["knowledge_bases"]
    return select(bases.c.id).where(bases.c.organization_id == org)


def org_conversations(org: str) -> Any:
    conversations = T["knowledge_conversations"]
    return select(conversations.c.id).where(conversations.c.knowledge_base_id.in_(org_bases(org)))


def org_profiles(org: str) -> Any:
    tenants = T["provider_tenants"]
    return select(tenants.c.provider_id).where(tenants.c.organization_id == org)


def _in(name: str, column: str, subquery: Callable[[str], Any]) -> Callable[[str], Any]:
    return lambda org: T[name].c[column].in_(subquery(org))


def _prep_scope(table: Table) -> Any:
    return table.c.scope == "prep"


def _non_prep_scope(table: Table) -> Any:
    return table.c.scope != "prep"


@dataclass(frozen=True)
class TableSpec:
    name: str
    scope: Callable[[str], Any]
    item_key: str | None = None


@dataclass(frozen=True)
class CategorySpec:
    key: str
    label: str
    description: str
    tables: tuple[TableSpec, ...]
    purgeable: bool = True


_MEETING_TABLES = (
    "meeting_transcription_routes", "meeting_knowledge_settings", "meeting_knowledge_bases", "meeting_sources",
    "calendar_schedules", "meeting_delivery_settings", "post_meeting_jobs", "meeting_mom_guidance",
    "transcript_segments", "transcript_segment_metadata", "transcript_speaker_corrections",
    "meeting_speaker_identities", "transcript_review_state", "minutes_source", "meeting_minutes_evidence",
    "meeting_minutes", "email_deliveries",
)

CATEGORIES: tuple[CategorySpec, ...] = (
    CategorySpec("meetings", "Meetings & transcripts",
                 "Meeting records, transcript segments, speaker reviews, minutes, evidence and email delivery logs.",
                 (TableSpec("meetings", _in("meetings", "id", org_meetings), "id"),
                  TableSpec("meeting_tenants", _org("meeting_tenants"), "meeting_id"),
                  *(TableSpec(name, _in(name, "meeting_id", org_meetings), "meeting_id") for name in _MEETING_TABLES))),
    CategorySpec("meeting_preps", "Meeting preps",
                 "Generated pre-meeting briefings, organizer inputs and documents uploaded for a prep.",
                 (TableSpec("meeting_preps", _org("meeting_preps"), "calendar_event_id"),
                  TableSpec("meeting_prep_inputs", _org("meeting_prep_inputs"), "calendar_event_id"),
                  TableSpec("knowledge_documents", _org("knowledge_documents", _prep_scope), "scope_id"))),
    CategorySpec("documents", "Documents",
                 "Uploaded company and knowledge-base documents with their extracted text.",
                 (TableSpec("knowledge_documents", _org("knowledge_documents", _non_prep_scope), "id"),
                  TableSpec("organization_brief_documents", _org("organization_brief_documents"), "id"))),
    CategorySpec("search_index", "Search index",
                 "Retrieval chunks and embedding vectors derived from meetings and documents. Can be rebuilt.",
                 (TableSpec("knowledge_chunks", _org("knowledge_chunks")),
                  TableSpec("knowledge_embeddings", _org("knowledge_embeddings"), "knowledge_base_id"))),
    CategorySpec("knowledge_bases", "Knowledge bases",
                 "Knowledge base definitions, sharing settings and indexing jobs.",
                 (TableSpec("knowledge_bases", _org("knowledge_bases"), "id"),
                  TableSpec("knowledge_base_access", _in("knowledge_base_access", "knowledge_base_id", org_bases), "knowledge_base_id"),
                  TableSpec("knowledge_index_jobs", _org("knowledge_index_jobs"), "knowledge_base_id"))),
    CategorySpec("ai_chats", "AI chats", "Saved Ask AI conversations, answers and citations.",
                 (TableSpec("knowledge_conversations", _in("knowledge_conversations", "knowledge_base_id", org_bases), "id"),
                  TableSpec("knowledge_messages", _in("knowledge_messages", "conversation_id", org_conversations), "conversation_id"))),
    CategorySpec("calendar_cache", "Calendar cache",
                 "Synced calendar event snapshots. Cleared events are fetched again on the next sync.",
                 (TableSpec("calendar_event_cache", _org("calendar_event_cache"), "connection_id"),
                  TableSpec("calendar_sync_state", _org("calendar_sync_state"), "connection_id"))),
    CategorySpec("logs", "Logs", "Usage/cost ledger and workspace audit trail.",
                 (TableSpec("usage_events", _org("usage_events")),
                  TableSpec("model_usage", _org("model_usage")),
                  TableSpec("audit_events", _org("audit_events")))),
    CategorySpec("workspace", "Workspace settings",
                 "Workspace profile, memberships, AI provider settings and retention policy. Not deletable here.",
                 (TableSpec("organizations", lambda org: T["organizations"].c.id == org),
                  TableSpec("organization_memberships", _org("organization_memberships")),
                  TableSpec("organization_briefs", _org("organization_briefs")),
                  TableSpec("provider_tenants", _org("provider_tenants")),
                  TableSpec("provider_profiles", _in("provider_profiles", "id", org_profiles)),
                  TableSpec("organization_provider_defaults", _org("organization_provider_defaults")),
                  TableSpec("provider_credentials", _org("provider_credentials")),
                  TableSpec("provider_profile_credentials", _in("provider_profile_credentials", "profile_id", org_profiles)),
                  TableSpec("organization_ai_settings", _org("organization_ai_settings")),
                  TableSpec("workspace_retention", _org("workspace_retention"))),
                 purgeable=False),
)
CATEGORY_BY_KEY = {category.key: category for category in CATEGORIES}


# --- public models ------------------------------------------------------------------------
class StorageTable(BaseModel):
    name: str
    rows: int
    bytes: int


class StorageCategory(BaseModel):
    key: str
    label: str
    description: str
    rows: int
    bytes: int
    purgeable: bool
    tables: list[StorageTable]


class DatabaseSize(BaseModel):
    dialect: str
    size_bytes: int | None
    note: str


class CaptureStorage(BaseModel):
    status: Literal["not_requested", "measured", "partial", "unavailable", "not_configured"]
    recording_bytes: int | None = None
    recordings: int = 0
    meetings_checked: int = 0
    meetings_with_capture: int = 0
    note: str


class StorageSummary(BaseModel):
    organization_id: UUID
    measured_at: datetime
    total_bytes: int
    total_rows: int
    categories: list[StorageCategory]
    database: DatabaseSize
    capture: CaptureStorage
    method: str


class StorageItem(BaseModel):
    id: str
    label: str
    created_at: datetime | None
    bytes: int
    rows: int
    detail: str | None = None


class StorageItemsResponse(BaseModel):
    category: str
    items: list[StorageItem]


METHOD_NOTE = ("Row data measured per workspace in the product database (PostgreSQL pg_column_size per column "
               "plus row headers). Indexes, free space and other workspaces are not included; the whole "
               "database size is shown for context.")
CAPTURE_NOTE = ("Audio/video recordings and Vexa's own transcript copies are stored by the separate Vexa "
                "capture service, not in this database. Recording sizes are read from Vexa's recordings API "
                "when requested; Vexa database rows are not measured.")


# --- measurement --------------------------------------------------------------------------
def row_bytes(table: Table, dialect: str) -> Any:
    if dialect == "postgresql":
        parts = [func.coalesce(func.pg_column_size(column), 0) for column in table.columns]
        return functools.reduce(operator.add, parts) + PG_TUPLE_HEADER_BYTES
    parts = [func.coalesce(func.length(cast(column, LargeBinary)), 0) for column in table.columns]
    return functools.reduce(operator.add, parts)


def measure_table(session: Session, spec: TableSpec, org: str) -> tuple[int, int]:
    table = T[spec.name]
    dialect = session.get_bind().dialect.name
    count, size = session.execute(select(func.count(), func.coalesce(func.sum(row_bytes(table, dialect)), 0))
                                  .select_from(table).where(spec.scope(org))).one()
    return int(count), int(size or 0)


def grouped_bytes(session: Session, spec: TableSpec, org: str, keys: list[str],
                  key_column: str | None = None, extra: Any = None) -> dict[str, tuple[int, int]]:
    column_name = key_column or spec.item_key
    if not keys or column_name is None:
        return {}
    table = T[spec.name]
    dialect = session.get_bind().dialect.name
    column = table.c[column_name]
    where = [spec.scope(org), column.in_(keys)]
    if extra is not None:
        where.append(extra)
    rows = session.execute(select(column, func.count(), func.coalesce(func.sum(row_bytes(table, dialect)), 0))
                           .where(*where).group_by(column)).all()
    return {str(key): (int(count), int(size or 0)) for key, count, size in rows}


def merge_sizes(*groups: dict[str, tuple[int, int]]) -> dict[str, tuple[int, int]]:
    merged: dict[str, tuple[int, int]] = {}
    for group in groups:
        for key, (count, size) in group.items():
            rows, total = merged.get(key, (0, 0))
            merged[key] = (rows + count, total + size)
    return merged


def database_size(session: Session) -> DatabaseSize:
    dialect = session.get_bind().dialect.name
    try:
        if dialect == "postgresql":
            size = session.execute(text("SELECT pg_database_size(current_database())")).scalar_one()
            note = "Whole product database, all workspaces, including indexes and free space."
        elif dialect == "sqlite":
            pages = session.execute(text("PRAGMA page_count")).scalar_one()
            page_size = session.execute(text("PRAGMA page_size")).scalar_one()
            size = int(pages) * int(page_size)
            note = "Whole local SQLite database."
        else:
            return DatabaseSize(dialect=dialect, size_bytes=None, note="Database size is not available for this engine.")
    except Exception:  # A permissions problem must not hide the per-workspace breakdown.
        logger.warning("could not read database size", exc_info=True)
        return DatabaseSize(dialect=dialect, size_bytes=None, note="Database size could not be read.")
    return DatabaseSize(dialect=dialect, size_bytes=int(size), note=note)


class StorageService:
    def __init__(self, database: Database, vexa: object | None = None) -> None:
        self.database = database
        self.vexa = vexa

    def categories(self, organization_id: UUID, *, include_workspace: bool = True) -> list[StorageCategory]:
        org = str(organization_id)
        result: list[StorageCategory] = []
        with self.database.session_factory() as session:
            for category in CATEGORIES:
                if not include_workspace and not category.purgeable:
                    continue
                tables = [StorageTable(name=spec.name, rows=rows, bytes=size)
                          for spec in category.tables for rows, size in [measure_table(session, spec, org)]]
                result.append(StorageCategory(
                    key=category.key, label=category.label, description=category.description,
                    rows=sum(item.rows for item in tables), bytes=sum(item.bytes for item in tables),
                    purgeable=category.purgeable, tables=tables,
                ))
        return result

    def total_bytes(self, organization_id: UUID) -> int:
        return sum(category.bytes for category in self.categories(organization_id))

    async def summary(self, organization_id: UUID, *, include_capture: bool = False) -> StorageSummary:
        categories = await asyncio.to_thread(self.categories, organization_id)
        with self.database.session_factory() as session:
            db_size = database_size(session)
        capture = await self.capture(organization_id) if include_capture else CaptureStorage(
            status="not_requested", note=CAPTURE_NOTE)
        return StorageSummary(
            organization_id=organization_id, measured_at=datetime.now(UTC),
            total_bytes=sum(item.bytes for item in categories), total_rows=sum(item.rows for item in categories),
            categories=categories, database=db_size, capture=capture, method=METHOD_NOTE,
        )

    async def capture(self, organization_id: UUID) -> CaptureStorage:
        lister = getattr(self.vexa, "list_recordings", None)
        if lister is None:
            return CaptureStorage(status="not_configured", note=CAPTURE_NOTE)
        meetings = T["meetings"]
        with self.database.session_factory() as session:
            capture_ids = session.execute(select(meetings.c.vexa_meeting_id).where(
                meetings.c.id.in_(org_meetings(str(organization_id))), meetings.c.vexa_meeting_id.is_not(None),
            ).order_by(meetings.c.created_at.desc()).limit(CAPTURE_MEETING_LIMIT)).scalars().all()
        if not capture_ids:
            return CaptureStorage(status="measured", recording_bytes=0, note=CAPTURE_NOTE)
        gate = asyncio.Semaphore(CAPTURE_CONCURRENCY)

        async def one(capture_id: int) -> list[dict[str, Any]] | None:
            async with gate:
                try:
                    return await lister(int(capture_id))
                except (RuntimeError, ValueError, OSError) as exc:  # Vexa outages degrade to "partial".
                    logger.warning("could not list Vexa recordings for capture %s: %s", capture_id, type(exc).__name__)
                    return None

        results = await asyncio.gather(*(one(capture_id) for capture_id in capture_ids))
        measured = [item for item in results if item is not None]
        sizes = [media.get("file_size_bytes") for recordings in measured for recording in recordings
                 for media in (recording.get("media_files") or []) if isinstance(media, dict)]
        total = sum(int(size) for size in sizes if isinstance(size, (int, float)) and not isinstance(size, bool))
        status = "measured" if len(measured) == len(results) else "partial" if measured else "unavailable"
        note = CAPTURE_NOTE
        if len(capture_ids) >= CAPTURE_MEETING_LIMIT:
            note += f" Only the {CAPTURE_MEETING_LIMIT} most recent captures were checked."
        return CaptureStorage(
            status=status, recording_bytes=total if measured else None,
            recordings=sum(len(item) for item in measured), meetings_checked=len(results),
            meetings_with_capture=sum(1 for item in measured if item), note=note,
        )

    def items(self, organization_id: UUID, category: str, *, q: str | None = None,
              limit: int = 50) -> StorageItemsResponse:
        from .storage_items import (
            list_items,  # Local import keeps the item queries in their own module.
        )
        limit = max(1, min(limit, ITEM_LIMIT_MAX))
        with self.database.session_factory() as session:
            items = list_items(session, str(organization_id), category, q=(q or "").strip().lower() or None, limit=limit)
        return StorageItemsResponse(category=category, items=items)


def like_pattern(value: str) -> str:
    escaped = value.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def ilike(column: Any, q: str | None) -> Any:
    return func.lower(column).like(like_pattern(q), escape="\\") if q else None


def any_of(*conditions: Any) -> Any:
    present = [item for item in conditions if item is not None]
    return or_(*present) if present else None
