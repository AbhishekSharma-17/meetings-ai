"""Signed local account sessions; external identity remains separate work."""

import hmac
import secrets
import time
from hashlib import sha256
from uuid import UUID

from .database import LEGACY_ORGANIZATION_ID


class AdminSession:
    def __init__(self, secret: str) -> None:
        self.secret = secret.encode()

    def issue(self, user_id: UUID, organization_id: UUID, session_version: int) -> str:
        expires = str(int(time.time()) + 12 * 60 * 60)
        nonce = secrets.token_hex(16)
        payload = f"{expires}.{user_id}.{organization_id}.{session_version}.{nonce}"
        signature = hmac.new(self.secret, payload.encode(), sha256).hexdigest()
        return f"{payload}.{signature}"

    def decode(self, token: str | None) -> tuple[UUID, UUID, int] | None:
        if not token:
            return None
        try:
            parts = token.split(".")
            if len(parts) == 6:
                expires, user_id, organization_id, version, nonce, signature = parts
                payload = f"{expires}.{user_id}.{organization_id}.{version}.{nonce}"
            elif len(parts) == 5:
                # Local sessions issued before workspace switching remain valid
                # for the original organization until they naturally expire.
                expires, user_id, version, nonce, signature = parts
                organization_id = str(LEGACY_ORGANIZATION_ID)
                payload = f"{expires}.{user_id}.{version}.{nonce}"
            else:
                return None
            if int(expires) <= time.time() or len(nonce) != 32:
                return None
            expected = hmac.new(self.secret, payload.encode(), sha256).hexdigest()
            if not hmac.compare_digest(signature, expected):
                return None
            return UUID(user_id), UUID(organization_id), int(version)
        except (ValueError, TypeError):
            return None
