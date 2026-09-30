"""What each connected calendar account holds, and disconnecting one without surprises.

The Integrations page shows, per account: whether an Outlook account is a work/school account or a
personal Microsoft account (a personal one never sees meetings sent to the work mailbox, the usual
reason "my meeting isn't showing"), how many meetings the last sync found, how many assistants are
scheduled from it, and whether the same mailbox is connected twice.

Disconnecting asks what happens to the assistants scheduled from the account: keep them (they join
at the saved time and link; reconnecting re-attaches them, see ``calendar_relink``) or cancel them.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy import func, select, update

from .accounts import Actor
from .calendar_cache import CalendarCacheService
from .composio_calendar import CalendarConnection, CalendarError, provider_name
from .database import (
    CalendarEventCacheRow,
    CalendarScheduleRow,
    CalendarSyncStateRow,
    Database,
)

logger = logging.getLogger(__name__)
AccountType = Literal["work", "personal"]
ScheduledChoice = Literal["keep", "cancel"]
PROFILE_TTL = timedelta(hours=12)
PROFILE_RETRY = timedelta(minutes=10)
PROFILE_TIMEOUT_SECONDS = 6.0
# Microsoft Graph ids: a work/school (Entra) user is a GUID, a personal Microsoft account 16 hex digits.
_GUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
_PERSONAL_ID = re.compile(r"[0-9a-f]{16}", re.IGNORECASE)


class CalendarAccountOverview(CalendarConnection):
    account_type: AccountType | None = None
    meetings_found: int | None = None  # None until the account's first sync
    last_synced_at: datetime | None = None
    scheduled: int = 0
    same_account_as: str | None = None  # another connection id for the same mailbox


class CalendarDisconnectResult(BaseModel):
    cancelled: int
    kept: int


@dataclass(frozen=True)
class _Profile:
    account_type: AccountType | None
    key: str | None  # stable mailbox identity, for spotting the same account connected twice


def outlook_account_type(profile_id: object) -> AccountType | None:
    value = str(profile_id or "")
    if _GUID.fullmatch(value):
        return "work"
    if _PERSONAL_ID.fullmatch(value):
        return "personal"
    return None


def _utc(value: datetime) -> datetime:
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC)


class CalendarAccountService:
    def __init__(self, database: Database, calendar: Any, cache: CalendarCacheService) -> None:
        self.database = database
        self.calendar = calendar
        self.cache = cache
        self._profiles: dict[str, tuple[datetime, _Profile]] = {}

    # ----- overview -------------------------------------------------------------------------
    async def overview(self, actor: Actor) -> list[CalendarAccountOverview]:
        connections = await self.calendar.connections(actor)
        profiles = await asyncio.gather(*(self._profile(actor, item) for item in connections))
        counts = self._counts(actor, [item.id for item in connections])
        first_with: dict[tuple[str, str], str] = {}
        result = []
        for connection, profile in zip(connections, profiles, strict=True):
            key = (connection.provider, profile.key) if profile.key else None
            duplicate_of = first_with.get(key) if key else None
            if key and duplicate_of is None:
                first_with[key] = connection.id
            found, synced_at, scheduled = counts.get(connection.id, (None, None, 0))
            result.append(CalendarAccountOverview(
                **connection.model_dump(), account_type=profile.account_type, meetings_found=found,
                last_synced_at=synced_at, scheduled=scheduled, same_account_as=duplicate_of,
            ))
        return result

    async def _profile(self, actor: Actor, connection: CalendarConnection) -> _Profile:
        identity = (connection.identity or "").strip().lower()
        fallback = _Profile(None, identity if "@" in identity else None)
        if connection.provider != "outlook" or connection.status != "ACTIVE":
            return fallback
        now = datetime.now(UTC)
        cached = self._profiles.get(connection.id)
        if cached is not None and now < cached[0]:
            return cached[1]
        try:
            data = await asyncio.wait_for(self.calendar.outlook_profile(actor, connection), PROFILE_TIMEOUT_SECONDS)
        except (CalendarError, TimeoutError) as exc:
            logger.warning("could not read the Microsoft profile of an Outlook connection: %s", exc or "timed out")
            self._profiles[connection.id] = (now + PROFILE_RETRY, fallback)
            return fallback
        profile_id = str(data.get("id") or "").strip().lower()
        profile = _Profile(outlook_account_type(profile_id), profile_id or fallback.key)
        self._profiles[connection.id] = (now + PROFILE_TTL, profile)
        return profile

    def _counts(self, actor: Actor, connection_ids: list[str]) -> dict[str, tuple[int | None, datetime | None, int]]:
        organization_id, user_id = str(actor.organization_id), str(actor.user_id)
        now = datetime.now(UTC)
        counts: dict[str, tuple[int | None, datetime | None, int]] = {}
        with self.database.session_factory() as session:
            states = {row.connection_id: row for row in session.execute(select(CalendarSyncStateRow).where(
                CalendarSyncStateRow.organization_id == organization_id, CalendarSyncStateRow.user_id == user_id,
            )).scalars()}
            scheduled = dict(session.execute(select(CalendarScheduleRow.connection_id, func.count()).where(
                CalendarScheduleRow.organization_id == organization_id, CalendarScheduleRow.user_id == user_id,
                CalendarScheduleRow.status == "pending", CalendarScheduleRow.starts_at > now - timedelta(minutes=10),
            ).group_by(CalendarScheduleRow.connection_id)).all())
            for connection_id in connection_ids:
                state = states.get(connection_id)
                found = None
                if state is not None:
                    found = session.execute(select(func.count()).select_from(CalendarEventCacheRow).where(
                        CalendarEventCacheRow.organization_id == organization_id,
                        CalendarEventCacheRow.user_id == user_id,
                        CalendarEventCacheRow.connection_id == connection_id,
                        CalendarEventCacheRow.starts_at >= _utc(state.range_start),
                        CalendarEventCacheRow.starts_at < _utc(state.range_end),
                    )).scalar_one()
                counts[connection_id] = (found, state.last_synced_at if state else None,
                                         int(scheduled.get(connection_id, 0)))
        return counts

    # ----- disconnect -----------------------------------------------------------------------
    async def disconnect(self, actor: Actor, connection_id: str, scheduled: ScheduledChoice) -> CalendarDisconnectResult:
        connection = next((item for item in await self.calendar.connections(actor) if item.id == connection_id), None)
        await self.calendar.disconnect(actor, connection_id)
        # The account's meetings disappear from the calendar immediately, not on the next sync.
        self.cache.forget_connection(actor, connection_id)
        self._profiles.pop(connection_id, None)
        now = datetime.now(UTC)
        pending = (
            CalendarScheduleRow.organization_id == str(actor.organization_id),
            CalendarScheduleRow.user_id == str(actor.user_id),
            CalendarScheduleRow.connection_id == connection_id,
            CalendarScheduleRow.status == "pending",
        )
        with self.database.session_factory.begin() as session:
            if scheduled == "cancel":
                name = provider_name(connection.provider) if connection else "the calendar"
                cancelled = session.execute(update(CalendarScheduleRow).where(*pending).values(
                    status="cancelled", last_error=f"Cancelled when {name} was disconnected", updated_at=now,
                )).rowcount
                return CalendarDisconnectResult(cancelled=int(cancelled or 0), kept=0)
            kept = session.execute(select(func.count()).select_from(CalendarScheduleRow).where(*pending)).scalar_one()
        return CalendarDisconnectResult(cancelled=0, kept=int(kept))
