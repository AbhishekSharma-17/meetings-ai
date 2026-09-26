"""Workspace credential vault: reusable, encrypted provider keys (OpenAI, OpenRouter, Exa, ...).

Secrets are encrypted with the server-held ``PROVIDER_CREDENTIAL_KEY`` (see
``CredentialCipher``) and are write-only over the API: responses expose a label,
provider type and a short ``••••last4`` hint, never the key itself. Every query is
scoped to one organization.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import httpx
from meetings_contracts import ProviderType
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import func, select

from .database import (
    Database,
    OrganizationAiSettingsRow,
    ProviderCredentialRow,
    ProviderProfileCredentialRow,
    ProviderProfileRow,
    ProviderTenantRow,
)
from .security import CredentialCipher

logger = logging.getLogger(__name__)

VaultProviderType = Literal["openai", "openrouter", "openai_compatible", "exa"]
VAULT_PROVIDER_TYPES: frozenset[str] = frozenset({"openai", "openrouter", "openai_compatible", "exa"})

OPENAI_BASE_URL = "https://api.openai.com/v1"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
EXA_BASE_URL = "https://api.exa.ai"

MIN_SECRET_LENGTH = 8
MAX_SECRET_LENGTH = 512
MAX_BASE_URL_LENGTH = 500
LAST_USED_WRITE_INTERVAL = timedelta(minutes=1)
TEST_TIMEOUT_SECONDS = 12

# Exa /search list price, verified 2026-09-26 at https://exa.ai/pricing:
# "$7 / 1k requests" for /search (up to 10 results; contents billed separately).
# Used only when Exa's response does not report costDollars.total itself.
EXA_SEARCH_USD_PER_REQUEST = 7 / 1000


class CredentialNotFoundError(LookupError):
    pass


class CredentialValidationError(ValueError):
    pass


class CredentialInUseError(RuntimeError):
    def __init__(self, usages: list[str]) -> None:
        super().__init__("this saved key is in use: " + ", ".join(usages))
        self.usages = usages


class CredentialCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str = Field(min_length=1, max_length=100)
    provider_type: VaultProviderType
    # Length/whitespace checks happen in the vault so errors never echo the value.
    secret: SecretStr = Field(repr=False)
    base_url: str | None = Field(default=None, max_length=MAX_BASE_URL_LENGTH)


class CredentialPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(default=None, min_length=1, max_length=100)
    secret: SecretStr | None = Field(default=None, repr=False)


class CredentialPublic(BaseModel):
    id: UUID
    label: str
    provider_type: VaultProviderType
    base_url: str | None
    hint: str
    created_at: datetime
    updated_at: datetime
    last_used_at: datetime | None
    used_by_profiles: int
    used_by_settings: bool = False


class CredentialTestResult(BaseModel):
    credential_id: UUID
    status: Literal["valid", "invalid", "unverified"]
    network_call_performed: bool
    message: str


def _utc(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=UTC)


def normalize_base_url(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip().rstrip("/")
    return cleaned or None


def clean_secret(raw: str) -> str:
    """Trim surrounding whitespace from a pasted key and reject malformed values."""
    secret = raw.strip()
    if not MIN_SECRET_LENGTH <= len(secret) <= MAX_SECRET_LENGTH:
        raise CredentialValidationError(
            f"API key must be {MIN_SECRET_LENGTH}-{MAX_SECRET_LENGTH} characters"
        )
    if any(not ("!" <= char <= "~") for char in secret):
        raise CredentialValidationError("API key must not contain spaces or non-printable characters")
    return secret


def secret_hint(secret: str) -> str:
    return f"••••{secret[-4:]}"


def _clean_label(value: str) -> str:
    label = " ".join(value.split())
    if not label or len(label) > 100:
        raise CredentialValidationError("label must be 1-100 characters")
    return label


def _vault_base_url(provider_type: str, base_url: str | None) -> str | None:
    """Fixed hosts for known providers; a validated URL for generic compatible endpoints."""
    requested = normalize_base_url(base_url)
    fixed = {"openai": None, "openrouter": OPENROUTER_BASE_URL, "exa": None}
    if provider_type in fixed:
        allowed = {None, fixed[provider_type]}
        if provider_type == "openai":
            allowed.add(OPENAI_BASE_URL)
        if requested not in allowed:
            raise CredentialValidationError(f"a {provider_type} key uses the provider's standard endpoint")
        return fixed[provider_type]
    if requested is None:
        raise CredentialValidationError("base_url is required for an OpenAI-compatible key")
    parts = urlsplit(requested)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password \
            or parts.query or parts.fragment:
        raise CredentialValidationError("base_url must be an http(s) URL without credentials or query")
    return requested


def profile_link_base_url(
    credential: CredentialPublic, provider_type: ProviderType, base_url: str | None,
) -> str | None:
    """Return the profile base URL to use with a vault key, or raise if incompatible.

    A saved key may only be sent to the host it was saved for, so a profile
    cannot redirect a workspace key to an arbitrary endpoint.
    """
    requested = normalize_base_url(base_url)
    if credential.provider_type == "exa":
        raise CredentialValidationError("an Exa key is for web research and cannot back a model profile")
    if credential.provider_type == "openai":
        if provider_type is not ProviderType.OPENAI or requested not in {None, OPENAI_BASE_URL}:
            raise CredentialValidationError("an OpenAI key can only be used by an OpenAI profile")
        return None
    expected = credential.base_url if credential.provider_type == "openai_compatible" else OPENROUTER_BASE_URL
    if provider_type is not ProviderType.OPENAI_COMPATIBLE or requested not in {None, expected}:
        raise CredentialValidationError(
            f"this saved key can only be used by an OpenAI-compatible profile at {expected}"
        )
    return expected


def vault_type_for_profile(provider_type: ProviderType, base_url: str | None) -> str:
    if provider_type is ProviderType.OPENAI:
        return "openai"
    if provider_type is ProviderType.OPENAI_COMPATIBLE:
        return "openrouter" if normalize_base_url(base_url) == OPENROUTER_BASE_URL else "openai_compatible"
    raise CredentialValidationError("keys for this provider type cannot be saved to the workspace vault")


class CredentialVault:
    def __init__(
        self, database: Database, cipher: CredentialCipher, usage: object | None = None,
        *, transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.database = database
        self.cipher = cipher
        self.usage = usage
        self.transport = transport

    # ----- reads -------------------------------------------------------------
    def list(self, organization_id: UUID, provider_type: str | None = None) -> list[CredentialPublic]:
        with self.database.session_factory() as session:
            query = select(ProviderCredentialRow).where(
                ProviderCredentialRow.organization_id == str(organization_id),
            ).order_by(ProviderCredentialRow.created_at)
            if provider_type:
                query = query.where(ProviderCredentialRow.provider_type == provider_type)
            rows = session.execute(query).scalars().all()
            counts = self._profile_counts(session, organization_id)
            research = self._research_credential_id(session, organization_id)
            return [self._public(row, counts.get(row.id, 0), research == row.id) for row in rows]

    def get(self, organization_id: UUID, credential_id: UUID) -> CredentialPublic:
        with self.database.session_factory() as session:
            row = self._row(session, organization_id, credential_id)
            counts = self._profile_counts(session, organization_id)
            research = self._research_credential_id(session, organization_id)
            return self._public(row, counts.get(row.id, 0), research == row.id)

    def resolve_secret(self, organization_id: UUID, credential_id: UUID) -> str:
        """Decrypt a workspace key for a server-side call and record its use."""
        with self.database.session_factory.begin() as session:
            row = self._row(session, organization_id, credential_id)
            secret = self.cipher.decrypt(row.credential_ciphertext)
            self._touch_row(row)
        if not secret:
            raise CredentialNotFoundError(credential_id)
        return secret

    def first_for(self, organization_id: UUID, provider_type: str) -> tuple[UUID, str] | None:
        """The oldest saved key of a provider type, e.g. the workspace Exa key."""
        with self.database.session_factory() as session:
            row = session.execute(select(ProviderCredentialRow).where(
                ProviderCredentialRow.organization_id == str(organization_id),
                ProviderCredentialRow.provider_type == provider_type,
            ).order_by(ProviderCredentialRow.created_at).limit(1)).scalar_one_or_none()
            credential_id = UUID(row.id) if row else None
        if credential_id is None:
            return None
        return credential_id, self.resolve_secret(organization_id, credential_id)

    def touch(self, organization_id: UUID, credential_id: UUID) -> None:
        """Record use of a linked profile key without failing the caller."""
        try:
            with self.database.session_factory.begin() as session:
                row = session.get(ProviderCredentialRow, str(credential_id))
                if row is not None and row.organization_id == str(organization_id):
                    self._touch_row(row)
        except Exception:  # noqa: BLE001 - last-used bookkeeping must not break a model call
            logger.exception("could not record provider credential use")

    # ----- writes (owner only; enforced at the route) ------------------------
    def create(
        self, organization_id: UUID, request: CredentialCreate, actor_user_id: UUID | None = None,
    ) -> CredentialPublic:
        secret = clean_secret(request.secret.get_secret_value())
        label = _clean_label(request.label)
        base_url = _vault_base_url(request.provider_type, request.base_url)
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            self._ensure_unique_label(session, organization_id, label)
            row = ProviderCredentialRow(
                id=str(uuid4()), organization_id=str(organization_id),
                provider_type=request.provider_type, label=label, base_url=base_url,
                credential_ciphertext=self.cipher.encrypt(secret), hint=secret_hint(secret),
                created_by=str(actor_user_id) if actor_user_id else None,
                created_at=now, updated_at=now, last_used_at=None,
            )
            session.add(row)
            session.flush()
            return self._public(row, 0, False)

    def update(self, organization_id: UUID, credential_id: UUID, patch: CredentialPatch) -> CredentialPublic:
        """Rename and/or rotate a key; linked profiles pick up a rotated key immediately."""
        with self.database.session_factory.begin() as session:
            row = self._row(session, organization_id, credential_id)
            if "label" in patch.model_fields_set and patch.label is not None:
                label = _clean_label(patch.label)
                if label != row.label:
                    self._ensure_unique_label(session, organization_id, label)
                row.label = label
            if patch.secret is not None:
                secret = clean_secret(patch.secret.get_secret_value())
                row.credential_ciphertext = self.cipher.encrypt(secret)
                row.hint = secret_hint(secret)
            row.updated_at = datetime.now(UTC)
            session.flush()
            counts = self._profile_counts(session, organization_id)
            research = self._research_credential_id(session, organization_id)
            return self._public(row, counts.get(row.id, 0), research == row.id)

    def delete(self, organization_id: UUID, credential_id: UUID) -> None:
        with self.database.session_factory.begin() as session:
            row = self._row(session, organization_id, credential_id)
            usages = [f"provider profile '{name}'" for (name,) in session.execute(
                select(ProviderProfileRow.name)
                .join(ProviderProfileCredentialRow, ProviderProfileCredentialRow.profile_id == ProviderProfileRow.id)
                .join(ProviderTenantRow, ProviderTenantRow.provider_id == ProviderProfileRow.id)
                .where(
                    ProviderProfileCredentialRow.credential_id == row.id,
                    ProviderTenantRow.organization_id == str(organization_id),
                ).order_by(ProviderProfileRow.name)
            ).all()]
            if self._research_credential_id(session, organization_id) == row.id:
                usages.append("workspace AI settings (web research)")
            if usages:
                raise CredentialInUseError(usages)
            session.delete(row)

    # ----- live check ----------------------------------------------------------
    async def test(
        self, organization_id: UUID, credential_id: UUID, actor_user_id: UUID | None = None,
    ) -> CredentialTestResult:
        credential = self.get(organization_id, credential_id)
        with self.database.session_factory() as session:
            secret = self.cipher.decrypt(self._row(session, organization_id, credential_id).credential_ciphertext)
        if credential.provider_type == "openai_compatible" or not secret:
            return CredentialTestResult(
                credential_id=credential.id, status="unverified", network_call_performed=False,
                message="Saved. Custom endpoints are checked when a profile first uses this key.",
            )
        try:
            async with httpx.AsyncClient(timeout=TEST_TIMEOUT_SECONDS, transport=self.transport) as client:
                if credential.provider_type == "exa":
                    return await self._test_exa(client, credential, secret, organization_id, actor_user_id)
                url = f"{OPENAI_BASE_URL}/models" if credential.provider_type == "openai" \
                    else f"{OPENROUTER_BASE_URL}/key"
                response = await client.get(url, headers={"Authorization": f"Bearer {secret}"})
        except httpx.HTTPError:
            return CredentialTestResult(
                credential_id=credential.id, status="unverified", network_call_performed=True,
                message="The provider could not be reached; try again later.",
            )
        return self._result_from_status(credential, response.status_code)

    async def _test_exa(
        self, client: httpx.AsyncClient, credential: CredentialPublic, secret: str,
        organization_id: UUID, actor_user_id: UUID | None,
    ) -> CredentialTestResult:
        started = time.monotonic()
        response = await client.post(f"{EXA_BASE_URL}/search", headers={"x-api-key": secret}, json={
            "query": "Meetings AI connection check", "numResults": 1, "contents": {"text": False},
        })
        if 200 <= response.status_code < 300:
            reported = None
            try:
                cost = response.json().get("costDollars")
                total = cost.get("total") if isinstance(cost, dict) else None
                reported = float(total) if isinstance(total, (int, float)) and total >= 0 else None
            except (ValueError, AttributeError):
                reported = None
            if self.usage is not None:
                self.usage.record_event(
                    kind="search", purpose="credential_test", provider="exa", model="exa-search",
                    units=1, unit_type="requests",
                    estimated_usd=reported if reported is not None else EXA_SEARCH_USD_PER_REQUEST,
                    price_source="exa_reported_cost" if reported is not None else "exa_published_list_price",
                    duration_ms=int((time.monotonic() - started) * 1000),
                    actor_user_id=actor_user_id, organization_id=organization_id,
                    details={"credential_id": str(credential.id), "num_results": 1},
                )
        return self._result_from_status(credential, response.status_code)

    @staticmethod
    def _result_from_status(credential: CredentialPublic, status_code: int) -> CredentialTestResult:
        if 200 <= status_code < 300:
            return CredentialTestResult(
                credential_id=credential.id, status="valid", network_call_performed=True,
                message="The provider accepted this key.",
            )
        if status_code in {401, 403}:
            return CredentialTestResult(
                credential_id=credential.id, status="invalid", network_call_performed=True,
                message="The provider rejected this key.",
            )
        return CredentialTestResult(
            credential_id=credential.id, status="unverified", network_call_performed=True,
            message=f"The provider returned HTTP {status_code}; the key could not be verified.",
        )

    # ----- helpers ---------------------------------------------------------------
    @staticmethod
    def _row(session: object, organization_id: UUID, credential_id: UUID) -> ProviderCredentialRow:
        row = session.get(ProviderCredentialRow, str(credential_id))
        if row is None or row.organization_id != str(organization_id):
            raise CredentialNotFoundError(credential_id)
        return row

    @staticmethod
    def _touch_row(row: ProviderCredentialRow) -> None:
        now = datetime.now(UTC)
        last = _utc(row.last_used_at)
        if last is None or now - last >= LAST_USED_WRITE_INTERVAL:
            row.last_used_at = now

    @staticmethod
    def _ensure_unique_label(session: object, organization_id: UUID, label: str) -> None:
        exists = session.execute(select(ProviderCredentialRow.id).where(
            ProviderCredentialRow.organization_id == str(organization_id),
            func.lower(ProviderCredentialRow.label) == label.lower(),
        ).limit(1)).first()
        if exists:
            raise CredentialValidationError("a saved key with this label already exists")

    @staticmethod
    def _profile_counts(session: object, organization_id: UUID) -> dict[str, int]:
        rows = session.execute(select(
            ProviderProfileCredentialRow.credential_id, func.count(ProviderProfileCredentialRow.profile_id),
        ).join(ProviderTenantRow, ProviderTenantRow.provider_id == ProviderProfileCredentialRow.profile_id).where(
            ProviderTenantRow.organization_id == str(organization_id),
        ).group_by(ProviderProfileCredentialRow.credential_id)).all()
        return {credential_id: count for credential_id, count in rows}

    @staticmethod
    def _research_credential_id(session: object, organization_id: UUID) -> str | None:
        settings = session.get(OrganizationAiSettingsRow, str(organization_id))
        return settings.research_credential_id if settings else None

    @staticmethod
    def _public(row: ProviderCredentialRow, used_by_profiles: int, used_by_settings: bool) -> CredentialPublic:
        return CredentialPublic(
            id=UUID(row.id), label=row.label, provider_type=row.provider_type, base_url=row.base_url,
            hint=row.hint, created_at=_utc(row.created_at), updated_at=_utc(row.updated_at),
            last_used_at=_utc(row.last_used_at), used_by_profiles=used_by_profiles,
            used_by_settings=used_by_settings,
        )


__all__ = [
    "CredentialCreate", "CredentialInUseError", "CredentialNotFoundError", "CredentialPatch",
    "CredentialPublic", "CredentialTestResult", "CredentialValidationError", "CredentialVault",
    "EXA_SEARCH_USD_PER_REQUEST", "VAULT_PROVIDER_TYPES",
    "profile_link_base_url", "vault_type_for_profile",
]
