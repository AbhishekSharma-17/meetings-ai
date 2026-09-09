import re
from urllib.parse import unquote, urlparse

from meetings_contracts import MeetingPlatform


_GOOGLE_MEET_ID = re.compile(r"^[a-z]{3}-[a-z]{4}-[a-z]{3}$")
_ZOOM_ID = re.compile(r"\d{9,11}")
_TEAMS_THREAD = re.compile(r"19:meeting_[^@%\s/]{1,256}@thread\.v2", re.IGNORECASE)
_TEAMS_SHORT = re.compile(r"/meet/([^/?#]+)", re.IGNORECASE)


def parse_meeting_url(value: str) -> tuple[MeetingPlatform, str] | None:
    parsed = urlparse(value.strip())
    host = (parsed.hostname or "").lower()
    if host == "meet.google.com" or host.endswith(".meet.google.com"):
        code = next((part for part in reversed(parsed.path.split("/")) if part), "").lower()
        if _GOOGLE_MEET_ID.fullmatch(code):
            return MeetingPlatform.GOOGLE_MEET, code
    if host == "zoom.us" or host.endswith(".zoom.us"):
        match = _ZOOM_ID.search(parsed.path) or _ZOOM_ID.search(parsed.query)
        if match:
            return MeetingPlatform.ZOOM, match.group(0)
    if host in {"teams.microsoft.com", "teams.live.com"} or host.endswith(
        (".teams.microsoft.com", ".teams.live.com")
    ):
        decoded = unquote(value)
        thread = _TEAMS_THREAD.search(decoded)
        if thread:
            return MeetingPlatform.TEAMS, thread.group(0)
        short = _TEAMS_SHORT.search(parsed.path)
        if short:
            return MeetingPlatform.TEAMS, short.group(1)
    if host == "meet.jit.si":
        room = parsed.path.strip("/")
        if room and "/" not in room and not any(char.isspace() for char in room):
            return MeetingPlatform.JITSI, room
    return None
