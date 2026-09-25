"""Small single-admin gate for internal MVP use, not a multi-tenant identity system."""

import hmac
import secrets
import time
from hashlib import sha256
from uuid import UUID


class AdminSession:
    def __init__(self, secret: str) -> None:
        self.secret = secret.encode()

    def issue(self, user_id: UUID, session_version: int) -> str:
        expires = str(int(time.time()) + 12 * 60 * 60)
        nonce = secrets.token_hex(16)
        payload = f"{expires}.{user_id}.{session_version}.{nonce}"
        signature = hmac.new(self.secret, payload.encode(), sha256).hexdigest()
        return f"{payload}.{signature}"

    def decode(self, token: str | None) -> tuple[UUID, int] | None:
        if not token:
            return None
        try:
            expires, user_id, version, nonce, signature = token.split(".")
            if int(expires) <= time.time() or len(nonce) != 32:
                return None
            payload = f"{expires}.{user_id}.{version}.{nonce}"
            expected = hmac.new(self.secret, payload.encode(), sha256).hexdigest()
            if not hmac.compare_digest(signature, expected):
                return None
            return UUID(user_id), int(version)
        except (ValueError, TypeError):
            return None
