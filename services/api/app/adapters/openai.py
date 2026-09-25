import json

import httpx

from meetings_contracts import (
    AdapterTestResult,
    Capability,
    EmbeddingRequest,
    EmbeddingResult,
    ProviderProfile,
    TextGenerationRequest,
    TextGenerationResult,
    TranscriptionRequest,
    TranscriptionResult,
)

from .base import ProviderExecutionError, RuntimeAdapterNotImplementedError


class OpenAIAdapter:
    """OpenAI provider using the Responses API for text generation."""

    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.transport = transport

    async def test_configuration(self, profile: ProviderProfile) -> AdapterTestResult:
        valid = bool(profile.api_key)
        return AdapterTestResult(
            profile_id=profile.id,
            status="configuration_valid" if valid else "configuration_invalid",
            capabilities=list(profile.models),
            message=(
                "OpenAI profile is configured; no network call was performed."
                if valid
                else "An API key is required for the OpenAI provider."
            ),
        )

    async def transcribe(
        self, profile: ProviderProfile, request: TranscriptionRequest
    ) -> TranscriptionResult:
        raise RuntimeAdapterNotImplementedError("OpenAI transcription runtime is not wired yet")

    async def generate_text(
        self, profile: ProviderProfile, request: TextGenerationRequest
    ) -> TextGenerationResult:
        if not profile.api_key:
            raise ProviderExecutionError("OpenAI API key is not configured")
        model = profile.models.get(Capability.TEXT_GENERATION)
        if not model:
            raise ProviderExecutionError("OpenAI text-generation model is not configured")

        input_items: list[dict[str, str]] = []
        if request.system_prompt:
            input_items.append({"role": "system", "content": request.system_prompt})
        input_items.append({"role": "user", "content": request.prompt})
        payload: dict[str, object] = {
            "model": model,
            "input": input_items,
            # Meeting content should not be retained as a retrievable Response.
            "store": False,
        }
        if request.temperature is not None:
            payload["temperature"] = request.temperature
        if request.max_output_tokens is not None:
            payload["max_output_tokens"] = request.max_output_tokens
        if request.response_schema:
            payload["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": "meeting_minutes",
                    "schema": request.response_schema,
                    "strict": True,
                }
            }

        body = await _post_json(
            "https://api.openai.com/v1/responses",
            profile.api_key,
            payload,
            "OpenAI",
            self.transport,
        )
        text = _responses_text(body)
        usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
        return TextGenerationResult(
            text=text,
            structured_output=_json_object(text),
            provider="openai",
            model=model,
            input_tokens=_optional_int(usage.get("input_tokens")),
            output_tokens=_optional_int(usage.get("output_tokens")),
        )

    async def embed(
        self, profile: ProviderProfile, request: EmbeddingRequest
    ) -> EmbeddingResult:
        raise RuntimeAdapterNotImplementedError("OpenAI embeddings runtime is not wired yet")


async def _post_json(
    url: str,
    api_key: str,
    payload: dict[str, object],
    provider: str,
    transport: httpx.AsyncBaseTransport | None,
) -> dict[str, object]:
    try:
        async with httpx.AsyncClient(timeout=90, transport=transport) as client:
            response = await client.post(
                url,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
            )
    except httpx.RequestError as exc:
        raise ProviderExecutionError(f"{provider} is unavailable") from exc
    if response.is_error:
        try:
            raw = response.json()
            detail = raw.get("error", raw) if isinstance(raw, dict) else raw
        except ValueError:
            detail = response.text[:500]
        raise ProviderExecutionError(
            f"{provider} request failed ({response.status_code}): {str(detail)[:500]}"
        )
    try:
        body = response.json()
    except ValueError as exc:
        raise ProviderExecutionError(f"{provider} returned invalid JSON") from exc
    if not isinstance(body, dict):
        raise ProviderExecutionError(f"{provider} returned an invalid response")
    return body


def _responses_text(body: dict[str, object]) -> str:
    direct = body.get("output_text")
    if isinstance(direct, str) and direct:
        return direct
    for item in body.get("output", []) if isinstance(body.get("output"), list) else []:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        for part in content if isinstance(content, list) else []:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                return part["text"]
    raise ProviderExecutionError("OpenAI returned no generated text")


def _json_object(text: str) -> dict[str, object] | None:
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _optional_int(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
