"""Database-backed login throttling and payload-free workspace audit events."""

from __future__ import annotations

import hmac
import time
from datetime import UTC, datetime
from hashlib import sha256
from uuid import UUID, uuid4

from pydantic import BaseModel
from sqlalchemy import delete, func, select, text

from .accounts import Actor
from .database import (
    AuditEventRow, AuthRateLimitBucketRow, Database, EmailDeliveryRow,
    KnowledgeIndexJobRow, MeetingRow, MeetingTenantRow, PostMeetingJobRow,
    OrganizationMembershipRow, KnowledgeConversationRow, KnowledgeBaseRow,
)


class LoginRateLimiter:
    """Shared across API replicas; never stores raw IPs, emails, or passwords."""

    WINDOW_SECONDS = 15 * 60
    EMAIL_LIMIT = 8
    IP_LIMIT = 30

    def __init__(self, database: Database, signing_key: str) -> None:
        self.database = database
        self.signing_key = signing_key.encode()

    def _key(self, kind: str, value: str) -> str:
        return hmac.new(self.signing_key, f"{kind}:{value}".encode(), sha256).hexdigest()

    def _buckets(self, email: str | None, ip: str) -> tuple[tuple[str, int], ...]:
        principal = (email or "owner").strip().lower()
        return (
            (self._key("login-email", principal), self.EMAIL_LIMIT),
            (self._key("login-ip", ip), self.IP_LIMIT),
        )

    def retry_after(self, email: str | None, ip: str) -> int:
        now = int(time.time())
        with self.database.session_factory() as session:
            keys = self._buckets(email, ip)
            rows = session.execute(select(AuthRateLimitBucketRow).where(
                AuthRateLimitBucketRow.bucket_key.in_([key for key, _ in keys])
            )).scalars().all()
            limits = dict(keys)
            return max((row.expires_at_epoch - now for row in rows
                        if row.attempts >= limits[row.bucket_key] and row.expires_at_epoch > now), default=0)

    def failed(self, email: str | None, ip: str) -> None:
        now = int(time.time())
        with self.database.session_factory.begin() as session:
            for key, _ in self._buckets(email, ip):
                # SQLite and PostgreSQL both support this atomic upsert. It avoids
                # a read/modify/write race when several replicas reject a login.
                session.execute(text("""
                    INSERT INTO auth_rate_limit_buckets (bucket_key, attempts, expires_at_epoch)
                    VALUES (:key, 1, :expires)
                    ON CONFLICT (bucket_key) DO UPDATE SET
                        attempts = CASE WHEN auth_rate_limit_buckets.expires_at_epoch <= :now
                            THEN 1 ELSE auth_rate_limit_buckets.attempts + 1 END,
                        expires_at_epoch = CASE WHEN auth_rate_limit_buckets.expires_at_epoch <= :now
                            THEN :expires ELSE auth_rate_limit_buckets.expires_at_epoch END
                """), {"key": key, "now": now, "expires": now + self.WINDOW_SECONDS})
            # Old buckets are no longer useful; bounded pruning avoids unlimited growth.
            session.execute(delete(AuthRateLimitBucketRow).where(
                AuthRateLimitBucketRow.expires_at_epoch < now - self.WINDOW_SECONDS
            ))

    def succeeded(self, email: str | None) -> None:
        # A correct password clears only the principal's failures. Clearing the
        # shared IP bucket would let an attacker bypass IP throttling.
        key = self._key("login-email", (email or "owner").strip().lower())
        with self.database.session_factory.begin() as session:
            session.execute(delete(AuthRateLimitBucketRow).where(AuthRateLimitBucketRow.bucket_key == key))


class AuditEventPublic(BaseModel):
    id: UUID
    actor_user_id: UUID | None
    action: str
    resource_path: str
    resource_id: UUID | None
    status_code: int
    created_at: datetime


class WorkspaceOperationsPublic(BaseModel):
    people: int
    meetings_captured: int
    completed_meetings: int
    saved_chats: int
    active_captures: int
    failed_captures: int
    failed_mom_jobs: int
    pending_index_jobs: int
    failed_index_jobs: int
    failed_email_deliveries: int
    latest_audit_at: datetime | None


def workspace_operations(database: Database, organization_id: UUID) -> WorkspaceOperationsPublic:
    org = str(organization_id)
    with database.session_factory() as session:
        meetings = session.execute(select(MeetingRow.status).join(
            MeetingTenantRow, MeetingTenantRow.meeting_id == MeetingRow.id,
        ).where(MeetingTenantRow.organization_id == org)).scalars().all()
        mom_failures = session.execute(select(func.count()).select_from(PostMeetingJobRow).join(
            MeetingTenantRow, MeetingTenantRow.meeting_id == PostMeetingJobRow.meeting_id,
        ).where(MeetingTenantRow.organization_id == org, PostMeetingJobRow.last_error.is_not(None),
                PostMeetingJobRow.completed_at.is_(None))).scalar_one()
        index_jobs = session.execute(select(KnowledgeIndexJobRow.status).where(
            KnowledgeIndexJobRow.organization_id == org,
        )).scalars().all()
        email_failures = session.execute(select(func.count()).select_from(EmailDeliveryRow).join(
            MeetingTenantRow, MeetingTenantRow.meeting_id == EmailDeliveryRow.meeting_id,
        ).where(MeetingTenantRow.organization_id == org, EmailDeliveryRow.status == "failed")).scalar_one()
        last_audit = session.execute(select(func.max(AuditEventRow.created_at)).where(
            AuditEventRow.organization_id == org,
        )).scalar_one_or_none()
        people = session.execute(select(func.count()).select_from(OrganizationMembershipRow).where(
            OrganizationMembershipRow.organization_id == org,
        )).scalar_one()
        saved_chats = session.execute(select(func.count()).select_from(KnowledgeConversationRow).join(
            KnowledgeBaseRow, KnowledgeBaseRow.id == KnowledgeConversationRow.knowledge_base_id,
        ).where(KnowledgeBaseRow.organization_id == org)).scalar_one()
    return WorkspaceOperationsPublic(
        people=people, meetings_captured=len(meetings), completed_meetings=meetings.count("completed"), saved_chats=saved_chats,
        active_captures=sum(status in {"requested", "joining", "awaiting_admission", "active", "needs_human_help", "stopping"} for status in meetings),
        failed_captures=meetings.count("failed"),
        failed_mom_jobs=mom_failures,
        pending_index_jobs=sum(status in {"pending", "running"} for status in index_jobs),
        failed_index_jobs=index_jobs.count("failed"),
        failed_email_deliveries=email_failures,
        latest_audit_at=last_audit,
    )


class AuditService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def append(self, actor: Actor | None, action: str, resource_path: str,
               status_code: int, resource_id: UUID | None = None,
               *, organization_id: UUID | None = None) -> None:
        with self.database.session_factory.begin() as session:
            session.add(AuditEventRow(
                id=str(uuid4()),
                organization_id=str(actor.organization_id if actor else organization_id) if actor or organization_id else None,
                actor_user_id=str(actor.user_id) if actor else None,
                action=action, resource_path=resource_path,
                resource_id=str(resource_id) if resource_id else None,
                status_code=status_code, created_at=datetime.now(UTC),
            ))

    def list(self, organization_id: UUID, limit: int = 50) -> list[AuditEventPublic]:
        with self.database.session_factory() as session:
            rows = session.execute(select(AuditEventRow).where(
                AuditEventRow.organization_id == str(organization_id)
            ).order_by(AuditEventRow.created_at.desc(), AuditEventRow.id.desc()).limit(limit)).scalars().all()
            return [AuditEventPublic(
                id=UUID(row.id), actor_user_id=UUID(row.actor_user_id) if row.actor_user_id else None,
                action=row.action, resource_path=row.resource_path,
                resource_id=UUID(row.resource_id) if row.resource_id else None,
                status_code=row.status_code, created_at=row.created_at,
            ) for row in rows]
