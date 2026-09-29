"""Shared, minimal HTTP access to Composio's v3.1 REST API (calendar discovery and Apollo research).

Only the fixed Composio host is ever called. The project API key (``COMPOSIO_API_KEY``) travels in the
``x-api-key`` header and is never logged or included in exceptions; neither are request bodies, which
may carry a customer's API key when a connected account is created.

API reference: https://docs.composio.dev/reference/api-reference (v3.1, base
``https://backend.composio.dev/api/v3.1``).
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3.1"
DEFAULT_TIMEOUT_SECONDS = 25.0


class ComposioHttpError(RuntimeError):
    """A sanitized Composio failure. ``status_code`` is None for network errors and timeouts."""

    def __init__(self, message: str, status_code: int | None = None, *, timeout: bool = False) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.timeout = timeout


def composio_api_key(explicit: str | None = None) -> str:
    return explicit if explicit is not None else os.getenv("COMPOSIO_API_KEY", "")


async def composio_request(
    api_key: str, method: str, path: str, *, params: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None, transport: httpx.AsyncBaseTransport | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS, base_url: str = COMPOSIO_BASE_URL,
) -> dict[str, Any]:
    """One JSON request to Composio; returns the decoded object or raises ``ComposioHttpError``."""
    if not api_key:
        raise ComposioHttpError("Composio is not configured on the server")
    try:
        async with httpx.AsyncClient(base_url=base_url, transport=transport, timeout=timeout) as client:
            response = await client.request(method, path, params=params, json=body, headers={"x-api-key": api_key})
            response.raise_for_status()
            payload = response.json()
    except httpx.HTTPStatusError as exc:
        logger.warning("Composio request failed: %s %s (HTTP %s)", method, _safe_path(path), exc.response.status_code)
        raise ComposioHttpError("Composio request failed", exc.response.status_code) from None
    except httpx.TimeoutException:
        logger.warning("Composio request timed out: %s %s", method, _safe_path(path))
        raise ComposioHttpError("Composio request timed out", timeout=True) from None
    except (httpx.HTTPError, ValueError):
        logger.warning("Composio request failed: %s %s", method, _safe_path(path))
        raise ComposioHttpError("Composio request failed") from None
    if not isinstance(payload, dict):
        raise ComposioHttpError("Composio returned an invalid response")
    return payload


def unwrap_tool_result(result: dict[str, Any], *, depth: int = 3) -> tuple[bool, dict[str, Any], str | None]:
    """``/tools/execute`` wraps results as ``{data, successful, error}``, sometimes nested; peel them off.

    Returns (successful, data, error text). An unexpected shape counts as unsuccessful.
    """
    current = result
    for _ in range(depth):
        if current.get("successful") is False:
            error = current.get("error")
            return False, {}, str(error)[:500] if error else None
        data = current.get("data")
        if not isinstance(data, dict):
            return False, {}, "the tool returned an invalid response"
        if "successful" not in data or "data" not in data:
            return True, data, None
        current = data
    return True, current, None


def _safe_path(path: str) -> str:
    # Connected-account ids are not secrets, but keep log lines short and query-free.
    return path.split("?", 1)[0][:120]
