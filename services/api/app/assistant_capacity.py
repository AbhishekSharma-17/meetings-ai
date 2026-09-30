"""How many meeting assistants can be in calls at once, how many are, and how many joins wait.

The limit is the Vexa account's ``max_concurrent_bots`` (every workspace shares the platform's one
account); "in use" is Vexa's own list of running bots. Both come from Vexa and are cached briefly,
so the Observability page and the overview can poll without hammering it. ``ASSISTANT_TESTED_CAPACITY``
(optional) records what a load test showed the current server holds, which can differ from the
account limit.
"""

from __future__ import annotations

import asyncio
import os
import time
from datetime import UTC, datetime

from pydantic import BaseModel
from sqlalchemy import func, select

from .adapters.vexa import ASSISTANTS_BUSY, VexaAPIError
from .database import CalendarScheduleRow, Database

CACHE_SECONDS = 20.0
LOOKUP_TIMEOUT_SECONDS = 5.0


class AssistantCapacity(BaseModel):
    limit: int | None  # None: Vexa didn't say (or is unreachable)
    in_use: int | None
    available: int | None
    waiting: int  # joins in line for a free assistant (all workspaces)
    tested_capacity: int | None
    checked_at: datetime
    error: str | None = None


def _tested_capacity() -> int | None:
    value = os.getenv("ASSISTANT_TESTED_CAPACITY", "").strip()
    return int(value) if value.isdigit() and int(value) > 0 else None


class AssistantCapacityService:
    def __init__(self, database: Database, vexa) -> None:
        self.database = database
        self.vexa = vexa
        self._cached: tuple[float, AssistantCapacity] | None = None

    async def snapshot(self) -> AssistantCapacity:
        if self._cached and time.monotonic() - self._cached[0] < CACHE_SECONDS:
            return self._cached[1].model_copy(update={"waiting": self._waiting()})
        limit = in_use = None
        error = None
        try:
            identity, running = await asyncio.wait_for(asyncio.gather(
                self.vexa.preflight(), self.vexa.list_running_bots()), LOOKUP_TIMEOUT_SECONDS)
            raw = identity.get("max_concurrent") or identity.get("max_concurrent_bots")
            limit = int(raw) if isinstance(raw, int | str) and str(raw).isdigit() else None
            in_use = len(running)
        except (VexaAPIError, TimeoutError) as exc:
            error = "The assistant service couldn't be reached" if isinstance(exc, TimeoutError) else exc.detail
        available = max(limit - in_use, 0) if limit is not None and in_use is not None else None
        snapshot = AssistantCapacity(limit=limit, in_use=in_use, available=available, waiting=self._waiting(),
                                     tested_capacity=_tested_capacity(), checked_at=datetime.now(UTC), error=error)
        if error is None:
            self._cached = (time.monotonic(), snapshot)
        return snapshot

    def _waiting(self) -> int:
        with self.database.session_factory() as session:
            return int(session.execute(select(func.count()).select_from(CalendarScheduleRow).where(
                CalendarScheduleRow.status == "pending", CalendarScheduleRow.last_error == ASSISTANTS_BUSY,
            )).scalar_one())
