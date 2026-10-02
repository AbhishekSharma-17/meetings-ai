"""Personal MOMs: one transcript, separately owned notes, explicit document-level access.

Admin access to a meeting grants catalogue metadata, NOT private version contents.
Sharing a version never grants transcript, calendar, provider or knowledge-base access.
"""
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID, uuid4

from meetings_contracts import MeetingMinutesDraft, MomGuidance
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, select, update

from .database import (Database, MinutesVersionRow, MinutesVersionAccessRow, MeetingRow,
                       MeetingTenantRow, OrganizationMembershipRow, UserRow)
from .minutes_service import MinutesConflictError, _validate_references


def now():
    return datetime.now(UTC)


def utc(value):
    return value.replace(tzinfo=UTC) if value and value.tzinfo is None else value


class VersionError(ValueError):
    def __init__(self, message, status=404):
        super().__init__(message)
        self.status = status


class VersionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(min_length=1, max_length=100)
    perspective: Literal["standard", "technical", "commercial", "detailed", "actions", "custom"] = "standard"
    guidance: MomGuidance = Field(default_factory=MomGuidance)

    @field_validator("label")
    @classmethod
    def clean_label(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("name your MOM version")
        return value


class VersionEdit(VersionCreate):
    revision: int = Field(ge=1)
    content: MeetingMinutesDraft | None = None


class VersionRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)


class VersionSharing(VersionRevision):
    visibility: Literal["private", "workspace", "specific"] = "private"
    user_ids: list[UUID] = Field(default_factory=list, max_length=200)


class VersionSummary(BaseModel):
    id: UUID
    meeting_id: UUID
    label: str
    creator_id: UUID
    creator_name: str
    template: str
    status: str
    visibility: str
    revision: int
    is_mine: bool
    can_read: bool
    created_at: datetime
    updated_at: datetime


class VersionDetail(VersionSummary):
    guidance: MomGuidance | None = None
    content: MeetingMinutesDraft | None = None
    user_ids: list[UUID] = Field(default_factory=list)
    source_is_current: bool
    provider: str | None = None
    model: str | None = None


class MinutesVersionsService:
    def __init__(self, database: Database, minutes, coordination, sharing):
        self.database, self.minutes = database, minutes
        self.coordination, self.sharing = coordination, sharing

    def can_use_transcript(self, actor, meeting_id):
        with self.database.session_factory() as session:
            tenant = session.get(MeetingTenantRow, str(meeting_id))
            if not tenant or tenant.organization_id != str(actor.organization_id):
                return False
        return actor.is_admin or self.coordination.can_read(actor, meeting_id) or self.sharing.can_read(actor, meeting_id)

    def _transcript_access(self, actor, meeting_id):
        if not self.can_use_transcript(actor, meeting_id):
            raise VersionError("meeting not found")

    def _row(self, session, actor, version_id):
        row = session.get(MinutesVersionRow, str(version_id))
        if not row or row.organization_id != str(actor.organization_id):
            raise VersionError("MOM version not found")
        tenant = session.get(MeetingTenantRow, row.meeting_id)
        if not tenant or tenant.organization_id != row.organization_id:
            raise VersionError("MOM version not found")
        return row

    @staticmethod
    def _mine(actor, row):
        return row.creator_id == str(actor.user_id)

    def _readable(self, session, actor, row):
        if self._mine(actor, row):
            return True
        if row.status != "approved":
            return False
        # A change to speaker identities/transcript invalidates the reviewed document.
        if self.minutes.repository.get_transcript_revision(UUID(row.meeting_id)) != row.source_revision:
            return False
        if row.visibility == "workspace":
            return True
        if row.visibility != "specific":
            return False
        access = session.get(MinutesVersionAccessRow, (row.id, str(actor.user_id)))
        membership = session.get(OrganizationMembershipRow, (row.organization_id, str(actor.user_id)))
        return bool(access and membership and utc(access.granted_at) >= utc(membership.created_at))

    def _summary(self, session, actor, row):
        user = session.get(UserRow, row.creator_id)
        return VersionSummary(id=row.id, meeting_id=row.meeting_id, label=row.label,
            creator_id=row.creator_id, creator_name=user.display_name if user else "Former teammate",
            template=row.perspective, status=row.status,
            visibility=row.visibility, revision=row.revision, is_mine=self._mine(actor, row),
            can_read=self._readable(session, actor, row), created_at=row.created_at, updated_at=row.updated_at)

    def _detail(self, session, actor, row):
        if not self._readable(session, actor, row):
            raise VersionError("this MOM is private or has not been approved", 403)
        mine = self._mine(actor, row)
        ids = session.execute(select(MinutesVersionAccessRow.user_id).where(
            MinutesVersionAccessRow.version_id == row.id)).scalars().all() if mine else []
        return VersionDetail(**self._summary(session, actor, row).model_dump(),
            guidance=MomGuidance.model_validate(row.guidance) if mine else None,
            content=MeetingMinutesDraft.model_validate(row.content) if row.content else None,
            user_ids=ids, source_is_current=row.source_revision == self.minutes.repository.get_transcript_revision(UUID(row.meeting_id)),
            provider=row.provider, model=row.model)

    def catalogue(self, actor, meeting_id):
        self._transcript_access(actor, meeting_id)
        with self.database.session_factory() as session:
            rows = session.execute(select(MinutesVersionRow).where(
                MinutesVersionRow.meeting_id == str(meeting_id),
                MinutesVersionRow.organization_id == str(actor.organization_id)).order_by(MinutesVersionRow.created_at)).scalars()
            return [self._summary(session, actor, row) for row in rows]

    def inbox(self, actor):
        """My versions plus approved versions explicitly shared with me; no private admin bypass."""
        with self.database.session_factory() as session:
            rows = session.execute(select(MinutesVersionRow).where(
                MinutesVersionRow.organization_id == str(actor.organization_id)).order_by(MinutesVersionRow.updated_at.desc())).scalars()
            return [self._summary(session, actor, row) for row in rows if self._readable(session, actor, row)]

    def create(self, actor, meeting_id, payload):
        self._transcript_access(actor, meeting_id)
        if actor.role == "viewer":
            raise VersionError("viewers can read shared MOMs but cannot create them", 403)
        with self.database.session_factory.begin() as session:
            row = MinutesVersionRow(id=str(uuid4()), meeting_id=str(meeting_id), organization_id=str(actor.organization_id),
                creator_id=str(actor.user_id), label=payload.label, perspective=payload.perspective, guidance=payload.guidance.model_dump(mode="json"),
                status="empty", visibility="private", revision=1, created_at=now(), updated_at=now())
            session.add(row)
            session.flush()
            return self._detail(session, actor, row)

    def get(self, actor, version_id):
        with self.database.session_factory() as session:
            return self._detail(session, actor, self._row(session, actor, version_id))

    def _editable(self, session, actor, version_id, revision):
        row = self._row(session, actor, version_id)
        if not self._mine(actor, row):
            raise VersionError("only this MOM's creator can edit, approve, share or delete it", 403)
        if row.revision != revision:
            raise VersionError("this version changed; refresh before saving", 409)
        if row.generation_token and utc(row.generation_started_at) > now() - timedelta(minutes=15):
            raise VersionError("generation is already running for this version", 409)
        return row

    @staticmethod
    def _advance(session, row, revision, **values):
        changed = session.execute(update(MinutesVersionRow).where(
            MinutesVersionRow.id == row.id, MinutesVersionRow.revision == revision).values(
            **values, revision=revision + 1, updated_at=now()))
        if changed.rowcount != 1:
            raise VersionError("this version changed; refresh before saving", 409)
        session.expire(row)

    def edit(self, actor, version_id, payload):
        with self.database.session_factory.begin() as session:
            row = self._editable(session, actor, version_id, payload.revision)
            self._transcript_access(actor, row.meeting_id)
            if payload.content is not None:
                if row.source_revision is None or row.source_revision != self.minutes.repository.get_transcript_revision(UUID(row.meeting_id)):
                    raise MinutesConflictError("transcript changed; generate this version again before editing")
                _validate_references(payload.content, self.minutes.repository.get_transcript(UUID(row.meeting_id)))
            self._advance(session, row, payload.revision, label=payload.label,
                perspective=payload.perspective,
                guidance=payload.guidance.model_dump(mode="json"),
                content=payload.content.model_dump(mode="json") if payload.content else row.content,
                status="draft" if payload.content or row.content else "empty", approved_at=None,
                generation_token=None, generation_started_at=None)
            return self._detail(session, actor, row)

    async def generate(self, actor, version_id, revision):
        if actor.role == "viewer":
            raise VersionError("viewers cannot generate MOMs", 403)
        token = str(uuid4())
        with self.database.session_factory.begin() as session:
            row = self._editable(session, actor, version_id, revision)
            self._transcript_access(actor, row.meeting_id)
            meeting_id, guidance = UUID(row.meeting_id), MomGuidance.model_validate(row.guidance)
            self._advance(session, row, revision, generation_token=token, generation_started_at=now())
        try:
            draft, profile, result, source = await self.minutes.generate_draft(meeting_id, guidance=guidance,
                metadata={"purpose": "personal_mom", "actor_user_id": str(actor.user_id), "version_id": str(version_id)})
            self._transcript_access(actor, meeting_id)
            with self.database.session_factory.begin() as session:
                row = self._row(session, actor, version_id)
                if row.generation_token != token:
                    raise VersionError("generation was replaced; refresh this version", 409)
                if self.minutes.repository.get_transcript_revision(meeting_id) != source:
                    raise MinutesConflictError("transcript changed during generation; try again")
                self._advance(session, row, row.revision, content=draft.model_dump(mode="json"),
                    source_revision=source, status="draft", approved_at=None, provider=result.provider,
                    model=result.model, generation_token=None, generation_started_at=None)
                return self._detail(session, actor, row)
        finally:
            with self.database.session_factory.begin() as session:
                session.execute(update(MinutesVersionRow).where(MinutesVersionRow.id == str(version_id),
                    MinutesVersionRow.generation_token == token).values(generation_token=None, generation_started_at=None))

    def approve(self, actor, version_id, revision):
        with self.database.session_factory.begin() as session:
            row = self._editable(session, actor, version_id, revision)
            self._transcript_access(actor, row.meeting_id)
            if not row.content:
                raise VersionError("generate a draft before approval", 409)
            if self.minutes.repository.get_transcript_revision(UUID(row.meeting_id)) != row.source_revision:
                raise MinutesConflictError("transcript changed; generate this version again before approval")
            _validate_references(MeetingMinutesDraft.model_validate(row.content), self.minutes.repository.get_transcript(UUID(row.meeting_id)))
            previous_status = row.status
            self._advance(session, row, revision, status="approved", approved_at=now())
            if previous_status != "approved" and row.visibility != "private":
                self._sharing_notice(session, actor, row, self._audience(session, row), "This shared MOM is approved and ready to read.")
            return self._detail(session, actor, row)

    def share(self, actor, version_id, payload):
        with self.database.session_factory.begin() as session:
            row = self._editable(session, actor, version_id, payload.revision)
            before = self._audience(session, row)
            old_visibility = row.visibility
            ids = sorted({str(key) for key in payload.user_ids if str(key) != row.creator_id}) if payload.visibility == "specific" else []
            if payload.visibility == "specific" and not ids:
                raise VersionError("choose at least one teammate", 422)
            for key in ids:
                membership = session.get(OrganizationMembershipRow, (row.organization_id, key))
                user = session.get(UserRow, key)
                if not membership or not user or user.status != "active":
                    raise VersionError("choose active teammates from this workspace", 422)
            session.execute(delete(MinutesVersionAccessRow).where(MinutesVersionAccessRow.version_id == row.id))
            session.add_all([MinutesVersionAccessRow(version_id=row.id, user_id=key, granted_at=now()) for key in ids])
            self._advance(session, row, payload.revision, visibility=payload.visibility)
            session.flush()
            after = self._audience(session, row)
            if old_visibility != row.visibility or before != after:
                self._sharing_notice(session, actor, row, after, "You can read this MOM once its author approves it." if row.status != "approved" else "You can now read this approved MOM.")
                self._sharing_notice(session, actor, row, before - after, "Your access to this MOM was removed.", removed=True)
            return self._detail(session, actor, row)

    def _audience(self, session, row):
        if row.visibility == "private":
            return set()
        query = select(OrganizationMembershipRow.user_id).where(
            OrganizationMembershipRow.organization_id == row.organization_id)
        if row.visibility == "specific":
            query = query.where(OrganizationMembershipRow.user_id.in_(select(MinutesVersionAccessRow.user_id).where(
                MinutesVersionAccessRow.version_id == row.id)))
        return set(session.execute(query).scalars().all())

    def _sharing_notice(self, session, actor, row, audience, message, *, removed=False):
        notifications = getattr(self.sharing, "notifications", None)
        if notifications is None:
            return
        from .database import NotificationEmailRow
        session.execute(update(NotificationEmailRow).where(
            NotificationEmailRow.organization_id == row.organization_id,
            NotificationEmailRow.link_id == row.id,
            NotificationEmailRow.user_id.in_(audience),
            NotificationEmailRow.status == "pending",
        ).values(status="cancelled", last_error="Superseded by a newer sharing update."))
        notifications.access_notice(
            session, row.organization_id, user_ids=audience, kind="minutes.access_changed",
            scope="workspace" if row.visibility == "workspace" and not removed else "personal",
            title=f"MOM access updated: {row.label}", body=f"{actor.display_name}: {message}",
            link_view=None if removed else "shared", link_id=row.id,
        )

    def remove(self, actor, version_id, revision):
        with self.database.session_factory.begin() as session:
            row = self._editable(session, actor, version_id, revision)
            session.execute(delete(MinutesVersionAccessRow).where(MinutesVersionAccessRow.version_id == row.id))
            changed = session.execute(delete(MinutesVersionRow).where(MinutesVersionRow.id == row.id,
                MinutesVersionRow.revision == revision))
            if changed.rowcount != 1:
                raise VersionError("this version changed; refresh before deleting", 409)
