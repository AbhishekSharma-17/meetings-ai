"""In-process sliding-window limits for endpoints that spend money on external providers.

The API runs as a single replica (see docs/deployment/railway.md), so process memory is
an adequate store. A multi-replica deployment needs a shared store before scaling out.
"""

from __future__ import annotations

from collections import deque
from time import monotonic

from fastapi import HTTPException


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float, message: str) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self.message = message
        self._events: dict[str, deque[float]] = {}

    def check(self, key: object) -> None:
        """Record one attempt for ``key`` or raise 429 when the window is full."""
        now = monotonic()
        events = self._events.setdefault(str(key), deque())
        while events and events[0] <= now - self.window_seconds:
            events.popleft()
        if len(events) >= self.limit:
            raise HTTPException(status_code=429, detail=self.message)
        events.append(now)


def provider_test_limiter() -> SlidingWindowLimiter:
    """Live key/profile checks call paid provider APIs (Exa bills every search)."""
    return SlidingWindowLimiter(10, 600, "too many connection tests; try again in a few minutes")


def provider_defaults_limiter() -> SlidingWindowLimiter:
    """Changing workspace-wide provider defaults reroutes every later call."""
    return SlidingWindowLimiter(30, 600, "too many default changes; try again in a few minutes")


def prep_generation_limiter() -> SlidingWindowLimiter:
    """One briefing can make up to 12 Exa calls and 3 LLM calls."""
    return SlidingWindowLimiter(10, 3600, "briefing limit reached (10 per hour); try again later")
