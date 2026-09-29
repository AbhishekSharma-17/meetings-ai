"""Call coordination: teammates who set an assistant for the same call decide who brings it.

Vexa is mocked (it refuses a second bot for a call that already has one, like the real
service does per API key); calendars are fakes; nothing leaves the test process.
"""

import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID

import httpx
import pytest
from account_links import accept_invite
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app.adapters.vexa import VexaCaptureAdapter
from app.composio_calendar import CalendarConnection, CalendarEvent, CalendarEventsResponse
from app.database import CalendarScheduleRow, MeetingCoverageRow, MeetingMinutesRow, MeetingRow, NotificationRow, UserCredentialRow
from app.main import create_app

OWNER_EMAIL, OWNER_PASSWORD = "developer@genaiprotos.com", "owner-password-for-test"
LINK = "https://meet.google.com/abc-defg-hij"
LINK_VARIANT = "https://meet.google.com/ABC-DEFG-HIJ?authuser=1"


class FakeVexa:
    """One bot per call at a time, like Vexa's per-user (platform, native id) dedupe."""

    def __init__(self) -> None:
        self.bots: dict[int, str] = {}
        self.spawned: list[str] = []

    def adapter(self) -> VexaCaptureAdapter:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "POST" and request.url.path == "/bots":
                native = request.read().decode()
                call = "abc-defg-hij" if "abc-defg-hij" in native.lower() else native
                if call in self.bots.values():
                    return httpx.Response(409, json={"detail": f"An active meeting already exists for google_meet/{call}"})
                bot_id = 100 + len(self.bots)
                self.bots[bot_id] = call
                self.spawned.append(call)
                return httpx.Response(201, json={"id": bot_id, "platform": "google_meet", "native_meeting_id": "abc-defg-hij",
                                                 "status": "active"})
            if request.method == "GET" and request.url.path.startswith("/meetings/"):
                return httpx.Response(200, json={"id": int(request.url.path.rsplit("/", 1)[1]), "status": "active"})
            if request.method == "GET" and request.url.path.startswith("/transcripts/"):
                return httpx.Response(200, json={"status": "active", "segments": [
                    {"segment_id": "s1", "start": 0, "end": 2, "text": "Welcome everyone", "speaker": "Asha", "completed": True}]})
            raise AssertionError(f"unexpected Vexa request {request.method} {request.url.path}")
        return VexaCaptureAdapter("http://vexa.test", transport=httpx.MockTransport(handler))


class FakeCalendar:
    """Each person's own calendar: ``events[user_id]`` lists their copies of calls."""

    def __init__(self) -> None:
        self.events: dict[str, list[CalendarEvent]] = {}

    async def connections(self, actor):
        return [CalendarConnection(id="google", provider="googlecalendar", status="ACTIVE", label="Work")]

    async def events_for_window(self, actor, connection_id, start, end, timezone, **kwargs):
        return CalendarEventsResponse(events=list(self.events.get(str(actor.user_id), [])),
                                      range_start=start, range_end=end, timezone=timezone)

    async def events(self, actor, connection_id, period, timezone):
        return await self.events_for_window(actor, connection_id, None, None, timezone)


def _event(title: str, starts: datetime, url: str = LINK, event_id: str = "weekly") -> CalendarEvent:
    return CalendarEvent(connection_id="google", provider="googlecalendar", event_id=event_id, title=title,
                         starts_at=starts, ends_at=starts + timedelta(hours=1), meeting_url=url, platform="google_meet",
                         agenda="Private agenda", organizer="host@example.com",
                         invitees=[{"name": "Guest", "email": "guest@example.com"}])


@pytest.fixture()
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER_PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "coordination-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER_EMAIL)
    vexa, calendar = FakeVexa(), FakeCalendar()
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'coordination.db'}", credential_key="test-key",
                     vexa_adapter=vexa.adapter(), calendar_adapter=calendar)
    with TestClient(app) as client:
        people = _people(client)
        yield {"app": app, "client": client, "vexa": vexa, "calendar": calendar, **people}


def _login(client: TestClient, email: str, password: str) -> dict:
    client.post("/v1/auth/logout")
    response = client.post("/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return client.get("/v1/auth/me").json()


def _people(client: TestClient) -> dict:
    owner = _login(client, OWNER_EMAIL, OWNER_PASSWORD)
    assert client.patch("/v1/auth/me", json={"display_name": "Asha Patel"}).status_code == 200
    invites = {key: client.post("/v1/workspace/invite", json={"email": f"{key}@example.com", "display_name": name, "role": role}).json()
               for key, name, role in (("ben", "Ben Ortiz", "admin"), ("cara", "Cara Lee", "member"), ("dan", "Dan Wu", "member"))}
    ids = {"asha": owner["user_id"], "org": owner["organization_id"]}
    for key, invited in invites.items():
        client.post("/v1/auth/logout")
        ids[key] = accept_invite(client, invited, f"{key}-password-long-enough")["user_id"]
    return ids


def _as(world, who: str) -> TestClient:
    client = world["client"]
    if who == "asha":
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
    else:
        _login(client, f"{who}@example.com", f"{who}-password-long-enough")
    return client


def _schedule(client: TestClient, url: str, starts: datetime, title: str = "Weekly sync", **extra) -> str:
    response = client.post("/v1/meetings/schedules", json={
        "starts_at": starts.isoformat(), "ends_at": (starts + timedelta(hours=1)).isoformat(),
        "meeting": {"meeting_url": url, "title": title}, **extra})
    assert response.status_code == 201, response.text
    return response.json()["meeting"]["id"]


def _notes(world, user_id: str) -> list[NotificationRow]:
    with world["app"].state.database.session_factory() as session:
        return session.execute(select(NotificationRow).where(NotificationRow.user_id == user_id)).scalars().all()


def _make_due(world, *meeting_ids: str) -> None:
    now = datetime.now(UTC)
    with world["app"].state.database.session_factory.begin() as session:
        session.execute(update(CalendarScheduleRow).where(CalendarScheduleRow.meeting_id.in_(meeting_ids)).values(
            starts_at=now - timedelta(minutes=1), ends_at=now + timedelta(hours=1)))


def _tick(world) -> None:
    asyncio.run(world["app"].state.calendar_schedule.tick())


def _schedule_status(world, meeting_id: str) -> CalendarScheduleRow:
    with world["app"].state.database.session_factory() as session:
        return session.get(CalendarScheduleRow, meeting_id)


START = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=3)


def test_check_finds_a_teammates_assistant_for_the_same_call_only(world) -> None:
    asha = _schedule(_as(world, "asha"), LINK, START)
    ben = _as(world, "ben")
    found = ben.post("/v1/call-coordination/check", json={"meeting_url": LINK_VARIANT,
                                                            "starts_at": (START + timedelta(minutes=10)).isoformat()}).json()
    assert found["supported"] and found["platform"] == "google_meet"
    assert [(item["meeting_id"], item["owner"]["display_name"], item["state"]) for item in found["assistants"]] == [
        (asha, "Asha Patel", "scheduled")]
    assert found["your_assistants"] == [] and found["teammates_on_calendar"] == 0
    next_week = ben.post("/v1/call-coordination/check", json={"meeting_url": LINK, "starts_at": (START + timedelta(days=7)).isoformat()}).json()
    assert next_week["assistants"] == []
    other_call = ben.post("/v1/call-coordination/check", json={"meeting_url": "https://meet.google.com/xyz-abcd-efg",
                                                                "starts_at": START.isoformat()}).json()
    assert other_call["assistants"] == []
    assert ben.post("/v1/call-coordination/check", json={"meeting_url": "https://example.com/x"}).json()["supported"] is False
    # Members cannot schedule, so they cannot run the pre-scheduling check either.
    assert _as(world, "cara").post("/v1/call-coordination/check", json={"meeting_url": LINK}).status_code == 403


def test_second_schedule_asks_both_to_decide_and_is_deduped(world) -> None:
    asha = _schedule(_as(world, "asha"), LINK, START)
    ben_client = _as(world, "ben")
    ben = _schedule(ben_client, LINK_VARIANT, START + timedelta(minutes=5))
    titles = [note.title for note in _notes(world, world["asha"]) if note.kind == "coordination.same_call"]
    assert titles == ["Ben Ortiz also scheduled an assistant for “Weekly sync” (same call) — decide who brings it"]
    world["app"].state.call_coordination.announce(world["app"].state.accounts.from_session(
        *_session_of(world, "ben")), ben)  # a repeated announcement never duplicates the notification
    assert len([note for note in _notes(world, world["asha"]) if note.kind == "coordination.same_call"]) == 1
    panel = ben_client.get(f"/v1/meetings/{ben}/coordination").json()
    assert panel["your_role"] == "owner" and [item["meeting_id"] for item in panel["other_assistants"]] == [asha]
    # Undecided: both stay set to join (an explicit choice is needed to drop one).
    assert _schedule_status(world, asha).status == _schedule_status(world, ben).status == "pending"


def _session_of(world, who: str):
    app = world["app"]
    ids = {"asha": world["asha"], "ben": world["ben"], "cara": world["cara"], "dan": world["dan"]}
    with app.state.database.session_factory() as session:
        version = session.get(UserCredentialRow, ids[who]).session_version
    return UUID(ids[who]), UUID(world["org"]), version


def test_share_cancels_my_schedule_grants_read_access_and_joins_once(world) -> None:
    asha_client = _as(world, "asha")
    asha = _schedule(asha_client, LINK, START)
    ben_client = _as(world, "ben")
    ben = _schedule(ben_client, LINK_VARIANT, START)
    shared = ben_client.post(f"/v1/meetings/{asha}/coverage", json={"receive_recap": True})
    assert shared.status_code == 200, shared.text
    assert shared.json()["your_role"] == "sharing" and shared.json()["receive_recap"] is True
    mine = _schedule_status(world, ben)
    assert mine.status == "cancelled" and "Asha Patel's assistant" in mine.last_error
    assert ben_client.get(f"/v1/meetings/{ben}/coordination").json()["handed_to"]["meeting_id"] == asha
    asha_view = _as(world, "asha").get(f"/v1/meetings/{asha}/coordination").json()
    assert [person["display_name"] for person in asha_view["covering"]] == ["Ben Ortiz"]
    assert "ben@example.com" in asha_client.get(f"/v1/meetings/{asha}/delivery-settings").json()["internal_recipients"]
    assert [note.title for note in _notes(world, world["asha"]) if note.kind == "coordination.sharing"] == [
        "Ben Ortiz is now sharing your assistant's notes for “Weekly sync”"]
    _make_due(world, asha, ben)
    _tick(world)
    assert world["vexa"].spawned == ["abc-defg-hij"]
    assert _schedule_status(world, asha).status == "joined" and _schedule_status(world, ben).status == "cancelled"
    # Stop sharing removes the recap address again.
    assert _as(world, "ben").delete(f"/v1/meetings/{asha}/coverage").status_code == 200
    assert "ben@example.com" not in _as(world, "asha").get(f"/v1/meetings/{asha}/delivery-settings").json()["internal_recipients"]


def test_send_my_own_anyway_keeps_both_and_the_later_one_stands_down(world) -> None:
    asha = _schedule(_as(world, "asha"), LINK, START)
    ben = _schedule(_as(world, "ben"), LINK_VARIANT, START, coordination="own")
    assert [note.title for note in _notes(world, world["asha"]) if note.kind == "coordination.two_assistants"] == [
        "Two assistants are set for “Weekly sync” (yours and Ben Ortiz's)"]
    assert not [note for note in _notes(world, world["asha"]) if note.kind == "coordination.same_call"]
    assert _as(world, "asha").get(f"/v1/meetings/{ben}/coordination").json()["kept_own"] is True
    _make_due(world, asha, ben)
    _tick(world)
    assert world["vexa"].spawned == ["abc-defg-hij"]  # the capture service allows one bot per call
    with world["app"].state.database.session_factory() as session:
        rows = {row.id: row for row in session.execute(select(MeetingRow).where(MeetingRow.id.in_([asha, ben]))).scalars()}
        coverage = session.execute(select(MeetingCoverageRow)).scalars().all()
    winner, loser = (asha, ben) if rows[asha].status == "active" else (ben, asha)
    assert rows[loser].status == "failed" and "was already in this call" in rows[loser].last_error
    loser_owner = world["ben"] if loser == ben else world["asha"]
    assert any(row.meeting_id == winner and row.user_id == loser_owner and row.role == "sharing" for row in coverage)
    assert [note.kind for note in _notes(world, loser_owner) if note.kind == "coordination.stood_down"] == ["coordination.stood_down"]


def test_the_same_persons_duplicate_records_never_double_join(world) -> None:
    client = _as(world, "asha")
    first = _schedule(client, LINK, START)
    second = _schedule(client, LINK_VARIANT, START + timedelta(minutes=2), title="Weekly sync (copy)")
    check = client.post("/v1/call-coordination/check", json={"meeting_url": LINK, "starts_at": START.isoformat()}).json()
    assert check["assistants"] == [] and len(check["your_assistants"]) == 2
    _make_due(world, first, second)
    _tick(world)
    _tick(world)
    assert world["vexa"].spawned == ["abc-defg-hij"]
    statuses = sorted([_schedule_status(world, first).status, _schedule_status(world, second).status])
    assert statuses == ["cancelled", "joined"]
    skipped = first if _schedule_status(world, first).status == "cancelled" else second
    assert _schedule_status(world, skipped).last_error.startswith("Skipped:")


def test_send_now_detects_the_live_assistant_and_own_anyway_stands_down(world) -> None:
    asha_client = _as(world, "asha")
    live = asha_client.post("/v1/meetings", json={"meeting_url": LINK, "title": "Design review"}).json()["id"]
    assert asha_client.post(f"/v1/meetings/{live}/join").status_code == 200
    ben_client = _as(world, "ben")
    check = ben_client.post("/v1/call-coordination/check", json={"meeting_url": LINK_VARIANT}).json()
    assert [(item["meeting_id"], item["state"]) for item in check["assistants"]] == [(live, "in_call")]
    mine = ben_client.post("/v1/meetings", json={"meeting_url": LINK_VARIANT, "title": "Design review"}).json()["id"]
    refused = ben_client.post(f"/v1/meetings/{mine}/join", params={"coordination": "own"})
    assert refused.status_code >= 400
    record = ben_client.get(f"/v1/meetings/{mine}").json()
    assert record["status"] == "failed" and record["last_error"].startswith("Asha Patel's assistant was already in this call")
    assert ben_client.get(f"/v1/meetings/{live}/coordination").json()["your_role"] == "sharing"
    assert ben_client.post(f"/v1/meetings/{mine}/join", params={"coordination": "maybe"}).status_code == 422


def test_calendar_sync_and_import_tell_teammates_with_the_same_call(world) -> None:
    calendar = world["calendar"]
    event_start = START.replace(minute=0, second=0)
    calendar.events[world["cara"]] = [_event("Acme weekly (Cara's copy)", event_start)]
    calendar.events[world["asha"]] = [_event("Acme weekly", event_start, url=LINK_VARIANT, event_id="asha-weekly")]
    cara = _as(world, "cara")
    assert cara.put("/v1/me/preferences", json={"timezone": "Asia/Kolkata"}).status_code == 200
    window = {"start_date": (event_start - timedelta(days=1)).date().isoformat(),
              "end_date": (event_start + timedelta(days=1)).date().isoformat(), "timezone": "UTC"}
    assert cara.post("/v1/calendar/sync", json=window).status_code == 200
    asha = _as(world, "asha")
    assert asha.post("/v1/calendar/sync", json=window).status_code == 200
    imported = asha.post("/v1/calendar/schedules", json={"connection_id": "google", "event_id": "asha-weekly",
                                                          "event_date": event_start.date().isoformat(), "timezone": "UTC",
                                                          "meeting": {"meeting_url": LINK_VARIANT}})
    assert imported.status_code == 201, imported.text
    meeting_id = imported.json()["meeting"]["id"]
    heads_up = [note for note in _notes(world, world["cara"]) if note.kind == "coordination.teammate_assistant"]
    assert len(heads_up) == 1
    assert heads_up[0].title.startswith("Asha Patel's assistant joins at") and "IST" in heads_up[0].title
    assert "Cara's copy" in heads_up[0].title and heads_up[0].link_view == "calendar"
    # A later sync of Cara's calendar does not repeat it.
    assert _as(world, "cara").post("/v1/calendar/sync", json=window).status_code == 200
    assert len([note for note in _notes(world, world["cara"]) if note.kind == "coordination.teammate_assistant"]) == 1
    # Asha only learns a count of teammates with the call on their calendar, nothing from Cara's event.
    panel = _as(world, "asha").get(f"/v1/meetings/{meeting_id}/coordination").json()
    assert panel["teammates_on_calendar"] == 1 and "Cara" not in str(panel)
    items = _as(world, "cara").get("/v1/call-coordination/calendar", params={
        "start": (event_start - timedelta(hours=2)).isoformat(), "end": (event_start + timedelta(hours=2)).isoformat()}).json()
    assert len(items) == 1 and items[0]["assistants"][0]["owner"]["display_name"] == "Asha Patel"
    assert items[0]["assistants"][0]["can_open"] is False and "title" not in items[0]["assistants"][0]


def test_sharer_permissions_and_other_members_see_nothing(world) -> None:
    calendar = world["calendar"]
    event_start = START.replace(minute=0, second=0)
    calendar.events[world["cara"]] = [_event("Weekly sync", event_start)]
    asha = _schedule(_as(world, "asha"), LINK, event_start)
    cara = _as(world, "cara")
    assert cara.get(f"/v1/meetings/{asha}").status_code == 404
    assert cara.get(f"/v1/meetings/{asha}/coordination").status_code == 404
    window = {"start_date": event_start.date().isoformat(), "end_date": event_start.date().isoformat(), "timezone": "UTC"}
    assert cara.post("/v1/calendar/sync", json=window).status_code == 200
    shared = cara.post(f"/v1/meetings/{asha}/coverage", json={"receive_recap": False})
    assert shared.status_code == 200, shared.text
    assert cara.get(f"/v1/meetings/{asha}").status_code == 200
    assert cara.get(f"/v1/meetings/{asha}/coordination").json()["your_role"] == "sharing"
    assert cara.get(f"/v1/meetings/{asha}/coverage/minutes").status_code == 404  # nothing approved yet
    for method, path in (("DELETE", f"/v1/meetings/{asha}"), ("PUT", f"/v1/meetings/{asha}/delivery-settings"),
                         ("POST", f"/v1/meetings/{asha}/stop"), ("POST", f"/v1/meetings/{asha}/join"),
                         ("GET", f"/v1/meetings/{asha}/minutes"), ("GET", "/v1/meetings"),
                         ("GET", f"/v1/meetings/{asha}/delivery-settings")):
        assert cara.request(method, path, json={}).status_code == 403, (method, path)
    assert "cara@example.com" not in _as(world, "asha").get(f"/v1/meetings/{asha}/delivery-settings").json()["internal_recipients"]
    dan = _as(world, "dan")  # not on the calendar, not covered
    assert dan.get(f"/v1/meetings/{asha}").status_code == 404
    assert dan.post(f"/v1/meetings/{asha}/coverage", json={}).status_code == 404
    assert dan.get(f"/v1/meetings/{asha}/coverage/minutes").status_code == 404
    assert dan.get("/v1/call-coordination/meetings").json() == []
    # Sharing a meeting never adds it to anyone's knowledge base, search or chat.
    assert _as(world, "cara").get("/v1/knowledge-bases").json() == []


def test_sharer_reads_transcript_and_approved_minutes_only(world) -> None:
    calendar = world["calendar"]
    event_start = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=5)
    calendar.events[world["cara"]] = [_event("Weekly sync", event_start)]
    asha_client = _as(world, "asha")
    live = asha_client.post("/v1/meetings", json={"meeting_url": LINK, "title": "Weekly sync"}).json()["id"]
    assert asha_client.post(f"/v1/meetings/{live}/join").status_code == 200
    cara = _as(world, "cara")
    window = {"start_date": event_start.date().isoformat(), "end_date": (event_start + timedelta(days=1)).date().isoformat(), "timezone": "UTC"}
    assert cara.post("/v1/calendar/sync", json=window).status_code == 200
    assert cara.post(f"/v1/meetings/{live}/coverage", json={}).status_code == 200
    transcript = cara.get(f"/v1/meetings/{live}/transcript")
    assert transcript.status_code == 200 and transcript.json()["segments"][0]["text"] == "Welcome everyone"
    now = datetime.now(UTC)
    with world["app"].state.database.session_factory.begin() as session:
        session.add(MeetingMinutesRow(meeting_id=live, status="approved", title="Weekly sync", executive_summary="Agreed the plan.",
                                      discussion_points=[], decisions=[], action_items=[], open_questions=[],
                                      provider_profile_id=None, provider="test", model="test", last_error=None,
                                      created_at=now, updated_at=now, approved_at=now, sent_at=None))
    minutes = _as(world, "cara").get(f"/v1/meetings/{live}/coverage/minutes")
    assert minutes.status_code == 200 and minutes.json()["executive_summary"] == "Agreed the plan."


def test_cross_workspace_isolation(world) -> None:
    asha = _schedule(_as(world, "asha"), LINK, START)
    client = _as(world, "asha")
    created = client.post("/v1/workspaces", json={"display_name": "Other company"})
    assert created.status_code in {200, 201}, created.text
    # The owner now works in the other workspace (switching is part of creating it).
    other = client.post("/v1/call-coordination/check", json={"meeting_url": LINK, "starts_at": START.isoformat()}).json()
    assert other["assistants"] == [] and other["your_assistants"] == []
    assert client.get(f"/v1/meetings/{asha}/coordination").status_code == 404
    assert client.post(f"/v1/meetings/{asha}/coverage", json={}).status_code == 404
    assert client.get("/v1/call-coordination/meetings").json() == []


def test_a_moved_event_keeps_its_coordination(world) -> None:
    asha = _schedule(_as(world, "asha"), LINK, START)
    ben_client = _as(world, "ben")
    ben = _schedule(ben_client, LINK, START)
    assert ben_client.post(f"/v1/meetings/{asha}/coverage", json={"receive_recap": False}).status_code == 200
    moved = START + timedelta(days=1)
    with world["app"].state.database.session_factory.begin() as session:  # what the reschedule watcher writes
        session.execute(update(CalendarScheduleRow).where(CalendarScheduleRow.meeting_id == asha).values(
            starts_at=moved, ends_at=moved + timedelta(hours=1)))
    panel = _as(world, "asha").get(f"/v1/meetings/{asha}/coordination").json()
    assert datetime.fromisoformat(panel["starts_at"]) == moved
    assert [person["display_name"] for person in panel["covering"]] == ["Ben Ortiz"]
    assert _schedule_status(world, ben).status == "cancelled"
    chips = {item["meeting_id"]: item for item in _as(world, "ben").get("/v1/call-coordination/meetings").json()}
    assert chips[asha]["your_role"] == "sharing" and chips[ben]["handed_to_owner"]["display_name"] == "Asha Patel"


def test_importing_a_teammates_calendar_event_needs_an_explicit_choice(world) -> None:
    calendar = world["calendar"]
    event_start = START.replace(minute=0, second=0)
    calendar.events[world["asha"]] = [_event("Acme weekly", event_start, event_id="asha-copy")]
    calendar.events[world["ben"]] = [_event("Acme weekly", event_start, event_id="ben-copy")]

    def body(event_id: str) -> dict:
        return {"connection_id": "google", "event_id": event_id, "event_date": event_start.date().isoformat(),
                "timezone": "UTC", "meeting": {"meeting_url": LINK}}

    assert _as(world, "asha").post("/v1/calendar/schedules", json=body("asha-copy")).status_code == 201
    ben = _as(world, "ben")
    refused = ben.post("/v1/calendar/schedules", json=body("ben-copy"))
    assert refused.status_code == 400 and "share that assistant or choose to send your own" in refused.json()["detail"]
    own = ben.post("/v1/calendar/schedules", json={**body("ben-copy"), "coordination": "own"})
    assert own.status_code == 201, own.text
    # The same person can never import the same call twice, even with "own".
    again = _as(world, "asha").post("/v1/calendar/schedules", json={**body("asha-copy"), "coordination": "own"})
    assert again.status_code == 400


def test_sharers_hear_about_the_call_but_not_about_draft_minutes(world) -> None:
    asha = _schedule(_as(world, "asha"), LINK, START)
    assert _as(world, "ben").post(f"/v1/meetings/{asha}/coverage", json={"receive_recap": False}).status_code == 200
    notifications = world["app"].state.notifications
    audience = notifications.meeting_audience(world["org"], asha)
    assert world["ben"] in audience
    assert world["ben"] in notifications.meeting_audience(world["org"], asha, include_sharers=False)  # Ben is an admin anyway
    calendar = world["calendar"]
    calendar.events[world["cara"]] = [_event("Weekly sync", START)]
    cara = _as(world, "cara")
    assert cara.post("/v1/calendar/sync", json={"start_date": START.date().isoformat(), "end_date": START.date().isoformat(),
                                                 "timezone": "UTC"}).status_code == 200
    assert cara.post(f"/v1/meetings/{asha}/coverage", json={"receive_recap": False}).status_code == 200
    assert world["cara"] in notifications.meeting_audience(world["org"], asha)
    assert world["cara"] not in notifications.meeting_audience(world["org"], asha, include_sharers=False)
    notifications.notify_meeting(world["org"], asha, kind="minutes.ready", severity="success", title="Draft minutes ready",
                                 dedupe_key="test-minutes")
    notifications.notify_meeting(world["org"], asha, kind="assistant.joined", severity="success", title="Assistant joined",
                                 dedupe_key="test-joined")
    kinds = {note.kind for note in _notes(world, world["cara"])}
    assert "assistant.joined" in kinds and "minutes.ready" not in kinds


def test_joining_another_workspaces_meeting_never_writes_coverage_for_it(world) -> None:
    asha = _schedule(_as(world, "asha"), LINK, START)
    client = _as(world, "asha")
    assert client.post("/v1/workspaces", json={"display_name": "Other company"}).status_code in {200, 201}
    other_org = client.get("/v1/auth/me").json()["organization_id"]
    # An owner of the other workspace tries the manual join route with the first workspace's meeting id.
    assert client.post(f"/v1/meetings/{asha}/join").status_code == 404
    with world["app"].state.database.session_factory() as session:
        foreign = session.execute(select(MeetingCoverageRow).where(
            MeetingCoverageRow.meeting_id == asha, MeetingCoverageRow.organization_id == other_org)).scalars().all()
    assert foreign == []
