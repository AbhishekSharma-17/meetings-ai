"""Safe, workspace-scoped discovery of text models for configured providers."""

from __future__ import annotations

from dataclasses import dataclass, field
from time import monotonic
from urllib.parse import urlparse

import httpx
from meetings_contracts import Capability, ProviderProfile, ProviderType
from pydantic import BaseModel


class ModelCatalogError(RuntimeError):
    pass


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
    _cache: dict[str, tuple[float, TextModelCatalog]] = field(default_factory=dict)

    def cached_price(self, profile: ProviderProfile, model_id: str) -> tuple[float, float] | None:
        cached = self._cache.get(f"{profile.id}:{profile.updated_at.isoformat()}")
        if not cached or cached[0] <= monotonic():
            return None
        for item in cached[1].models:
            if item.id == model_id and item.input_per_million_usd is not None and item.output_per_million_usd is not None:
                return item.input_per_million_usd, item.output_per_million_usd
        return None

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


def _router_price(value: object) -> float | None:
    try:
        amount = float(value) * 1_000_000
        return round(amount, 6) if 0 <= amount < 1_000_000 else None
    except (TypeError, ValueError):
        return None
