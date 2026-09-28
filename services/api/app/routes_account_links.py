"""Invitations, access resets, forgot-password and single-use account links.

Links are emailed. Only when email cannot be sent does an admin get the link back, once,
and only for an account that belongs to their workspace alone.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import quote
from uuid import UUID

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Response

from .account_access import (
    AcceptLinkRequest, AccessGrant, AccountAccessService, InspectLinkRequest, LinkPreview, PasswordResetRequest,
)
from .account_emails import EmailContent, added_to_workspace_email, invite_email, password_reset_email
from .account_tokens import LINK_TTL_MINUTES, IssuedLink, LinkError
from .accounts import AccountError, AccountPublic, AccountService, Actor, InviteOutcome, InviteRequest, InviteResult
from .adapters.resend import EmailDeliveryError, ResendAdapter
from .database import Database
from .operations import AuditService, LoginRateLimiter
from .rate_limit import SlidingWindowLimiter

logger = logging.getLogger(__name__)

PASSWORD_RESET_PATH = "/v1/auth/password-reset"
LINK_INSPECT_PATH = "/v1/auth/account-link"
LINK_ACCEPT_PATH = "/v1/auth/account-link/accept"
PUBLIC_ACCOUNT_LINK_PATHS = frozenset({PASSWORD_RESET_PATH, LINK_INSPECT_PATH, LINK_ACCEPT_PATH})

RESET_WINDOW_SECONDS = 15 * 60
RESET_EMAIL_LIMIT = 3
RESET_IP_LIMIT = 20
LINK_FAILURE_IP_LIMIT = 20
ADMIN_EMAILS_PER_WINDOW = 30
ADMIN_EMAIL_WINDOW_SECONDS = 10 * 60

RESET_REQUESTED = {
    "accepted": True,
    "message": "If an account exists for that email, we've emailed a link to set a new password. It expires in "
               f"{LINK_TTL_MINUTES} minutes.",
}
LINK_MESSAGES = {
    "expired": "This link has expired. Links work for 10 minutes; ask your admin to send a new one, or request another reset.",
    "used": "This link has already been used. Sign in with your password, or request a new link.",
    "revoked": "This link was replaced by a newer one. Use the most recent email, or ask your admin to send a new link.",
    "invalid": "This link isn't valid. Check that you copied the whole link, or ask your admin to send a new one.",
}


class AccountLinkLimiter(LoginRateLimiter):
    """Database-backed attempt buckets, shared across replicas like the sign-in limiter."""

    def __init__(self, database: Database, signing_key: str, *, scope: str, email_limit: int, ip_limit: int,
                 window_seconds: int = RESET_WINDOW_SECONDS) -> None:
        super().__init__(database, signing_key)
        self.scope = scope
        self.EMAIL_LIMIT = email_limit
        self.IP_LIMIT = ip_limit
        self.WINDOW_SECONDS = window_seconds

    def _buckets(self, email: str | None, ip: str) -> tuple[tuple[str, int], ...]:
        buckets = [(self._key(f"{self.scope}-ip", ip), self.IP_LIMIT)]
        if email:
            buckets.append((self._key(f"{self.scope}-email", email.strip().lower()), self.EMAIL_LIMIT))
        return tuple(buckets)


@dataclass(frozen=True)
class DeliveryNotes:
    sent: str
    not_sent: str
    fallback: str
    email_only: str


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def register_account_link_routes(
    app: FastAPI, *, accounts: AccountService, resend: ResendAdapter, audit: AuditService, database: Database,
    signing_key: str, sessions_enabled: bool, set_session: Callable[[Response, Actor], None], web_origin: str,
) -> None:
    access = AccountAccessService(accounts)
    app.state.account_access = access
    origin = web_origin.rstrip("/")
    reset_limiter = AccountLinkLimiter(database, signing_key, scope="reset", email_limit=RESET_EMAIL_LIMIT,
                                       ip_limit=RESET_IP_LIMIT)
    link_limiter = AccountLinkLimiter(database, signing_key, scope="account-link", email_limit=0,
                                      ip_limit=LINK_FAILURE_IP_LIMIT)
    admin_email_limiter = SlidingWindowLimiter(ADMIN_EMAILS_PER_WINDOW, ADMIN_EMAIL_WINDOW_SECONDS,
                                               "too many invitation emails; try again in a few minutes")

    def can_send() -> bool:
        return bool(resend.configuration()["can_attempt_send"])

    def link_url(link: IssuedLink) -> str:
        # A fragment never reaches servers, proxies or Referer headers; the app strips it on load.
        key = "accept" if link.purpose == "invite" else "reset"
        return f"{origin}/#{key}={link.token}"

    async def send(recipient: str, content: EmailContent, idempotency_key: str) -> bool:
        try:
            await resend.send(recipients=[recipient], subject=content.subject, html=content.html,
                              text=content.text, idempotency_key=idempotency_key)
            return True
        except EmailDeliveryError:
            logger.warning("account email could not be delivered")  # never log the link
            return False

    async def deliver(result: InviteResult, *, link: IssuedLink, content: EmailContent,
                      single_workspace: bool, notes: DeliveryNotes) -> InviteResult:
        recipient = result.account.email or ""
        if can_send() and await send(recipient, content, f"account-link-{link.token_id}"):
            return result.model_copy(update={"email_sent": True, "note": notes.sent, "link_expires_at": link.expires_at})
        if single_workspace:
            return result.model_copy(update={
                "email_sent": False, "accept_url": link_url(link), "link_expires_at": link.expires_at,
                "note": f"{notes.not_sent} {notes.fallback}",
            })
        return result.model_copy(update={"email_sent": False, "note": f"{notes.not_sent} {notes.email_only}"})

    def check_admin_email_budget(actor: Actor) -> None:
        admin_email_limiter.check(actor.organization_id)

    def invite_notes(email: str, *, resend_note: bool = False) -> DeliveryNotes:
        return DeliveryNotes(
            sent=f"{'New invitation' if resend_note else 'Invitation'} emailed to {email}. The link works once and "
                 f"expires in {LINK_TTL_MINUTES} minutes; use “Resend invite” if it lapses.",
            not_sent="The invitation email couldn't be sent." if can_send() else "Email delivery isn't configured, so no invitation was sent.",
            fallback=f"Copy this one-time link and send it to {email} privately. It works once and expires in {LINK_TTL_MINUTES} minutes.",
            email_only="This account also belongs to another workspace, so its link can only be sent by email. Try “Resend invite” once email works.",
        )

    async def notify_added(outcome: InviteOutcome, actor: Actor) -> InviteResult:
        result = outcome.result
        email = result.account.email or ""
        note = f"{email} already has a Meetings AI account, so they were added to this workspace. They sign in with their existing password."
        if not can_send():
            return result.model_copy(update={"note": note})
        content = added_to_workspace_email(
            workspace_name=outcome.workspace_name, inviter_name=actor.display_name,
            recipient_name=result.account.display_name, email=email, role=result.account.role,
            sign_in_url=f"{origin}/?invite={quote(email)}",
        )
        sent = await send(email, content, f"workspace-added-{actor.organization_id}-{result.account.user_id}")
        return result.model_copy(update={"email_sent": sent, "note": f"{note}{' We emailed them.' if sent else ' The email could not be sent.'}"})

    @app.post("/v1/workspace/invite", response_model=InviteResult, status_code=201)
    async def invite_member(payload: InviteRequest, request: Request) -> InviteResult:
        actor: Actor = request.state.actor
        check_admin_email_budget(actor)
        try:
            outcome = accounts.invite(actor, payload)
        except AccountError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if outcome.link is None:
            return await notify_added(outcome, actor)
        content = invite_email(workspace_name=outcome.workspace_name, inviter_name=actor.display_name,
                               recipient_name=outcome.result.account.display_name, email=payload.email,
                               role=payload.role, link=link_url(outcome.link))
        return await deliver(outcome.result, link=outcome.link, content=content,
                             single_workspace=outcome.single_workspace, notes=invite_notes(payload.email))

    @app.post("/v1/workspace/members/{user_id}/resend-invite", response_model=InviteResult)
    async def resend_invite(user_id: UUID, request: Request) -> InviteResult:
        actor: Actor = request.state.actor
        check_admin_email_budget(actor)
        try:
            grant = access.resend_invite(actor, user_id)
        except AccountError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        email = grant.account.email or ""
        content = invite_email(workspace_name=grant.workspace_name or "your workspace", inviter_name=actor.display_name,
                               recipient_name=grant.account.display_name, email=email, role=grant.account.role,
                               link=link_url(grant.link))
        return await deliver(InviteResult(account=grant.account), link=grant.link, content=content,
                             single_workspace=grant.single_workspace, notes=invite_notes(email, resend_note=True))

    async def reset_member_access(user_id: UUID, request: Request) -> InviteResult:
        actor: Actor = request.state.actor
        check_admin_email_budget(actor)
        try:
            grant = access.reset_access(actor, user_id, can_email=can_send())
        except AccountError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return await deliver(InviteResult(account=grant.account), link=grant.link,
                             content=_reset_content(grant, actor.display_name, link_url(grant.link)),
                             single_workspace=grant.single_workspace, notes=_reset_notes(grant, can_send()))

    app.add_api_route("/v1/workspace/members/{user_id}/reset-access", reset_member_access,
                      methods=["POST"], response_model=InviteResult)
    # Older clients call the previous path; it now issues an emailed link as well.
    app.add_api_route("/v1/workspace/members/{user_id}/temporary-password", reset_member_access,
                      methods=["POST"], response_model=InviteResult, include_in_schema=False)

    def require_sessions() -> None:
        if not sessions_enabled:
            raise HTTPException(status_code=409, detail="account login is not configured")

    def check_limit(limiter: AccountLinkLimiter, email: str | None, ip: str, message: str) -> None:
        retry_after = limiter.retry_after(email, ip)
        if retry_after:
            raise HTTPException(status_code=429, detail=message, headers={"Retry-After": str(retry_after)})

    async def email_reset_link(grant: AccessGrant) -> None:
        content = password_reset_email(recipient_name=grant.account.display_name, email=grant.account.email or "",
                                       link=link_url(grant.link), requested_by=None)
        await send(grant.account.email or "", content, f"account-link-{grant.link.token_id}")

    @app.post(PASSWORD_RESET_PATH, status_code=202)
    def request_password_reset(payload: PasswordResetRequest, request: Request,
                               background: BackgroundTasks) -> dict[str, object]:
        require_sessions()
        ip = _client_ip(request)
        try:
            check_limit(reset_limiter, payload.email, ip, "too many reset requests; try again later")
        except HTTPException:
            audit.append(None, "auth.password_reset.throttled", PASSWORD_RESET_PATH, 429)
            raise
        # Every request counts, whether or not the account exists, so the limit reveals nothing.
        reset_limiter.failed(payload.email, ip)
        grant = access.request_password_reset(payload.email) if can_send() else None
        audit.append(None, "auth.password_reset.requested", PASSWORD_RESET_PATH, 202)
        if grant is not None:
            # Sent after the response so timing does not reveal whether the account exists.
            background.add_task(email_reset_link, grant)
        return RESET_REQUESTED

    @app.post(LINK_INSPECT_PATH, response_model=LinkPreview)
    def inspect_account_link(payload: InspectLinkRequest, request: Request) -> LinkPreview:
        require_sessions()
        ip = _client_ip(request)
        check_limit(link_limiter, None, ip, "too many attempts; try again later")
        preview = access.inspect(payload.token)
        if preview.state != "valid":
            link_limiter.failed(None, ip)
        return preview

    @app.post(LINK_ACCEPT_PATH, response_model=AccountPublic)
    def accept_account_link(payload: AcceptLinkRequest, request: Request, response: Response) -> AccountPublic:
        require_sessions()
        ip = _client_ip(request)
        check_limit(link_limiter, None, ip, "too many attempts; try again later")
        try:
            accepted = access.accept(payload.token, payload.password)
        except LinkError as exc:
            link_limiter.failed(None, ip)
            audit.append(None, "auth.account_link.denied", LINK_ACCEPT_PATH, 410)
            raise HTTPException(status_code=410, detail={"reason": exc.reason, "message": LINK_MESSAGES[exc.reason]}) from exc
        except AccountError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        action = "auth.invite.accepted" if accepted.purpose == "invite" else "auth.password_reset.completed"
        audit.append(accepted.actor, action, LINK_ACCEPT_PATH, 200, accepted.actor.user_id)
        set_session(response, accepted.actor)
        return accounts.public(accepted.actor)


def _reset_content(grant: AccessGrant, admin_name: str, link: str) -> EmailContent:
    return password_reset_email(recipient_name=grant.account.display_name, email=grant.account.email or "",
                                link=link, requested_by=admin_name)


def _reset_notes(grant: AccessGrant, email_configured: bool) -> DeliveryNotes:
    name = grant.account.display_name
    return DeliveryNotes(
        sent=f"{name}'s old password and sessions no longer work. We emailed them a link to set a new one; "
             f"it expires in {LINK_TTL_MINUTES} minutes.",
        not_sent=f"{name}'s old password and sessions no longer work, but "
                 + ("the email couldn't be sent." if email_configured else "email delivery isn't configured."),
        fallback=f"Copy this one-time link and send it to them privately. It works once and expires in {LINK_TTL_MINUTES} minutes.",
        email_only="Their account belongs to other workspaces too, so they should use “Forgot password?” on the sign-in page.",
    )

