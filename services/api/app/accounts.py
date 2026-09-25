"""Local organization accounts for the pilot; not a multi-tenant identity provider."""

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
    OrganizationMembershipRow, UserCredentialRow, UserRow,
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
    temporary_password: str
    note: str = "Shown once. Share it privately; the recipient must change it on first sign-in."


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=12, max_length=200)


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

    def from_session(self, user_id: UUID, version: int) -> Actor | None:
        with self.database.session_factory() as session:
            row = session.get(UserRow, str(user_id))
            credential = session.get(UserCredentialRow, str(user_id))
            if row is None or credential is None or credential.session_version != version or row.status not in {"active", "invited"}:
                return None
            return self._actor(session, row, credential)

    def invite(self, requester: Actor, data: InviteRequest) -> InviteResult:
        if not requester.is_admin:
            raise AccountError("only admins can invite people")
        temporary = secrets.token_urlsafe(24)
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            if session.execute(select(UserRow.id).where(func.lower(UserRow.email) == data.email)).scalar_one_or_none():
                raise AccountError("an account with this email already exists")
            user_id = str(uuid4())
            session.add(UserRow(
                id=user_id, email=data.email, display_name=data.display_name,
                auth_subject=f"local:{user_id}", status="invited",
                created_at=now, updated_at=now,
            ))
            session.add(OrganizationMembershipRow(
                organization_id=str(requester.organization_id), user_id=user_id,
                role=data.role, created_at=now,
            ))
            session.add(UserCredentialRow(
                user_id=user_id, password_hash=_hash_password(temporary),
                must_change_password=True, session_version=1,
                created_at=now, updated_at=now,
            ))
            return InviteResult(account=AccountPublic(
                user_id=UUID(user_id), organization_id=requester.organization_id,
                email=data.email, display_name=data.display_name,
                role=data.role, must_change_password=True,
            ), temporary_password=temporary)

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
    def _actor(session, user: UserRow, credential: UserCredentialRow) -> Actor:
        membership = session.get(OrganizationMembershipRow, (str(LEGACY_ORGANIZATION_ID), user.id))
        if membership is None:
            raise AccountError("account has no workspace membership")
        return Actor(
            user_id=UUID(user.id), organization_id=UUID(membership.organization_id),
            email=user.email, display_name=user.display_name, role=membership.role,
            must_change_password=credential.must_change_password,
            session_version=credential.session_version,
        )
