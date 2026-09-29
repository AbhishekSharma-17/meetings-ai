"""Link-based account access: resend invites, reset access, forgot password, and accepting links."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from pydantic import BaseModel, Field
from sqlalchemy import func, select

from .account_tokens import (
    MAX_TOKEN_LENGTH, IssuedLink, LinkError, LinkState, consume_link, find_link, issue_link, link_state,
    revoke_links, unusable_password_hash,
)
from .accounts import (
    PASSWORD_MAX, PASSWORD_MIN, AccountError, AccountPublic, AccountService, Actor, InviteRequest, _hash_password,
)
from .database import (
    LEGACY_ADMIN_USER_ID, OrganizationMembershipRow, OrganizationRow, UserCredentialRow, UserRow,
)
from .workspace_preferences import record_last_organization



class AcceptLinkRequest(BaseModel):
    token: str = Field(min_length=1, max_length=MAX_TOKEN_LENGTH)
    password: str = Field(min_length=PASSWORD_MIN, max_length=PASSWORD_MAX)


class InspectLinkRequest(BaseModel):
    token: str = Field(min_length=1, max_length=MAX_TOKEN_LENGTH)


class PasswordResetRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class LinkPreview(BaseModel):
    """What the accept screen shows. Details are only filled in for a usable link."""

    state: LinkState
    purpose: str | None = None
    email: str | None = None
    display_name: str | None = None
    workspace_name: str | None = None
    expires_at: datetime | None = None


@dataclass(frozen=True)
class AccessGrant:
    """A link issued for someone, plus what the caller needs to email it."""

    account: AccountPublic
    link: IssuedLink
    workspace_name: str | None
    single_workspace: bool


@dataclass(frozen=True)
class AcceptedLink:
    actor: Actor
    purpose: str


class AccountAccessService:
    def __init__(self, accounts: AccountService) -> None:
        self.accounts = accounts
        self.database = accounts.database

    def resend_invite(self, requester: Actor, user_id: UUID) -> AccessGrant:
        with self.database.session_factory.begin() as session:
            user, membership, _ = self._managed_target(session, requester, user_id)
            if user.status != "invited":
                raise AccountError("this person has already accepted their invitation")
            link = issue_link(session, purpose="invite", user_id=user.id,
                              organization_id=str(requester.organization_id), created_by=str(requester.user_id))
            return self._grant(session, requester, user, membership, link)

    def reset_access(self, requester: Actor, user_id: UUID, *, can_email: bool) -> AccessGrant:
        """Disable the member's password and sessions now; they set a new one from the link."""
        if user_id == LEGACY_ADMIN_USER_ID:
            raise AccountError("the owner password cannot be reset here")
        with self.database.session_factory.begin() as session:
            user, membership, credential = self._managed_target(session, requester, user_id)
            single = AccountService.membership_count(session, user.id) == 1
            if not can_email and not single:
                # Without email the link would be handed to this admin, who must not be able
                # to take over an account that also belongs to other workspaces.
                raise AccountError("email delivery isn't configured, and this account belongs to other "
                                   "workspaces too, so access can only be reset by email")
            now = datetime.now(UTC)
            credential.password_hash = unusable_password_hash()
            credential.must_change_password = False
            credential.session_version += 1
            credential.updated_at = now
            user.updated_at = now
            link = issue_link(session, purpose="password_reset", user_id=user.id,
                              organization_id=str(requester.organization_id),
                              created_by=str(requester.user_id), now=now)
            return self._grant(session, requester, user, membership, link)

    def request_password_reset(self, email: str) -> AccessGrant | None:
        """Self-service reset. Returns None when there is nobody to email; callers must not reveal which."""
        try:
            clean_email = InviteRequest.clean_email(email)
        except ValueError:
            return None
        with self.database.session_factory.begin() as session:
            user = session.execute(select(UserRow).where(func.lower(UserRow.email) == clean_email)).scalar_one_or_none()
            if user is None or user.status not in {"active", "invited"}:
                return None
            credential = session.get(UserCredentialRow, user.id)
            if credential is None:
                return None
            try:
                actor = AccountService._actor(session, user, credential)
            except AccountError:
                return None  # no active workspace to land in
            # The current password keeps working until the link is used: a stranger
            # requesting a reset must not be able to lock anyone out.
            link = issue_link(session, purpose="password_reset", user_id=user.id, organization_id=None, created_by=None)
            return AccessGrant(account=AccountService.public(actor), link=link, workspace_name=None,
                               single_workspace=AccountService.membership_count(session, user.id) == 1)

    def inspect(self, token: str) -> LinkPreview:
        now = datetime.now(UTC)
        with self.database.session_factory() as session:
            row = find_link(session, token)
            state = link_state(row, now)
            if row is None or state != "valid":
                return LinkPreview(state=state, purpose=row.purpose if row else None)
            user = session.get(UserRow, row.user_id)
            if user is None or user.status not in {"active", "invited"} or not self._link_target_exists(session, row.purpose, row.organization_id, user.id):
                return LinkPreview(state="invalid")
            workspace = session.get(OrganizationRow, row.organization_id) if row.organization_id else None
            return LinkPreview(state="valid", purpose=row.purpose, email=user.email, display_name=user.display_name,
                               workspace_name=workspace.display_name if workspace else None, expires_at=row.expires_at)

    def accept(self, token: str, password: str) -> AcceptedLink:
        if not PASSWORD_MIN <= len(password) <= PASSWORD_MAX:
            raise AccountError(f"password must be {PASSWORD_MIN}–{PASSWORD_MAX} characters")
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            row = consume_link(session, token, now)
            user = session.get(UserRow, row.user_id)
            credential = session.get(UserCredentialRow, row.user_id)
            if user is None or credential is None or user.status not in {"active", "invited"}:
                raise LinkError("invalid")
            if not self._link_target_exists(session, row.purpose, row.organization_id, user.id):
                raise LinkError("invalid")
            credential.password_hash = _hash_password(password)
            credential.must_change_password = False
            credential.session_version += 1
            credential.updated_at = now
            user.status = "active"
            user.updated_at = now
            # A password now exists, so any other outstanding link for this person is stale.
            revoke_links(session, user_id=user.id, now=now)
            actor = self._landing(session, user, credential, row.purpose, row.organization_id)
            record_last_organization(session, user.id, str(actor.organization_id))
            return AcceptedLink(actor=actor, purpose=row.purpose)

    def _landing(self, session, user: UserRow, credential: UserCredentialRow, purpose: str,
                 organization_id: str | None) -> Actor:
        try:
            if purpose == "invite" and organization_id:
                return AccountService._actor(session, user, credential, UUID(organization_id))
            return self.accounts._landing_actor(session, user, credential)
        except AccountError as exc:
            raise LinkError("invalid") from exc

    @staticmethod
    def _link_target_exists(session, purpose: str, organization_id: str | None, user_id: str) -> bool:
        """An invite is void once its membership is gone (removed or workspace archived)."""
        if purpose != "invite":
            return True
        if not organization_id:
            return False
        membership = session.get(OrganizationMembershipRow, (organization_id, user_id))
        workspace = session.get(OrganizationRow, organization_id)
        return membership is not None and workspace is not None and workspace.status == "active"

    @staticmethod
    def _managed_target(session, requester: Actor, user_id: UUID) -> tuple[UserRow, OrganizationMembershipRow, UserCredentialRow]:
        """Admins manage members and viewers; only owners manage admins. Nobody targets themselves here."""
        if not requester.is_admin:
            raise AccountError("only admins can manage people")
        if requester.user_id == user_id:
            raise AccountError("use your profile to change your own password")
        membership = session.get(OrganizationMembershipRow, (str(requester.organization_id), str(user_id)))
        user = session.get(UserRow, str(user_id))
        credential = session.get(UserCredentialRow, str(user_id))
        if membership is None or user is None or credential is None:
            raise AccountError("member not found")
        if membership.role == "owner" or (membership.role == "admin" and requester.role != "owner"):
            raise AccountError("you can't manage this member's access")
        return user, membership, credential

    @staticmethod
    def _grant(session, requester: Actor, user: UserRow, membership: OrganizationMembershipRow, link: IssuedLink) -> AccessGrant:
        workspace = session.get(OrganizationRow, str(requester.organization_id))
        return AccessGrant(
            account=AccountPublic(user_id=UUID(user.id), organization_id=requester.organization_id, email=user.email,
                                  display_name=user.display_name, role=membership.role, must_change_password=False),
            link=link, workspace_name=workspace.display_name if workspace else None,
            single_workspace=AccountService.membership_count(session, user.id) == 1,
        )
