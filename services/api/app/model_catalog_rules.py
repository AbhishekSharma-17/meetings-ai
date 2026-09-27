"""Pure parsing and classification rules for provider model lists.

Everything here turns a provider's raw ``/models`` rows into :class:`CatalogModel`
entries for one capability. No network access and no invented data: a price is
only shown when the provider's live catalog states it or when it is one of the
published list prices already used for cost estimates in ``usage.py``.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel

CatalogProvider = Literal["openai", "openrouter", "openai_compatible"]
CatalogCapability = Literal["text_generation", "transcription", "embeddings", "vision"]

MAX_MODELS = 2000
MAX_NAME_LENGTH = 160
MAX_MODEL_ID_LENGTH = 200
# OpenRouter lists most speech-to-text prices as USD per audio second. A few rows use
# another unit (e.g. per hour) under the same field; a per-minute rate above this is not
# plausible for speech-to-text, so such rows stay unpriced instead of showing a wrong price.
MAX_PLAUSIBLE_STT_USD_PER_MINUTE = 1.0

# OpenAI ids that are never chat/completions models, even when they start with gpt-/o*.
_OPENAI_NON_CHAT_MARKERS = (
    "audio", "realtime", "tts", "image", "embedding", "transcribe", "moderation", "search", "whisper",
)
_COMPATIBLE_STT_MARKERS = ("whisper", "transcribe", "stt", "asr")

NOTE_OPENAI_VISION = (
    "OpenAI's model list doesn't say which models read images, so only models verified to accept "
    "images are listed. You can type another model id."
)
NOTE_COMPATIBLE_VISION = "This endpoint doesn't say which models read images. Choose one you know accepts images."
NOTE_COMPATIBLE_UNLABELLED = "This endpoint doesn't label model types, so every model it serves is listed."


class CatalogModel(BaseModel):
    id: str
    name: str
    vendor: str | None = None
    input_per_million_usd: float | None = None
    output_per_million_usd: float | None = None
    usd_per_minute: float | None = None
    context_length: int | None = None
    accepts_images: bool | None = None


def router_price_per_million(value: object) -> float | None:
    """OpenRouter prices are USD per token (strings); negative means variable/unknown."""
    try:
        amount = float(value) * 1_000_000  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return round(amount, 6) if 0 <= amount < 1_000_000 else None


def _router_number(value: object) -> float | None:
    try:
        amount = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return amount if amount >= 0 else None


def _modalities(item: dict[str, Any], key: str) -> list[str] | None:
    architecture = item.get("architecture")
    if not isinstance(architecture, dict):
        return None
    value = architecture.get(key)
    return [str(entry) for entry in value] if isinstance(value, list) else None


def _split_name(model_id: str, raw_name: object) -> tuple[str, str | None]:
    """"OpenAI: GPT-6 Luna" -> ("GPT-6 Luna", "OpenAI"); falls back to the id's vendor prefix."""
    name = str(raw_name or model_id).strip()[:MAX_NAME_LENGTH] or model_id
    if ": " in name:
        vendor, _, rest = name.partition(": ")
        if vendor and rest:
            return rest, vendor
    prefix = model_id.split("/", 1)[0] if "/" in model_id else None
    return name, prefix


def _valid_id(item: object) -> str | None:
    if not isinstance(item, dict):
        return None
    model_id = item.get("id")
    if not isinstance(model_id, str):
        return None
    model_id = model_id.strip()
    if not model_id or len(model_id) > MAX_MODEL_ID_LENGTH or any(char.isspace() for char in model_id):
        return None
    return model_id


def _stt_prices(pricing: dict[str, Any]) -> tuple[float | None, float | None, float | None]:
    """(input per 1M, output per 1M, USD per minute) for an OpenRouter speech-to-text row."""
    completion = _router_number(pricing.get("completion"))
    if completion:  # token-priced transcription (e.g. gpt-4o-transcribe)
        return router_price_per_million(pricing.get("prompt")), router_price_per_million(completion), None
    per_second = _router_number(pricing.get("prompt"))
    if per_second is None:
        return None, None, None
    per_minute = round(per_second * 60, 6)
    return None, None, per_minute if per_minute <= MAX_PLAUSIBLE_STT_USD_PER_MINUTE else None


def openrouter_models(rows: list[Any], capability: CatalogCapability) -> list[CatalogModel]:
    models: list[CatalogModel] = []
    seen: set[str] = set()
    for item in rows:
        model_id = _valid_id(item)
        if model_id is None or model_id in seen:
            continue
        inputs = _modalities(item, "input_modalities") or []
        outputs = _modalities(item, "output_modalities")
        wanted = {"text_generation": "text", "vision": "text", "transcription": "transcription",
                  "embeddings": "embeddings"}[capability]
        if outputs is not None and wanted not in outputs:
            continue
        if capability == "vision" and "image" not in inputs:
            continue
        pricing = item.get("pricing") if isinstance(item.get("pricing"), dict) else {}
        name, vendor = _split_name(model_id, item.get("name"))
        context = item.get("context_length")
        prices: dict[str, Any]
        if capability == "transcription":
            per_in, per_out, per_minute = _stt_prices(pricing)
            prices = {"input_per_million_usd": per_in, "output_per_million_usd": per_out, "usd_per_minute": per_minute}
        elif capability == "embeddings":
            prices = {"input_per_million_usd": router_price_per_million(pricing.get("prompt"))}
        else:
            prices = {
                "input_per_million_usd": router_price_per_million(pricing.get("prompt")),
                "output_per_million_usd": router_price_per_million(pricing.get("completion")),
                "accepts_images": "image" in inputs,
            }
        entry = CatalogModel(
            id=model_id, name=name, vendor=vendor,
            context_length=context if isinstance(context, int) and context > 0 else None, **prices,
        )
        seen.add(model_id)
        models.append(entry)
        if len(models) >= MAX_MODELS:
            break
    return models


def openai_kind(model_id: str) -> CatalogCapability | None:
    lower = model_id.lower()
    if "transcribe" in lower or "whisper" in lower:
        return "transcription"
    if "embedding" in lower:
        return "embeddings"
    is_chat_family = lower.startswith("gpt-") or re.match(r"^o\d", lower) is not None
    if is_chat_family and not any(marker in lower for marker in _OPENAI_NON_CHAT_MARKERS):
        return "text_generation"
    return None


def openai_models(
    rows: list[Any], capability: CatalogCapability, *,
    image_models: frozenset[str], text_prices: dict[str, tuple[float, float]],
    embedding_prices: dict[str, float], stt_prices: dict[str, float],
) -> list[CatalogModel]:
    """Classify OpenAI's /v1/models by id; prices come only from the published list prices."""
    wanted: CatalogCapability = "text_generation" if capability == "vision" else capability
    ids = sorted({model_id for item in rows if (model_id := _valid_id(item)) and openai_kind(model_id) == wanted})
    if capability == "vision":
        ids = [model_id for model_id in ids if model_id in image_models]
    models: list[CatalogModel] = []
    for model_id in ids[:MAX_MODELS]:
        prices: dict[str, Any] = {}
        if wanted == "text_generation":
            price = text_prices.get(model_id)
            prices = {
                "input_per_million_usd": price[0] if price else None,
                "output_per_million_usd": price[1] if price else None,
                "accepts_images": True if model_id in image_models else None,
            }
        elif wanted == "embeddings":
            prices = {"input_per_million_usd": embedding_prices.get(model_id)}
        else:
            prices = {"usd_per_minute": stt_prices.get(model_id)}
        entry = CatalogModel(id=model_id, name=model_id, vendor="OpenAI", **prices)
        models.append(entry)
    return models


def compatible_kind(model_id: str) -> CatalogCapability:
    lower = model_id.lower()
    if any(marker in lower for marker in _COMPATIBLE_STT_MARKERS):
        return "transcription"
    if "embed" in lower:
        return "embeddings"
    return "text_generation"


def compatible_models(rows: list[Any], capability: CatalogCapability) -> tuple[list[CatalogModel], str | None]:
    """Generic OpenAI-compatible servers only expose ids; classify by id and say so when unsure."""
    ids = list(dict.fromkeys(model_id for item in rows if (model_id := _valid_id(item))))[:MAX_MODELS]
    wanted: CatalogCapability = "text_generation" if capability == "vision" else capability
    matching = [model_id for model_id in ids if compatible_kind(model_id) == wanted]
    note = NOTE_COMPATIBLE_VISION if capability == "vision" else None
    if not matching and ids:
        matching, note = ids, NOTE_COMPATIBLE_UNLABELLED
    return [CatalogModel(id=model_id, name=model_id) for model_id in matching], note
