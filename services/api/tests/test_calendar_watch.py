"""The calendar watcher keeps scheduled joins and synced events in step with the calendar.

Composio is never called: a mocked transport plays a Google Calendar account.
"""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app.calendar_watch import WatchSettings
from app.composio_calendar import ComposioCalendar
from app.database import (
    CalendarEventChangeRow,
    CalendarEventCacheRow,
    CalendarScheduleRow,
    MeetingPrepInputRow,
    MeetingSourceRow,
    UserPreferenceRow,
    LEGACY_ADMIN_USER_ID,
)
from app.main import create_app

MEET = "https://meet.google.com/abc-defg-hij"


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat()


class FakeGoogle:
    """One Google Calendar account behind Composio's tool-execution API."""

    def __init__(self) -> None:
        self.items: dict[str, dict] = {}
        self.calls: list[dict] = []
        self.status = "ACTIVE"
        self.truncate = False
        self.delay = 0.0

    def add(self, event_id: str, start: datetime, *, minutes: int = 60, url: str = MEET, title: str = "Customer call") -> None:
        self.items[event_id] = {"id": event_id, "status": "confirmed", "summary": title, "hangoutLink": url,
                                "start": {"dateTime": _iso(start)}, "end": {"dateTime": _iso(start + timedelta(minutes=minutes))}}

    def move(self, event_id: str, start: datetime, minutes: int = 60) -> None:
        self.items[event_id]["start"] = {"dateTime": _iso(start)}
        self.items[event_id]["end"] = {"dateTime": _iso(start + timedelta(minutes=minutes))}

    def list_calls(self) -> int:
        return sum(1 for call in self.calls if call.get("tool") == "GOOGLECALENDAR_EVENTS_LIST")

    async def respond(self, request: httpx.Request) -> httpx.Response:
        if self.delay:
            await asyncio.sleep(self.delay)
        if request.url.path.endswith("/connected_accounts"):
            self.calls.append({"tool": "connections"})
            return httpx.Response(200, json={"items": [{
                "id": "ca-google", "toolkit": {"slug": "googlecalendar"},
                "user_id": request.url.params["user_ids"], "status": self.status,
            }]})
        arguments = json.loads(request.content)["arguments"]
        self.calls.append({"tool": request.url.path.rsplit("/", 1)[-1], **arguments})
        low, high = datetime.fromisoformat(arguments["timeMin"]), datetime.fromisoformat(arguments["timeMax"])
        items = [item for item in self.items.values()
                 if low <= datetime.fromisoformat(item["start"]["dateTime"]) < high
                 and (arguments["showDeleted"] or item["status"] != "cancelled")]
        data: dict = {"items": items, **({"nextPageToken": "more"} if self.truncate else {})}
        return httpx.Response(200, json={"successful": True, "data": data})


def _app(tmp_path, fake: FakeGoogle, name: str = "watch.db", **settings):
    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(fake.respond))
    calendar.auth_configs["googlecalendar"] = "ac_test"
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / name}",
                     credential_key="test-only-credential-key", calendar_adapter=calendar)
    app.state.calendar_watch.settings = WatchSettings(**settings)
    app.state.calendar_schedule.meetings.join = AsyncMock()
    return app


def _schedule(client: TestClient, start: datetime, event_id: str = "evt-1") -> str:
    created = client.post("/v1/calendar/schedules", json={
        "connection_id": "ca-google", "event_id": event_id, "event_date": start.date().isoformat(), "timezone": "UTC",
        "meeting": {"meeting_url": MEET, "title": "Customer call"},
    })
    assert created.status_code == 201, created.text
    return created.json()["meeting"]["id"]


def _notifications(client: TestClient) -> list[dict]:
    return client.get("/v1/notifications").json()["items"]


def _changes(app, meeting_id: str) -> list[CalendarEventChangeRow]:
    with app.state.database.session_factory() as session:
        return session.execute(select(CalendarEventChangeRow).where(
            CalendarEventChangeRow.meeting_id == meeting_id)).scalars().all()


def _force_due(app) -> None:
    app.state.calendar_watch._attempted.clear()
    app.state.calendar_watch._checked.clear()


def test_moved_event_updates_schedule_source_and_notifies_once(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=4)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        later = start + timedelta(days=1, hours=2)
        fake.move("evt-1", later, minutes=30)
        asyncio.run(app.state.calendar_watch.tick())

        schedule = client.get(f"/v1/calendar/schedules/{meeting_id}").json()
        assert schedule["status"] == "pending"
        assert datetime.fromisoformat(schedule["starts_at"]) == later
        assert datetime.fromisoformat(schedule["rescheduled_from"]) == start
        assert schedule["last_checked_at"] is not None
        assert datetime.fromisoformat(client.get(f"/v1/meetings/{meeting_id}/source").json()["starts_at"]) == later
        moved = [item for item in _notifications(client) if item["kind"] == "calendar.event_moved"]
        assert len(moved) == 1
        assert moved[0]["title"].startswith("“Customer call” moved to ")
        assert moved[0]["body"].endswith("The assistant will join at the new time.")
        assert moved[0]["link_view"] == "meeting" and moved[0]["link_id"] == meeting_id

        history = client.get(f"/v1/meetings/{meeting_id}/schedule/changes").json()
        assert [item["kind"] for item in history["items"]] == ["moved"]
        assert datetime.fromisoformat(history["items"][0]["old_starts_at"]) == start
        assert history["provider"] == "googlecalendar" and history["last_checked_at"]

        # Repeated checks with nothing new record and send nothing.
        _force_due(app)
        asyncio.run(app.state.calendar_watch.tick())
        asyncio.run(app.state.calendar_watch.tick())
        assert len(_changes(app, meeting_id)) == 1
        assert len([item for item in _notifications(client) if item["kind"] == "calendar.event_moved"]) == 1


def test_join_follows_the_new_time_not_the_old_one(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=4)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake, prejoin_max_age=timedelta(0))
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        # Simulate the clock reaching the stored start: both sides agree on "a moment ago".
        old = datetime.now(UTC).replace(microsecond=0) - timedelta(seconds=5)
        with app.state.database.session_factory.begin() as session:
            session.execute(update(CalendarScheduleRow).where(CalendarScheduleRow.meeting_id == meeting_id)
                            .values(starts_at=old, ends_at=old + timedelta(hours=1)))
            session.execute(update(MeetingSourceRow).where(MeetingSourceRow.meeting_id == meeting_id)
                            .values(starts_at=old, ends_at=old + timedelta(hours=1)))
        # …but the organizer has just moved it two hours later.
        fake.move("evt-1", old + timedelta(hours=2))
        join = app.state.calendar_schedule.meetings.join
        asyncio.run(app.state.calendar_schedule.tick())
        join.assert_not_awaited()
        assert client.get(f"/v1/calendar/schedules/{meeting_id}").json()["status"] == "pending"

        # Moved again, to right now: the periodic check (every 2 min this close) picks it up and
        # the scheduler joins at that new time.
        now = datetime.now(UTC).replace(microsecond=0) - timedelta(seconds=30)
        fake.move("evt-1", now)
        _force_due(app)
        asyncio.run(app.state.calendar_watch.tick())
        asyncio.run(app.state.calendar_schedule.tick())
        join.assert_awaited_once()
        assert client.get(f"/v1/calendar/schedules/{meeting_id}").json()["status"] == "joined"


def test_moved_into_the_past_is_marked_missed_by_the_scheduler(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=4)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        fake.move("evt-1", datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=30))
        asyncio.run(app.state.calendar_watch.tick())
        moved = next(item for item in _notifications(client) if item["kind"] == "calendar.event_moved")
        assert moved["body"].endswith("The new start time has already passed.")
        asyncio.run(app.state.calendar_schedule.tick())
        app.state.calendar_schedule.meetings.join.assert_not_awaited()
        assert client.get(f"/v1/calendar/schedules/{meeting_id}").json()["status"] == "missed"


def test_cancelled_in_google_stops_the_join(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=4)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        fake.items["evt-1"]["status"] = "cancelled"
        asyncio.run(app.state.calendar_watch.tick())
        schedule = client.get(f"/v1/calendar/schedules/{meeting_id}").json()
        assert schedule["status"] == "cancelled"
        assert schedule["last_error"] == "Cancelled in Google Calendar"
        assert any(call.get("showDeleted") is True for call in fake.calls)
        cancelled = [item for item in _notifications(client) if item["kind"] == "calendar.event_cancelled"]
        assert [item["title"] for item in cancelled] == ["“Customer call” was cancelled in Google Calendar — the assistant won't join"]
        with app.state.database.session_factory.begin() as session:
            session.execute(update(CalendarScheduleRow).where(CalendarScheduleRow.meeting_id == meeting_id)
                            .values(starts_at=datetime.now(UTC) - timedelta(seconds=5)))
        asyncio.run(app.state.calendar_schedule.tick())
        app.state.calendar_schedule.meetings.join.assert_not_awaited()


def test_meetings_say_they_were_cancelled_or_moved_not_just_created(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=4)
    fake.add("evt-1", start)
    fake.add("evt-2", start + timedelta(hours=1), title="Pricing review")
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        cancelled_id = _schedule(client, start)
        moved_id = _schedule(client, start + timedelta(hours=1), event_id="evt-2")
        listed = {item["id"]: item for item in client.get("/v1/meetings").json()["items"]}
        assert listed[cancelled_id]["schedule"]["status"] == "pending"
        assert datetime.fromisoformat(listed[cancelled_id]["schedule"]["starts_at"]) == start

        fake.items["evt-1"]["status"] = "cancelled"
        fake.move("evt-2", start + timedelta(days=1))
        asyncio.run(app.state.calendar_watch.tick())

        cancelled = client.get(f"/v1/meetings/{cancelled_id}").json()
        assert cancelled["status"] == "created"  # the meeting itself never ran
        assert cancelled["schedule"]["status"] == "cancelled"
        assert cancelled["schedule"]["note"] == "Cancelled in Google Calendar"
        assert cancelled["schedule"]["provider"] == "googlecalendar" and cancelled["schedule"]["changed_at"]
        listed = {item["id"]: item for item in client.get("/v1/meetings").json()["items"]}
        assert listed[cancelled_id]["schedule"]["status"] == "cancelled"
        moved = listed[moved_id]["schedule"]
        assert moved["status"] == "pending"
        assert datetime.fromisoformat(moved["starts_at"]) == start + timedelta(days=1)
        assert datetime.fromisoformat(moved["rescheduled_from"]) == start + timedelta(hours=1)
        # A meeting sent straight to a call has no schedule.
        direct = client.post("/v1/meetings", json={"meeting_url": "https://meet.google.com/xyz-wxyz-xyz", "title": "Ad hoc"}).json()
        assert client.get(f"/v1/meetings/{direct['id']}").json()["schedule"] is None


def test_absent_event_is_cancelled_only_when_the_wide_lookup_is_complete(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=4)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        del fake.items["evt-1"]
        fake.truncate = True
        asyncio.run(app.state.calendar_watch.tick())
        assert client.get(f"/v1/calendar/schedules/{meeting_id}").json()["status"] == "pending"
        assert _changes(app, meeting_id) == []

        fake.truncate = False
        _force_due(app)
        asyncio.run(app.state.calendar_watch.tick())
        assert client.get(f"/v1/calendar/schedules/{meeting_id}").json()["status"] == "cancelled"
        assert [row.kind for row in _changes(app, meeting_id)] == ["cancelled"]


def test_event_moved_far_away_is_found_by_the_wide_lookup(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=4)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        far = start + timedelta(days=40)
        fake.move("evt-1", far)
        asyncio.run(app.state.calendar_watch.tick())
        schedule = client.get(f"/v1/calendar/schedules/{meeting_id}").json()
        assert schedule["status"] == "pending" and datetime.fromisoformat(schedule["starts_at"]) == far


def test_link_change_updates_the_meeting_and_keeps_passcodes_out_of_history(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=4)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        fake.items["evt-1"]["hangoutLink"] = "https://zoom.us/j/12345678901?pwd=secret-passcode"
        asyncio.run(app.state.calendar_watch.tick())
        meeting = client.get(f"/v1/meetings/{meeting_id}").json()
        assert meeting["meeting_url"] == "https://zoom.us/j/12345678901?pwd=secret-passcode"
        assert meeting["platform"] == "zoom"
        changed = [item for item in _notifications(client) if item["kind"] == "calendar.link_changed"]
        assert [item["title"] for item in changed] == ["Meeting link changed for “Customer call”"]
        assert changed[0]["body"] == "The assistant will use the new Zoom link."
        (row,) = _changes(app, meeting_id)
        assert row.kind == "link_changed" and row.new_meeting_url == "https://zoom.us/j/12345678901"
        assert "secret" not in (row.new_meeting_url or "") and row.old_meeting_url == MEET


def test_moved_notification_uses_each_readers_zone(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime(2026, 10, 12, 9, 30, tzinfo=UTC)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        with app.state.database.session_factory.begin() as session:
            session.add(UserPreferenceRow(user_id=str(LEGACY_ADMIN_USER_ID), timezone="Asia/Kolkata",
                                          detected_timezone=None, time_format="auto", updated_at=datetime.now(UTC)))
        meeting_id = _schedule(client, start)
        fake.move("evt-1", datetime(2026, 10, 13, 11, 30, tzinfo=UTC))
        asyncio.run(app.state.calendar_watch.tick())
        moved = next(item for item in _notifications(client) if item["kind"] == "calendar.event_moved")
        assert moved["title"] == "“Customer call” moved to Tue, Oct 13, 5:00 PM IST"
        assert moved["body"].startswith("Was ") and "3:00 PM IST" in moved["body"]
        assert moved["meeting_id"] == meeting_id


def test_unchanged_checks_are_cheap_and_follow_the_cadence(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=6)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        _schedule(client, start)
        fake.calls.clear()
        asyncio.run(app.state.calendar_watch.tick())
        assert fake.list_calls() == 1
        asyncio.run(app.state.calendar_watch.tick())  # not due again for 10 minutes
        assert fake.list_calls() == 1
        assert [item["kind"] for item in _notifications(client)] == ["assistant.scheduled"]


def test_slow_calendar_never_blocks_the_join_for_long(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=4)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake, prejoin_timeout=0.3)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        with app.state.database.session_factory.begin() as session:
            session.execute(update(CalendarScheduleRow).where(CalendarScheduleRow.meeting_id == meeting_id)
                            .values(starts_at=datetime.now(UTC) - timedelta(seconds=5)))
        fake.delay = 5
        began = datetime.now(UTC)
        asyncio.run(app.state.calendar_schedule.tick())
        assert (datetime.now(UTC) - began).total_seconds() < 3
        app.state.calendar_schedule.meetings.join.assert_awaited_once()


def test_disconnected_calendar_flags_the_schedule_but_keeps_the_join(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=4)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        fake.status = "EXPIRED"
        asyncio.run(app.state.calendar_watch.tick())
        _force_due(app)
        app.state.calendar_watch._connections.clear()
        asyncio.run(app.state.calendar_watch.tick())
        schedule = client.get(f"/v1/calendar/schedules/{meeting_id}").json()
        assert schedule["status"] == "pending"
        assert schedule["last_error"].startswith("Couldn't re-check with Google Calendar")
        flagged = [item for item in _notifications(client) if item["kind"] == "calendar.check_failed"]
        assert [item["title"] for item in flagged] == ["Couldn't re-check “Customer call”: reconnect your calendar"]

        fake.status = "ACTIVE"
        _force_due(app)
        app.state.calendar_watch._connections.clear()
        asyncio.run(app.state.calendar_watch.tick())
        assert client.get(f"/v1/calendar/schedules/{meeting_id}").json()["last_error"] is None


def test_owner_who_left_flags_the_schedule(tmp_path) -> None:
    from app.database import OrganizationMembershipRow
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=4)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        meeting_id = _schedule(client, start)
        watcher = app.state.calendar_watch
        schedule = watcher.applier.schedule(meeting_id)
        assert schedule is not None
        with app.state.database.session_factory() as session:
            assert session.get(OrganizationMembershipRow, (schedule.organization_id, schedule.user_id)) is not None
        watcher._owner = lambda organization_id, user_id: None  # membership removed
        asyncio.run(watcher.tick())
        assert "left this workspace" in client.get(f"/v1/calendar/schedules/{meeting_id}").json()["last_error"]
        assert fake.list_calls() == 1  # only the creation-time lookup; nothing ran as a former member


def test_watcher_is_idle_without_composio(tmp_path) -> None:
    fake = FakeGoogle()
    app = _app(tmp_path, fake)
    app.state.calendar_watch.calendar.api_key = ""
    with TestClient(app):
        asyncio.run(app.state.calendar_watch.tick())
    assert fake.calls == []


def _sync(client: TestClient, first: datetime, last: datetime):
    response = client.post("/v1/calendar/sync", json={
        "start_date": first.date().isoformat(), "end_date": last.date().isoformat(), "timezone": "UTC",
    })
    assert response.status_code == 200, response.text
    return response.json()


def _prep_inputs(app, cache_id: str) -> None:
    with app.state.database.session_factory.begin() as session:
        cache = session.get(CalendarEventCacheRow, cache_id)
        session.add(MeetingPrepInputRow(calendar_event_id=cache_id, organization_id=cache.organization_id,
                                        target_company="Acme", company_website=None, links=[], notes="Bring pricing",
                                        updated_by=str(LEGACY_ADMIN_USER_ID), updated_at=datetime.now(UTC)))


def test_sync_rekeys_a_moved_event_in_place_so_prep_stays_attached(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(days=3)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        (event,) = _sync(client, start, start + timedelta(days=10))["events"]
        _prep_inputs(app, event["id"])
        later = start + timedelta(days=2)
        fake.move("evt-1", later)
        (moved,) = _sync(client, start, start + timedelta(days=10))["events"]
        assert moved["id"] == event["id"]
        assert datetime.fromisoformat(moved["starts_at"]) == later
        assert datetime.fromisoformat(moved["rescheduled_from"]) == start
        with app.state.database.session_factory() as session:
            assert session.get(MeetingPrepInputRow, event["id"]).notes == "Bring pricing"
            assert session.query(CalendarEventCacheRow).count() == 1
        notes = [item for item in _notifications(client) if item["kind"] == "calendar.event_moved"]
        assert len(notes) == 1
        assert notes[0]["body"].endswith("No assistant is scheduled for this meeting.")
        assert notes[0]["link_view"] == "prep" and notes[0]["link_id"] == event["id"]
        history = client.get(f"/v1/calendar/events/{event['id']}/changes").json()
        assert [(item["kind"], item["source"]) for item in history["items"]] == [("moved", "sync")]

        # The watcher's periodic scan sees the same state: nothing new to record or say.
        asyncio.run(app.state.calendar_watch.tick())
        assert len(client.get(f"/v1/calendar/events/{event['id']}/changes").json()["items"]) == 1
        assert len([item for item in _notifications(client) if item["kind"] == "calendar.event_moved"]) == 1


def test_watcher_scan_rekeys_synced_events_and_moves_their_schedule(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(days=2)
    fake.add("evt-1", start)
    fake.add("evt-2", start + timedelta(hours=3), title="Board review")
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        events = {item["event_id"]: item for item in _sync(client, start, start + timedelta(days=5))["events"]}
        meeting_id = _schedule(client, start, "evt-1")
        asyncio.run(app.state.calendar_watch.tick())  # baseline scan: nothing changed
        fake.move("evt-1", start + timedelta(hours=1))
        fake.move("evt-2", start + timedelta(days=1))
        _force_due(app)
        app.state.calendar_watch._scanned.clear()
        asyncio.run(app.state.calendar_watch.tick())

        with app.state.database.session_factory() as session:
            rows = {row.event_id: row for row in session.query(CalendarEventCacheRow).all()}
        assert rows["evt-1"].id == events["evt-1"]["id"] and rows["evt-2"].id == events["evt-2"]["id"]
        moved = {item["link_view"]: item for item in _notifications(client) if item["kind"] == "calendar.event_moved"}
        assert set(moved) == {"meeting", "prep"}
        assert moved["meeting"]["link_id"] == meeting_id
        assert moved["prep"]["title"].startswith("“Board review” moved to")
        (change,) = _changes(app, meeting_id)
        assert change.cache_event_id == events["evt-1"]["id"]


def test_recurring_instances_are_never_confused(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=5)
    fake.add("series_1", start)
    fake.add("series_2", start + timedelta(days=7))
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        first = _schedule(client, start, "series_1")
        second = _schedule(client, start + timedelta(days=7), "series_2")
        fake.items["series_1"]["status"] = "cancelled"  # only this occurrence was cancelled
        asyncio.run(app.state.calendar_watch.tick())
        assert client.get(f"/v1/calendar/schedules/{first}").json()["status"] == "cancelled"
        second_state = client.get(f"/v1/calendar/schedules/{second}").json()
        assert second_state["status"] == "pending"
        assert datetime.fromisoformat(second_state["starts_at"]) == start + timedelta(days=7)


class FakeCalendly:
    """A Calendly account: a reschedule cancels the booking and creates a new one."""

    def __init__(self) -> None:
        self.bookings: dict[str, dict] = {}
        self.invitees: dict[str, list[dict]] = {}

    def book(self, uuid: str, start: datetime, email: str = "guest@example.test") -> str:
        uri = f"https://api.calendly.com/scheduled_events/{uuid}"
        self.bookings[uuid] = {"uri": uri, "name": "Discovery", "status": "active",
                               "start_time": _iso(start), "end_time": _iso(start + timedelta(minutes=30)),
                               "location": {"join_url": MEET}}
        self.invitees[uuid] = [{"email": email, "name": "Guest", "status": "active", "rescheduled": False,
                                "new_invitee": None}]
        return uri

    def reschedule(self, old: str, new: str, start: datetime) -> str:
        uri = self.book(new, start)
        self.bookings[old]["status"] = "canceled"
        self.invitees[old] = [{**self.invitees[old][0], "status": "canceled", "rescheduled": True,
                               "new_invitee": f"{uri}/invitees/inv-2"}]
        return uri

    def respond(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/connected_accounts"):
            return httpx.Response(200, json={"items": [{"id": "ca-calendly", "toolkit": {"slug": "calendly"},
                                                        "user_id": request.url.params["user_ids"], "status": "ACTIVE"}]})
        tool = request.url.path.rsplit("/", 1)[-1]
        arguments = json.loads(request.content)["arguments"]
        if tool == "CALENDLY_WHO_AM_I":
            return httpx.Response(200, json={"successful": True, "data": {"resource": {"uri": "https://api.calendly.com/users/me"},
                                                                          "uri": "https://api.calendly.com/users/me"}})
        if tool == "CALENDLY_LIST_EVENT_INVITEES":
            people = [item for item in self.invitees.get(arguments["uuid"], [])
                      if "status" not in arguments or item["status"] == arguments["status"]]
            return httpx.Response(200, json={"successful": True, "data": {"collection": people}})
        low = datetime.fromisoformat(arguments["min_start_time"])
        high = datetime.fromisoformat(arguments["max_start_time"])
        items = [item for item in self.bookings.values() if item["status"] == "active"
                 and low <= datetime.fromisoformat(item["start_time"]) < high]
        return httpx.Response(200, json={"successful": True, "data": {"collection": items}})


def test_calendly_reschedule_follows_the_new_booking(tmp_path) -> None:
    fake = FakeCalendly()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=5)
    old_uri = fake.book("old", start)
    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(fake.respond))
    calendar.auth_configs["calendly"] = "ac_test"
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'calendly.db'}",
                     credential_key="test-only-credential-key", calendar_adapter=calendar)
    with TestClient(app) as client:
        created = client.post("/v1/calendar/schedules", json={
            "connection_id": "ca-calendly", "event_id": old_uri, "event_date": start.date().isoformat(), "timezone": "UTC",
            "meeting": {"meeting_url": MEET},
        })
        assert created.status_code == 201, created.text
        meeting_id = created.json()["meeting"]["id"]
        new_start = start + timedelta(days=2)
        new_uri = fake.reschedule("old", "new", new_start)
        asyncio.run(app.state.calendar_watch.tick())
        schedule = client.get(f"/v1/calendar/schedules/{meeting_id}").json()
        assert schedule["status"] == "pending"
        assert schedule["event_id"] == new_uri
        assert datetime.fromisoformat(schedule["starts_at"]) == new_start
        assert [row.kind for row in _changes(app, meeting_id)] == ["moved"]

        # A plain cancellation of the new booking stops the join.
        fake.bookings["new"]["status"] = "canceled"
        fake.invitees["new"] = [{**fake.invitees["new"][0], "status": "canceled"}]
        _force_due(app)
        asyncio.run(app.state.calendar_watch.tick())
        assert client.get(f"/v1/calendar/schedules/{meeting_id}").json()["status"] == "cancelled"


def test_a_move_onto_an_already_scheduled_time_never_joins_twice(tmp_path) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=4)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        first = _schedule(client, start)
        later = start + timedelta(days=1)
        fake.move("evt-1", later)
        second = _schedule(client, later)  # someone already scheduled the event at its new time
        asyncio.run(app.state.calendar_watch.tick())
        assert client.get(f"/v1/calendar/schedules/{first}").json()["status"] == "cancelled"
        remaining = client.get(f"/v1/calendar/schedules/{second}").json()
        assert remaining["status"] == "pending" and datetime.fromisoformat(remaining["starts_at"]) == later


def test_busy_calendly_page_never_falsely_cancels_a_booking(tmp_path) -> None:
    fake = FakeCalendly()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=5)
    old_uri = fake.book("old", start)
    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(fake.respond))
    calendar.auth_configs["calendly"] = "ac_test"
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'busy.db'}",
                     credential_key="test-only-credential-key", calendar_adapter=calendar)
    with TestClient(app) as client:
        created = client.post("/v1/calendar/schedules", json={
            "connection_id": "ca-calendly", "event_id": old_uri, "event_date": start.date().isoformat(), "timezone": "UTC",
            "meeting": {"meeting_url": MEET},
        })
        assert created.status_code == 201, created.text
        meeting_id = created.json()["meeting"]["id"]
        # The booking vanished with no invitee record, and the page is busy with other guests' bookings:
        # more same-type bookings than the invitee check covers, so absence proves nothing.
        del fake.bookings["old"], fake.invitees["old"]
        for index in range(12):
            fake.book(f"other-{index}", start + timedelta(hours=index + 1), email=f"guest{index}@example.test")
        asyncio.run(app.state.calendar_watch.tick())
        assert client.get(f"/v1/calendar/schedules/{meeting_id}").json()["status"] == "pending"
