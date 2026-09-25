"""Small SSE reader shared by text-generation adapters."""

import json
from collections.abc import AsyncIterator

import httpx

from .base import ProviderExecutionError


async def json_events(response: httpx.Response, provider: str) -> AsyncIterator[dict]:
    data: list[str] = []
    async for line in response.aiter_lines():
        if not line:
            if data:
                raw = "\n".join(data)
                data = []
                if raw == "[DONE]":
                    return
                try:
                    value = json.loads(raw)
                except ValueError as exc:
                    raise ProviderExecutionError(f"{provider} returned an invalid stream event") from exc
                if isinstance(value, dict):
                    yield value
            continue
        if line.startswith("data:"):
            data.append(line[5:].lstrip())
    if data:
        raw = "\n".join(data)
        if raw != "[DONE]":
            try:
                value = json.loads(raw)
            except ValueError as exc:
                raise ProviderExecutionError(f"{provider} returned an invalid stream event") from exc
            if isinstance(value, dict):
                yield value
