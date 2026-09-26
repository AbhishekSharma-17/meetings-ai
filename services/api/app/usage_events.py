"""Filterable, keyset-paginated ledger rows and a CSV export, always scoped to one workspace."""

from __future__ import annotations

import base64
import binascii
import csv
import io
import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from .database import (
    CalendarEventCacheRow,
    Database,
    KnowledgeBaseRow,
    MeetingRow,
    MeetingSourceRow,
    MeetingTenantRow,
    UsageEventRow,
    UserRow,
)

MAX_PAGE = 200
EXPORT_MAX_ROWS = 100_000
CSV_COLUMNS = (
    "id", "created_at", "kind", "purpose", "provider", "model", "input_tokens", "output_tokens", "units",
    "unit_type", "estimated_usd", "price_source", "duration_ms", "status", "meeting_id", "meeting_title",
    "knowledge_base_id", "knowledge_base_name", "prep_event_id", "prep_event_title", "actor_user_id",
    "actor_display_name", "details",
)


class UsageCursorError(ValueError):
    pass


@dataclass(frozen=True)
class UsageEventFilter:
    kind: str | None = None
    purpose: str | None = None
    provider: str | None = None
    model: str | None = None
    status: str | None = None
    meeting_id: UUID | None = None
    since: datetime | None = None
    until: datetime | None = None
    q: str | None = None


class UsageEventPublic(BaseModel):
    id: UUID
    created_at: datetime
    kind: str
    purpose: str
    provider: str
    model: str
    input_tokens: int | None
    output_tokens: int | None
    units: float | None
    unit_type: str | None
    estimated_usd: float | None
    price_source: str | None
    duration_ms: int | None
    status: str
    meeting_id: UUID | None
    meeting_title: str | None
    knowledge_base_id: UUID | None
    knowledge_base_name: str | None
    prep_event_id: UUID | None
    prep_event_title: str | None
    actor_user_id: UUID | None
    actor_display_name: str | None
    details: dict[str, Any]


class UsageEventPage(BaseModel):
    items: list[UsageEventPublic]
    next_cursor: str | None
    total: int


def _like(value: str) -> str:
    escaped = value.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _conditions(organization_id: UUID, flt: UsageEventFilter) -> list[Any]:
    org = str(organization_id)
    where: list[Any] = [UsageEventRow.organization_id == org]
    for column, value in ((UsageEventRow.kind, flt.kind), (UsageEventRow.purpose, flt.purpose),
                          (UsageEventRow.provider, flt.provider), (UsageEventRow.model, flt.model),
                          (UsageEventRow.status, flt.status)):
        if value:
            where.append(column == value)
    if flt.meeting_id is not None:
        where.append(UsageEventRow.meeting_id == str(flt.meeting_id))
    if flt.since is not None:
        where.append(UsageEventRow.created_at >= flt.since)
    if flt.until is not None:
        where.append(UsageEventRow.created_at < flt.until)
    if flt.q:
        pattern = _like(flt.q)
        titled = select(MeetingRow.id).join(MeetingTenantRow, MeetingTenantRow.meeting_id == MeetingRow.id).where(
            MeetingTenantRow.organization_id == org, func.lower(MeetingRow.title).like(pattern, escape="\\"))
        where.append(or_(
            *(func.lower(column).like(pattern, escape="\\") for column in (
                UsageEventRow.kind, UsageEventRow.purpose, UsageEventRow.provider, UsageEventRow.model)),
            UsageEventRow.meeting_id.in_(titled),
        ))
    return where


def encode_cursor(created_at: datetime, event_id: str) -> str:
    stamp = (created_at if created_at.tzinfo else created_at.replace(tzinfo=UTC)).astimezone(UTC).isoformat()
    return base64.urlsafe_b64encode(f"{stamp}|{event_id}".encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        stamp, event_id = raw.split("|", 1)
        UUID(event_id)
        created_at = datetime.fromisoformat(stamp)
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise UsageCursorError("invalid usage cursor") from exc
    return created_at.astimezone(UTC), event_id


def _labels(session: Session, organization_id: UUID, rows: list[UsageEventRow]) -> dict[str, dict[str, str]]:
    org = str(organization_id)
    meeting_ids = {row.meeting_id for row in rows if row.meeting_id}
    prep_ids = {row.prep_event_id for row in rows if row.prep_event_id}
    base_ids = {row.knowledge_base_id for row in rows if row.knowledge_base_id}
    actor_ids = {row.actor_user_id for row in rows if row.actor_user_id}
    meetings: dict[str, str] = {}
    if meeting_ids:
        for meeting_id, title, source_title in session.execute(
            select(MeetingRow.id, MeetingRow.title, MeetingSourceRow.title)
            .join(MeetingTenantRow, MeetingTenantRow.meeting_id == MeetingRow.id)
            .outerjoin(MeetingSourceRow, MeetingSourceRow.meeting_id == MeetingRow.id)
            .where(MeetingTenantRow.organization_id == org, MeetingRow.id.in_(meeting_ids))
        ).all():
            meetings[meeting_id] = title or source_title or "Untitled meeting"
    preps: dict[str, str] = {}
    if prep_ids:
        for event_id, payload in session.execute(select(CalendarEventCacheRow.id, CalendarEventCacheRow.payload).where(
            CalendarEventCacheRow.organization_id == org, CalendarEventCacheRow.id.in_(prep_ids),
        )).all():
            title = payload.get("title") if isinstance(payload, dict) else None
            preps[event_id] = str(title) if title else "Untitled event"
    bases = dict(session.execute(select(KnowledgeBaseRow.id, KnowledgeBaseRow.name).where(
        KnowledgeBaseRow.organization_id == org, KnowledgeBaseRow.id.in_(base_ids),
    )).all()) if base_ids else {}
    actors = dict(session.execute(select(UserRow.id, UserRow.display_name).where(
        UserRow.id.in_(actor_ids))).all()) if actor_ids else {}
    return {"meetings": meetings, "preps": preps, "bases": bases, "actors": actors}


def _public(row: UsageEventRow, labels: dict[str, dict[str, str]]) -> UsageEventPublic:
    def uuid_or_none(value: str | None) -> UUID | None:
        return UUID(value) if value else None
    return UsageEventPublic(
        id=UUID(row.id), created_at=row.created_at, kind=row.kind, purpose=row.purpose, provider=row.provider,
        model=row.model, input_tokens=row.input_tokens, output_tokens=row.output_tokens, units=row.units,
        unit_type=row.unit_type, estimated_usd=row.estimated_usd, price_source=row.price_source,
        duration_ms=row.duration_ms, status=row.status, meeting_id=uuid_or_none(row.meeting_id),
        meeting_title=labels["meetings"].get(row.meeting_id or "") if row.meeting_id else None,
        knowledge_base_id=uuid_or_none(row.knowledge_base_id),
        knowledge_base_name=labels["bases"].get(row.knowledge_base_id or ""),
        prep_event_id=uuid_or_none(row.prep_event_id),
        prep_event_title=labels["preps"].get(row.prep_event_id or ""),
        actor_user_id=uuid_or_none(row.actor_user_id),
        actor_display_name=labels["actors"].get(row.actor_user_id or ""),
        details=dict(row.details or {}),
    )


def list_usage_events(database: Database, organization_id: UUID, flt: UsageEventFilter, *,
                      limit: int = 50, cursor: str | None = None, with_total: bool = True) -> UsageEventPage:
    limit = max(1, min(limit, MAX_PAGE))
    where = _conditions(organization_id, flt)
    page_where = list(where)
    if cursor:
        created_at, event_id = decode_cursor(cursor)
        page_where.append(or_(UsageEventRow.created_at < created_at,
                              and_(UsageEventRow.created_at == created_at, UsageEventRow.id < event_id)))
    with database.session_factory() as session:
        rows = session.execute(select(UsageEventRow).where(*page_where).order_by(
            UsageEventRow.created_at.desc(), UsageEventRow.id.desc()).limit(limit + 1)).scalars().all()
        more = len(rows) > limit
        rows = rows[:limit]
        total = session.execute(select(func.count(UsageEventRow.id)).where(*where)).scalar_one() if with_total else 0
        labels = _labels(session, organization_id, rows)
    items = [_public(row, labels) for row in rows]
    next_cursor = encode_cursor(rows[-1].created_at, rows[-1].id) if more and rows else None
    return UsageEventPage(items=items, next_cursor=next_cursor, total=total)


def _cell(value: object) -> object:
    if value is None:
        return ""
    if isinstance(value, dict):
        value = json.dumps(value, sort_keys=True, separators=(",", ":"))
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str) and value[:1] in {"=", "+", "-", "@", "\t", "\r"}:
        return "'" + value  # Keep spreadsheet apps from evaluating ledger text as a formula.
    return value


def export_usage_csv(database: Database, organization_id: UUID, flt: UsageEventFilter) -> Iterator[str]:
    """Yield CSV text in batches; bounded so one export cannot exhaust the API process."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(CSV_COLUMNS)
    cursor: str | None = None
    exported = 0
    while exported < EXPORT_MAX_ROWS:
        page = list_usage_events(database, organization_id, flt, limit=MAX_PAGE, cursor=cursor, with_total=False)
        for item in page.items:
            record = item.model_dump()
            writer.writerow([_cell(record[column]) for column in CSV_COLUMNS])
        exported += len(page.items)
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)
        if not page.next_cursor:
            break
        cursor = page.next_cursor
