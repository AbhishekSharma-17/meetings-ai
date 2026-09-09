"""Encryption boundary for provider credentials at rest."""

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken


class CredentialDecryptionError(RuntimeError):
    pass


class CredentialCipher:
    def __init__(self, server_key: str) -> None:
        if not server_key.strip():
            raise ValueError("PROVIDER_CREDENTIAL_KEY must not be empty")
        derived_key = base64.urlsafe_b64encode(hashlib.sha256(server_key.encode()).digest())
        self._fernet = Fernet(derived_key)

    def encrypt(self, plaintext: str | None) -> str | None:
        if plaintext is None:
            return None
        return self._fernet.encrypt(plaintext.encode()).decode()

    def decrypt(self, ciphertext: str | None) -> str | None:
        if ciphertext is None:
            return None
        try:
            return self._fernet.decrypt(ciphertext.encode()).decode()
        except InvalidToken as exc:
            raise CredentialDecryptionError(
                "stored provider credential cannot be decrypted with the configured server key"
            ) from exc
