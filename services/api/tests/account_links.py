"""Test helpers for link-based invitations and resets (no real email is ever sent)."""

from __future__ import annotations

import re

from fastapi.testclient import TestClient

from app.account_access import AccountAccessService
from app.accounts import AccountService, Actor, InviteOutcome
from app.adapters.resend import EmailDeliveryError

ACCEPT_PATH = "/v1/auth/account-link/accept"
_LINK = re.compile(r"#(?:accept|reset)=([A-Za-z0-9_-]+)")


class FakeResend:
    """Stands in for the Resend adapter; records messages instead of sending them."""

    def __init__(self, *, configured: bool = True, fail: bool = False) -> None:
        self.configured = configured
        self.fail = fail
        self.sent: list[dict[str, object]] = []

    def configuration(self) -> dict[str, object]:
        return {
            "api_key_configured": self.configured, "sender_configured": self.configured,
            "sender": "Meetings AI <meetings@example.test>" if self.configured else None,
            "can_attempt_send": self.configured, "domain_verification": "not_checked",
        }

    async def send(self, **message: object) -> str:
        if not self.configured or self.fail:
            raise EmailDeliveryError("Resend is unavailable")
        self.sent.append(message)
        return f"email_{len(self.sent)}"


def token_from(text: str | None) -> str:
    match = _LINK.search(text or "")
    assert match, "no account link found"
    return match.group(1)


def accept_invite(client: TestClient, invited: dict, password: str) -> dict:
    """Accept the one-time link an invite response carries when email is not configured."""
    response = client.post(ACCEPT_PATH, json={"token": token_from(invited["accept_url"]), "password": password})
    assert response.status_code == 200, response.text
    return response.json()


def activate(accounts: AccountService, outcome: InviteOutcome, password: str) -> Actor:
    """Service-level equivalent of accepting an invitation link."""
    assert outcome.link is not None
    return AccountAccessService(accounts).accept(outcome.link.token, password).actor
