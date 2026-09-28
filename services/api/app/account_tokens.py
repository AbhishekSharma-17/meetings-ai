"""Single-use, ten-minute account links for invite acceptance and password resets.

Only a SHA-256 of each token is stored. The raw token exists in the emailed link (or,
when email cannot be sent, in one admin response) and is never logged.
"""

from __future__ import annotations

import hmac
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Literal
from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .database import AccountTokenRow

LINK_TTL_MINUTES = 10
LINK_TTL = timedelta(minutes=LINK_TTL_MINUTES)
TOKEN_BYTES = 32
# token_urlsafe(32) is 43 characters; anything far longer is not one of ours.
MAX_TOKEN_LENGTH = 128
# Never a valid scrypt encoding, so no password can ever match it.
UNUSABLE_PASSWORD_PREFIX = "!unusable:"

LinkPurpose = Literal["invite", "password_reset"]
LinkState = Literal["valid", "expired", "used", "revoked", "invalid"]


class LinkError(ValueError):
    """An account link that cannot be used; ``reason`` is safe to show its holder."""

    def __init__(self, reason: LinkState) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class IssuedLink:
    token_id: str
    purpose: str
    expires_at: datetime
    # The raw credential. Kept out of repr so it never lands in logs or tracebacks.
    token: str = field(repr=False)


def hash_token(token: str) -> str:
    return sha256(token.encode()).hexdigest()


def unusable_password_hash() -> str:
    return f"{UNUSABLE_PASSWORD_PREFIX}{secrets.token_hex(16)}"


def has_usable_password(encoded: str) -> bool:
    return not encoded.startswith(UNUSABLE_PASSWORD_PREFIX)


def as_utc(value: datetime) -> datetime:
    """SQLite returns naive datetimes; every stored timestamp is UTC."""
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def revoke_links(session: Session, *, user_id: str, now: datetime,
                 purpose: str | None = None, organization_id: str | None = None) -> None:
    statement = update(AccountTokenRow).where(
        AccountTokenRow.user_id == user_id,
        AccountTokenRow.used_at.is_(None),
        AccountTokenRow.revoked_at.is_(None),
    )
    if purpose is not None:
        statement = statement.where(AccountTokenRow.purpose == purpose)
    if organization_id is not None:
        statement = statement.where(AccountTokenRow.organization_id == organization_id)
    session.execute(statement.values(revoked_at=now).execution_options(synchronize_session=False))


def issue_link(session: Session, *, purpose: LinkPurpose, user_id: str, organization_id: str | None,
               created_by: str | None, now: datetime | None = None) -> IssuedLink:
    """Create a fresh link and revoke older unused links for the same person and purpose.

    Invite links are revoked only within the issuing workspace: one workspace's admin must
    never invalidate another workspace's pending invitation. Reset links are per person.
    """
    issued_at = now or datetime.now(UTC)
    revoke_links(session, user_id=user_id, purpose=purpose, now=issued_at,
                 organization_id=organization_id if purpose == "invite" else None)
    token = secrets.token_urlsafe(TOKEN_BYTES)
    row = AccountTokenRow(
        id=str(uuid4()), token_hash=hash_token(token), purpose=purpose, user_id=user_id,
        organization_id=organization_id, created_by=created_by, created_at=issued_at,
        expires_at=issued_at + LINK_TTL, used_at=None, revoked_at=None,
    )
    session.add(row)
    return IssuedLink(token_id=row.id, purpose=purpose, expires_at=row.expires_at, token=token)


def find_link(session: Session, token: str | None) -> AccountTokenRow | None:
    if not token or len(token) > MAX_TOKEN_LENGTH:
        return None
    digest = hash_token(token)
    # Looking up by the SHA-256 of a 256-bit secret is safe: index timing can only reveal
    # prefixes of a hash, never of the token. compare_digest re-checks the match in constant
    # time as defence in depth (for example against a case-insensitive collation).
    row = session.execute(select(AccountTokenRow).where(AccountTokenRow.token_hash == digest)).scalar_one_or_none()
    if row is None or not hmac.compare_digest(row.token_hash, digest):
        return None
    return row


def link_state(row: AccountTokenRow | None, now: datetime) -> LinkState:
    if row is None:
        return "invalid"
    if row.used_at is not None:
        return "used"
    if row.revoked_at is not None:
        return "revoked"
    if as_utc(row.expires_at) <= now:
        return "expired"
    return "valid"


def consume_link(session: Session, token: str, now: datetime) -> AccountTokenRow:
    """Mark a link used exactly once; concurrent attempts lose the conditional update."""
    row = find_link(session, token)
    state = link_state(row, now)
    if row is None or state != "valid":
        raise LinkError(state)
    claimed = session.execute(update(AccountTokenRow).where(
        AccountTokenRow.id == row.id,
        AccountTokenRow.used_at.is_(None),
        AccountTokenRow.revoked_at.is_(None),
        AccountTokenRow.expires_at > now,
    ).values(used_at=now).execution_options(synchronize_session=False))
    if claimed.rowcount != 1:
        raise LinkError("used")
    return row
