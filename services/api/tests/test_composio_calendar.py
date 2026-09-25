"""Calendar discovery is user-scoped and only returns supported meeting links."""

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from app.accounts import Actor
from app.composio_calendar import CalendarConnectResponse, CalendarError, CalendarEvent, ComposioCalendar, calendar_callback_url, calendar_window
from app.main import create_app
from app.database import CalendarScheduleRow


def _actor() -> Actor:
    from app.database import LEGACY_ADMIN_USER_ID, LEGACY_ORGANIZATION_ID
    return Actor(
        user_id=LEGACY_ADMIN_USER_ID, organization_id=LEGACY_ORGANIZATION_ID,
        email="calendar@example.com", display_name="Calendar Tester", role="owner",
        must_change_password=False, session_version=0,
    )


def test_calendar_window_respects_local_week_and_time_zone() -> None:
    start, end = calendar_window("next_week", "America/New_York", datetime(2026, 9, 25, 12, tzinfo=UTC))
    assert start.isoformat() == "2026-09-28T00:00:00-04:00"
    assert end.isoformat() == "2026-10-05T00:00:00-04:00"


def test_callback_uses_browser_visible_loopback_port_without_allowing_external_redirect() -> None:
    assert calendar_callback_url("http://localhost:59631", "http://localhost:3020", "development") == \
        "http://localhost:59631/?calendar=connected"
    with pytest.raises(CalendarError, match="not allowed"):
        calendar_callback_url("https://attacker.example", "http://localhost:3020", "development")
    with pytest.raises(CalendarError, match="not allowed"):
        calendar_callback_url("https://attacker.example", "https://app.example", "production")
    with pytest.raises(CalendarError, match="must use HTTPS"):
        calendar_callback_url(None, "http://localhost:3020", "production")


def test_connect_route_passes_browser_origin_to_composio(tmp_path) -> None:
    class FakeCalendar:
        callback: str | None = None

        async def connect(self, actor, provider, callback_url):
            self.callback = callback_url
            return CalendarConnectResponse(redirect_url="https://connect.composio.dev/example")

    fake = FakeCalendar()
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'callback.db'}",
                     credential_key="test-only-credential-key", calendar_adapter=fake)
    with TestClient(app) as client:
        response = client.post("/v1/calendar/connect/outlook", json={"callback_origin": "http://localhost:59631"})
        assert response.status_code == 200
        assert fake.callback == "http://localhost:59631/?calendar=connected"
        denied = client.post("/v1/calendar/connect/outlook", json={"callback_origin": "https://attacker.example"})
        assert denied.status_code == 400


def test_composio_tool_scan_filters_non_meetings_and_uses_explicit_account() -> None:
    actor = _actor()
    start, _ = calendar_window("tomorrow", "UTC")
    event_time = start + timedelta(hours=9)
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/connected_accounts"):
            return httpx.Response(200, json={"items": [
                {"id": "ca-own", "toolkit": {"slug": "googlecalendar"}, "user_id":
                 f"meetings-ai:{actor.organization_id}:{actor.user_id}", "status": "ACTIVE"},
                {"id": "ca-other", "toolkit": {"slug": "googlecalendar"}, "user_id": "other", "status": "ACTIVE"},
            ]})
        return httpx.Response(200, json={"successful": True, "data": {"items": [
            {"id": "meeting", "summary": "Team sync", "start": {"dateTime": event_time.isoformat()},
             "end": {"dateTime": (event_time + timedelta(hours=1)).isoformat()},
             "description": "Join https://meet.google.com/abc-defg-hij"},
            {"id": "no-link", "summary": "Lunch", "start": {"dateTime": event_time.isoformat()},
             "end": {"dateTime": (event_time + timedelta(hours=1)).isoformat()}},
        ]}})

    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(respond))
    import asyncio
    result = asyncio.run(calendar.events(actor, "ca-own", "tomorrow", "UTC"))
    assert [event.event_id for event in result.events] == ["meeting"]
    assert result.events[0].meeting_url == "https://meet.google.com/abc-defg-hij"
    assert b'"connected_account_id":"ca-own"' in requests[-1].content
    assert b'"version":"20260915_00"' in requests[-1].content


def test_schedule_refetches_calendar_event_and_can_cancel(tmp_path) -> None:
    class FakeCalendar:
        async def events(self, actor, connection_id, period, timezone):
            event = CalendarEvent(
                connection_id="ca-own", provider="googlecalendar", event_id="event-123",
                title="Customer call", starts_at=datetime.now(UTC) + timedelta(hours=4),
                ends_at=datetime.now(UTC) + timedelta(hours=5),
                meeting_url="https://meet.google.com/abc-defg-hij", platform="google_meet",
            )
            return type("Result", (), {"events": [event]})()

    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'calendar.db'}",
        credential_key="test-only-credential-key", calendar_adapter=FakeCalendar(),
    )
    with TestClient(app) as client:
        response = client.post("/v1/calendar/schedules", json={
            "connection_id": "ca-own", "event_id": "event-123", "period": "today", "timezone": "UTC",
            "meeting": {"meeting_url": "https://meet.google.com/attacker-link", "bot_name": "Team assistant"},
        })
        assert response.status_code == 201, response.text
        meeting_id = response.json()["meeting"]["id"]
        assert response.json()["meeting"]["meeting_url"] == "https://meet.google.com/abc-defg-hij"
        assert client.get("/v1/calendar/schedules").json()[0]["status"] == "pending"
        assert client.post(f"/v1/calendar/schedules/{meeting_id}/cancel").json()["status"] == "cancelled"
        assert client.get(f"/v1/meetings/{meeting_id}").status_code == 200


def test_missed_schedule_does_not_join_an_expired_call(tmp_path) -> None:
    class FakeCalendar:
        async def events(self, actor, connection_id, period, timezone):
            return type("Result", (), {"events": [CalendarEvent(
                connection_id="ca-own", provider="googlecalendar", event_id="event-456",
                title="Expired meeting", starts_at=datetime.now(UTC) + timedelta(hours=2),
                ends_at=datetime.now(UTC) + timedelta(hours=3),
                meeting_url="https://meet.google.com/abc-defg-hij", platform="google_meet",
            )]})()

    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'missed.db'}",
                     credential_key="test-only-credential-key", calendar_adapter=FakeCalendar())
    with TestClient(app) as client:
        created = client.post("/v1/calendar/schedules", json={
            "connection_id": "ca-own", "event_id": "event-456", "period": "today",
            "meeting": {"meeting_url": "https://meet.google.com/abc-defg-hij"},
        })
        assert created.status_code == 201
        meeting_id = created.json()["meeting"]["id"]
        with app.state.database.session_factory.begin() as session:
            session.execute(update(CalendarScheduleRow).where(CalendarScheduleRow.meeting_id == meeting_id).values(
                starts_at=datetime.now(UTC) - timedelta(hours=2),
                ends_at=datetime.now(UTC) - timedelta(hours=1),
            ))
        import asyncio
        asyncio.run(app.state.calendar_schedule.tick())
        assert client.get(f"/v1/calendar/schedules/{meeting_id}").json()["status"] == "missed"
        assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] == "created"
