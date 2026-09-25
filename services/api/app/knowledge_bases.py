"""Named and shareable organization knowledge bases."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from meetings_contracts import Capability, MeetingStatus, MinutesStatus
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select

from .database import (
    Database, KnowledgeBaseAccessRow, KnowledgeBaseRow, KnowledgeConversationRow, KnowledgeMessageRow, KnowledgeEmbeddingRow,
    LEGACY_ADMIN_USER_ID, MeetingKnowledgeBaseRow, MeetingTenantRow,
    MeetingKnowledgeSettingsRow, MeetingMinutesRow, MeetingRow,
    OrganizationMembershipRow,
)
from .accounts import Actor
from .repository import ProfileNotFoundError
from .tenant import current_organization_id


class KnowledgeBaseNotFoundError(LookupError):
    pass


class KnowledgeBaseConflictError(ValueError):
    pass


class KnowledgeBaseCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    text_profile_id: UUID | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if len(cleaned) < 2:
            raise ValueError("knowledge base name must contain at least two characters")
        return cleaned


class KnowledgeBasePatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    text_profile_id: UUID | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        return KnowledgeBaseCreate.clean_name(value) if value is not None else None


class KnowledgeBasePublic(BaseModel):
    id: UUID
    organization_id: UUID
    name: str
    description: str | None
    created_by: UUID
    visibility: str
    text_profile_id: UUID | None
    meeting_count: int
    shared_user_ids: list[UUID] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class KnowledgeMessagePublic(BaseModel):
    id: UUID
    role: str
    content: str
    citations: list[dict]
    provider: str | None
    model: str | None
    created_at: datetime


class KnowledgeConversationPublic(BaseModel):
    id: UUID
    knowledge_base_id: UUID
    title: str
    created_at: datetime
    updated_at: datetime
    messages: list[KnowledgeMessagePublic] = Field(default_factory=list)


class KnowledgeWikiMeeting(BaseModel):
    id: UUID
    title: str
    created_at: datetime
    tags: list[str]
    summary: str | None
    decisions: list[str]
    action_items: list[str]
    related_meeting_ids: list[UUID] = Field(default_factory=list)


class KnowledgeWikiOverview(BaseModel):
    knowledge_base_id: UUID
    name: str
    meetings: list[KnowledgeWikiMeeting]


class KnowledgeShareRequest(BaseModel):
    visibility: str = "private"
    user_ids: list[UUID] = Field(default_factory=list, max_length=100)

    @field_validator("visibility")
    @classmethod
    def valid_visibility(cls, value: str) -> str:
        if value not in {"private", "organization", "specific"}:
            raise ValueError("visibility must be private, organization, or specific")
        return value


class KnowledgeBaseService:
    def __init__(self, database: Database, repository: object) -> None:
        self.database = database
        self.repository = repository

    def list(self, actor: Actor | None = None) -> list[KnowledgeBasePublic]:
        with self.database.session_factory() as session:
            rows = session.execute(select(KnowledgeBaseRow).where(
                KnowledgeBaseRow.organization_id == str(self._organization(actor))
            ).order_by(KnowledgeBaseRow.name)).scalars().all()
            return [self._public(session, row) for row in rows if self._can_read(session, row, actor)]

    def get(self, base_id: UUID, actor: Actor | None = None) -> KnowledgeBasePublic:
        with self.database.session_factory() as session:
            return self._public(session, self._row(session, base_id, actor))

    def overview(self, base_id: UUID, actor: Actor | None = None) -> KnowledgeWikiOverview:
        """Canonical wiki map: base → opted-in meetings → approved facts."""
        with self.database.session_factory() as session:
            base = self._row(session, base_id, actor)
            rows = session.execute(
                select(MeetingRow, MeetingKnowledgeSettingsRow, MeetingMinutesRow)
                .join(MeetingTenantRow, MeetingTenantRow.meeting_id == MeetingRow.id)
                .join(MeetingKnowledgeBaseRow, MeetingKnowledgeBaseRow.meeting_id == MeetingRow.id)
                .join(MeetingKnowledgeSettingsRow, MeetingKnowledgeSettingsRow.meeting_id == MeetingRow.id)
                .outerjoin(MeetingMinutesRow, MeetingMinutesRow.meeting_id == MeetingRow.id)
                .where(
                    MeetingKnowledgeBaseRow.knowledge_base_id == base.id,
                    MeetingTenantRow.organization_id == base.organization_id,
                    MeetingKnowledgeSettingsRow.organization_id == base.organization_id,
                    MeetingKnowledgeSettingsRow.knowledge_enabled.is_(True),
                    MeetingRow.status == MeetingStatus.COMPLETED.value,
                )
                .order_by(MeetingRow.created_at.desc()).limit(100)
            ).all()
            meetings = []
            for meeting, settings, minutes in rows:
                approved = minutes is not None and minutes.status in {
                    MinutesStatus.APPROVED.value, MinutesStatus.SENT.value,
                }
                meetings.append(KnowledgeWikiMeeting(
                    id=UUID(meeting.id), title=meeting.title or "Untitled meeting",
                    created_at=meeting.created_at, tags=list(settings.tags or []),
                    summary=minutes.executive_summary if approved else None,
                    decisions=list(minutes.decisions or []) if approved else [],
                    action_items=[str(item.get("description", "")) for item in minutes.action_items or []
                                  if isinstance(item, dict) and item.get("description")] if approved else [],
                ))
            for meeting in meetings:
                meeting.related_meeting_ids = [other.id for other in meetings if other.id != meeting.id
                                               and set(meeting.tags) & set(other.tags)][:5]
            return KnowledgeWikiOverview(knowledge_base_id=base_id, name=base.name, meetings=meetings)

    def create(self, data: KnowledgeBaseCreate, actor: Actor | None = None) -> KnowledgeBasePublic:
        if actor is not None and not actor.is_admin and data.text_profile_id is not None:
            raise KnowledgeBaseConflictError("only admins can select an AI provider")
        self._validate_profile(data.text_profile_id)
        now = datetime.now(UTC)
        organization_id = self._organization(actor)
        with self.database.session_factory.begin() as session:
            self._unique_name(session, data.name, organization_id)
            row = KnowledgeBaseRow(
                id=str(uuid4()), organization_id=str(organization_id),
                name=data.name, description=data.description,
                created_by=str(actor.user_id if actor else LEGACY_ADMIN_USER_ID), visibility="private",
                text_profile_id=str(data.text_profile_id) if data.text_profile_id else None,
                created_at=now, updated_at=now,
            )
            session.add(row)
            session.flush()
            return self._public(session, row)

    def update(self, base_id: UUID, data: KnowledgeBasePatch, actor: Actor | None = None) -> KnowledgeBasePublic:
        if "text_profile_id" in data.model_fields_set:
            if actor is not None and not actor.is_admin:
                raise KnowledgeBaseConflictError("only admins can select an AI provider")
            self._validate_profile(data.text_profile_id)
        with self.database.session_factory.begin() as session:
            row = self._row(session, base_id, actor)
            self._require_manage(row, actor)
            if "name" in data.model_fields_set:
                if data.name is None:
                    raise KnowledgeBaseConflictError("knowledge base name cannot be empty")
                self._unique_name(session, data.name, self._organization(actor), except_id=row.id)
                row.name = data.name
            if "description" in data.model_fields_set:
                row.description = data.description
            if "text_profile_id" in data.model_fields_set:
                row.text_profile_id = str(data.text_profile_id) if data.text_profile_id else None
            row.updated_at = datetime.now(UTC)
            session.flush()
            return self._public(session, row)

    def share(self, base_id: UUID, data: KnowledgeShareRequest, actor: Actor | None = None) -> KnowledgeBasePublic:
        with self.database.session_factory.begin() as session:
            row = self._row(session, base_id, actor)
            self._require_manage(row, actor)
            member_ids = set(session.execute(select(OrganizationMembershipRow.user_id).where(
                OrganizationMembershipRow.organization_id == row.organization_id
            )).scalars().all())
            if any(str(user_id) not in member_ids for user_id in data.user_ids):
                raise KnowledgeBaseConflictError("sharing target must belong to this workspace")
            session.execute(delete(KnowledgeBaseAccessRow).where(KnowledgeBaseAccessRow.knowledge_base_id == row.id))
            if data.visibility == "specific":
                for user_id in set(data.user_ids):
                    session.add(KnowledgeBaseAccessRow(
                        knowledge_base_id=row.id, user_id=str(user_id), access="read",
                    ))
            row.visibility = data.visibility
            row.updated_at = datetime.now(UTC)
            session.flush()
            return self._public(session, row)

    def assign_meeting(self, meeting_id: UUID, base_id: UUID | None) -> None:
        self.repository.get_meeting(meeting_id)
        with self.database.session_factory.begin() as session:
            association = session.get(MeetingKnowledgeBaseRow, str(meeting_id))
            if association is not None and association.knowledge_base_id != (str(base_id) if base_id else None):
                session.execute(delete(KnowledgeEmbeddingRow).where(
                    KnowledgeEmbeddingRow.meeting_id == str(meeting_id),
                    KnowledgeEmbeddingRow.organization_id == str(current_organization_id()),
                ))
            if base_id is None:
                if association:
                    session.delete(association)
                return
            self._row(session, base_id)
            if association is None:
                association = MeetingKnowledgeBaseRow(meeting_id=str(meeting_id))
                session.add(association)
            association.knowledge_base_id = str(base_id)

    def meeting_base_id(self, meeting_id: UUID) -> UUID | None:
        self.repository.get_meeting(meeting_id)
        with self.database.session_factory() as session:
            row = session.get(MeetingKnowledgeBaseRow, str(meeting_id))
            return UUID(row.knowledge_base_id) if row else None

    def meeting_ids(self, base_id: UUID, actor: Actor | None = None) -> set[UUID]:
        with self.database.session_factory() as session:
            self._row(session, base_id, actor)
            values = session.execute(select(MeetingKnowledgeBaseRow.meeting_id).where(
                MeetingKnowledgeBaseRow.knowledge_base_id == str(base_id)
            )).scalars().all()
            return {UUID(value) for value in values}

    def list_conversations(self, base_id: UUID, actor: Actor | None = None) -> list[KnowledgeConversationPublic]:
        with self.database.session_factory() as session:
            self._row(session, base_id, actor)
            rows = session.execute(select(KnowledgeConversationRow).where(
                KnowledgeConversationRow.knowledge_base_id == str(base_id),
                KnowledgeConversationRow.user_id == str(actor.user_id if actor else LEGACY_ADMIN_USER_ID),
            ).order_by(KnowledgeConversationRow.updated_at.desc())).scalars().all()
            return [self._conversation_public(row, []) for row in rows]

    def get_conversation(self, base_id: UUID, conversation_id: UUID, actor: Actor | None = None) -> KnowledgeConversationPublic:
        with self.database.session_factory() as session:
            self._row(session, base_id, actor)
            row = self._conversation_row(session, base_id, conversation_id, actor)
            messages = session.execute(select(KnowledgeMessageRow).where(
                KnowledgeMessageRow.conversation_id == str(conversation_id)
            ).order_by(KnowledgeMessageRow.position)).scalars().all()
            return self._conversation_public(row, messages)

    def delete_conversation(self, base_id: UUID, conversation_id: UUID, actor: Actor | None = None) -> None:
        """Delete only the caller's saved chat and its copied answer/citation data."""
        with self.database.session_factory.begin() as session:
            self._row(session, base_id, actor)
            row = self._conversation_row(session, base_id, conversation_id, actor)
            session.execute(delete(KnowledgeMessageRow).where(
                KnowledgeMessageRow.conversation_id == str(conversation_id)
            ))
            session.delete(row)

    def save_exchange(
        self, base_id: UUID, conversation_id: UUID | None, question: str,
        answer: str, citations: list[dict], provider: str | None, model: str | None,
        actor: Actor | None = None,
    ) -> UUID:
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            self._row(session, base_id, actor)
            if conversation_id is None:
                conversation_id = uuid4()
                row = KnowledgeConversationRow(
                    id=str(conversation_id), knowledge_base_id=str(base_id),
                    user_id=str(actor.user_id if actor else LEGACY_ADMIN_USER_ID), title=question[:200],
                    created_at=now, updated_at=now,
                )
                session.add(row)
            else:
                row = session.execute(select(KnowledgeConversationRow).where(
                    KnowledgeConversationRow.id == str(conversation_id),
                    KnowledgeConversationRow.knowledge_base_id == str(base_id),
                    KnowledgeConversationRow.user_id == str(actor.user_id if actor else LEGACY_ADMIN_USER_ID),
                ).with_for_update()).scalar_one_or_none()
                if row is None:
                    raise KnowledgeBaseNotFoundError(conversation_id)
                row.updated_at = now
            next_position = session.execute(select(func.coalesce(func.max(KnowledgeMessageRow.position), -1) + 1).where(
                KnowledgeMessageRow.conversation_id == str(conversation_id)
            )).scalar_one()
            session.add(KnowledgeMessageRow(
                id=str(uuid4()), conversation_id=str(conversation_id), position=next_position, role="user",
                content=question, citations=[], provider=None, model=None, created_at=now,
            ))
            session.add(KnowledgeMessageRow(
                id=str(uuid4()), conversation_id=str(conversation_id), position=next_position + 1, role="assistant",
                content=answer, citations=citations, provider=provider, model=model,
                created_at=now,
            ))
            return conversation_id

    def _validate_profile(self, profile_id: UUID | None) -> None:
        if profile_id is None:
            return
        try:
            profile = self.repository.get_profile(profile_id)
        except ProfileNotFoundError as exc:
            raise KnowledgeBaseConflictError("text-generation profile not found") from exc
        if not profile.supports(Capability.TEXT_GENERATION):
            raise KnowledgeBaseConflictError("profile does not support text generation")

    @staticmethod
    def _row(session, base_id: UUID, actor: Actor | None = None) -> KnowledgeBaseRow:
        row = session.get(KnowledgeBaseRow, str(base_id))
        if row is None or row.organization_id != str(KnowledgeBaseService._organization(actor)) or not KnowledgeBaseService._can_read(session, row, actor):
            raise KnowledgeBaseNotFoundError(base_id)
        return row

    @staticmethod
    def _organization(actor: Actor | None) -> UUID:
        return actor.organization_id if actor is not None else current_organization_id()

    @staticmethod
    def _can_read(session, row: KnowledgeBaseRow, actor: Actor | None) -> bool:
        if actor is None:
            return True  # Development-only no-auth test mode is the legacy owner.
        if row.organization_id != str(actor.organization_id):
            return False
        if actor.is_admin or row.created_by == str(actor.user_id) or row.visibility == "organization":
            return True
        return session.get(KnowledgeBaseAccessRow, (row.id, str(actor.user_id))) is not None

    @staticmethod
    def _require_manage(row: KnowledgeBaseRow, actor: Actor | None) -> None:
        if actor is not None and not actor.is_admin and row.created_by != str(actor.user_id):
            raise KnowledgeBaseConflictError("only the creator or an admin can manage this knowledge base")

    @staticmethod
    def _conversation_row(session, base_id: UUID, conversation_id: UUID, actor: Actor | None = None) -> KnowledgeConversationRow:
        row = session.get(KnowledgeConversationRow, str(conversation_id))
        if row is None or row.knowledge_base_id != str(base_id) or row.user_id != str(actor.user_id if actor else LEGACY_ADMIN_USER_ID):
            raise KnowledgeBaseNotFoundError(conversation_id)
        return row

    @staticmethod
    def _conversation_public(row: KnowledgeConversationRow, messages: list[KnowledgeMessageRow]) -> KnowledgeConversationPublic:
        return KnowledgeConversationPublic(
            id=UUID(row.id), knowledge_base_id=UUID(row.knowledge_base_id),
            title=row.title, created_at=row.created_at, updated_at=row.updated_at,
            messages=[KnowledgeMessagePublic(
                id=UUID(message.id), role=message.role, content=message.content,
                citations=message.citations, provider=message.provider,
                model=message.model, created_at=message.created_at,
            ) for message in messages],
        )

    @staticmethod
    def _unique_name(session, name: str, organization_id: UUID, except_id: str | None = None) -> None:
        existing = session.execute(select(KnowledgeBaseRow.id).where(
            KnowledgeBaseRow.organization_id == str(organization_id),
            func.lower(KnowledgeBaseRow.name) == name.lower(),
        )).scalar_one_or_none()
        if existing and existing != except_id:
            raise KnowledgeBaseConflictError("a knowledge base with this name already exists")

    @staticmethod
    def _public(session, row: KnowledgeBaseRow) -> KnowledgeBasePublic:
        count = session.execute(select(func.count()).select_from(MeetingKnowledgeBaseRow).where(
            MeetingKnowledgeBaseRow.knowledge_base_id == row.id
        )).scalar_one()
        shared = session.execute(select(KnowledgeBaseAccessRow.user_id).where(
            KnowledgeBaseAccessRow.knowledge_base_id == row.id
        )).scalars().all()
        return KnowledgeBasePublic(
            id=UUID(row.id), organization_id=UUID(row.organization_id),
            name=row.name, description=row.description, created_by=UUID(row.created_by),
            visibility=row.visibility,
            text_profile_id=UUID(row.text_profile_id) if row.text_profile_id else None,
            meeting_count=count, created_at=row.created_at, updated_at=row.updated_at,
            shared_user_ids=[UUID(value) for value in shared],
        )
