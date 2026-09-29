"""Render a moment in time for one person: their time zone and their 12/24-hour clock.

Server-rendered text (notifications, emails) never knows the reader's browser, so it uses the
stored per-user preference (see ``user_preferences``). Anything unknown falls back to UTC, and
the zone is always named in the text so a reader can never mistake whose clock it is.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

TimeFormat = Literal["auto", "12h", "24h"]
TIME_FORMATS: tuple[TimeFormat, ...] = ("auto", "12h", "24h")
DEFAULT_TIMEZONE = "UTC"

# "auto" follows the reader's locale in the browser. The server has no locale, so it uses the
# clock most people in the zone read: the 12-hour clock is the norm in these regions.
_TWELVE_HOUR_PREFIXES = ("America/", "Australia/", "Canada/", "US/")
_TWELVE_HOUR_ZONES = frozenset({
    "Asia/Kolkata", "Asia/Calcutta", "Asia/Karachi", "Asia/Dhaka", "Asia/Manila", "Asia/Riyadh",
    "Africa/Cairo", "Pacific/Auckland", "Pacific/Honolulu",
})
# Latin America mostly reads a 24-hour clock even though its zones share the America/ prefix.
_TWENTY_FOUR_HOUR_AMERICAS = ("America/Sao_Paulo", "America/Argentina/", "America/Buenos_Aires", "America/Santiago",
                              "America/Lima", "America/Montevideo", "America/Caracas", "America/Havana")


@dataclass(frozen=True)
class TimePreferences:
    """How one person reads times. ``timezone`` is always the effective IANA zone."""

    timezone: str = DEFAULT_TIMEZONE
    time_format: TimeFormat = "auto"


UTC_PREFERENCES = TimePreferences()


@lru_cache(maxsize=512)
def zone_for(name: str | None) -> ZoneInfo:
    """The named zone, or UTC when the name is missing or unknown (never raises)."""
    try:
        return ZoneInfo(name) if name else ZoneInfo(DEFAULT_TIMEZONE)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(DEFAULT_TIMEZONE)


def uses_twelve_hour_clock(preferences: TimePreferences) -> bool:
    if preferences.time_format != "auto":
        return preferences.time_format == "12h"
    zone = preferences.timezone
    if zone.startswith(_TWENTY_FOUR_HOUR_AMERICAS):
        return False
    return zone in _TWELVE_HOUR_ZONES or zone.startswith(_TWELVE_HOUR_PREFIXES)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def zone_abbreviation(local: datetime) -> str:
    """IST, EDT, CET… or UTC+4 / UTC-3:30 for zones that have no common abbreviation."""
    name = local.strftime("%Z")
    if not name or name[0] not in "+-":
        return name or DEFAULT_TIMEZONE
    offset = local.utcoffset()
    minutes = int(offset.total_seconds() // 60) if offset else 0
    sign = "+" if minutes >= 0 else "-"
    hours, rest = divmod(abs(minutes), 60)
    return f"UTC{sign}{hours}" + (f":{rest:02d}" if rest else "")


def _clock(local: datetime, twelve_hour: bool) -> str:
    if twelve_hour:
        hour = local.hour % 12 or 12
        return f"{hour}:{local.minute:02d} {'AM' if local.hour < 12 else 'PM'}"
    return f"{local.hour:02d}:{local.minute:02d}"


def localize(value: datetime, preferences: TimePreferences = UTC_PREFERENCES) -> datetime:
    return _aware(value).astimezone(zone_for(preferences.timezone))


def format_time(value: datetime, preferences: TimePreferences = UTC_PREFERENCES) -> str:
    """``4:12 PM IST`` or ``16:12 CEST``."""
    local = localize(value, preferences)
    return f"{_clock(local, uses_twelve_hour_clock(preferences))} {zone_abbreviation(local)}"


def format_datetime(value: datetime, preferences: TimePreferences = UTC_PREFERENCES) -> str:
    """``Mon, Sep 28, 4:12 PM IST``; the year is added when it is not the current one."""
    local = localize(value, preferences)
    now = datetime.now(local.tzinfo)
    day = f"{local:%a}, {local:%b} {local.day}" + (f", {local.year}" if local.year != now.year else "")
    return f"{day}, {_clock(local, uses_twelve_hour_clock(preferences))} {zone_abbreviation(local)}"


def format_day_time(value: datetime, preferences: TimePreferences = UTC_PREFERENCES) -> str:
    """``Mon 3:00 PM IST`` within a week of now, otherwise the full ``format_datetime`` form."""
    local = localize(value, preferences)
    if abs(local - datetime.now(local.tzinfo)).days >= 6:
        return format_datetime(value, preferences)
    return f"{local:%a} {_clock(local, uses_twelve_hour_clock(preferences))} {zone_abbreviation(local)}"
