from app.meeting_links import parse_meeting_url
from meetings_contracts import MeetingPlatform


def test_parses_supported_meeting_platform_urls() -> None:
    assert parse_meeting_url("https://meet.google.com/abc-defg-hij") == (
        MeetingPlatform.GOOGLE_MEET,
        "abc-defg-hij",
    )
    assert parse_meeting_url("https://us06web.zoom.us/j/12345678901?pwd=secret") == (
        MeetingPlatform.ZOOM,
        "12345678901",
    )
    assert parse_meeting_url(
        "https://teams.microsoft.com/l/meetup-join/19%3ameeting_example%40thread.v2/0"
    ) == (MeetingPlatform.TEAMS, "19:meeting_example@thread.v2")
    assert parse_meeting_url("https://meet.jit.si/MeetingsAiWitness") == (
        MeetingPlatform.JITSI,
        "MeetingsAiWitness",
    )


def test_rejects_lookalike_hosts() -> None:
    assert parse_meeting_url("https://meet.google.com.example.org/abc-defg-hij") is None
    assert parse_meeting_url("https://notzoom.example.org/j/12345678901") is None
    assert parse_meeting_url("https://jitsi.example.org/room") is None
