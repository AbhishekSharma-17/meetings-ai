"""Per-person time zone and clock preferences (``user_preferences``, schema v25).

A person either follows the time zone their browser reports (``timezone`` NULL, the default)
or pins one zone by hand. The web app reports the browser zone on every load, so the stored
``detected_timezone`` follows people who travel or sign in from another country. Preferences
belong to the person, not the workspace: they apply in every workspace they belong to.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from functools import lru_cache
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .database import Database, UserPreferenceRow
from .time_display import DEFAULT_TIMEZONE, TIME_FORMATS, TimeFormat, TimePreferences

# Legacy names some browsers still report; stored under the current IANA name.
_ALIASES = {"Asia/Calcutta": "Asia/Kolkata", "Asia/Katmandu": "Asia/Kathmandu", "Asia/Saigon": "Asia/Ho_Chi_Minh",
            "Asia/Rangoon": "Asia/Yangon", "Europe/Kiev": "Europe/Kyiv", "America/Buenos_Aires": "America/Argentina/Buenos_Aires"}
_NOT_A_PLACE = frozenset({"Factory", "localtime", "posixrules"})
MAX_ZONE_LENGTH = 64


class InvalidTimezoneError(ValueError):
    pass


class PreferencesPublic(BaseModel):
    timezone: str
    timezone_source: Literal["browser", "manual"]
    detected_timezone: str | None
    time_format: TimeFormat


class PreferencesUpdate(BaseModel):
    """Only the fields sent are changed. ``timezone: null`` means "follow my browser"."""

    model_config = ConfigDict(extra="forbid")

    timezone: str | None = Field(default=None, max_length=MAX_ZONE_LENGTH)
    time_format: TimeFormat | None = None


class DetectedTimezone(BaseModel):
    model_config = ConfigDict(extra="forbid")

    timezone: str = Field(min_length=1, max_length=MAX_ZONE_LENGTH)


@lru_cache(maxsize=1)
def _known_zones() -> frozenset[str]:
    from zoneinfo import available_timezones

    return frozenset(available_timezones()) - _NOT_A_PLACE


def valid_timezone(name: str) -> str:
    """The canonical IANA name, or ``InvalidTimezoneError`` with a readable message."""
    raw = name.strip()
    candidate = _ALIASES.get(raw, raw)
    if candidate not in _known_zones():
        candidate = raw  # older tzdata without the newer name: keep what the browser sent
    if len(candidate) > MAX_ZONE_LENGTH or candidate not in _known_zones():
        raise InvalidTimezoneError("choose a valid time zone, for example Asia/Kolkata or America/New_York")
    return candidate


def _public(row: UserPreferenceRow | None) -> PreferencesPublic:
    if row is None:
        return PreferencesPublic(timezone=DEFAULT_TIMEZONE, timezone_source="browser",
                                 detected_timezone=None, time_format="auto")
    return PreferencesPublic(
        timezone=row.timezone or row.detected_timezone or DEFAULT_TIMEZONE,
        timezone_source="manual" if row.timezone else "browser",
        detected_timezone=row.detected_timezone,
        time_format=row.time_format if row.time_format in TIME_FORMATS else "auto",
    )


def _to_preferences(row: UserPreferenceRow | None) -> TimePreferences:
    public = _public(row)
    return TimePreferences(timezone=public.timezone, time_format=public.time_format)


class UserPreferenceService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def get(self, user_id: UUID | str) -> PreferencesPublic:
        with self.database.session_factory() as session:
            return _public(session.get(UserPreferenceRow, str(user_id)))

    def time_preferences(self, user_id: UUID | str) -> TimePreferences:
        with self.database.session_factory() as session:
            return _to_preferences(session.get(UserPreferenceRow, str(user_id)))

    def update(self, user_id: UUID | str, payload: PreferencesUpdate) -> PreferencesPublic:
        changes: dict[str, str | None] = {}
        if "timezone" in payload.model_fields_set:
            changes["timezone"] = valid_timezone(payload.timezone) if payload.timezone else None
        if "time_format" in payload.model_fields_set and payload.time_format is not None:
            changes["time_format"] = payload.time_format
        return self._write(user_id, changes)

    def record_detected(self, user_id: UUID | str, timezone: str) -> PreferencesPublic:
        """Called on every web app load; writes only when the browser zone actually changed."""
        return self._write(user_id, {"detected_timezone": valid_timezone(timezone)})

    def _write(self, user_id: UUID | str, changes: dict[str, str | None]) -> PreferencesPublic:
        try:
            return self._apply(user_id, changes)
        except IntegrityError:
            # Two first requests (e.g. two tabs reporting the browser zone) raced to create the row.
            return self._apply(user_id, changes)

    def _apply(self, user_id: UUID | str, changes: dict[str, str | None]) -> PreferencesPublic:
        with self.database.session_factory.begin() as session:
            row = session.get(UserPreferenceRow, str(user_id))
            if row is None:
                row = UserPreferenceRow(user_id=str(user_id), timezone=None, detected_timezone=None,
                                        time_format="auto", updated_at=datetime.now(UTC))
                session.add(row)
            changed = {key: value for key, value in changes.items() if getattr(row, key) != value}
            for key, value in changed.items():
                setattr(row, key, value)
            if changed:
                row.updated_at = datetime.now(UTC)
            session.flush()
            return _public(row)


def load_time_preferences(database: Database, user_ids: Iterable[UUID | str]) -> dict[str, TimePreferences]:
    """Preferences for many readers in one query; people without a row read UTC."""
    wanted = sorted({str(user_id) for user_id in user_ids if user_id})
    if not wanted:
        return {}
    with database.session_factory() as session:
        rows = session.execute(select(UserPreferenceRow).where(UserPreferenceRow.user_id.in_(wanted))).scalars().all()
        found = {row.user_id: _to_preferences(row) for row in rows}
    return {user_id: found.get(user_id, TimePreferences()) for user_id in wanted}
