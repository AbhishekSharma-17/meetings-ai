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
from sqlalchemy import delete, func, select, update

from .account_tokens import IssuedLink, has_usable_password, issue_link, revoke_links, unusable_password_hash
from .database import (
    Database, KnowledgeBaseAccessRow, KnowledgeBaseRow, LEGACY_ADMIN_USER_ID, LEGACY_ORGANIZATION_ID,
    MeetingShareRow, OrganizationMembershipRow, OrganizationRow, UserCredentialRow, UserRow, VoiceSampleRow,
)
from .workspace_preferences import (
    default_organization_id, forget_organization, preferred_organization_id, record_last_organization,
    set_default_organization,
)



# Account password length rules (product decision: 6 is the minimum). Shared by every flow.
PASSWORD_MIN = 6
PASSWORD_MAX = 200

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
    photo_url: str | None = None


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
    """Result of an invite, resend, or access reset.

    ``temporary_password`` is kept for older clients and is always null: people set their own
    password from a single-use link. ``accept_url`` carries that link only when it could not be
    emailed; it is a credential, shown to the admin once and never stored in plain text.
    """

    account: AccountPublic
    temporary_password: str | None = None
    note: str = ""
    email_sent: bool = False
    accept_url: str | None = None
    link_expires_at: datetime | None = None


@dataclass(frozen=True)
class InviteOutcome:
    result: InviteResult
    workspace_name: str
    # Set when the person has no password yet and must accept through a link.
    link: IssuedLink | None
    # Copy-link fallback is only safe when this workspace is the account's only one.
    single_workspace: bool


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=PASSWORD_MIN, max_length=PASSWORD_MAX)


class ProfilePatch(BaseModel):
    display_name: str = Field(min_length=2, max_length=120)

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, value: str) -> str:
        return InviteRequest.clean_name(value)


class MemberRolePatch(BaseModel):
    role: str

    @field_validator("role")
    @classmethod
    def allowed_role(cls, value: str) -> str:
        if value not in {"owner", "admin", "member", "viewer"}:
            raise ValueError("role must be owner, admin, member, or viewer")
        return value


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
    is_default: bool = False


class DefaultWorkspaceRequest(BaseModel):
    """Set the workspace a new sign-in opens in; null means "use the last active workspace"."""

    organization_id: UUID | None = None


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
        self.notifications = None

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
        with self.database.session_factory.begin() as session:
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
            actor = self._landing_actor(session, row, credential)
            record_last_organization(session, row.id, str(actor.organization_id))
            return actor

    def _landing_actor(self, session, row: UserRow, credential: UserCredentialRow) -> Actor:
        """Default workspace, else last active, else the oldest membership."""
        preferred = preferred_organization_id(session, row.id)
        if preferred is not None:
            try:
                return self._actor(session, row, credential, UUID(preferred))
            except AccountError:
                pass  # membership vanished since the check; fall back below
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
            default_id = default_organization_id(session, str(actor.user_id))
            return [OrganizationOption(id=UUID(org.id), slug=org.slug,
                                       display_name=org.display_name, role=membership.role,
                                       is_default=org.id == default_id)
                    for membership, org in rows]

    def set_default_organization(self, actor: Actor, organization_id: UUID | None) -> list[OrganizationOption]:
        with self.database.session_factory.begin() as session:
            if organization_id is not None:
                membership = session.execute(select(OrganizationMembershipRow)
                    .join(OrganizationRow, OrganizationRow.id == OrganizationMembershipRow.organization_id)
                    .where(OrganizationMembershipRow.user_id == str(actor.user_id),
                           OrganizationMembershipRow.organization_id == str(organization_id),
                           OrganizationRow.status == "active")).scalar_one_or_none()
                if membership is None:
                    raise AccountError("workspace not found")
            set_default_organization(session, str(actor.user_id), str(organization_id) if organization_id else None)
        return self.list_organizations(actor)

    def select_organization(self, actor: Actor, organization_id: UUID) -> Actor:
        with self.database.session_factory.begin() as session:
            user = session.get(UserRow, str(actor.user_id))
            credential = session.get(UserCredentialRow, str(actor.user_id))
            if user is None or credential is None:
                raise AccountError("account not found")
            selected = self._actor(session, user, credential, organization_id)
            record_last_organization(session, user.id, str(selected.organization_id))
            return selected

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
            # Without an ORM relationship SQLAlchemy may flush the membership
            # first. PostgreSQL enforces the FK immediately, so persist the
            # parent row before adding its first member.
            session.flush()
            session.add(OrganizationMembershipRow(
                organization_id=str(organization_id), user_id=str(actor.user_id),
                role="owner", created_at=now,
            ))
        return self.select_organization(actor, organization_id)

    def invite(self, requester: Actor, data: InviteRequest) -> InviteOutcome:
        if not requester.is_admin:
            raise AccountError("only admins can invite people")
        if data.role == "admin" and requester.role != "owner":
            raise AccountError("only an owner can assign an admin role")
        now = datetime.now(UTC)
        organization_id = str(requester.organization_id)
        with self.database.session_factory.begin() as session:
            existing = session.execute(select(UserRow).where(func.lower(UserRow.email) == data.email)).scalar_one_or_none()
            if existing:
                user_id, display_name, needs_link = self._existing_invitee(session, existing, organization_id)
            else:
                user_id, display_name, needs_link = self._create_invitee(session, data, now), data.display_name, True
            session.add(OrganizationMembershipRow(
                organization_id=organization_id, user_id=user_id, role=data.role, created_at=now,
            ))
            session.flush()  # autoflush is off; membership_count below must see this row
            link = issue_link(session, purpose="invite", user_id=user_id, organization_id=organization_id,
                              created_by=str(requester.user_id), now=now) if needs_link else None
            workspace = session.get(OrganizationRow, organization_id)
            if self.notifications is not None:
                self.notifications.access_notice(
                    session, organization_id, user_ids=[user_id], kind="member.access_added",
                    title=f"Welcome to {workspace.display_name if workspace else 'your workspace'}",
                    body=f"{requester.display_name} invited you as {data.role}.",
                    send_email=False,  # The invitation endpoint sends the secure acceptance email.
                )
            result = InviteResult(account=AccountPublic(
                user_id=UUID(user_id), organization_id=requester.organization_id,
                email=data.email, display_name=display_name, role=data.role, must_change_password=False,
            ), link_expires_at=link.expires_at if link else None)
            return InviteOutcome(result=result, workspace_name=workspace.display_name if workspace else "your workspace",
                                 link=link, single_workspace=self.membership_count(session, user_id) == 1)

    @staticmethod
    def _existing_invitee(session, existing: UserRow, organization_id: str) -> tuple[str, str, bool]:
        if existing.status not in {"active", "invited"}:
            raise AccountError("this account is not active")
        if session.get(OrganizationMembershipRow, (organization_id, existing.id)):
            raise AccountError("this account already belongs to this workspace")
        credential = session.get(UserCredentialRow, existing.id)
        if credential is None:
            raise AccountError("this account has no local sign-in method")
        # Someone still pending elsewhere has no password yet, so they need an accept link too.
        return existing.id, existing.display_name, not has_usable_password(credential.password_hash)

    @staticmethod
    def _create_invitee(session, data: InviteRequest, now: datetime) -> str:
        user_id = str(uuid4())
        session.add(UserRow(
            id=user_id, email=data.email, display_name=data.display_name,
            auth_subject=f"local:{user_id}", status="invited", created_at=now, updated_at=now,
        ))
        # The credential and membership both reference users.id. With no ORM
        # relationships SQLAlchemy may flush the membership first; PostgreSQL
        # rejects that immediate foreign key.
        session.flush()
        # No usable password until the invite is accepted through its link.
        session.add(UserCredentialRow(
            user_id=user_id, password_hash=unusable_password_hash(),
            must_change_password=False, session_version=1, created_at=now, updated_at=now,
        ))
        return user_id

    @staticmethod
    def membership_count(session, user_id: str) -> int:
        return session.execute(select(func.count()).select_from(OrganizationMembershipRow).where(
            OrganizationMembershipRow.user_id == user_id
        )).scalar_one()

    def change_password(self, actor: Actor, current: str, new: str) -> Actor:
        if not PASSWORD_MIN <= len(new) <= PASSWORD_MAX:
            raise AccountError(f"new password must be {PASSWORD_MIN}–{PASSWORD_MAX} characters")
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
            return self._actor(session, user, credential, actor.organization_id)

    def update_profile(self, actor: Actor, patch: ProfilePatch) -> Actor:
        with self.database.session_factory.begin() as session:
            user = session.get(UserRow, str(actor.user_id))
            credential = session.get(UserCredentialRow, str(actor.user_id))
            if user is None or credential is None:
                raise AccountError("account not found")
            user.display_name = patch.display_name
            user.updated_at = datetime.now(UTC)
            return self._actor(session, user, credential, actor.organization_id)

    def change_member_role(self, requester: Actor, user_id: UUID, data: MemberRolePatch) -> AccountPublic:
        with self.database.session_factory.begin() as session:
            membership = self._managed_membership(session, requester, user_id)
            if data.role in {"owner", "admin"} and requester.role != "owner":
                raise AccountError("only an owner can assign an admin or owner role")
            if membership.role == "owner" and data.role != "owner":
                self._require_another_owner(session, requester.organization_id)
            previous_role = membership.role
            membership.role = data.role
            user = session.get(UserRow, str(user_id))
            credential = session.get(UserCredentialRow, str(user_id))
            if user is None or credential is None:
                raise AccountError("member account is unavailable")
            if self.notifications is not None and previous_role != data.role:
                self.notifications.access_notice(
                    session, str(requester.organization_id), user_ids=[str(user_id)],
                    kind="member.role_changed", title="Your workspace role changed",
                    body=f"{requester.display_name} changed your role from {previous_role} to {data.role}.",
                )
            return self.public(self._actor(session, user, credential, requester.organization_id))

    def remove_member(self, requester: Actor, user_id: UUID) -> None:
        with self.database.session_factory.begin() as session:
            membership = self._managed_membership(session, requester, user_id)
            if membership.role == "owner":
                self._require_another_owner(session, requester.organization_id)
            session.execute(delete(KnowledgeBaseAccessRow).where(
                KnowledgeBaseAccessRow.user_id == str(user_id),
                KnowledgeBaseAccessRow.knowledge_base_id.in_(
                    select(KnowledgeBaseRow.id).where(KnowledgeBaseRow.organization_id == str(requester.organization_id))
                ),
            ))
            forget_organization(session, str(user_id), str(requester.organization_id))
            now = datetime.now(UTC)
            revoke_links(session, user_id=str(user_id), organization_id=str(requester.organization_id), now=now)
            # Meetings shared with them stop being shared (re-inviting them later grants nothing back).
            session.execute(update(MeetingShareRow).where(
                MeetingShareRow.organization_id == str(requester.organization_id),
                MeetingShareRow.user_id == str(user_id), MeetingShareRow.revoked_at.is_(None),
            ).values(revoked_at=now, revoked_by=str(requester.user_id)))
            # Their voice sample belonged to this workspace only; it goes with the membership.
            session.execute(delete(VoiceSampleRow).where(
                VoiceSampleRow.organization_id == str(requester.organization_id), VoiceSampleRow.user_id == str(user_id)))
            session.delete(membership)

    @staticmethod
    def _managed_membership(session, requester: Actor, user_id: UUID) -> OrganizationMembershipRow:
        if not requester.is_admin:
            raise AccountError("only admins can manage people")
        if requester.user_id == user_id:
            raise AccountError("you cannot change your own membership")
        session.execute(select(OrganizationRow).where(
            OrganizationRow.id == str(requester.organization_id)
        ).with_for_update()).scalar_one()
        membership = session.get(OrganizationMembershipRow, (str(requester.organization_id), str(user_id)))
        if membership is None:
            raise AccountError("member not found")
        if membership.role in {"owner", "admin"} and requester.role != "owner":
            raise AccountError("only an owner can manage admins and owners")
        return membership

    @staticmethod
    def _require_another_owner(session, organization_id: UUID) -> None:
        owners = session.execute(select(func.count()).select_from(OrganizationMembershipRow).where(
            OrganizationMembershipRow.organization_id == str(organization_id),
            OrganizationMembershipRow.role == "owner",
        )).scalar_one()
        if owners <= 1:
            raise AccountError("a workspace must retain at least one owner")

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
