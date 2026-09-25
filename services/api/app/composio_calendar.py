"""Per-user, read-only calendar discovery through Composio's versioned tools."""

from __future__ import annotations

import html
import logging
import os
import re
from datetime import UTC, datetime, time, timedelta
from typing import Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from pydantic import BaseModel, Field

from .accounts import Actor
from .meeting_links import parse_meeting_url

logger = logging.getLogger(__name__)
CalendarProvider = Literal["googlecalendar", "outlook", "calendly", "zoom"]
CalendarRange = Literal["today", "tomorrow", "this_week", "next_week"]

_TOOL = {
    "googlecalendar": "GOOGLECALENDAR_EVENTS_LIST",
    "outlook": "OUTLOOK_GET_CALENDAR_VIEW",
    "calendly": "CALENDLY_LIST_SCHEDULED_EVENTS",
    "zoom": "ZOOM_LIST_MEETINGS",
}
_VERSION_DEFAULT = {"googlecalendar": "20260915_00", "outlook": "20260922_00", "calendly": "20260915_00", "zoom": "20260903_00"}
_PROVIDER_NAME = {"googlecalendar": "Google Calendar", "outlook": "Outlook Calendar", "calendly": "Calendly", "zoom": "Zoom"}
_TIMEZONE_ALIASES = {"Asia/Calcutta": "Asia/Kolkata"}
_URL = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)


class CalendarError(RuntimeError):
    pass


class CalendarConnection(BaseModel):
    id: str
    provider: CalendarProvider
    status: str
    label: str


class CalendarConnectResponse(BaseModel):
    redirect_url: str


class CalendarConnectRequest(BaseModel):
    callback_origin: str | None = None


class CalendarEvent(BaseModel):
    connection_id: str
    provider: CalendarProvider
    event_id: str
    title: str
    starts_at: datetime
    ends_at: datetime
    meeting_url: str
    platform: str
    agenda: str | None = None
    organizer: str | None = None
    invitees: list["CalendarInvitee"] = Field(default_factory=list)


class CalendarInvitee(BaseModel):
    name: str
    email: str | None = None
    response_status: str | None = None


class CalendarEventsResponse(BaseModel):
    events: list[CalendarEvent] = Field(default_factory=list)
    range_start: datetime
    range_end: datetime
    timezone: str
    truncated: bool = False


def calendar_window(preset: CalendarRange, timezone: str, now: datetime | None = None) -> tuple[datetime, datetime]:
    timezone = _TIMEZONE_ALIASES.get(timezone, timezone)
    try:
        zone = ZoneInfo(timezone)
    except ZoneInfoNotFoundError as exc:
        raise CalendarError("choose a valid IANA time zone") from exc
    current = (now or datetime.now(UTC)).astimezone(zone)
    today = current.date()
    if preset == "today":
        first, last = today, today + timedelta(days=1)
    elif preset == "tomorrow":
        first, last = today + timedelta(days=1), today + timedelta(days=2)
    elif preset == "this_week":
        first = today - timedelta(days=today.weekday())
        last = first + timedelta(days=7)
    else:
        first = today - timedelta(days=today.weekday()) + timedelta(days=7)
        last = first + timedelta(days=7)
    return datetime.combine(first, time.min, zone), datetime.combine(last, time.min, zone)


def _user_id(actor: Actor) -> str:
    # Stable UUIDs prevent email changes or identical identities in two workspaces
    # from selecting another user's connected account.
    return f"meetings-ai:{actor.organization_id}:{actor.user_id}"


def calendar_callback_url(requested_origin: str | None, configured_origin: str, app_env: str) -> str:
    """Allow browser-visible loopback ports in development, not arbitrary redirects."""
    origin = (requested_origin or configured_origin).rstrip("/")
    try:
        parts = urlsplit(origin)
        _ = parts.port
    except ValueError as exc:
        raise CalendarError("calendar callback origin is invalid") from exc
    if (parts.scheme not in {"http", "https"} or not parts.netloc or parts.username
            or parts.password or parts.path or parts.query or parts.fragment):
        raise CalendarError("calendar callback origin is invalid")
    if app_env == "production" and parts.scheme != "https":
        raise CalendarError("calendar callback origin must use HTTPS in production")
    if origin != configured_origin.rstrip("/"):
        if app_env == "production" or parts.scheme != "http" or parts.hostname not in {"localhost", "127.0.0.1"}:
            raise CalendarError("calendar callback origin is not allowed")
    return origin + "/?calendar=connected"


def _event_time(value: object, timezone: str) -> datetime | None:
    if isinstance(value, dict):
        value = value.get("dateTime") or value.get("date_time") or value.get("dateTimeOffset")
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=ZoneInfo(timezone))
    except (ValueError, ZoneInfoNotFoundError):
        return None


def _meeting_link(item: dict) -> tuple[str, str] | None:
    candidates: list[str] = []
    for key in ("hangoutLink", "hangout_link", "onlineMeetingUrl", "online_meeting_url", "join_url", "webLink"):
        value = item.get(key)
        if isinstance(value, str):
            candidates.append(value)
    for key in ("onlineMeeting", "online_meeting", "location", "body"):
        value = item.get(key)
        if isinstance(value, dict):
            candidates.extend(str(value.get(field) or "") for field in ("joinUrl", "join_url", "displayName", "content", "location"))
        elif isinstance(value, str):
            candidates.append(value)
    for entry in (item.get("conferenceData") or {}).get("entryPoints", []) if isinstance(item.get("conferenceData"), dict) else []:
        if isinstance(entry, dict):
            candidates.append(str(entry.get("uri") or ""))
    for key in ("description", "htmlLink"):
        value = item.get(key)
        if isinstance(value, str):
            candidates.append(value)
    for candidate in candidates:
        for match in _URL.findall(html.unescape(candidate)):
            url = match.rstrip(".,;:)]}")
            parsed = parse_meeting_url(url)
            if parsed:
                return url, parsed[0].value
    return None


def _plain(value: object, limit: int = 3000) -> str | None:
    if isinstance(value, dict):
        value = value.get("content") or value.get("text")
    if not isinstance(value, str):
        return None
    clean = re.sub(r"<[^>]+>", " ", html.unescape(value))
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean[:limit] or None


def _person(item: object) -> CalendarInvitee | None:
    if not isinstance(item, dict):
        return None
    address = item.get("email") or item.get("emailAddress") or item.get("email_address")
    if isinstance(address, dict):
        name = address.get("name") or item.get("displayName") or item.get("name")
        address = address.get("address")
    else:
        name = item.get("displayName") or item.get("name") or item.get("first_name")
    email = address.strip().lower()[:254] if isinstance(address, str) and "@" in address else None
    name = _plain(name, 160) or email
    if not name:
        return None
    response = item.get("responseStatus") or item.get("response_status") or item.get("status")
    return CalendarInvitee(name=name, email=email, response_status=str(response)[:40] if response else None)


def _people(item: dict) -> list[CalendarInvitee]:
    people: list[CalendarInvitee] = []
    for key in ("attendees", "invitees", "event_guests", "event_memberships"):
        entries = item.get(key)
        for entry in entries if isinstance(entries, list) else []:
            person = _person(entry.get("user", entry) if isinstance(entry, dict) else entry)
            if person:
                people.append(person)
    seen: set[str] = set()
    unique: list[CalendarInvitee] = []
    for person in people:
        key = person.email or person.name.casefold()
        if key not in seen:
            unique.append(person)
            seen.add(key)
    return unique[:100]


def _event(item: dict, connection: CalendarConnection, timezone: str) -> CalendarEvent | None:
    if item.get("status") == "cancelled" or item.get("isCancelled") is True or item.get("is_cancelled") is True:
        return None
    link = _meeting_link(item)
    starts_at = _event_time(item.get("start") or item.get("start_time") or item.get("start_datetime"), timezone)
    ends_at = _event_time(item.get("end") or item.get("end_time") or item.get("end_datetime"), timezone)
    if not ends_at and connection.provider == "zoom" and starts_at:
        ends_at = starts_at + timedelta(minutes=max(1, min(int(item.get("duration") or 60), 720)))
    event_id = item.get("id") or item.get("event_id") or item.get("uri")
    if not link or not starts_at or not ends_at or ends_at <= starts_at or event_id is None:
        return None
    organizer = item.get("organizer") or item.get("creator") or item.get("host_email")
    if isinstance(organizer, dict):
        organizer = _person(organizer)
        organizer = organizer.name if organizer else None
    return CalendarEvent(
        connection_id=connection.id, provider=connection.provider, event_id=str(event_id),
        title=str(item.get("summary") or item.get("subject") or item.get("name") or item.get("topic") or "Untitled meeting")[:200],
        starts_at=starts_at, ends_at=ends_at, meeting_url=link[0], platform=link[1],
        agenda=_plain(item.get("description") or item.get("body") or item.get("meeting_notes_plain") or item.get("meeting_notes_html") or item.get("agenda")),
        organizer=_plain(organizer, 160), invitees=_people(item),
    )


class ComposioCalendar:
    def __init__(self, api_key: str | None = None, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.api_key = api_key if api_key is not None else os.getenv("COMPOSIO_API_KEY", "")
        self.transport = transport
        self.base_url = "https://backend.composio.dev/api/v3.1"
        self.auth_configs = {
            "googlecalendar": os.getenv("COMPOSIO_GOOGLE_CALENDAR_AUTH_CONFIG_ID", ""),
            "outlook": os.getenv("COMPOSIO_OUTLOOK_AUTH_CONFIG_ID", ""),
            "calendly": os.getenv("COMPOSIO_CALENDLY_AUTH_CONFIG_ID", ""),
            "zoom": os.getenv("COMPOSIO_ZOOM_AUTH_CONFIG_ID", ""),
        }
        self.versions = {
            "googlecalendar": os.getenv("COMPOSIO_GOOGLE_CALENDAR_VERSION") or _VERSION_DEFAULT["googlecalendar"],
            "outlook": os.getenv("COMPOSIO_OUTLOOK_VERSION") or _VERSION_DEFAULT["outlook"],
            "calendly": os.getenv("COMPOSIO_CALENDLY_VERSION") or _VERSION_DEFAULT["calendly"],
            "zoom": os.getenv("COMPOSIO_ZOOM_VERSION") or _VERSION_DEFAULT["zoom"],
        }

    @property
    def configured(self) -> bool:
        return bool(self.api_key and any(self.auth_configs.values()))

    async def _request(self, method: str, path: str, *, params: dict | None = None, body: dict | None = None) -> dict:
        if not self.api_key:
            raise CalendarError("Composio is not configured on the server")
        try:
            async with httpx.AsyncClient(base_url=self.base_url, transport=self.transport, timeout=25) as client:
                response = await client.request(method, path, params=params, json=body, headers={"x-api-key": self.api_key})
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("Composio calendar request failed: %s %s", method, path)
            raise CalendarError("calendar provider request failed; please try again or reconnect") from exc
        if not isinstance(payload, dict):
            raise CalendarError("calendar provider returned an invalid response")
        return payload

    async def connections(self, actor: Actor) -> list[CalendarConnection]:
        result = await self._request("GET", "/connected_accounts", params={"user_ids": _user_id(actor), "limit": 100})
        connections = []
        for item in result.get("items", []):
            if not isinstance(item, dict):
                continue
            provider = (item.get("toolkit") or {}).get("slug")
            if provider not in _TOOL:
                continue
            if not item.get("id") or item.get("user_id") not in {None, _user_id(actor)}:
                continue
            account_data = item.get("data") if isinstance(item.get("data"), dict) else {}
            label = item.get("alias") or account_data.get("displayName")
            if not isinstance(label, str) or not label.strip():
                label = f"{_PROVIDER_NAME[provider]} · {str(item['id'])[-4:]}"
            connections.append(CalendarConnection(
                id=str(item.get("id")), provider=provider, status=str(item.get("status") or "UNKNOWN"),
                label=label.strip()[:160],
            ))
        return connections

    async def connect(self, actor: Actor, provider: CalendarProvider, callback_url: str) -> CalendarConnectResponse:
        auth_config = self.auth_configs.get(provider)
        if not auth_config:
            raise CalendarError(f"{provider} is not configured on the server")
        parsed = urlsplit(callback_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise CalendarError("calendar callback URL is invalid")
        result = await self._request("POST", "/connected_accounts/link", body={
            "auth_config_id": auth_config, "user_id": _user_id(actor), "callback_url": callback_url,
        })
        url = result.get("redirect_url")
        if not isinstance(url, str) or urlsplit(url).scheme != "https":
            raise CalendarError("calendar provider did not return a secure connection link")
        return CalendarConnectResponse(redirect_url=url)

    async def _execute(self, actor: Actor, connection: CalendarConnection, tool: str, arguments: dict) -> dict:
        result = await self._request("POST", f"/tools/execute/{tool}", body={
            "user_id": _user_id(actor), "connected_account_id": connection.id,
            "version": self.versions[connection.provider], "arguments": arguments,
        })
        for _ in range(3):
            if result.get("successful") is False:
                raise CalendarError(f"{_PROVIDER_NAME[connection.provider]} scan failed; check account permissions or reconnect")
            data = result.get("data")
            if not isinstance(data, dict):
                raise CalendarError("meeting source returned an invalid response")
            if "successful" not in data or "data" not in data:
                return data
            result = data
        return result

    async def events(self, actor: Actor, connection_id: str, preset: CalendarRange, timezone: str) -> CalendarEventsResponse:
        timezone = _TIMEZONE_ALIASES.get(timezone, timezone)
        start, end = calendar_window(preset, timezone)
        connection = next((item for item in await self.connections(actor) if item.id == connection_id), None)
        if connection is None or connection.status != "ACTIVE":
            raise CalendarError("choose an active calendar connection owned by your account")
        if connection.provider == "googlecalendar":
            arguments = {"calendarId": "primary", "timeMin": start.isoformat(), "timeMax": end.isoformat(),
                         "singleEvents": True, "orderBy": "startTime", "maxResults": 100, "showDeleted": False}
        elif connection.provider == "outlook":
            arguments = {"start_datetime": start.isoformat(), "end_datetime": end.isoformat(),
                         "timezone": timezone, "top": 100}
        elif connection.provider == "calendly":
            identity = await self._execute(actor, connection, "CALENDLY_WHO_AM_I", {})
            user = identity.get("uri") or (identity.get("data") or {}).get("uri")
            if not isinstance(user, str) or not user.startswith("https://api.calendly.com/users/"):
                raise CalendarError("Calendly could not identify the connected user")
            arguments = {"user": user, "min_start_time": start.astimezone(UTC).isoformat(),
                         "max_start_time": end.astimezone(UTC).isoformat(), "status": "active", "count": 100}
        else:
            arguments = {"user_id": "me", "type": "upcoming", "page_size": 100}
        records: list[CalendarEvent] = []
        token: str | None = None
        truncated = False
        for page in range(3):
            if token:
                arguments["pageToken" if connection.provider == "googlecalendar" else "next_page_token" if connection.provider == "zoom" else "page_token"] = token
            data = await self._execute(actor, connection, _TOOL[connection.provider], arguments)
            items = data.get("items") or data.get("events") or data.get("value") or data.get("collection") or data.get("meetings") or []
            if not isinstance(items, list):
                raise CalendarError("calendar provider returned an invalid event list")
            for item in items:
                event = _event(item, connection, timezone) if isinstance(item, dict) else None
                if event and event.ends_at.astimezone(UTC) > datetime.now(UTC) and start <= event.starts_at.astimezone(start.tzinfo) < end:
                    records.append(event)
            token = data.get("nextPageToken") or data.get("next_page_token") or (data.get("pagination") or {}).get("next_page_token")
            if not token:
                break
            if page == 2:
                truncated = True
        if connection.provider == "calendly":
            enriched = []
            for event in records:
                event_uuid = event.event_id.rstrip("/").rsplit("/", 1)[-1]
                if len(enriched) < 40:
                    try:
                        people = await self._execute(actor, connection, "CALENDLY_LIST_EVENT_INVITEES", {"uuid": event_uuid, "count": 100, "status": "active"})
                        event.invitees = _people({"invitees": [*([person.model_dump() for person in event.invitees]), *(people.get("collection") or [])]})
                    except CalendarError:
                        logger.warning("Calendly invitees unavailable for a discovered event")
                enriched.append(event)
            records = enriched
            if len(records) > 40:
                truncated = True
        unique = {(event.event_id, event.starts_at): event for event in records}
        return CalendarEventsResponse(
            events=sorted(unique.values(), key=lambda event: event.starts_at),
            range_start=start, range_end=end, timezone=timezone, truncated=truncated,
        )
