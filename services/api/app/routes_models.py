"""GET /v1/model-catalog: searchable model lists for the AI providers page.

Admins and the owner only (the ``require_admin`` middleware already blocks other
roles; the handler re-checks). The key used to list models comes from, in order:
a key pasted in the editor (``X-Provider-Key`` header, never echoed or stored),
the saved profile (``profile_id``), or a saved vault key (``credential_id``).
A stored key is only ever sent to the host it was saved for.
"""

from __future__ import annotations

from urllib.parse import urlsplit
from uuid import UUID

from fastapi import FastAPI, Header, HTTPException, Query, Request
from meetings_contracts import ExecutionLocation, ProviderProfile, ProviderType

from .credential_vault import (
    CredentialNotFoundError,
    CredentialValidationError,
    CredentialVault,
    clean_secret,
    normalize_base_url,
)
from .model_catalog import (
    OPENAI_BASE_URL,
    OPENROUTER_BASE_URL,
    CatalogSource,
    ModelCatalogAuthError,
    ModelCatalogError,
    ModelCatalogResponse,
    ModelCatalogService,
)
from .model_catalog_rules import CatalogCapability, CatalogProvider
from .rate_limit import SlidingWindowLimiter
from .repository import ProfileNotFoundError

MAX_BASE_URL_LENGTH = 500
# Only uncached fetches count; each one is a single free GET /models call.
CATALOG_FETCHES_PER_WINDOW = 60
CATALOG_WINDOW_SECONDS = 600


class CatalogRequestError(ValueError):
    """Safe to show: the request cannot be turned into a catalog source."""


def profile_catalog_provider(profile: ProviderProfile) -> CatalogProvider:
    if profile.provider_type is ProviderType.OPENAI:
        return "openai"
    if profile.provider_type is ProviderType.OPENAI_COMPATIBLE:
        return "openrouter" if normalize_base_url(profile.base_url) == OPENROUTER_BASE_URL else "openai_compatible"
    raise CatalogRequestError("this provider type has no model list; type the model id")


def _clean_endpoint(value: str | None) -> str | None:
    endpoint = normalize_base_url(value)
    if endpoint is None:
        return None
    parts = urlsplit(endpoint)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password \
            or parts.query or parts.fragment:
        raise CatalogRequestError("base_url must be an http(s) URL without credentials or query")
    return endpoint


def _fixed_base(provider: CatalogProvider, endpoint: str | None) -> str | None:
    if provider == "openai":
        return OPENAI_BASE_URL
    if provider == "openrouter":
        return OPENROUTER_BASE_URL
    return endpoint


class CatalogSourceResolver:
    def __init__(self, repository: object, vault: CredentialVault) -> None:
        self.repository = repository
        self.vault = vault

    def resolve(
        self, organization_id: UUID, *, provider: CatalogProvider | None, profile_id: UUID | None,
        credential_id: UUID | None, base_url: str | None, pasted_key: str | None,
    ) -> CatalogSource:
        endpoint = _clean_endpoint(base_url)
        key = self._pasted(pasted_key)
        if profile_id is not None:
            return self._from_profile(profile_id, provider, endpoint, key)
        if credential_id is not None:
            return self._from_credential(organization_id, credential_id, provider, endpoint, key)
        if provider is None:
            raise CatalogRequestError("choose a provider, a saved profile or a saved key")
        base = _fixed_base(provider, endpoint)
        if base is None:
            raise CatalogRequestError("enter the endpoint's base URL first")
        return CatalogSource(provider, base, key, self._known_local(base))

    @staticmethod
    def _pasted(value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        try:
            return clean_secret(value)
        except CredentialValidationError as exc:
            raise CatalogRequestError(str(exc)) from exc

    def _from_profile(
        self, profile_id: UUID, provider: CatalogProvider | None, endpoint: str | None, key: str | None,
    ) -> CatalogSource:
        profile = self.repository.get_profile(profile_id)
        derived = profile_catalog_provider(profile)
        if provider is not None and provider != derived:
            raise CatalogRequestError("provider does not match the saved profile")
        base = _fixed_base(derived, normalize_base_url(profile.base_url))
        if base is None:
            raise CatalogRequestError("the saved profile has no base URL")
        if derived == "openai_compatible" and endpoint is not None and endpoint != base:
            raise CatalogRequestError("save the new endpoint before browsing its models")
        return CatalogSource(derived, base, key or profile.api_key,
                             profile.execution_location is ExecutionLocation.LOCAL or self._known_local(base))

    def _from_credential(
        self, organization_id: UUID, credential_id: UUID, provider: CatalogProvider | None,
        endpoint: str | None, key: str | None,
    ) -> CatalogSource:
        credential = self.vault.get(organization_id, credential_id)
        if credential.provider_type == "exa":
            raise CatalogRequestError("an Exa key is for web research and has no model list")
        derived: CatalogProvider = credential.provider_type  # type: ignore[assignment]
        if provider is not None and provider != derived:
            raise CatalogRequestError("this saved key belongs to a different provider")
        base = _fixed_base(derived, normalize_base_url(credential.base_url))
        if base is None:
            raise CatalogRequestError("this saved key has no endpoint")
        if derived == "openai_compatible" and endpoint is not None and endpoint != base:
            raise CatalogRequestError(f"this saved key can only be used with {base}")
        secret = key or self.vault.resolve_secret(organization_id, credential_id)
        return CatalogSource(derived, base, secret, self._known_local(base))

    def _known_local(self, base: str) -> bool:
        """Private endpoints are allowed only when a saved local profile already uses them."""
        return any(
            profile.execution_location is ExecutionLocation.LOCAL and normalize_base_url(profile.base_url) == base
            for profile in self.repository.list_profiles()
        )


def register_model_catalog_routes(
    app: FastAPI, *, model_catalog: ModelCatalogService, repository: object, vault: CredentialVault,
) -> None:
    limiter = SlidingWindowLimiter(CATALOG_FETCHES_PER_WINDOW, CATALOG_WINDOW_SECONDS,
                                   "too many model list refreshes; try again in a few minutes")
    sources = CatalogSourceResolver(repository, vault)

    @app.get("/v1/model-catalog", response_model=ModelCatalogResponse)
    async def browse_models(
        request: Request,
        capability: CatalogCapability,
        provider: CatalogProvider | None = None,
        profile_id: UUID | None = None,
        credential_id: UUID | None = None,
        base_url: str | None = Query(default=None, max_length=MAX_BASE_URL_LENGTH),
        provider_key: str | None = Header(default=None, alias="X-Provider-Key"),
    ) -> ModelCatalogResponse:
        actor = getattr(request.state, "actor", None)
        if actor is None or not getattr(actor, "is_admin", False):
            raise HTTPException(status_code=403, detail="workspace role does not permit this action")
        try:
            source = sources.resolve(
                actor.organization_id, provider=provider, profile_id=profile_id,
                credential_id=credential_id, base_url=base_url, pasted_key=provider_key,
            )
        except ProfileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="provider profile not found") from exc
        except CredentialNotFoundError as exc:
            raise HTTPException(status_code=404, detail="saved key not found") from exc
        except CatalogRequestError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        try:
            return await model_catalog.browse(source, capability, before_fetch=lambda: limiter.check(actor.user_id))
        except ModelCatalogAuthError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except ModelCatalogError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
