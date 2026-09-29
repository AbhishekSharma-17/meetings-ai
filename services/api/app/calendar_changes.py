"""The history of detected calendar changes (moved, cancelled, link changed) and how to read it.

Rows are written by the calendar watcher and by a manual calendar sync. One real-world change is
one row: when both paths see it (or it touches a schedule *and* a synced event), the second write
fills in the missing link instead of adding a duplicate.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from pydantic import BaseModel
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from .database import CalendarEventChangeRow

ChangeKind = Literal["moved", "cancelled", "link_changed", "restored"]
ChangeSource = Literal["watcher", "sync"]
HISTORY_LIMIT = 100


class CalendarEventChangePublic(BaseModel):
    id: UUID
    kind: ChangeKind
    provider: str
    source: ChangeSource
    detected_at: datetime
    old_starts_at: datetime | None = None
    new_starts_at: datetime | None = None
    old_ends_at: datetime | None = None
    new_ends_at: datetime | None = None
    old_meeting_url: str | None = None
    new_meeting_url: str | None = None
    meeting_id: UUID | None = None
    cache_event_id: UUID | None = None


class CalendarChangeHistory(BaseModel):
    items: list[CalendarEventChangePublic]
    provider: str | None = None
    # When the watcher last confirmed this event with the calendar (this API process).
    last_checked_at: datetime | None = None


@dataclass(frozen=True)
class ChangeRecord:
    organization_id: str
    user_id: str
    connection_id: str
    provider: str
    event_id: str
    kind: ChangeKind
    source: ChangeSource
    meeting_id: str | None = None
    cache_event_id: str | None = None
    old_starts_at: datetime | None = None
    new_starts_at: datetime | None = None
    old_ends_at: datetime | None = None
    new_ends_at: datetime | None = None
    old_meeting_url: str | None = None
    new_meeting_url: str | None = None


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC)


def link_without_secrets(url: str | None) -> str | None:
    """Scheme, host and path only: Zoom and Teams links can carry passcodes in the query string."""
    if not url:
        return None
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        return None
    return f"{parts.scheme}://{parts.hostname}{parts.path}"[:500]


def _same_change(row: CalendarEventChangeRow, record: ChangeRecord) -> bool:
    if record.kind == "moved":
        return _utc(row.new_starts_at) == _utc(record.new_starts_at) and _utc(row.new_ends_at) == _utc(record.new_ends_at)
    if record.kind == "link_changed":
        return row.new_meeting_url == link_without_secrets(record.new_meeting_url)
    return True


def record_change(session: Session, record: ChangeRecord, now: datetime | None = None) -> bool:
    """Add the change inside the caller's transaction; returns False when it was already recorded."""
    rows = session.execute(select(CalendarEventChangeRow).where(
        CalendarEventChangeRow.organization_id == record.organization_id,
        CalendarEventChangeRow.user_id == record.user_id,
        CalendarEventChangeRow.connection_id == record.connection_id,
        CalendarEventChangeRow.event_id == record.event_id,
        CalendarEventChangeRow.kind == record.kind,
    )).scalars().all()
    existing = next((row for row in rows if _same_change(row, record)), None)
    if existing is not None:
        existing.meeting_id = existing.meeting_id or record.meeting_id
        existing.cache_event_id = existing.cache_event_id or record.cache_event_id
        return False
    session.add(CalendarEventChangeRow(
        id=str(uuid4()), organization_id=record.organization_id, user_id=record.user_id,
        connection_id=record.connection_id, provider=record.provider, event_id=record.event_id,
        meeting_id=record.meeting_id, cache_event_id=record.cache_event_id, kind=record.kind,
        old_starts_at=_utc(record.old_starts_at), new_starts_at=_utc(record.new_starts_at),
        old_ends_at=_utc(record.old_ends_at), new_ends_at=_utc(record.new_ends_at),
        old_meeting_url=link_without_secrets(record.old_meeting_url),
        new_meeting_url=link_without_secrets(record.new_meeting_url),
        source=record.source, detected_at=now or datetime.now(UTC),
    ))
    return True


def _public(row: CalendarEventChangeRow) -> CalendarEventChangePublic:
    return CalendarEventChangePublic(
        id=UUID(row.id), kind=row.kind, provider=row.provider, source=row.source,  # type: ignore[arg-type]
        detected_at=_utc(row.detected_at), old_starts_at=_utc(row.old_starts_at), new_starts_at=_utc(row.new_starts_at),
        old_ends_at=_utc(row.old_ends_at), new_ends_at=_utc(row.new_ends_at),
        old_meeting_url=row.old_meeting_url, new_meeting_url=row.new_meeting_url,
        meeting_id=UUID(row.meeting_id) if row.meeting_id else None,
        cache_event_id=UUID(row.cache_event_id) if row.cache_event_id else None,
    )


def meeting_changes(session: Session, organization_id: str, meeting_id: str) -> list[CalendarEventChangePublic]:
    rows = session.execute(select(CalendarEventChangeRow).where(
        CalendarEventChangeRow.organization_id == organization_id,
        CalendarEventChangeRow.meeting_id == meeting_id,
    ).order_by(CalendarEventChangeRow.detected_at.desc()).limit(HISTORY_LIMIT)).scalars().all()
    return [_public(row) for row in rows]


def event_changes(session: Session, organization_id: str, user_id: str, cache_event_id: str,
                  connection_id: str, event_id: str) -> list[CalendarEventChangePublic]:
    """Changes to one synced event of one person (also those recorded while it was a schedule)."""
    rows = session.execute(select(CalendarEventChangeRow).where(
        CalendarEventChangeRow.organization_id == organization_id,
        CalendarEventChangeRow.user_id == user_id,
        or_(CalendarEventChangeRow.cache_event_id == cache_event_id, and_(
            CalendarEventChangeRow.connection_id == connection_id, CalendarEventChangeRow.event_id == event_id,
        )),
    ).order_by(CalendarEventChangeRow.detected_at.desc()).limit(HISTORY_LIMIT)).scalars().all()
    return [_public(row) for row in rows]


def first_moves(session: Session, organization_id: str, *, meeting_ids: Iterable[str] = (),
                cache_event_ids: Iterable[str] = ()) -> dict[str, datetime]:
    """The original start before the first detected move, keyed by meeting id or cache event id."""
    meetings, caches = list(meeting_ids), list(cache_event_ids)
    if not meetings and not caches:
        return {}
    condition = CalendarEventChangeRow.meeting_id.in_(meetings) if meetings else CalendarEventChangeRow.cache_event_id.in_(caches)
    rows = session.execute(select(CalendarEventChangeRow).where(
        CalendarEventChangeRow.organization_id == organization_id,
        CalendarEventChangeRow.kind == "moved", condition,
    ).order_by(CalendarEventChangeRow.detected_at)).scalars().all()
    found: dict[str, datetime] = {}
    for row in rows:
        key = row.meeting_id if meetings else row.cache_event_id
        if key and key not in found and row.old_starts_at is not None:
            found[key] = _utc(row.old_starts_at)  # type: ignore[assignment]
    return found
