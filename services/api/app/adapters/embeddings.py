"""Shared OpenAI-style embedding response handling for cloud and local routes."""

import math

import httpx

from meetings_contracts import EmbeddingRequest, EmbeddingResult

from .base import ProviderExecutionError


async def create_embeddings(
    *, url: str, api_key: str | None, model: str, request: EmbeddingRequest,
    provider: str, transport: httpx.AsyncBaseTransport | None,
) -> EmbeddingResult:
    if len(request.inputs) > 128 or any(not text.strip() for text in request.inputs):
        raise ProviderExecutionError("embedding inputs must be 1–128 nonempty strings")
    payload: dict[str, object] = {
        "model": model,
        "input": request.inputs,
        "encoding_format": "float",
    }
    if request.dimensions is not None:
        payload["dimensions"] = request.dimensions
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        async with httpx.AsyncClient(timeout=90, transport=transport) as client:
            response = await client.post(url, headers=headers, json=payload)
    except httpx.RequestError as exc:
        raise ProviderExecutionError(f"{provider} embedding provider is unavailable") from exc
    if response.is_error:
        # Providers sometimes echo submitted content or credentials in errors.
        raise ProviderExecutionError(f"{provider} embedding request failed ({response.status_code})")
    try:
        body = response.json()
        data = body["data"]
        if not isinstance(data, list) or len(data) != len(request.inputs):
            raise ValueError("embedding count mismatch")
        vectors: list[list[float] | None] = [None] * len(request.inputs)
        width: int | None = None
        for item in data:
            index = item["index"]
            raw = item["embedding"]
            if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(vectors):
                raise ValueError("invalid embedding index")
            if vectors[index] is not None or not isinstance(raw, list) or not raw:
                raise ValueError("invalid embedding vector")
            if any(isinstance(value, bool) or not isinstance(value, (int, float))
                   or not math.isfinite(value) for value in raw):
                raise ValueError("invalid embedding value")
            if width is None:
                width = len(raw)
            elif len(raw) != width:
                raise ValueError("embedding dimensions differ")
            vectors[index] = [float(value) for value in raw]
        if any(vector is None for vector in vectors) or width is None:
            raise ValueError("embedding response is incomplete")
        if request.dimensions is not None and width != request.dimensions:
            raise ValueError("embedding dimensions do not match the request")
    except (ValueError, KeyError, TypeError, IndexError, OverflowError) as exc:
        raise ProviderExecutionError(f"{provider} returned invalid embeddings") from exc
    return EmbeddingResult(
        vectors=[vector for vector in vectors if vector is not None],
        provider=provider, model=model, dimensions=width,
    )
