"""Internal teams (recipient groups): named sets of workspace members and addresses.

A meeting's recap can target a team by reference. The team is expanded to its
*current* members only when the recap is sent, so editing a team changes every
future send that targets it. Workspace members are resolved to their current
email and skipped once they leave the workspace; external addresses are sent to
as entered. Every query is scoped to the caller's organization.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .database import (
    Database,
    MeetingDeliveryGroupRow,
    OrganizationMembershipRow,
    RecipientGroupMemberRow,
    RecipientGroupRow,
    UserProfilePhotoRow,
    UserRow,
)
from .profile_photos import photo_url
from .repository import RecipientGroupNotFoundError
from .tenant import current_organization_id

NAME_MAX_LENGTH = 80
DESCRIPTION_MAX_LENGTH = 500
MAX_MEMBERS = 200
EMAIL_MAX_LENGTH = 320
# Same shape the web chip input accepts; the server is the authority.
EMAIL_PATTERN = re.compile(r"[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}")


class RecipientGroupError(ValueError):
    """Invalid team input (422)."""


class RecipientGroupConflictError(RuntimeError):
    """A team with this name already exists (409)."""


class RecipientGroupPermissionError(PermissionError):
    """Only workspace owners and admins manage teams (403)."""


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    if len(email) > EMAIL_MAX_LENGTH or not EMAIL_PATTERN.fullmatch(email):
        raise ValueError(f"invalid email address: {value}")
    return email


def _clean_name(value: str) -> str:
    name = " ".join(value.split())
    if not 1 <= len(name) <= NAME_MAX_LENGTH:
        raise ValueError(f"team name must be 1–{NAME_MAX_LENGTH} characters")
    return name


def _clean_description(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    if len(text) > DESCRIPTION_MAX_LENGTH:
        raise ValueError(f"description must be at most {DESCRIPTION_MAX_LENGTH} characters")
    return text or None


class TeamMemberInput(BaseModel):
    """Either a workspace member (user_id) or an external address (email)."""

    model_config = ConfigDict(extra="forbid")
    user_id: UUID | None = None
    email: str | None = Field(default=None, max_length=EMAIL_MAX_LENGTH)

    @model_validator(mode="after")
    def one_identity(self) -> "TeamMemberInput":
        if self.user_id is None and not self.email:
            raise ValueError("each team member needs a user_id or an email")
        if self.user_id is None and self.email:
            self.email = normalize_email(self.email)
        elif self.user_id is not None:
            # The server resolves a member's address from their account; a client email is ignored.
            self.email = None
        return self


class TeamCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    members: list[TeamMemberInput] = Field(default_factory=list, max_length=MAX_MEMBERS)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return _clean_name(value)

    @field_validator("description")
    @classmethod
    def clean_description(cls, value: str | None) -> str | None:
        return _clean_description(value)


class TeamPatch(BaseModel):
    """Fields left out are unchanged; `members` replaces the whole list when present."""

    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    members: list[TeamMemberInput] | None = Field(default=None, max_length=MAX_MEMBERS)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        return None if value is None else _clean_name(value)

    @field_validator("description")
    @classmethod
    def clean_description(cls, value: str | None) -> str | None:
        return _clean_description(value)


class TeamMemberPublic(BaseModel):
    email: str
    user_id: UUID | None
    display_name: str | None
    photo_url: str | None = None
    # False for an account that has since left the workspace; such entries are skipped when sending.
    active: bool = True


class TeamPublic(BaseModel):
    id: UUID
    name: str
    description: str | None
    created_by: UUID | None
    created_at: datetime
    updated_at: datetime
    member_count: int
    # How many meetings currently target this team for their recap.
    meeting_count: int
    members: list[TeamMemberPublic]


@dataclass(frozen=True)
class Expansion:
    """Current addresses for a set of teams, plus what each team contributed."""

    emails: list[str]
    groups: list[dict[str, object]]


def _org() -> str:
    return str(current_organization_id())


class RecipientGroupService:
    def __init__(self, database: Database) -> None:
        self.database = database

    # --- queries -------------------------------------------------------------------------
    def list(self) -> list[TeamPublic]:
        with self.database.session_factory() as session:
            rows = session.execute(
                select(RecipientGroupRow).where(RecipientGroupRow.organization_id == _org())
                .order_by(RecipientGroupRow.name_key)
            ).scalars().all()
            return [self._public(session, row) for row in rows]

    def get(self, group_id: UUID) -> TeamPublic:
        with self.database.session_factory() as session:
            return self._public(session, self._require(session, group_id))

    def expand(self, group_ids: list[UUID]) -> Expansion:
        """Resolve teams to current addresses at send time (deduplicated, first spelling wins)."""
        if not group_ids:
            return Expansion(emails=[], groups=[])
        with self.database.session_factory() as session:
            emails: list[str] = []
            used: list[dict[str, object]] = []
            for group_id in group_ids:
                row = self._require(session, group_id)
                addresses = [member.email for member in self._members(session, row.id) if member.active]
                used.append({"id": row.id, "name": row.name, "member_count": len(addresses)})
                emails.extend(address for address in addresses if address not in emails)
            return Expansion(emails=emails, groups=used)

    # --- writes --------------------------------------------------------------------------
    def create(self, payload: TeamCreate, actor) -> TeamPublic:
        self._require_admin(actor)
        now = datetime.now(UTC)
        row = RecipientGroupRow(
            id=str(uuid4()), organization_id=_org(), name=payload.name, name_key=payload.name.casefold(),
            description=payload.description, created_by=str(actor.user_id), created_at=now, updated_at=now,
        )
        try:
            with self.database.session_factory.begin() as session:
                self._assert_name_free(session, row.name_key)
                session.add(row)
                session.flush()
                self._replace_members(session, row.id, payload.members, now)
        except IntegrityError as exc:
            raise RecipientGroupConflictError("a team with this name already exists") from exc
        return self.get(UUID(row.id))

    def update(self, group_id: UUID, patch: TeamPatch, actor) -> TeamPublic:
        self._require_admin(actor)
        now = datetime.now(UTC)
        fields = patch.model_fields_set
        try:
            with self.database.session_factory.begin() as session:
                row = self._require(session, group_id)
                if "name" in fields and patch.name is not None and patch.name.casefold() != row.name_key:
                    self._assert_name_free(session, patch.name.casefold())
                    row.name, row.name_key = patch.name, patch.name.casefold()
                elif "name" in fields and patch.name is not None:
                    row.name = patch.name  # a change of case only
                if "description" in fields:
                    row.description = patch.description
                if "members" in fields and patch.members is not None:
                    self._replace_members(session, row.id, patch.members, now)
                row.updated_at = now
        except IntegrityError as exc:
            raise RecipientGroupConflictError("a team with this name already exists") from exc
        return self.get(group_id)

    def delete(self, group_id: UUID, actor) -> None:
        """Remove a team. Meetings that targeted it stop sending to it; past deliveries keep its name."""
        self._require_admin(actor)
        with self.database.session_factory.begin() as session:
            row = self._require(session, group_id)
            session.execute(delete(MeetingDeliveryGroupRow).where(MeetingDeliveryGroupRow.group_id == row.id))
            session.execute(delete(RecipientGroupMemberRow).where(RecipientGroupMemberRow.group_id == row.id))
            session.delete(row)

    # --- helpers -------------------------------------------------------------------------
    @staticmethod
    def _require_admin(actor) -> None:
        if actor is None or not actor.is_admin:
            raise RecipientGroupPermissionError("only workspace owners and admins can manage teams")

    @staticmethod
    def _require(session: Session, group_id: UUID) -> RecipientGroupRow:
        row = session.get(RecipientGroupRow, str(group_id))
        if row is None or row.organization_id != _org():
            raise RecipientGroupNotFoundError(f"team not found: {group_id}")
        return row

    @staticmethod
    def _assert_name_free(session: Session, name_key: str) -> None:
        taken = session.execute(select(RecipientGroupRow.id).where(
            RecipientGroupRow.organization_id == _org(), RecipientGroupRow.name_key == name_key,
        )).first()
        if taken:
            raise RecipientGroupConflictError("a team with this name already exists")

    def _replace_members(self, session: Session, group_id: str, members: list[TeamMemberInput], now: datetime) -> None:
        user_ids = [str(member.user_id) for member in members if member.user_id is not None]
        accounts = dict(session.execute(
            select(UserRow.id, UserRow.email)
            .join(OrganizationMembershipRow, OrganizationMembershipRow.user_id == UserRow.id)
            .where(OrganizationMembershipRow.organization_id == _org(), UserRow.id.in_(user_ids))
        ).all()) if user_ids else {}
        rows: dict[str, RecipientGroupMemberRow] = {}
        for member in members:
            if member.user_id is not None:
                user_id = str(member.user_id)
                if user_id not in accounts:
                    raise RecipientGroupError(f"workspace member not found: {member.user_id}")
                if not accounts[user_id]:
                    raise RecipientGroupError("that workspace member has no email address")
                email = accounts[user_id].strip().lower()
                # A workspace account wins over the same address typed as an external email.
                rows[email] = RecipientGroupMemberRow(group_id=group_id, email=email, user_id=user_id, added_at=now)
            elif member.email and member.email not in rows:
                rows[member.email] = RecipientGroupMemberRow(group_id=group_id, email=member.email, user_id=None, added_at=now)
        session.execute(delete(RecipientGroupMemberRow).where(RecipientGroupMemberRow.group_id == group_id))
        session.add_all(rows.values())

    @staticmethod
    def _members(session: Session, group_id: str) -> list[TeamMemberPublic]:
        rows = session.execute(
            select(RecipientGroupMemberRow, UserRow, OrganizationMembershipRow.user_id, UserProfilePhotoRow.updated_at)
            .outerjoin(UserRow, UserRow.id == RecipientGroupMemberRow.user_id)
            .outerjoin(OrganizationMembershipRow, (OrganizationMembershipRow.user_id == RecipientGroupMemberRow.user_id)
                       & (OrganizationMembershipRow.organization_id == _org()))
            .outerjoin(UserProfilePhotoRow, UserProfilePhotoRow.user_id == RecipientGroupMemberRow.user_id)
            .where(RecipientGroupMemberRow.group_id == group_id)
        ).all()
        members: list[TeamMemberPublic] = []
        for member, user, membership, photo_updated_at in rows:
            if member.user_id is None:
                members.append(TeamMemberPublic(email=member.email, user_id=None, display_name=None))
                continue
            active = membership is not None and user is not None and bool(user.email)
            members.append(TeamMemberPublic(
                email=(user.email or member.email).lower() if user else member.email,
                user_id=UUID(member.user_id), display_name=user.display_name if user else None,
                photo_url=photo_url(member.user_id, photo_updated_at) if active else None, active=active,
            ))
        members.sort(key=lambda item: (item.user_id is None, (item.display_name or item.email).casefold()))
        return members

    def _public(self, session: Session, row: RecipientGroupRow) -> TeamPublic:
        members = self._members(session, row.id)
        meeting_count = session.execute(
            select(func.count()).select_from(MeetingDeliveryGroupRow).where(MeetingDeliveryGroupRow.group_id == row.id)
        ).scalar_one()
        return TeamPublic(
            id=UUID(row.id), name=row.name, description=row.description,
            created_by=UUID(row.created_by) if row.created_by else None,
            created_at=row.created_at, updated_at=row.updated_at,
            member_count=sum(1 for member in members if member.active), meeting_count=meeting_count,
            members=members,
        )
