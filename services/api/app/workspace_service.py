"""Organization-scoped workspace profile and membership listings."""

import re
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select

from .database import (
    AccountTokenRow,
    Database,
    OrganizationMembershipRow,
    OrganizationRow,
    UserProfilePhotoRow,
    UserRow,
)
from .account_tokens import as_utc
from .profile_photos import photo_url
from .tenant import current_organization_id


class WorkspacePublic(BaseModel):
    id: UUID
    slug: str
    display_name: str
    contact_email: str | None
    status: str
    created_at: datetime
    updated_at: datetime
    tenant_isolation_enabled: bool = True


class WorkspacePatch(BaseModel):
    display_name: str | None = Field(default=None, min_length=2, max_length=120)
    contact_email: str | None = Field(default=None, max_length=320)

    @field_validator("display_name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if len(cleaned) < 2:
            raise ValueError("workspace name must contain at least two characters")
        return cleaned

    @field_validator("contact_email")
    @classmethod
    def clean_email(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip().lower()
        if not cleaned:
            return None
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", cleaned):
            raise ValueError("contact email must be a valid email address")
        return cleaned


class WorkspaceMemberPublic(BaseModel):
    user_id: UUID
    display_name: str
    email: str | None
    role: str
    status: str
    photo_url: str | None = None
    # Latest usable invitation link for this workspace; null when none is outstanding.
    invite_expires_at: datetime | None = None


class WorkspaceService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def get(self) -> WorkspacePublic:
        with self.database.session_factory() as session:
            row = session.get(OrganizationRow, str(current_organization_id()))
            if row is None:
                raise RuntimeError("workspace is missing")
            return self._public(row)

    def update(self, patch: WorkspacePatch) -> WorkspacePublic:
        with self.database.session_factory.begin() as session:
            row = session.get(OrganizationRow, str(current_organization_id()))
            if row is None:
                raise RuntimeError("workspace is missing")
            if "display_name" in patch.model_fields_set:
                if patch.display_name is None:
                    raise ValueError("workspace name cannot be empty")
                row.display_name = patch.display_name
            if "contact_email" in patch.model_fields_set:
                row.contact_email = patch.contact_email
            if patch.model_fields_set:
                from datetime import UTC

                row.updated_at = datetime.now(UTC)
            return self._public(row)

    def list_members(self) -> list[WorkspaceMemberPublic]:
        organization_id = str(current_organization_id())
        with self.database.session_factory() as session:
            invites = dict(session.execute(
                select(AccountTokenRow.user_id, func.max(AccountTokenRow.expires_at))
                .where(AccountTokenRow.organization_id == organization_id, AccountTokenRow.purpose == "invite",
                       AccountTokenRow.used_at.is_(None), AccountTokenRow.revoked_at.is_(None))
                .group_by(AccountTokenRow.user_id)
            ).all())
            rows = session.execute(
                select(OrganizationMembershipRow, UserRow, UserProfilePhotoRow.updated_at)
                .join(UserRow, UserRow.id == OrganizationMembershipRow.user_id)
                .outerjoin(UserProfilePhotoRow, UserProfilePhotoRow.user_id == UserRow.id)
                .where(OrganizationMembershipRow.organization_id == organization_id)
                .order_by(UserRow.display_name)
            ).all()
            return [WorkspaceMemberPublic(
                user_id=UUID(user.id), display_name=user.display_name,
                email=user.email, role=membership.role, status=user.status,
                photo_url=photo_url(user.id, photo_updated_at),
                invite_expires_at=as_utc(invites[user.id]) if user.status == "invited" and user.id in invites else None,
            ) for membership, user, photo_updated_at in rows]

    @staticmethod
    def _public(row: OrganizationRow) -> WorkspacePublic:
        return WorkspacePublic(
            id=UUID(row.id), slug=row.slug, display_name=row.display_name,
            contact_email=row.contact_email, status=row.status,
            created_at=row.created_at, updated_at=row.updated_at,
        )

