"""Local organization accounts; external identity and switching are separate work."""

from __future__ import annotations

import hmac
import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import scrypt
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select

from .database import (
    Database, LEGACY_ADMIN_USER_ID, LEGACY_ORGANIZATION_ID,
    OrganizationMembershipRow, OrganizationRow, UserCredentialRow, UserRow,
)


class AccountError(ValueError):
    pass


@dataclass(frozen=True)
class Actor:
    user_id: UUID
    organization_id: UUID
    email: str | None
    display_name: str
    role: str
    must_change_password: bool
    session_version: int

    @property
    def is_admin(self) -> bool:
        return self.role in {"owner", "admin"}


class AccountPublic(BaseModel):
    user_id: UUID
    organization_id: UUID
    email: str | None
    display_name: str
    role: str
    must_change_password: bool


class InviteRequest(BaseModel):
    email: str = Field(max_length=320)
    display_name: str = Field(min_length=2, max_length=120)
    role: str = "member"

    @field_validator("email")
    @classmethod
    def clean_email(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", cleaned):
            raise ValueError("enter a valid email address")
        return cleaned

    @field_validator("display_name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if len(cleaned) < 2:
            raise ValueError("name must contain at least two characters")
        return cleaned

    @field_validator("role")
    @classmethod
    def allowed_role(cls, value: str) -> str:
        if value not in {"admin", "member", "viewer"}:
            raise ValueError("role must be admin, member, or viewer")
        return value


class InviteResult(BaseModel):
    account: AccountPublic
    temporary_password: str | None
    note: str = "Shown once. Share it privately; the recipient must change it on first sign-in."


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=12, max_length=200)


class OrganizationCreateRequest(BaseModel):
    display_name: str = Field(min_length=2, max_length=120)

    @field_validator("display_name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return InviteRequest.clean_name(value)


class OrganizationOption(BaseModel):
    id: UUID
    slug: str
    display_name: str
    role: str


def _hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt:16384:8:1:{salt.hex()}:{digest.hex()}"


def _check_password(password: str, encoded: str) -> bool:
    try:
        algorithm, n, r, p, salt_hex, digest_hex = encoded.split(":")
        if algorithm != "scrypt":
            return False
        digest = scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(digest, bytes.fromhex(digest_hex))
    except (ValueError, TypeError):
        return False


class AccountService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def bootstrap_owner(self, email: str, password: str) -> None:
        if not password:
            return
        clean_email = InviteRequest.clean_email(email)
        with self.database.session_factory.begin() as session:
            user = session.get(UserRow, str(LEGACY_ADMIN_USER_ID))
            if user is None:
                raise RuntimeError("workspace owner record is missing")
            if user.email is None:
                user.email = clean_email
                user.display_name = "Workspace owner"
            credential = session.get(UserCredentialRow, user.id)
            if credential is None:
                now = datetime.now(UTC)
                session.add(UserCredentialRow(
                    user_id=user.id, password_hash=_hash_password(password),
                    must_change_password=False, session_version=1,
                    created_at=now, updated_at=now,
                ))

    def login(self, email: str | None, password: str) -> Actor:
        with self.database.session_factory() as session:
            if email:
                row = session.execute(select(UserRow).where(func.lower(UserRow.email) == email.strip().lower())).scalar_one_or_none()
            else:
                row = session.get(UserRow, str(LEGACY_ADMIN_USER_ID))
            if row is None or row.status not in {"active", "invited"}:
                raise AccountError("invalid email or password")
            credential = session.get(UserCredentialRow, row.id)
            if credential is None or not _check_password(password, credential.password_hash):
                raise AccountError("invalid email or password")
            if not email and row.id != str(LEGACY_ADMIN_USER_ID):
                raise AccountError("email is required")
            return self._actor(session, row, credential)

    def from_session(self, user_id: UUID, organization_id: UUID, version: int) -> Actor | None:
        with self.database.session_factory() as session:
            row = session.get(UserRow, str(user_id))
            credential = session.get(UserCredentialRow, str(user_id))
            if row is None or credential is None or credential.session_version != version or row.status not in {"active", "invited"}:
                return None
            try:
                return self._actor(session, row, credential, organization_id)
            except AccountError:
                return None

    def list_organizations(self, actor: Actor) -> list[OrganizationOption]:
        with self.database.session_factory() as session:
            rows = session.execute(select(OrganizationMembershipRow, OrganizationRow)
                .join(OrganizationRow, OrganizationRow.id == OrganizationMembershipRow.organization_id)
                .where(OrganizationMembershipRow.user_id == str(actor.user_id), OrganizationRow.status == "active")
                .order_by(OrganizationRow.display_name)).all()
            return [OrganizationOption(id=UUID(org.id), slug=org.slug,
                                       display_name=org.display_name, role=membership.role)
                    for membership, org in rows]

    def select_organization(self, actor: Actor, organization_id: UUID) -> Actor:
        with self.database.session_factory() as session:
            user = session.get(UserRow, str(actor.user_id))
            credential = session.get(UserCredentialRow, str(actor.user_id))
            if user is None or credential is None:
                raise AccountError("account not found")
            return self._actor(session, user, credential, organization_id)

    def create_organization(self, actor: Actor, data: OrganizationCreateRequest) -> Actor:
        now = datetime.now(UTC)
        organization_id = uuid4()
        base_slug = re.sub(r"[^a-z0-9]+", "-", data.display_name.lower()).strip("-")[:60] or "workspace"
        slug = f"{base_slug}-{organization_id.hex[:8]}"
        with self.database.session_factory.begin() as session:
            session.add(OrganizationRow(
                id=str(organization_id), slug=slug, display_name=data.display_name,
                contact_email=None, status="active", created_at=now, updated_at=now,
            ))
            session.add(OrganizationMembershipRow(
                organization_id=str(organization_id), user_id=str(actor.user_id),
                role="owner", created_at=now,
            ))
        return self.select_organization(actor, organization_id)

    def invite(self, requester: Actor, data: InviteRequest) -> InviteResult:
        if not requester.is_admin:
            raise AccountError("only admins can invite people")
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            existing = session.execute(select(UserRow).where(func.lower(UserRow.email) == data.email)).scalar_one_or_none()
            if existing:
                if existing.status not in {"active", "invited"}:
                    raise AccountError("this account is not active")
                if session.get(OrganizationMembershipRow, (str(requester.organization_id), existing.id)):
                    raise AccountError("this account already belongs to this workspace")
                user_id = existing.id
                display_name = existing.display_name
                credential = session.get(UserCredentialRow, user_id)
                if credential is None:
                    raise AccountError("this account has no local sign-in method")
                temporary = None
                must_change_password = credential.must_change_password
                note = "Existing account added. They can switch workspaces after signing in with their current password."
            else:
                user_id = str(uuid4())
                display_name = data.display_name
                temporary = secrets.token_urlsafe(24)
                must_change_password = True
                note = "Shown once. Share it privately; the recipient must change it on first sign-in."
                session.add(UserRow(
                    id=user_id, email=data.email, display_name=data.display_name,
                    auth_subject=f"local:{user_id}", status="invited",
                    created_at=now, updated_at=now,
                ))
                session.add(UserCredentialRow(
                    user_id=user_id, password_hash=_hash_password(temporary),
                    must_change_password=True, session_version=1,
                    created_at=now, updated_at=now,
                ))
            session.add(OrganizationMembershipRow(
                organization_id=str(requester.organization_id), user_id=user_id,
                role=data.role, created_at=now,
            ))
            return InviteResult(account=AccountPublic(
                user_id=UUID(user_id), organization_id=requester.organization_id,
                email=data.email, display_name=display_name,
                role=data.role, must_change_password=must_change_password,
            ), temporary_password=temporary, note=note)

    def reset_temporary_password(self, requester: Actor, user_id: UUID) -> InviteResult:
        if not requester.is_admin:
            raise AccountError("only admins can reset access")
        if user_id == LEGACY_ADMIN_USER_ID:
            raise AccountError("the owner password cannot be reset here")
        temporary = secrets.token_urlsafe(24)
        with self.database.session_factory.begin() as session:
            user = session.get(UserRow, str(user_id))
            membership = session.get(OrganizationMembershipRow, (str(requester.organization_id), str(user_id)))
            credential = session.get(UserCredentialRow, str(user_id))
            if user is None or membership is None or credential is None:
                raise AccountError("member not found")
            credential.password_hash = _hash_password(temporary)
            credential.must_change_password = True
            credential.session_version += 1
            credential.updated_at = datetime.now(UTC)
            user.status = "invited"
            user.updated_at = credential.updated_at
            return InviteResult(account=AccountPublic(
                user_id=user_id, organization_id=requester.organization_id,
                email=user.email, display_name=user.display_name,
                role=membership.role, must_change_password=True,
            ), temporary_password=temporary)

    def change_password(self, actor: Actor, current: str, new: str) -> Actor:
        if len(new) < 12 or len(new) > 200:
            raise AccountError("new password must be 12–200 characters")
        if current == new:
            raise AccountError("new password must be different")
        with self.database.session_factory.begin() as session:
            user = session.get(UserRow, str(actor.user_id))
            credential = session.get(UserCredentialRow, str(actor.user_id))
            if user is None or credential is None or not _check_password(current, credential.password_hash):
                raise AccountError("current password is incorrect")
            credential.password_hash = _hash_password(new)
            credential.must_change_password = False
            credential.session_version += 1
            credential.updated_at = datetime.now(UTC)
            user.status = "active"
            user.updated_at = credential.updated_at
            return self._actor(session, user, credential)

    @staticmethod
    def public(actor: Actor) -> AccountPublic:
        return AccountPublic(
            user_id=actor.user_id, organization_id=actor.organization_id,
            email=actor.email, display_name=actor.display_name,
            role=actor.role, must_change_password=actor.must_change_password,
        )

    @staticmethod
    def _actor(session, user: UserRow, credential: UserCredentialRow, organization_id: UUID | None = None) -> Actor:
        query = select(OrganizationMembershipRow).join(
            OrganizationRow, OrganizationRow.id == OrganizationMembershipRow.organization_id
        ).where(OrganizationMembershipRow.user_id == user.id, OrganizationRow.status == "active")
        if organization_id is not None:
            query = query.where(OrganizationMembershipRow.organization_id == str(organization_id))
        membership = session.execute(query.order_by(
            OrganizationMembershipRow.created_at, OrganizationMembershipRow.organization_id
        )).scalars().first()
        if membership is None:
            raise AccountError("account has no workspace membership")
        return Actor(
            user_id=UUID(user.id), organization_id=UUID(membership.organization_id),
            email=user.email, display_name=user.display_name, role=membership.role,
            must_change_password=credential.must_change_password,
            session_version=credential.session_version,
        )
