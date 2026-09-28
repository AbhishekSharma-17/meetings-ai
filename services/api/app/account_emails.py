"""Invitation and password emails. Every interpolated value is HTML-escaped."""

from __future__ import annotations

from dataclasses import dataclass
from html import escape

from .account_tokens import LINK_TTL_MINUTES

_ROLE_ARTICLE = {"admin": "an admin", "member": "a member", "viewer": "a viewer", "owner": "an owner"}


@dataclass(frozen=True)
class EmailContent:
    subject: str
    html: str
    text: str


def _role_phrase(role: str) -> str:
    return _ROLE_ARTICLE.get(role, f"a {role}")


def _layout(*, heading: str, paragraphs: list[str], button_text: str, button_url: str, footnote: str) -> str:
    """Paragraphs are pre-escaped HTML fragments; everything else is escaped here."""
    body = "".join(f'<p style="margin:0 0 14px;line-height:1.5">{paragraph}</p>' for paragraph in paragraphs)
    return (
        '<html><body style="background:#f4f7f6;padding:32px;font-family:Arial,sans-serif;color:#183331">'
        '<div style="max-width:540px;margin:auto;background:white;border:1px solid #dce7e3;border-radius:12px;padding:32px">'
        '<div style="font-size:15px;font-weight:bold;color:#13766d">&#9635; Meetings AI</div>'
        f'<h1 style="font-size:24px;margin:28px 0 12px">{escape(heading)}</h1>'
        f"{body}"
        f'<p style="margin:22px 0"><a href="{escape(button_url, quote=True)}" '
        'style="display:inline-block;background:#13766d;color:white;padding:12px 20px;border-radius:7px;'
        f'text-decoration:none;font-weight:bold">{escape(button_text)}</a></p>'
        f'<p style="font-size:12px;color:#687c77;margin-top:32px;line-height:1.5">{escape(footnote)}</p>'
        "</div></body></html>"
    )


def invite_email(*, workspace_name: str, inviter_name: str, recipient_name: str, email: str,
                 role: str, link: str) -> EmailContent:
    minutes = LINK_TTL_MINUTES
    html = _layout(
        heading=f"Join {workspace_name}",
        paragraphs=[
            f"Hi {escape(recipient_name)},",
            f"<b>{escape(inviter_name)}</b> invited you to <b>{escape(workspace_name)}</b> on Meetings AI as {escape(_role_phrase(role))}.",
            f"<b>Sign-in email</b><br>{escape(email)}",
            f"Accept the invitation to choose your password. This link works once and expires in {minutes} minutes.",
        ],
        button_text="Accept invite", button_url=link,
        footnote=f"If the link has expired, ask {inviter_name} to send a new invitation. "
                 "Don't forward this email: the link signs you in.",
    )
    text = (
        f"Hi {recipient_name},\n\n"
        f"{inviter_name} invited you to {workspace_name} on Meetings AI as {_role_phrase(role)}.\n\n"
        f"Sign-in email: {email}\n\n"
        f"Accept invite: {link}\n\n"
        f"The link works once and expires in {minutes} minutes. If it has expired, ask {inviter_name} to send a new invitation.\n"
        "Don't forward this email: the link signs you in.\n"
    )
    return EmailContent(subject=f"{inviter_name} invited you to {workspace_name} on Meetings AI", html=html, text=text)


def added_to_workspace_email(*, workspace_name: str, inviter_name: str, recipient_name: str, email: str,
                             role: str, sign_in_url: str) -> EmailContent:
    html = _layout(
        heading=f"You now have access to {workspace_name}",
        paragraphs=[
            f"Hi {escape(recipient_name)},",
            f"<b>{escape(inviter_name)}</b> added you to <b>{escape(workspace_name)}</b> on Meetings AI as {escape(_role_phrase(role))}.",
            f"Sign in with <b>{escape(email)}</b> and your existing password, then switch to {escape(workspace_name)} from your account menu.",
        ],
        button_text="Open Meetings AI", button_url=sign_in_url,
        footnote="You didn't need a new password. If you've forgotten yours, use \"Forgot password?\" on the sign-in page.",
    )
    text = (
        f"Hi {recipient_name},\n\n"
        f"{inviter_name} added you to {workspace_name} on Meetings AI as {_role_phrase(role)}.\n\n"
        f"Sign in with {email} and your existing password: {sign_in_url}\n"
        f"Then switch to {workspace_name} from your account menu.\n"
    )
    return EmailContent(subject=f"You've been added to {workspace_name} on Meetings AI", html=html, text=text)


def password_reset_email(*, recipient_name: str, email: str, link: str, requested_by: str | None) -> EmailContent:
    """``requested_by`` names the admin who reset access; None for a self-service request."""
    minutes = LINK_TTL_MINUTES
    reason = (
        f"<b>{escape(requested_by)}</b> reset your Meetings AI sign-in. Your old password no longer works."
        if requested_by else
        "We received a request to reset the password for your Meetings AI account."
    )
    reason_text = (
        f"{requested_by} reset your Meetings AI sign-in. Your old password no longer works."
        if requested_by else
        "We received a request to reset the password for your Meetings AI account."
    )
    ignore = (
        "Contact your workspace admin if you didn't expect this."
        if requested_by else
        "If you didn't ask for this, you can ignore this email; your password stays the same."
    )
    html = _layout(
        heading="Set a new password",
        paragraphs=[
            f"Hi {escape(recipient_name)},",
            reason,
            f"<b>Sign-in email</b><br>{escape(email)}",
            f"Choose a new password with the button below. This link works once and expires in {minutes} minutes.",
        ],
        button_text="Set a new password", button_url=link,
        footnote=f"{ignore} Don't forward this email: the link signs you in.",
    )
    text = (
        f"Hi {recipient_name},\n\n{reason_text}\n\nSign-in email: {email}\n\n"
        f"Set a new password: {link}\n\n"
        f"The link works once and expires in {minutes} minutes.\n{ignore}\n"
        "Don't forward this email: the link signs you in.\n"
    )
    return EmailContent(subject="Set a new password for Meetings AI", html=html, text=text)
