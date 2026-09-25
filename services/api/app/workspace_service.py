"""Single legacy workspace profile; multi-tenant access is not enabled yet."""

import re
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from .database import (
    Database,
    LEGACY_ORGANIZATION_ID,
    OrganizationMembershipRow,
    OrganizationRow,
    UserRow,
)


class WorkspacePublic(BaseModel):
    id: UUID
    slug: str
    display_name: str
    contact_email: str | None
    status: str
    created_at: datetime
    updated_at: datetime
    tenant_isolation_enabled: bool = False


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


class WorkspaceService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def get(self) -> WorkspacePublic:
        with self.database.session_factory() as session:
            row = session.get(OrganizationRow, str(LEGACY_ORGANIZATION_ID))
            if row is None:
                raise RuntimeError("legacy workspace is missing")
            return self._public(row)

    def update(self, patch: WorkspacePatch) -> WorkspacePublic:
        with self.database.session_factory.begin() as session:
            row = session.get(OrganizationRow, str(LEGACY_ORGANIZATION_ID))
            if row is None:
                raise RuntimeError("legacy workspace is missing")
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
        with self.database.session_factory() as session:
            rows = session.execute(
                select(OrganizationMembershipRow, UserRow)
                .join(UserRow, UserRow.id == OrganizationMembershipRow.user_id)
                .where(OrganizationMembershipRow.organization_id == str(LEGACY_ORGANIZATION_ID))
                .order_by(UserRow.display_name)
            ).all()
            return [WorkspaceMemberPublic(
                user_id=UUID(user.id), display_name=user.display_name,
                email=user.email, role=membership.role, status=user.status,
            ) for membership, user in rows]

    @staticmethod
    def _public(row: OrganizationRow) -> WorkspacePublic:
        return WorkspacePublic(
            id=UUID(row.id), slug=row.slug, display_name=row.display_name,
            contact_email=row.contact_email, status=row.status,
            created_at=row.created_at, updated_at=row.updated_at,
        )
