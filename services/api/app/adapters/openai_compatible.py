import json

import httpx

from meetings_contracts import (
    AdapterTestResult,
    EmbeddingRequest,
    EmbeddingResult,
    ProviderProfile,
    TextGenerationRequest,
    TextGenerationResult,
    TranscriptionRequest,
    TranscriptionResult,
)

from .base import ProviderExecutionError, RuntimeAdapterNotImplementedError


class OpenAICompatibleAdapter:
    """Foundation for local or hosted OpenAI-compatible endpoints."""

    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.transport = transport

    async def test_configuration(self, profile: ProviderProfile) -> AdapterTestResult:
        valid = bool(profile.base_url)
        return AdapterTestResult(
            profile_id=profile.id,
            status="configuration_valid" if valid else "configuration_invalid",
            capabilities=list(profile.models),
            message=(
                "Compatible endpoint is configured; no network call was performed."
                if valid
                else "A base URL is required for an OpenAI-compatible provider."
            ),
        )

    async def transcribe(
        self, profile: ProviderProfile, request: TranscriptionRequest
    ) -> TranscriptionResult:
        raise RuntimeAdapterNotImplementedError(
            "OpenAI-compatible transcription runtime is not wired yet"
        )

    async def generate_text(
        self, profile: ProviderProfile, request: TextGenerationRequest
    ) -> TextGenerationResult:
        from meetings_contracts import Capability

        if not profile.base_url:
            raise ProviderExecutionError("Compatible provider base URL is not configured")
        model = profile.models.get(Capability.TEXT_GENERATION)
        if not model:
            raise ProviderExecutionError("Compatible text-generation model is not configured")
        messages: list[dict[str, str]] = []
        if request.system_prompt:
            messages.append({"role": "system", "content": request.system_prompt})
        messages.append({"role": "user", "content": request.prompt})
        payload: dict[str, object] = {"model": model, "messages": messages}
        if request.temperature is not None:
            payload["temperature"] = request.temperature
        if request.max_output_tokens is not None:
            payload["max_tokens"] = request.max_output_tokens
        if request.response_schema:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "meeting_minutes",
                    "strict": True,
                    "schema": request.response_schema,
                },
            }
        headers = {"Content-Type": "application/json"}
        if profile.api_key:
            headers["Authorization"] = f"Bearer {profile.api_key}"
        try:
            async with httpx.AsyncClient(timeout=90, transport=self.transport) as client:
                response = await client.post(
                    f"{profile.base_url.rstrip('/')}/chat/completions",
                    headers=headers,
                    json=payload,
                )
        except httpx.RequestError as exc:
            raise ProviderExecutionError("Compatible provider is unavailable") from exc
        if response.is_error:
            try:
                raw = response.json()
                detail = raw.get("error", raw) if isinstance(raw, dict) else raw
            except ValueError:
                detail = response.text[:500]
            raise ProviderExecutionError(
                f"Compatible provider request failed ({response.status_code}): {str(detail)[:500]}"
            )
        try:
            body = response.json()
            choice = body["choices"][0]
            text = choice["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderExecutionError("Compatible provider returned invalid generated text") from exc
        if not isinstance(text, str) or not text:
            raise ProviderExecutionError("Compatible provider returned no generated text")
        usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
        try:
            structured = json.loads(text)
        except ValueError:
            structured = None
        return TextGenerationResult(
            text=text,
            structured_output=structured if isinstance(structured, dict) else None,
            provider=profile.provider_type.value,
            model=model,
            input_tokens=_integer(usage.get("prompt_tokens")),
            output_tokens=_integer(usage.get("completion_tokens")),
        )

    async def embed(
        self, profile: ProviderProfile, request: EmbeddingRequest
    ) -> EmbeddingResult:
        raise RuntimeAdapterNotImplementedError(
            "OpenAI-compatible embeddings runtime is not wired yet"
        )


def _integer(value: object) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
