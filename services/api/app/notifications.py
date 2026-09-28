"""Per-user in-app notifications (the notification center).

``NotificationService.notify`` is called from background flows (meeting status polling, the
calendar scheduler, the post-meeting worker, background jobs, indexing). It must never break
the flow that calls it: every failure is logged and swallowed, and ``dedupe_key`` makes repeated
calls from polling loops idempotent per recipient (unique ``(user_id, dedupe_key)``).

Recipients are always resolved against current workspace memberships, so a notification can
never reach a user outside the organization it belongs to.
"""

from __future__ import annotations

import base64
import logging
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError

from .accounts import Actor
from .database import (
    CalendarScheduleRow,
    Database,
    NotificationRow,
    OrganizationMembershipRow,
)

logger = logging.getLogger(__name__)

Severity = Literal["info", "success", "warning", "danger"]
SEVERITIES = frozenset({"info", "success", "warning", "danger"})
ADMIN_ROLES = ("owner", "admin")
MAX_PAGE = 100
RETENTION_DAYS = 90
TITLE_LIMIT = 300
BODY_LIMIT = 2000


class NotificationPublic(BaseModel):
    id: UUID
    kind: str
    severity: Severity
    title: str
    body: str | None = None
    link_view: str | None = None
    link_id: str | None = None
    meeting_id: UUID | None = None
    created_at: datetime
    read_at: datetime | None = None


class NotificationPage(BaseModel):
    items: list[NotificationPublic]
    next_cursor: str | None = None
    unread_count: int


class UnreadCount(BaseModel):
    unread_count: int


class NotificationNotFoundError(LookupError):
    pass


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _encode_cursor(row: NotificationRow) -> str:
    raw = f"{_utc(row.created_at).isoformat()}|{row.id}"
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, str] | None:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        stamp, row_id = base64.urlsafe_b64decode(padded.encode()).decode().split("|", 1)
        return _utc(datetime.fromisoformat(stamp)), str(UUID(row_id))
    except (ValueError, UnicodeDecodeError):
        return None


def _public(row: NotificationRow) -> NotificationPublic:
    return NotificationPublic(
        id=UUID(row.id), kind=row.kind, severity=row.severity if row.severity in SEVERITIES else "info",
        title=row.title, body=row.body, link_view=row.link_view, link_id=row.link_id,
        meeting_id=UUID(row.meeting_id) if row.meeting_id else None,
        created_at=_utc(row.created_at), read_at=_utc(row.read_at) if row.read_at else None,
    )


class NotificationService:
    def __init__(self, database: Database) -> None:
        self.database = database

    # ----- emitting ------------------------------------------------------------------------
    def notify(
        self, organization_id: UUID | str, *, user_ids: Iterable[UUID | str | None] = (),
        roles: Iterable[str] = (), kind: str, severity: Severity = "info", title: str,
        body: str | None = None, link_view: str | None = None, link_id: UUID | str | None = None,
        meeting_id: UUID | str | None = None, dedupe_key: str | None = None,
    ) -> int:
        """Create one notification per recipient; returns how many were created. Never raises."""
        try:
            return self._notify(
                str(organization_id), user_ids=user_ids, roles=roles, kind=kind, severity=severity,
                title=title, body=body, link_view=link_view, link_id=link_id, meeting_id=meeting_id,
                dedupe_key=dedupe_key,
            )
        except Exception:
            logger.exception("could not record notification %s", kind)
            return 0

    def _notify(self, organization_id: str, *, user_ids: Iterable[UUID | str | None], roles: Iterable[str],
                kind: str, severity: str, title: str, body: str | None, link_view: str | None,
                link_id: UUID | str | None, meeting_id: UUID | str | None, dedupe_key: str | None) -> int:
        if severity not in SEVERITIES:
            severity = "info"
        recipients = self.recipients(organization_id, user_ids=user_ids, roles=roles)
        if not recipients:
            return 0
        now = datetime.now(UTC)
        if dedupe_key:
            with self.database.session_factory() as session:
                existing = set(session.execute(select(NotificationRow.user_id).where(
                    NotificationRow.user_id.in_(recipients), NotificationRow.dedupe_key == dedupe_key,
                )).scalars().all())
            recipients = [user_id for user_id in recipients if user_id not in existing]
        created = 0
        for user_id in recipients:
            row = NotificationRow(
                id=str(uuid4()), organization_id=organization_id, user_id=user_id, kind=kind[:60],
                severity=severity, title=title.strip()[:TITLE_LIMIT] or kind,
                body=(body.strip()[:BODY_LIMIT] or None) if body else None,
                link_view=link_view[:40] if link_view else None,
                link_id=str(link_id)[:120] if link_id else None,
                meeting_id=str(meeting_id) if meeting_id else None,
                dedupe_key=dedupe_key[:200] if dedupe_key else None, created_at=now, read_at=None,
            )
            try:
                # One short transaction per recipient: a concurrent writer that inserted the same
                # dedupe key first only skips that recipient.
                with self.database.session_factory.begin() as session:
                    session.add(row)
                created += 1
            except IntegrityError:
                continue
        return created

    def recipients(self, organization_id: UUID | str, *, user_ids: Iterable[UUID | str | None] = (),
                   roles: Iterable[str] = ()) -> list[str]:
        """Explicit users and/or everyone holding one of ``roles``, limited to current members."""
        wanted = {str(user_id) for user_id in user_ids if user_id}
        role_set = set(roles)
        if not wanted and not role_set:
            return []
        conditions = []
        if wanted:
            conditions.append(OrganizationMembershipRow.user_id.in_(wanted))
        if role_set:
            conditions.append(OrganizationMembershipRow.role.in_(role_set))
        with self.database.session_factory() as session:
            rows = session.execute(select(OrganizationMembershipRow.user_id).where(
                OrganizationMembershipRow.organization_id == str(organization_id), or_(*conditions),
            )).scalars().all()
        return sorted(set(rows))

    def meeting_audience(self, organization_id: UUID | str, meeting_id: UUID | str) -> list[str]:
        """Owners and admins, plus whoever scheduled the meeting's assistant (if still a member)."""
        creator = None
        try:
            with self.database.session_factory() as session:
                row = session.get(CalendarScheduleRow, str(meeting_id))
                if row is not None and row.organization_id == str(organization_id):
                    creator = row.user_id
        except Exception:
            logger.exception("could not resolve meeting creator for notifications")
        return self.recipients(organization_id, user_ids=[creator], roles=ADMIN_ROLES)

    def notify_meeting(self, organization_id: UUID | str, meeting_id: UUID | str, *, kind: str,
                       severity: Severity, title: str, body: str | None = None, dedupe_key: str | None = None) -> int:
        """Notify the meeting audience with a link to the meeting detail screen."""
        try:
            audience = self.meeting_audience(organization_id, meeting_id)
        except Exception:
            logger.exception("could not resolve meeting audience")
            return 0
        return self.notify(organization_id, user_ids=audience, kind=kind, severity=severity, title=title,
                           body=body, link_view="meeting", link_id=meeting_id, meeting_id=meeting_id,
                           dedupe_key=dedupe_key)

    # ----- reading -------------------------------------------------------------------------
    @staticmethod
    def _mine(actor: Actor) -> tuple:
        return (NotificationRow.organization_id == str(actor.organization_id),
                NotificationRow.user_id == str(actor.user_id))

    def list(self, actor: Actor, *, unread_only: bool = False, limit: int = 30,
             cursor: str | None = None) -> NotificationPage:
        limit = max(1, min(limit, MAX_PAGE))
        conditions = list(self._mine(actor))
        if unread_only:
            conditions.append(NotificationRow.read_at.is_(None))
        position = _decode_cursor(cursor) if cursor else None
        if position:
            stamp, row_id = position
            conditions.append(or_(NotificationRow.created_at < stamp,
                                  and_(NotificationRow.created_at == stamp, NotificationRow.id < row_id)))
        with self.database.session_factory() as session:
            rows = session.execute(select(NotificationRow).where(*conditions).order_by(
                NotificationRow.created_at.desc(), NotificationRow.id.desc(),
            ).limit(limit + 1)).scalars().all()
            items = [_public(row) for row in rows[:limit]]
            next_cursor = _encode_cursor(rows[limit - 1]) if len(rows) > limit else None
        return NotificationPage(items=items, next_cursor=next_cursor, unread_count=self.unread_count(actor))

    def unread_count(self, actor: Actor) -> int:
        with self.database.session_factory() as session:
            return int(session.execute(select(func.count(NotificationRow.id)).where(
                *self._mine(actor), NotificationRow.read_at.is_(None),
            )).scalar_one())

    def mark_read(self, actor: Actor, notification_id: UUID) -> NotificationPublic:
        with self.database.session_factory.begin() as session:
            row = session.get(NotificationRow, str(notification_id))
            if row is None or row.organization_id != str(actor.organization_id) or row.user_id != str(actor.user_id):
                raise NotificationNotFoundError("notification not found")
            if row.read_at is None:
                row.read_at = datetime.now(UTC)
            return _public(row)

    def mark_all_read(self, actor: Actor) -> int:
        with self.database.session_factory.begin() as session:
            result = session.execute(update(NotificationRow).where(
                *self._mine(actor), NotificationRow.read_at.is_(None),
            ).values(read_at=datetime.now(UTC)))
            return int(result.rowcount or 0)

    def delete(self, actor: Actor, notification_id: UUID) -> None:
        with self.database.session_factory.begin() as session:
            row = session.get(NotificationRow, str(notification_id))
            if row is None or row.organization_id != str(actor.organization_id) or row.user_id != str(actor.user_id):
                raise NotificationNotFoundError("notification not found")
            session.delete(row)

    def prune(self, *, older_than_days: int = RETENTION_DAYS) -> int:
        """Drop read notifications older than the retention window (unread ones stay)."""
        cutoff = datetime.now(UTC) - timedelta(days=older_than_days)
        with self.database.session_factory.begin() as session:
            result = session.execute(delete(NotificationRow).where(
                NotificationRow.read_at.is_not(None), NotificationRow.created_at < cutoff,
            ))
            return int(result.rowcount or 0)
