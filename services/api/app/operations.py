"""Database-backed login throttling and payload-free workspace audit events."""

from __future__ import annotations

import hmac
import time
from datetime import UTC, datetime
from hashlib import sha256
from uuid import UUID, uuid4

from pydantic import BaseModel
from sqlalchemy import delete, select, text

from .accounts import Actor
from .database import AuditEventRow, AuthRateLimitBucketRow, Database


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


class AuditService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def append(self, actor: Actor | None, action: str, resource_path: str,
               status_code: int, resource_id: UUID | None = None) -> None:
        with self.database.session_factory.begin() as session:
            session.add(AuditEventRow(
                id=str(uuid4()),
                organization_id=str(actor.organization_id) if actor else None,
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
