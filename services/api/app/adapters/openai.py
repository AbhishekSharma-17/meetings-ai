import json
from collections.abc import Awaitable, Callable

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
from .embeddings import create_embeddings
from .streaming import json_events


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
        if body.get("status") == "incomplete":
            details = body.get("incomplete_details")
            reason = details.get("reason") if isinstance(details, dict) else None
            if reason == "max_output_tokens":
                raise ProviderExecutionError("OpenAI MOM response exceeded the output token limit; increase the limit or shorten the transcript")
            raise ProviderExecutionError(f"OpenAI MOM response was incomplete ({reason or 'unknown reason'})")
        if body.get("status") not in {None, "completed"}:
            raise ProviderExecutionError(f"OpenAI MOM response ended with status {body['status']}")
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

    async def generate_text_stream(
        self, profile: ProviderProfile, request: TextGenerationRequest,
        on_delta: Callable[[str], Awaitable[None]],
    ) -> TextGenerationResult:
        if not profile.api_key:
            raise ProviderExecutionError("OpenAI API key is not configured")
        model = profile.models.get(Capability.TEXT_GENERATION)
        if not model:
            raise ProviderExecutionError("OpenAI text-generation model is not configured")
        input_items = []
        if request.system_prompt:
            input_items.append({"role": "system", "content": request.system_prompt})
        input_items.append({"role": "user", "content": request.prompt})
        payload: dict[str, object] = {"model": model, "input": input_items, "store": False, "stream": True}
        if request.temperature is not None:
            payload["temperature"] = request.temperature
        if request.max_output_tokens is not None:
            payload["max_output_tokens"] = request.max_output_tokens
        if request.response_schema:
            payload["text"] = {"format": {"type": "json_schema", "name": "meeting_minutes", "schema": request.response_schema, "strict": True}}
        chunks: list[str] = []
        completed: dict | None = None
        try:
            async with httpx.AsyncClient(timeout=90, transport=self.transport) as client:
                async with client.stream("POST", "https://api.openai.com/v1/responses", headers={
                    "Authorization": f"Bearer {profile.api_key}", "Content-Type": "application/json",
                }, json=payload) as response:
                    if response.is_error:
                        raise ProviderExecutionError(f"OpenAI request failed ({response.status_code}): {(await response.aread()).decode(errors='replace')[:500]}")
                    async for event in json_events(response, "OpenAI"):
                        kind = event.get("type")
                        if kind == "response.output_text.delta" and isinstance(event.get("delta"), str):
                            chunks.append(event["delta"])
                            await on_delta(event["delta"])
                        elif kind == "response.completed":
                            completed = event.get("response") if isinstance(event.get("response"), dict) else {}
                        elif kind in {"response.failed", "response.incomplete", "error"}:
                            raise ProviderExecutionError(f"OpenAI response ended with {kind}")
        except httpx.RequestError as exc:
            raise ProviderExecutionError("OpenAI is unavailable") from exc
        if completed is None:
            raise ProviderExecutionError("OpenAI stream ended before completion")
        text = "".join(chunks)
        if not text:
            raise ProviderExecutionError("OpenAI returned no generated text")
        usage = completed.get("usage") if isinstance(completed.get("usage"), dict) else {}
        return TextGenerationResult(
            text=text, structured_output=_json_object(text), provider="openai", model=model,
            input_tokens=_optional_int(usage.get("input_tokens")),
            output_tokens=_optional_int(usage.get("output_tokens")),
        )

    async def embed(
        self, profile: ProviderProfile, request: EmbeddingRequest
    ) -> EmbeddingResult:
        if not profile.api_key:
            raise ProviderExecutionError("OpenAI API key is not configured")
        model = profile.models.get(Capability.EMBEDDINGS)
        if not model:
            raise ProviderExecutionError("OpenAI embedding model is not configured")
        return await create_embeddings(
            url="https://api.openai.com/v1/embeddings", api_key=profile.api_key,
            model=model, request=request, provider="openai", transport=self.transport,
        )


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
