"""Safe, workspace-scoped discovery of models for configured providers.

Two entry points share one service:

* ``list_for(profile)`` - the original text-model list for one saved profile
  (``GET /v1/knowledge/text-profiles/{id}/models``).
* ``browse(source, capability)`` - any capability (text generation, vision,
  speech-to-text, embeddings) for OpenAI, OpenRouter or a generic
  OpenAI-compatible endpoint (``GET /v1/model-catalog``).

Live lists are cached for ten minutes per (URL, key fingerprint); keys are never
cached, logged or returned. Arbitrary endpoints are fetched SSRF-safely (public
addresses only, pinned to the vetted IP) unless the workspace already talks to
that endpoint through a saved local profile.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from time import monotonic
from typing import Any
from urllib.parse import urlparse, urlsplit, urlunsplit

import httpx
from meetings_contracts import Capability, ProviderProfile, ProviderType
from pydantic import BaseModel

from .model_catalog_rules import (
    NOTE_OPENAI_VISION,
    CatalogCapability,
    CatalogModel,
    CatalogProvider,
    compatible_models,
    openai_models,
    openrouter_models,
)
from .url_fetch import ALLOWED_PORTS, UrlFetchError, is_public_address, system_resolver

OPENAI_BASE_URL = "https://api.openai.com/v1"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
# Public OpenRouter catalogs (no key needed), checked 2026-09-27:
# https://openrouter.ai/api/v1/models, ...?output_modalities=transcription, /embeddings/models
OPENROUTER_LLM_URL = f"{OPENROUTER_BASE_URL}/models"
OPENROUTER_STT_URL = f"{OPENROUTER_BASE_URL}/models?output_modalities=transcription"
OPENROUTER_EMBEDDINGS_URL = f"{OPENROUTER_BASE_URL}/embeddings/models"
CATALOG_TTL_SECONDS = 600
CATALOG_TIMEOUT = httpx.Timeout(12.0, connect=5.0)
MAX_CACHE_ENTRIES = 128
PUBLIC_FINGERPRINT = "public"
NOTE_OPENAI_NO_KEY = "Add an OpenAI API key to list its models, or type a model id."
NOTE_COMPATIBLE_UNAVAILABLE = "This endpoint didn't return a model list. Type the model id."


class ModelCatalogError(RuntimeError):
    pass


class ModelCatalogAuthError(ModelCatalogError):
    """The provider rejected the key used to list models."""


class ModelOption(BaseModel):
    id: str
    name: str
    input_per_million_usd: float | None = None
    output_per_million_usd: float | None = None


class TextModelCatalog(BaseModel):
    profile_id: str
    provider: str
    configured_model: str
    live_catalog: bool
    models: list[ModelOption]


@dataclass(slots=True)
class ModelCatalogService:
    transport: httpx.AsyncBaseTransport | None = None
    resolver: Callable[[str, int], Any] | None = None
    _cache: dict[str, tuple[float, TextModelCatalog]] = field(default_factory=dict)
    _browser: ModelBrowser | None = None

    @property
    def browser(self) -> ModelBrowser:
        if self._browser is None:
            self._browser = ModelBrowser(self.transport, self.resolver)
        return self._browser

    async def browse(
        self, source: CatalogSource, capability: CatalogCapability,
        *, before_fetch: Callable[[], None] | None = None,
    ) -> ModelCatalogResponse:
        return await self.browser.browse(source, capability, before_fetch=before_fetch)

    def cached_price(self, profile: ProviderProfile, model_id: str) -> tuple[float, float] | None:
        cached = self._cache.get(f"{profile.id}:{profile.updated_at.isoformat()}")
        if cached and cached[0] > monotonic():
            for item in cached[1].models:
                if item.id == model_id and item.input_per_million_usd is not None \
                        and item.output_per_million_usd is not None:
                    return item.input_per_million_usd, item.output_per_million_usd
        if not _is_openrouter_profile(profile):
            return None
        return self.cached_openrouter_text_price(model_id)

    def cached_openrouter_text_price(self, model_id: str) -> tuple[float, float] | None:
        """OpenRouter's public list price (USD per 1M input, output tokens), when its catalog is cached."""
        for item in openrouter_models(self.browser.cached_rows(OPENROUTER_LLM_URL) or [], "text_generation"):
            if item.id == model_id and item.input_per_million_usd is not None \
                    and item.output_per_million_usd is not None:
                return item.input_per_million_usd, item.output_per_million_usd
        return None

    def cached_openrouter_embedding_price(self, model_id: str) -> float | None:
        """OpenRouter's public embeddings list price (USD per 1M input tokens), when cached."""
        for item in openrouter_models(self.browser.cached_rows(OPENROUTER_EMBEDDINGS_URL) or [], "embeddings"):
            if item.id == model_id:
                return item.input_per_million_usd
        return None

    def cached_openrouter_stt_price(self, model_id: str) -> float | None:
        """OpenRouter's public speech-to-text list price (USD per audio minute), when cached."""
        for item in openrouter_models(self.browser.cached_rows(OPENROUTER_STT_URL) or [], "transcription"):
            if item.id == model_id:
                return item.usd_per_minute
        return None

    async def warm_openrouter_prices(self) -> None:
        """Load OpenRouter's public (keyless) LLM, embeddings and speech-to-text price lists."""
        source = CatalogSource(provider="openrouter", base_url=OPENROUTER_BASE_URL)
        for capability in ("text_generation", "embeddings", "transcription"):
            await self.browser.browse(source, capability)

    async def list_for(self, profile: ProviderProfile) -> TextModelCatalog:
        configured = profile.models.get(Capability.TEXT_GENERATION)
        if not configured:
            raise ModelCatalogError("this profile has no text-generation model")
        url: str | None = None
        provider = profile.provider_type.value
        if profile.provider_type is ProviderType.OPENAI:
            url = "https://api.openai.com/v1/models"
        elif profile.provider_type is ProviderType.OPENAI_COMPATIBLE and profile.base_url:
            parsed = urlparse(profile.base_url)
            if parsed.scheme == "https" and parsed.hostname == "openrouter.ai" and parsed.path.rstrip("/") == "/api/v1":
                url = "https://openrouter.ai/api/v1/models?output_modalities=text"
                provider = "openrouter"
        fallback = TextModelCatalog(
            profile_id=str(profile.id), provider=provider, configured_model=configured,
            live_catalog=False, models=[ModelOption(id=configured, name=configured)],
        )
        if not url:
            return fallback
        cache_key = f"{profile.id}:{profile.updated_at.isoformat()}"
        cached = self._cache.get(cache_key)
        if cached and cached[0] > monotonic():
            return cached[1]
        if not profile.api_key:
            raise ModelCatalogError("configure this provider's API key before browsing models")
        try:
            async with httpx.AsyncClient(timeout=12, transport=self.transport) as client:
                response = await client.get(url, headers={"Authorization": f"Bearer {profile.api_key}"})
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ModelCatalogError("live model catalog is unavailable; retry later") from exc
        rows = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            raise ModelCatalogError("provider returned an invalid model catalog")
        models: list[ModelOption] = []
        for item in rows:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                continue
            model_id = item["id"]
            if provider == "openai" and not (model_id.startswith("gpt-") or model_id.startswith("o")):
                continue
            architecture = item.get("architecture")
            if provider == "openrouter" and isinstance(architecture, dict):
                output = architecture.get("output_modalities")
                if isinstance(output, list) and "text" not in output:
                    continue
            pricing = item.get("pricing") if isinstance(item.get("pricing"), dict) else {}
            models.append(ModelOption(
                id=model_id, name=str(item.get("name") or model_id)[:160],
                input_per_million_usd=_router_price(pricing.get("prompt")) if provider == "openrouter" else None,
                output_per_million_usd=_router_price(pricing.get("completion")) if provider == "openrouter" else None,
            ))
        if configured not in {item.id for item in models}:
            models.insert(0, ModelOption(id=configured, name=f"{configured} (configured)"))
        catalog = TextModelCatalog(
            profile_id=str(profile.id), provider=provider, configured_model=configured,
            live_catalog=True, models=models[:1000],
        )
        self._cache[cache_key] = (monotonic() + 600, catalog)
        return catalog


def _is_openrouter_profile(profile: ProviderProfile) -> bool:
    if profile.provider_type is not ProviderType.OPENAI_COMPATIBLE or not profile.base_url:
        return False
    parsed = urlparse(profile.base_url)
    return parsed.scheme == "https" and parsed.hostname == "openrouter.ai" and parsed.path.rstrip("/") == "/api/v1"


def _router_price(value: object) -> float | None:
    try:
        amount = float(value) * 1_000_000
        return round(amount, 6) if 0 <= amount < 1_000_000 else None
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True, slots=True)
class CatalogSource:
    """Where to list models. ``api_key`` is used for the request only and never stored."""

    provider: CatalogProvider
    base_url: str
    api_key: str | None = None
    allow_private: bool = False  # the workspace already talks to this local endpoint


class ModelCatalogResponse(BaseModel):
    provider: CatalogProvider
    capability: CatalogCapability
    live_catalog: bool
    fetched_at: datetime
    note: str | None = None
    models: list[CatalogModel]


def key_fingerprint(api_key: str | None) -> str:
    if not api_key:
        return PUBLIC_FINGERPRINT
    return hashlib.sha256(api_key.encode()).hexdigest()[:16]


def _openrouter_url(capability: CatalogCapability) -> str:
    if capability == "transcription":
        return OPENROUTER_STT_URL
    if capability == "embeddings":
        return OPENROUTER_EMBEDDINGS_URL
    return OPENROUTER_LLM_URL


@dataclass(slots=True)
class _RowCache:
    entries: dict[tuple[str, str], tuple[float, list[Any]]] = field(default_factory=dict)

    def get(self, key: tuple[str, str]) -> list[Any] | None:
        cached = self.entries.get(key)
        if cached is None or cached[0] <= monotonic():
            return None
        return cached[1]

    def put(self, key: tuple[str, str], rows: list[Any]) -> None:
        if len(self.entries) >= MAX_CACHE_ENTRIES:
            oldest = min(self.entries, key=lambda item: self.entries[item][0])
            self.entries.pop(oldest, None)
        self.entries[key] = (monotonic() + CATALOG_TTL_SECONDS, rows)


class ModelBrowser:
    """Capability-aware model lists (the ``browse`` half of :class:`ModelCatalogService`)."""

    def __init__(self, transport: httpx.AsyncBaseTransport | None, resolver: Callable | None = None) -> None:
        self.transport = transport
        self.resolver = resolver or system_resolver
        self.cache = _RowCache()

    async def browse(
        self, source: CatalogSource, capability: CatalogCapability,
        *, before_fetch: Callable[[], None] | None = None,
    ) -> ModelCatalogResponse:
        def respond(models: list[CatalogModel], live: bool, note: str | None = None) -> ModelCatalogResponse:
            return ModelCatalogResponse(provider=source.provider, capability=capability, live_catalog=live,
                                        fetched_at=datetime.now(UTC), note=note, models=models)

        if source.provider == "openrouter":
            rows = await self._rows(_openrouter_url(capability), None, safe=False, before_fetch=before_fetch)
            return respond(openrouter_models(rows, capability), True)
        if source.provider == "openai":
            if not source.api_key:
                return respond([], False, NOTE_OPENAI_NO_KEY)
            rows = await self._rows(f"{OPENAI_BASE_URL}/models", source.api_key, safe=False, before_fetch=before_fetch)
            return respond(_openai_models(rows, capability), True, NOTE_OPENAI_VISION if capability == "vision" else None)
        try:
            rows = await self._rows(f"{source.base_url.rstrip('/')}/models", source.api_key,
                                    safe=not source.allow_private, before_fetch=before_fetch)
        except ModelCatalogError:
            return respond([], False, NOTE_COMPATIBLE_UNAVAILABLE)
        models, note = compatible_models(rows, capability)
        return respond(models, True, note if models else NOTE_COMPATIBLE_UNAVAILABLE)

    def cached_rows(self, url: str) -> list[Any] | None:
        return self.cache.get((url, PUBLIC_FINGERPRINT))

    async def _rows(
        self, url: str, api_key: str | None, *, safe: bool, before_fetch: Callable[[], None] | None,
    ) -> list[Any]:
        cache_key = (url, key_fingerprint(api_key))
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached
        if before_fetch is not None:
            before_fetch()
        headers = {"Accept": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        try:
            async with httpx.AsyncClient(timeout=CATALOG_TIMEOUT, transport=self.transport,
                                         follow_redirects=False) as client:
                response = await (self._pinned_get(client, url, headers) if safe else client.get(url, headers=headers))
        except (httpx.HTTPError, UrlFetchError) as exc:
            raise ModelCatalogError("the provider's model list is unavailable right now; retry or type a model id") from exc
        if response.status_code in {401, 403}:
            raise ModelCatalogAuthError("the provider rejected this API key")
        if response.status_code >= 300:
            raise ModelCatalogError("the provider's model list is unavailable right now; retry or type a model id")
        try:
            payload = response.json()
        except ValueError as exc:
            raise ModelCatalogError("the provider returned an invalid model list") from exc
        rows = payload.get("data") if isinstance(payload, dict) else payload
        if not isinstance(rows, list):
            raise ModelCatalogError("the provider returned an invalid model list")
        self.cache.put(cache_key, rows)
        return rows

    async def _pinned_get(self, client: httpx.AsyncClient, url: str, headers: dict[str, str]) -> httpx.Response:
        """GET a public endpoint only: every resolved address must be public; connect to the vetted IP."""
        parts = urlsplit(url)
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
            raise UrlFetchError("invalid endpoint")
        host = parts.hostname.rstrip(".").lower()
        port = parts.port or (443 if parts.scheme == "https" else 80)
        if port not in ALLOWED_PORTS or host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
            raise UrlFetchError("private or internal addresses cannot be used")
        addresses = await self.resolver(host, port)
        if not addresses or not all(is_public_address(item) for item in addresses):
            raise UrlFetchError("private or internal addresses cannot be used")
        literal = f"[{addresses[0]}]" if ":" in addresses[0] else addresses[0]
        target = urlunsplit((parts.scheme, f"{literal}:{port}" if parts.port else literal, parts.path, parts.query, ""))
        request = client.build_request(
            "GET", target, headers={**headers, "Host": parts.netloc},
            extensions={"sni_hostname": host} if parts.scheme == "https" else {},
        )
        return await client.send(request)


def _openai_models(rows: list[Any], capability: CatalogCapability) -> list[CatalogModel]:
    # Imported lazily: usage.py and document_vision.py import this module.
    from .document_vision import OPENAI_IMAGE_INPUT_MODELS
    from .usage import (
        OPENAI_EMBEDDING_USD_PER_MILLION,
        OPENAI_TEXT_FALLBACK_PRICES,
        OPENAI_TRANSCRIPTION_USD_PER_MINUTE,
    )
    return openai_models(
        rows, capability, image_models=OPENAI_IMAGE_INPUT_MODELS, text_prices=OPENAI_TEXT_FALLBACK_PRICES,
        embedding_prices=OPENAI_EMBEDDING_USD_PER_MILLION, stt_prices=OPENAI_TRANSCRIPTION_USD_PER_MINUTE,
    )
