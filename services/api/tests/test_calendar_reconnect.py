"""Disconnecting and reconnecting a calendar never strands scheduled assistants or briefings.

Composio is never called: a mocked transport plays several connected accounts that can be removed
and re-added under a new id (as a real reconnect does).
"""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import httpx
from fastapi.testclient import TestClient

from app.calendar_accounts import outlook_account_type
from app.calendar_relink import match_event
from app.calendar_watch import WatchSettings
from app.composio_calendar import CalendarEvent, ComposioCalendar
from app.database import (
    CalendarEventCacheRow,
    CalendarScheduleRow,
    MeetingPrepInputRow,
    MeetingSourceRow,
)
from app.main import create_app

MEET = "https://meet.google.com/abc-defg-hij"
OTHER_MEET = "https://meet.google.com/xyz-wxyz-xyz"


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat()


class FakeComposio:
    """Connected accounts (Google and Outlook) behind Composio's REST API."""

    def __init__(self) -> None:
        self.accounts: dict[str, dict] = {}
        self.items: dict[str, dict[str, dict]] = {}
        self.profiles: dict[str, str | None] = {}
        self.user_id = ""

    def connect(self, account_id: str, provider: str = "googlecalendar", *, identity: str | None = None,
                profile_id: str | None = None) -> None:
        self.accounts[account_id] = {"id": account_id, "toolkit": {"slug": provider}, "status": "ACTIVE",
                                     **({"data": {"displayName": identity}} if identity else {})}
        self.items.setdefault(account_id, {})
        self.profiles[account_id] = profile_id

    def add(self, account_id: str, event_id: str, start: datetime, *, url: str = MEET) -> None:
        self.items[account_id][event_id] = {
            "id": event_id, "status": "confirmed", "summary": "Customer call", "hangoutLink": url,
            "start": {"dateTime": _iso(start)}, "end": {"dateTime": _iso(start + timedelta(hours=1))}}

    async def respond(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/connected_accounts"):
            self.user_id = request.url.params["user_ids"]
            return httpx.Response(200, json={"items": [{**item, "user_id": self.user_id} for item in self.accounts.values()]})
        if "/connected_accounts/" in path:
            account_id = path.rsplit("/", 1)[-1]
            if request.method == "DELETE":
                self.accounts.pop(account_id, None)
                return httpx.Response(200, json={"success": True})
            return httpx.Response(200, json={"id": account_id, "user_id": self.user_id})
        body = json.loads(request.content)
        account_id, tool, arguments = body["connected_account_id"], path.rsplit("/", 1)[-1], body["arguments"]
        if tool == "OUTLOOK_GET_PROFILE":
            profile = self.profiles.get(account_id)
            if profile is None:
                return httpx.Response(200, json={"successful": False, "error": "forbidden"})
            return httpx.Response(200, json={"successful": True, "data": {"id": profile, "displayName": "Abhishek"}})
        if tool == "OUTLOOK_GET_CALENDAR_VIEW":
            return httpx.Response(200, json={"successful": True, "data": {"value": []}})
        low, high = datetime.fromisoformat(arguments["timeMin"]), datetime.fromisoformat(arguments["timeMax"])
        items = [item for item in self.items.get(account_id, {}).values()
                 if low <= datetime.fromisoformat(item["start"]["dateTime"]) < high]
        return httpx.Response(200, json={"successful": True, "data": {"items": items}})


def _app(tmp_path, fake: FakeComposio):
    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(fake.respond))
    calendar.auth_configs["googlecalendar"] = "ac_google"
    calendar.auth_configs["outlook"] = "ac_outlook"
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'reconnect.db'}",
                     credential_key="test-only-credential-key", calendar_adapter=calendar)
    app.state.calendar_watch.settings = WatchSettings()
    app.state.calendar_schedule.meetings.join = AsyncMock()
    return app


def _start() -> datetime:
    return datetime.now(UTC).replace(microsecond=0, second=0) + timedelta(days=1)


def _sync(client: TestClient, start: datetime):
    response = client.post("/v1/calendar/sync", json={
        "start_date": (start - timedelta(days=2)).date().isoformat(),
        "end_date": (start + timedelta(days=2)).date().isoformat(), "timezone": "UTC"})
    assert response.status_code == 200, response.text
    return response.json()


def _schedule(client: TestClient, start: datetime, connection_id: str = "ca-1", event_id: str = "evt-1") -> str:
    created = client.post("/v1/calendar/schedules", json={
        "connection_id": connection_id, "event_id": event_id, "event_date": start.date().isoformat(),
        "timezone": "UTC", "meeting": {"meeting_url": MEET, "title": "Customer call"},
    })
    assert created.status_code == 201, created.text
    return created.json()["meeting"]["id"]


def _row(app, meeting_id: str) -> CalendarScheduleRow:
    with app.state.database.session_factory() as session:
        return session.get(CalendarScheduleRow, meeting_id)


def _source(app, meeting_id: str) -> MeetingSourceRow:
    with app.state.database.session_factory() as session:
        return session.get(MeetingSourceRow, meeting_id)


def _connections(client: TestClient) -> dict[str, dict]:
    response = client.get("/v1/calendar/connections")
    assert response.status_code == 200, response.text
    return {item["id"]: item for item in response.json()}


# ----- disconnect ------------------------------------------------------------------------------

def test_disconnect_keeps_scheduled_assistants_by_default(tmp_path) -> None:
    fake, start = FakeComposio(), _start()
    fake.connect("ca-1")
    fake.add("ca-1", "evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        assert _connections(client)["ca-1"]["scheduled"] == 1

        removed = client.delete("/v1/calendar/connections/ca-1?scheduled=keep")

        assert removed.status_code == 200 and removed.json() == {"cancelled": 0, "kept": 1}
        assert _row(app, meeting_id).status == "pending"


def test_disconnect_can_cancel_scheduled_assistants(tmp_path) -> None:
    fake, start = FakeComposio(), _start()
    fake.connect("ca-1")
    fake.add("ca-1", "evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)

        removed = client.delete("/v1/calendar/connections/ca-1?scheduled=cancel")

        assert removed.json() == {"cancelled": 1, "kept": 0}
        row = _row(app, meeting_id)
        assert row.status == "cancelled"
        assert row.last_error == "Cancelled when Google Calendar was disconnected"
        assert client.get("/v1/calendar/connections/ca-1?scheduled=later").status_code in {404, 405}
        assert client.delete("/v1/calendar/connections/ca-2?scheduled=later").status_code == 422


# ----- reconnect -------------------------------------------------------------------------------

def test_reconnecting_the_same_account_reattaches_the_assistant_on_sync(tmp_path) -> None:
    fake, start = FakeComposio(), _start()
    fake.connect("ca-1")
    fake.add("ca-1", "evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        client.delete("/v1/calendar/connections/ca-1")
        fake.connect("ca-2")  # the same mailbox, reconnected under a new id
        fake.add("ca-2", "evt-1", start)

        _sync(client, start)

        row, source = _row(app, meeting_id), _source(app, meeting_id)
        assert (row.connection_id, row.event_id, row.status) == ("ca-2", "evt-1", "pending")
        assert (source.connection_id, source.event_id) == ("ca-2", "evt-1")
        assert _connections(client)["ca-2"]["scheduled"] == 1
        schedules = client.get("/v1/calendar/schedules").json()
        assert [item["connection_id"] for item in schedules if item["meeting_id"] == meeting_id] == ["ca-2"]


def test_the_same_call_on_another_mailbox_is_matched_by_link_and_time(tmp_path) -> None:
    fake, start = FakeComposio(), _start()
    fake.connect("ca-1")
    fake.add("ca-1", "evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        client.delete("/v1/calendar/connections/ca-1")
        fake.connect("ca-2")
        fake.add("ca-2", "other-id", start, url=MEET)
        fake.add("ca-2", "unrelated", start, url=OTHER_MEET)

        _sync(client, start)

        row = _row(app, meeting_id)
        assert (row.connection_id, row.event_id) == ("ca-2", "other-id")


def test_an_unmatched_assistant_stays_where_it_was(tmp_path) -> None:
    fake, start = FakeComposio(), _start()
    fake.connect("ca-1")
    fake.add("ca-1", "evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        client.delete("/v1/calendar/connections/ca-1")
        fake.connect("ca-2")
        fake.add("ca-2", "evt-9", start + timedelta(hours=3))  # a different call

        _sync(client, start)

        row = _row(app, meeting_id)
        assert (row.connection_id, row.status) == ("ca-1", "pending")


def test_the_watcher_reattaches_before_flagging_a_missing_account(tmp_path) -> None:
    fake, start = FakeComposio(), _start()
    fake.connect("ca-1")
    fake.add("ca-1", "evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        client.delete("/v1/calendar/connections/ca-1")
        fake.connect("ca-2")
        fake.add("ca-2", "evt-1", start)

        asyncio.run(app.state.calendar_watch.tick())

        row = _row(app, meeting_id)
        assert row.connection_id == "ca-2" and row.last_error is None
        kinds = [item["kind"] for item in client.get("/v1/notifications").json()["items"]]
        assert "calendar.check_failed" not in kinds


def test_the_watcher_still_flags_when_nothing_matches(tmp_path) -> None:
    fake, start = FakeComposio(), _start()
    fake.connect("ca-1")
    fake.add("ca-1", "evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        client.delete("/v1/calendar/connections/ca-1")

        asyncio.run(app.state.calendar_watch.tick())

        row = _row(app, meeting_id)
        assert row.connection_id == "ca-1" and row.status == "pending"
        assert row.last_error.startswith("Couldn't re-check")


def test_a_briefing_follows_its_event_to_the_reconnected_account(tmp_path) -> None:
    fake, start = FakeComposio(), _start()
    fake.connect("ca-1")
    fake.add("ca-1", "evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        old_id = next(item["id"] for item in _sync(client, start)["events"] if item["event_id"] == "evt-1")
        saved = client.put(f"/v1/calendar/events/{old_id}/prep/inputs", json={
            "target_company": "Acme", "company_website": None, "links": [], "notes": "Bring the pricing sheet"})
        assert saved.status_code == 200, saved.text
        client.delete("/v1/calendar/connections/ca-1")
        fake.connect("ca-2")
        fake.add("ca-2", "evt-1", start)

        new_id = next(item["id"] for item in _sync(client, start)["events"] if item["event_id"] == "evt-1")

        assert new_id != old_id
        with app.state.database.session_factory() as session:
            assert session.get(MeetingPrepInputRow, old_id) is None
            assert session.get(MeetingPrepInputRow, new_id).notes == "Bring the pricing sheet"
            assert session.get(CalendarEventCacheRow, old_id) is None
        assert client.get(f"/v1/calendar/events/{new_id}/prep/inputs").json()["notes"] == "Bring the pricing sheet"


# ----- overview --------------------------------------------------------------------------------

def test_overview_shows_account_type_meetings_found_and_duplicates(tmp_path) -> None:
    fake, start = FakeComposio(), _start()
    fake.connect("ca-google")
    fake.add("ca-google", "evt-1", start)
    fake.add("ca-google", "evt-2", start + timedelta(hours=2), url=OTHER_MEET)
    fake.connect("ca-personal", "outlook", profile_id="0123456789abcdef")
    fake.connect("ca-work", "outlook", profile_id="3f2504e0-4f89-11d3-9a0c-0305e82c3301")
    fake.connect("ca-work-again", "outlook", profile_id="3F2504E0-4F89-11D3-9A0C-0305E82C3301")
    fake.connect("ca-unknown", "outlook", profile_id=None)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        assert _connections(client)["ca-google"]["meetings_found"] is None
        _sync(client, start)
        _schedule(client, start, connection_id="ca-google")

        overview = _connections(client)

        assert overview["ca-google"]["meetings_found"] == 2 and overview["ca-google"]["scheduled"] == 1
        assert overview["ca-google"]["last_synced_at"] is not None
        assert overview["ca-personal"]["account_type"] == "personal"
        assert overview["ca-work"]["account_type"] == "work" and overview["ca-work"]["same_account_as"] is None
        assert overview["ca-work-again"]["same_account_as"] == "ca-work"
        assert overview["ca-unknown"]["account_type"] is None
        assert overview["ca-personal"]["meetings_found"] == 0


# ----- units -----------------------------------------------------------------------------------

def _event(event_id: str, start: datetime, url: str = MEET) -> CalendarEvent:
    return CalendarEvent(connection_id="ca-2", provider="googlecalendar", event_id=event_id, title="Call",
                         starts_at=start, ends_at=start + timedelta(hours=1), meeting_url=url, platform="google_meet")


def test_match_prefers_the_same_event_id_then_the_same_call_at_the_same_time() -> None:
    start = datetime(2026, 10, 1, 9, tzinfo=UTC)
    moved = _event("evt-1", start + timedelta(hours=2))
    assert match_event("evt-1", start, MEET, [moved, _event("x", start)]) is moved
    same_call = _event("x", start + timedelta(seconds=30))
    assert match_event("evt-1", start, MEET, [same_call]) is same_call
    assert match_event("evt-1", start, MEET, [_event("x", start + timedelta(minutes=5))]) is None
    assert match_event("evt-1", start, MEET, [_event("x", start, OTHER_MEET)]) is None
    assert match_event("evt-1", start, MEET, [_event("x", start), _event("y", start)]) is None  # ambiguous


def test_outlook_account_type_from_the_microsoft_id() -> None:
    assert outlook_account_type("3f2504e0-4f89-11d3-9a0c-0305e82c3301") == "work"
    assert outlook_account_type("0123456789ABCDEF") == "personal"
    assert outlook_account_type("") is None and outlook_account_type(None) is None
