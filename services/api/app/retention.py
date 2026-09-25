"""Opt-in workspace retention. Defaults preserve all records."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import delete, select

from .database import (
    AuditEventRow, CalendarEventCacheRow, Database, KnowledgeBaseRow, KnowledgeConversationRow,
    KnowledgeMessageRow, MeetingPrepRow, MeetingRow, MeetingTenantRow, WorkspaceRetentionRow,
)
from .tenant import tenant_scope

logger = logging.getLogger(__name__)


class RetentionPolicy(BaseModel):
    enabled: bool = False
    meeting_days: int | None = Field(default=None, ge=30, le=3650)
    chat_days: int | None = Field(default=None, ge=30, le=3650)
    audit_days: int | None = Field(default=None, ge=30, le=3650)

    @model_validator(mode="after")
    def require_selected_period(self):
        if self.enabled and all(value is None for value in (
            self.meeting_days, self.chat_days, self.audit_days,
        )):
            raise ValueError("select at least one retention period before enabling automatic deletion")
        return self


class RetentionService:
    def __init__(self, database: Database, meetings: object, audit: object) -> None:
        self.database = database
        self.meetings = meetings
        self.audit = audit

    def get(self, organization_id: UUID) -> RetentionPolicy:
        with self.database.session_factory() as session:
            row = session.get(WorkspaceRetentionRow, str(organization_id))
            return RetentionPolicy.model_validate({
                "enabled": row.enabled, "meeting_days": row.meeting_days,
                "chat_days": row.chat_days, "audit_days": row.audit_days,
            }) if row else RetentionPolicy()

    def save(self, organization_id: UUID, policy: RetentionPolicy) -> RetentionPolicy:
        with self.database.session_factory.begin() as session:
            row = session.get(WorkspaceRetentionRow, str(organization_id))
            if row is None:
                row = WorkspaceRetentionRow(organization_id=str(organization_id))
                session.add(row)
            row.enabled = policy.enabled
            row.meeting_days = policy.meeting_days
            row.chat_days = policy.chat_days
            row.audit_days = policy.audit_days
            row.updated_at = datetime.now(UTC)
        return policy

    async def tick(self) -> None:
        with self.database.session_factory() as session:
            policies = session.execute(select(WorkspaceRetentionRow).where(
                WorkspaceRetentionRow.enabled.is_(True),
            )).scalars().all()
        for policy in policies:
            organization_id = UUID(policy.organization_id)
            with tenant_scope(organization_id):
                now = datetime.now(UTC)
                if policy.meeting_days is not None:
                    cutoff = now - timedelta(days=policy.meeting_days)
                    # Calendar snapshots and their research briefings contain
                    # the same attendee data as captured meeting records.
                    # Delete reports first because they reference cached events.
                    with self.database.session_factory.begin() as session:
                        expired_events = select(CalendarEventCacheRow.id).where(
                            CalendarEventCacheRow.organization_id == policy.organization_id,
                            CalendarEventCacheRow.ends_at < cutoff,
                        )
                        session.execute(delete(MeetingPrepRow).where(
                            MeetingPrepRow.organization_id == policy.organization_id,
                            MeetingPrepRow.calendar_event_id.in_(expired_events),
                        ))
                        session.execute(delete(CalendarEventCacheRow).where(
                            CalendarEventCacheRow.organization_id == policy.organization_id,
                            CalendarEventCacheRow.ends_at < cutoff,
                        ))
                    with self.database.session_factory() as session:
                        meeting_ids = session.execute(select(MeetingRow.id).join(
                            MeetingTenantRow, MeetingTenantRow.meeting_id == MeetingRow.id,
                        ).where(
                            MeetingTenantRow.organization_id == policy.organization_id,
                            MeetingRow.status.in_(["created", "completed", "failed"]),
                            MeetingRow.created_at < cutoff,
                        ).order_by(MeetingRow.created_at).limit(25)).scalars().all()
                    for meeting_id in meeting_ids:
                        try:
                            await self.meetings.delete(UUID(meeting_id))
                            self.audit.append(None, "retention.meeting.deleted", "/v1/meetings/{meeting_id}",
                                              204, UUID(meeting_id), organization_id=organization_id)
                        except Exception:
                            logger.exception("retention could not delete meeting %s", meeting_id)
                if policy.chat_days is not None:
                    cutoff = now - timedelta(days=policy.chat_days)
                    with self.database.session_factory.begin() as session:
                        conversation_ids = session.execute(select(KnowledgeConversationRow.id).join(
                            KnowledgeBaseRow, KnowledgeConversationRow.knowledge_base_id == KnowledgeBaseRow.id,
                        ).where(KnowledgeBaseRow.organization_id == policy.organization_id,
                                KnowledgeConversationRow.updated_at < cutoff).limit(100)).scalars().all()
                        if conversation_ids:
                            session.execute(delete(KnowledgeMessageRow).where(
                                KnowledgeMessageRow.conversation_id.in_(conversation_ids)))
                            session.execute(delete(KnowledgeConversationRow).where(
                                KnowledgeConversationRow.id.in_(conversation_ids)))
                    if conversation_ids:
                        self.audit.append(None, "retention.chats.deleted", "/v1/knowledge-bases", 204,
                                          organization_id=organization_id)
                if policy.audit_days is not None:
                    cutoff = now - timedelta(days=policy.audit_days)
                    with self.database.session_factory.begin() as session:
                        session.execute(delete(AuditEventRow).where(
                            AuditEventRow.organization_id == policy.organization_id,
                            AuditEventRow.created_at < cutoff,
                        ))

    async def run(self, interval_seconds: int = 3600) -> None:
        while True:
            try:
                await self.tick()
            except Exception:
                logger.exception("workspace retention reconciliation failed")
            await asyncio.sleep(interval_seconds)
