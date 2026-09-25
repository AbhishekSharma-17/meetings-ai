"""Calendar discovery is user-scoped and only returns supported meeting links."""

import asyncio
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from app.accounts import Actor
from app.composio_calendar import CalendarConnection, CalendarConnectResponse, CalendarError, CalendarEvent, ComposioCalendar, calendar_callback_url, calendar_window
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
    # Some browsers still report this historical alias.
    assert calendar_window("today", "Asia/Calcutta") == calendar_window("today", "Asia/Kolkata")


def test_callback_uses_browser_visible_loopback_port_without_allowing_external_redirect() -> None:
    assert calendar_callback_url("http://localhost:59631", "http://localhost:3020", "development") == \
        "http://localhost:59631/?calendar=connected"
    with pytest.raises(CalendarError, match="not allowed"):
        calendar_callback_url("https://attacker.example", "http://localhost:3020", "development")
    assert calendar_callback_url("https://attacker.example", "https://app.example", "production") == \
        "https://app.example/?calendar=connected"
    assert calendar_callback_url("https://old-railway.example", "https://meeting.genaiprotos.com", "production") == \
        "https://meeting.genaiprotos.com/?calendar=connected"
    with pytest.raises(CalendarError, match="must use HTTPS"):
        calendar_callback_url(None, "http://localhost:3020", "production")


def test_connect_route_passes_browser_origin_to_composio(tmp_path) -> None:
    class FakeCalendar:
        callback: str | None = None

        async def connect(self, actor, provider, callback_url, alias=None):
            self.callback = callback_url
            self.alias = alias
            return CalendarConnectResponse(redirect_url="https://connect.composio.dev/example")

    fake = FakeCalendar()
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'callback.db'}",
                     credential_key="test-only-credential-key", calendar_adapter=fake)
    with TestClient(app) as client:
        response = client.post("/v1/calendar/connect/outlook", json={"callback_origin": "http://localhost:59631"})
        assert response.status_code == 200
        assert fake.callback == "http://localhost:59631/?calendar=connected"
        named = client.post("/v1/calendar/connect/outlook", json={"callback_origin": "http://localhost:59631", "alias": "Client A"})
        assert named.status_code == 200
        assert fake.alias == "Client A"
        denied = client.post("/v1/calendar/connect/outlook", json={"callback_origin": "https://attacker.example"})
        assert denied.status_code == 400


def test_production_connect_uses_configured_url_instead_of_browser_origin(tmp_path, monkeypatch) -> None:
    class FakeCalendar:
        callback: str | None = None

        async def connect(self, actor, provider, callback_url, alias=None):
            self.callback = callback_url
            return CalendarConnectResponse(redirect_url="https://connect.composio.dev/example")

    monkeypatch.setenv("APP_BASE_URL", "https://meeting.genaiprotos.com")
    fake = FakeCalendar()
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'production-callback.db'}",
                     credential_key="test-only-credential-key", calendar_adapter=fake)
    # The route reads APP_ENV when invoked; keep the test database in its
    # isolated development mode during app construction.
    monkeypatch.setenv("APP_ENV", "production")
    with TestClient(app) as client:
        response = client.post("/v1/calendar/connect/outlook", json={"callback_origin": "https://old-railway.example"})
        assert response.status_code == 200
        assert fake.callback == "https://meeting.genaiprotos.com/?calendar=connected"


def test_admin_can_audit_each_members_calendar_connections(tmp_path) -> None:
    class FakeCalendar:
        seen = []

        async def connections(self, actor):
            self.seen.append(actor.user_id)
            return [CalendarConnection(id=f"account-{actor.user_id}", provider="outlook", status="ACTIVE", label="Work calendar")]

    fake = FakeCalendar()
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'account-audit.db'}",
                     credential_key="test-only-credential-key", calendar_adapter=fake)
    with TestClient(app) as client:
        invited = client.post("/v1/workspace/invite", json={"email": "teammate@example.test", "display_name": "Teammate", "role": "member"})
        assert invited.status_code == 201
        response = client.get("/v1/workspace/calendar-connections")
        assert response.status_code == 200
        rows = response.json()
        assert len(rows) == 2
        assert {row["user_id"] for row in rows} == {str(_actor().user_id), invited.json()["account"]["user_id"]}
        assert {row["user_name"] for row in rows} == {"Local administrator", "Teammate"}
        assert len(fake.seen) == 2


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
             "description": "Discuss roadmap. Join https://meet.google.com/abc-defg-hij",
             "organizer": {"email": "host@example.test", "displayName": "Host"},
             "attendees": [{"email": "asha@example.test", "displayName": "Asha", "responseStatus": "accepted"}]},
            {"id": "no-link", "summary": "Lunch", "start": {"dateTime": event_time.isoformat()},
             "end": {"dateTime": (event_time + timedelta(hours=1)).isoformat()}},
        ]}})

    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(respond))
    import asyncio
    result = asyncio.run(calendar.events(actor, "ca-own", "tomorrow", "UTC"))
    assert [event.event_id for event in result.events] == ["meeting"]
    assert result.events[0].meeting_url == "https://meet.google.com/abc-defg-hij"
    assert result.events[0].organizer == "Host"
    assert result.events[0].invitees[0].email == "asha@example.test"
    assert result.events[0].invitees[0].response_status == "accepted"
    assert b'"connected_account_id":"ca-own"' in requests[-1].content
    assert b'"version":"20260915_00"' in requests[-1].content


def test_multiple_accounts_of_same_provider_are_listed_and_selected_explicitly() -> None:
    import asyncio

    actor = _actor()
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/connected_accounts"):
            return httpx.Response(200, json={"items": [
                {"id": "ca-work", "toolkit": {"slug": "googlecalendar"}, "user_id":
                 f"meetings-ai:{actor.organization_id}:{actor.user_id}", "status": "ACTIVE",
                 "data": {"displayName": "work@example.test"}},
                {"id": "ca-personal", "toolkit": {"slug": "googlecalendar"}, "user_id":
                 f"meetings-ai:{actor.organization_id}:{actor.user_id}", "status": "ACTIVE",
                 "alias": "Personal calendar", "data": {"displayName": "personal@example.test"}},
            ]})
        return httpx.Response(200, json={"successful": True, "data": {"items": []}})

    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(respond))
    connections = asyncio.run(calendar.connections(actor))
    assert [(item.id, item.label) for item in connections] == [
        ("ca-work", "work@example.test"), ("ca-personal", "Personal calendar"),
    ]
    assert connections[1].identity == "personal@example.test"
    asyncio.run(calendar.events(actor, "ca-personal", "today", "UTC"))
    assert b'"connected_account_id":"ca-personal"' in requests[-1].content


def test_connect_alias_is_sent_to_composio_with_multiple_accounts_enabled() -> None:
    actor = _actor()
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(201, json={"redirect_url": "https://connect.composio.dev/test"})

    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(respond))
    calendar.auth_configs["googlecalendar"] = "ac-test"
    result = asyncio.run(calendar.connect(actor, "googlecalendar", "https://meeting.example/?calendar=connected", "  Client A  "))
    assert result.redirect_url == "https://connect.composio.dev/test"
    assert requests[0].url.path.endswith("/connected_accounts/link")
    assert requests[0].read().decode().count('"alias":"Client A"') == 1
    assert b'"allow_multiple":true' in requests[0].content


def test_rename_requires_owned_connection_and_updates_only_alias() -> None:
    actor = _actor()
    requests: list[httpx.Request] = []
    alias = "Old name"

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal alias
        requests.append(request)
        if request.url.path.endswith("/connected_accounts"):
            return httpx.Response(200, json={"items": [{"id": "ca-own", "toolkit": {"slug": "outlook"},
                "user_id": f"meetings-ai:{actor.organization_id}:{actor.user_id}", "status": "ACTIVE",
                "alias": alias, "data": {"displayName": "work@example.test"}}]})
        if request.method == "GET":
            return httpx.Response(200, json={"id": "ca-own", "user_id": f"meetings-ai:{actor.organization_id}:{actor.user_id}"})
        alias = request.read().decode().split('"alias":"')[1].split('"')[0]
        return httpx.Response(200, json={"success": True, "id": "ca-own", "status": "ACTIVE"})

    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(respond))
    with pytest.raises(CalendarError, match="not found for your account"):
        asyncio.run(calendar.rename(actor, "ca-other", "Wrong"))
    assert not any(request.method == "PATCH" for request in requests)
    renamed = asyncio.run(calendar.rename(actor, "ca-own", "Client A"))
    assert renamed.label == "Client A"
    assert renamed.identity == "work@example.test"
    patch = next(request for request in requests if request.method == "PATCH")
    assert patch.url.path.endswith("/connected_accounts/ca-own")
    assert patch.content == b'{"alias":"Client A"}'


def test_disconnect_only_deletes_own_account_and_requests_upstream_revocation(tmp_path) -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/connected_accounts/ca-own") and request.method == "GET":
            return httpx.Response(200, json={"id": "ca-own", "user_id": f"meetings-ai:{_actor().organization_id}:{_actor().user_id}"})
        if request.method == "GET":
            return httpx.Response(200, json={"items": [
                {"id": "ca-own", "toolkit": {"slug": "outlook"}, "status": "ACTIVE"},
                {"id": "ca-other", "toolkit": {"slug": "outlook"}, "user_id": "someone-else", "status": "ACTIVE"},
            ]})
        return httpx.Response(200, json={"success": True})

    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(respond))
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'disconnect.db'}",
                     credential_key="test-only-credential-key", calendar_adapter=calendar)
    with TestClient(app) as client:
        denied = client.delete("/v1/calendar/connections/ca-other")
        assert denied.status_code == 404
        assert not any(request.method == "DELETE" for request in requests)
        removed = client.delete("/v1/calendar/connections/ca-own")
        assert removed.status_code == 204

    deletes = [request for request in requests if request.method == "DELETE"]
    assert len(deletes) == 1
    assert deletes[0].url.path.endswith("/connected_accounts/ca-own")
    assert deletes[0].url.params["revoke_on_delete"] == "true"


def test_disconnect_requires_provider_confirmation() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/connected_accounts/ca-own") and request.method == "GET":
            return httpx.Response(200, json={"id": "ca-own", "user_id": f"meetings-ai:{_actor().organization_id}:{_actor().user_id}"})
        if request.method == "GET":
            return httpx.Response(200, json={"items": [{
                "id": "ca-own", "toolkit": {"slug": "outlook"}, "status": "ACTIVE",
            }]})
        return httpx.Response(200, json={"success": False})

    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(respond))
    with pytest.raises(CalendarError, match="did not confirm"):
        asyncio.run(calendar.disconnect(_actor(), "ca-own"))


def test_disconnect_refuses_account_when_provider_detail_has_another_owner() -> None:
    methods: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        if request.url.path.endswith("/connected_accounts/ca-shared"):
            return httpx.Response(200, json={"id": "ca-shared", "user_id": "someone-else"})
        return httpx.Response(200, json={"items": [{
            "id": "ca-shared", "toolkit": {"slug": "outlook"}, "status": "ACTIVE",
        }]})

    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(respond))
    with pytest.raises(CalendarError, match="not found for your account"):
        asyncio.run(calendar.disconnect(_actor(), "ca-shared"))
    assert methods == ["GET", "GET"]


def test_calendly_scan_enriches_invitees_and_agenda() -> None:
    actor = _actor()
    start, _ = calendar_window("tomorrow", "UTC")
    when = start + timedelta(hours=10)
    calls = []

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path.endswith("/connected_accounts"):
            return httpx.Response(200, json={"items": [{"id": "ca-calendly", "toolkit": {"slug": "calendly"},
                "user_id": f"meetings-ai:{actor.organization_id}:{actor.user_id}", "status": "ACTIVE"}]})
        if request.url.path.endswith("/CALENDLY_WHO_AM_I"):
            return httpx.Response(200, json={"successful": True, "data": {"data": {"uri": "https://api.calendly.com/users/me"}}})
        if request.url.path.endswith("/CALENDLY_LIST_EVENT_INVITEES"):
            return httpx.Response(200, json={"successful": True, "data": {"collection": [
                {"name": "Asha Patel", "email": "asha@example.test", "status": "active"}]}})
        return httpx.Response(200, json={"successful": True, "data": {"collection": [{
            "uri": "https://api.calendly.com/scheduled_events/event-1", "name": "Discovery",
            "start_time": when.isoformat(), "end_time": (when + timedelta(hours=1)).isoformat(),
            "location": {"join_url": "https://meet.google.com/abc-defg-hij"},
            "meeting_notes_plain": "Discuss rollout", "event_guests": [{"email": "guest@example.test"}],
        }]}})

    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(respond))
    result = asyncio.run(calendar.events(actor, "ca-calendly", "tomorrow", "UTC"))
    assert result.events[0].agenda == "Discuss rollout"
    assert {person.email for person in result.events[0].invitees} == {"guest@example.test", "asha@example.test"}
    assert any(request.url.path.endswith("/CALENDLY_LIST_EVENT_INVITEES") for request in calls)


def test_zoom_scan_returns_hosted_meeting_without_inventing_invitees() -> None:
    actor = _actor()
    start, _ = calendar_window("tomorrow", "UTC")
    when = start + timedelta(hours=11)

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/connected_accounts"):
            return httpx.Response(200, json={"items": [{"id": "ca-zoom", "toolkit": {"slug": "zoom"},
                "user_id": f"meetings-ai:{actor.organization_id}:{actor.user_id}", "status": "ACTIVE"}]})
        return httpx.Response(200, json={"successful": True, "data": {"meetings": [{
            "id": 12345678901, "topic": "Planning", "start_time": when.isoformat(), "duration": 45,
            "join_url": "https://zoom.us/j/12345678901", "agenda": "Quarterly planning", "host_email": "host@example.test",
        }]}})

    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(respond))
    result = asyncio.run(calendar.events(actor, "ca-zoom", "tomorrow", "UTC"))
    assert result.events[0].event_id == "12345678901"
    assert result.events[0].organizer == "host@example.test"
    assert result.events[0].invitees == []
    assert result.events[0].ends_at - result.events[0].starts_at == timedelta(minutes=45)


def test_schedule_refetches_calendar_event_and_can_cancel(tmp_path) -> None:
    class FakeCalendar:
        async def events(self, actor, connection_id, period, timezone):
            event = CalendarEvent(
                connection_id="ca-own", provider="googlecalendar", event_id="event-123",
                title="Customer call", starts_at=datetime.now(UTC) + timedelta(hours=4),
                ends_at=datetime.now(UTC) + timedelta(hours=5),
                meeting_url="https://meet.google.com/abc-defg-hij", platform="google_meet",
                agenda="Discuss rollout", organizer="host@example.test",
                invitees=[{"name": "Asha Patel", "email": "asha@example.test"}],
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
        source = client.get(f"/v1/meetings/{meeting_id}/source").json()
        assert source["agenda"] == "Discuss rollout"
        people = client.get(f"/v1/meetings/{meeting_id}/participants").json()
        assert people["participants"][0]["email"] == "asha@example.test"
        assert client.post(f"/v1/calendar/schedules/{meeting_id}/cancel").json()["status"] == "cancelled"
        assert client.get(f"/v1/meetings/{meeting_id}").status_code == 200


def test_immediate_source_import_refetches_link_and_saves_invitees(tmp_path) -> None:
    from unittest.mock import AsyncMock

    class FakeCalendar:
        async def events(self, actor, connection_id, period, timezone):
            return type("Result", (), {"events": [CalendarEvent(
                connection_id="ca-zoom", provider="zoom", event_id="zoom-42",
                title="Product review", starts_at=datetime.now(UTC) - timedelta(minutes=5),
                ends_at=datetime.now(UTC) + timedelta(minutes=55),
                meeting_url="https://zoom.us/j/12345678901", platform="zoom",
                agenda="Review scope", invitees=[{"name": "Casey", "email": "casey@example.test"}],
            )]})()

    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'source-now.db'}",
                     credential_key="test-only-credential-key", calendar_adapter=FakeCalendar())
    app.state.meeting_service.join = AsyncMock(side_effect=lambda meeting_id: app.state.meeting_service.repository.get_meeting(meeting_id))
    with TestClient(app) as client:
        created = client.post("/v1/calendar/meetings", json={
            "connection_id": "ca-zoom", "event_id": "zoom-42", "period": "today", "timezone": "UTC",
            "meeting": {"meeting_url": "https://meet.google.com/attacker-link"},
        })
        assert created.status_code == 201, created.text
        meeting_id = created.json()["meeting"]["id"]
        assert created.json()["meeting"]["meeting_url"] == "https://zoom.us/j/12345678901"
        assert client.get(f"/v1/meetings/{meeting_id}/source").json()["agenda"] == "Review scope"
        assert client.get(f"/v1/meetings/{meeting_id}/participants").json()["participants"][0]["email"] == "casey@example.test"
        duplicate = client.post("/v1/calendar/meetings", json={
            "connection_id": "ca-zoom", "event_id": "zoom-42", "period": "today", "timezone": "UTC",
            "meeting": {"meeting_url": "https://zoom.us/j/12345678901"},
        })
        assert duplicate.status_code == 400


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


def test_manual_meeting_waits_for_its_start_and_can_be_cancelled(tmp_path) -> None:
    from unittest.mock import AsyncMock

    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'manual-schedule.db'}",
                     credential_key="test-only-credential-key")
    start = datetime.now(UTC) + timedelta(hours=2)
    with TestClient(app) as client:
        created = client.post("/v1/meetings/schedules", json={
            "starts_at": start.isoformat(),
            "meeting": {"meeting_url": "https://meet.google.com/abc-defg-hij", "title": "Scheduled customer call"},
        })
        assert created.status_code == 201, created.text
        meeting_id = created.json()["meeting"]["id"]
        assert created.json()["schedule"]["provider"] == "manual"
        assert created.json()["schedule"]["status"] == "pending"
        join = AsyncMock()
        app.state.calendar_schedule.meetings.join = join
        asyncio.run(app.state.calendar_schedule.tick())
        join.assert_not_awaited()
        assert client.post(f"/v1/calendar/schedules/{meeting_id}/cancel").json()["status"] == "cancelled"


def test_manual_schedule_joins_when_start_arrives(tmp_path) -> None:
    from unittest.mock import AsyncMock

    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'manual-due.db'}",
                     credential_key="test-only-credential-key")
    with TestClient(app) as client:
        created = client.post("/v1/meetings/schedules", json={
            "starts_at": (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
            "meeting": {"meeting_url": "https://meet.google.com/abc-defg-hij"},
        })
        assert created.status_code == 201, created.text
        meeting_id = created.json()["meeting"]["id"]
        with app.state.database.session_factory.begin() as session:
            session.execute(update(CalendarScheduleRow).where(CalendarScheduleRow.meeting_id == meeting_id).values(
                starts_at=datetime.now(UTC) - timedelta(seconds=1),
            ))
        join = AsyncMock()
        app.state.calendar_schedule.meetings.join = join
        asyncio.run(app.state.calendar_schedule.tick())
        join.assert_awaited_once()
        assert client.get(f"/v1/calendar/schedules/{meeting_id}").json()["status"] == "joined"


def test_manual_schedule_rejects_past_or_naive_times_without_creating_meeting(tmp_path) -> None:
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'invalid-manual.db'}",
                     credential_key="test-only-credential-key")
    with TestClient(app) as client:
        for starts_at in [(datetime.now(UTC) - timedelta(minutes=1)).isoformat(),
                          (datetime.now(UTC) + timedelta(hours=2)).replace(tzinfo=None).isoformat()]:
            response = client.post("/v1/meetings/schedules", json={
                "starts_at": starts_at,
                "meeting": {"meeting_url": "https://meet.google.com/abc-defg-hij"},
            })
            assert response.status_code == 400, response.text
        assert client.get("/v1/meetings").json()["count"] == 0
