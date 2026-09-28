"""Per-person time zone and clock: API, validation, isolation, roles, and server-rendered times."""

from datetime import UTC, date, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.accounts import _hash_password
from app.database import (
    AuditEventRow,
    CalendarScheduleRow,
    CalendarEventCacheRow,
    Database,
    NotificationRow,
    CalendarSyncStateRow,
    OrganizationMembershipRow,
    UserCredentialRow,
    UserPreferenceRow,
    UserRow,
)
from app.main import create_app
from app.notification_events import NotificationEvents
from app.notifications import NotificationService
from app.time_display import TimePreferences, format_datetime, format_time, uses_twelve_hour_clock, zone_abbreviation
from app.user_preferences import InvalidTimezoneError, load_time_preferences, valid_timezone

LEGACY_ORG = UUID("00000000-0000-4000-8000-000000000001")
OWNER = ("owner@example.test", "owner-password-for-test")


# ----- formatter ---------------------------------------------------------------------------
def test_formats_in_the_readers_zone_and_clock() -> None:
    moment = datetime(2026, 9, 28, 10, 42, tzinfo=UTC)
    assert format_time(moment, TimePreferences("Asia/Kolkata", "12h")) == "4:12 PM IST"
    assert format_time(moment, TimePreferences("Asia/Kolkata", "24h")) == "16:12 IST"
    assert format_time(moment, TimePreferences("Europe/Berlin", "24h")) == "12:42 CEST"
    assert format_time(moment, TimePreferences("UTC", "24h")) == "10:42 UTC"
    assert format_time(datetime(2026, 9, 28, 0, 5, tzinfo=UTC), TimePreferences("UTC", "12h")) == "12:05 AM UTC"


def test_new_york_is_dst_safe_across_the_november_change() -> None:
    reader = TimePreferences("America/New_York", "12h")
    # US daylight saving time ends at 2026-11-01 06:00 UTC.
    before = datetime(2026, 10, 31, 16, 0, tzinfo=UTC)
    after = datetime(2026, 11, 2, 16, 0, tzinfo=UTC)
    assert format_time(before, reader) == "12:00 PM EDT"
    assert format_time(after, reader) == "11:00 AM EST"
    assert format_time(datetime(2026, 11, 1, 5, 30, tzinfo=UTC), reader) == "1:30 AM EDT"
    assert format_time(datetime(2026, 11, 1, 6, 30, tzinfo=UTC), reader) == "1:30 AM EST"  # the repeated hour


def test_datetime_names_the_day_and_zone_and_adds_other_years() -> None:
    this_year = datetime.now(UTC).year
    moment = datetime(this_year, 3, 2, 9, 5, tzinfo=UTC)
    assert format_datetime(moment, TimePreferences("UTC", "24h")) == f"{moment:%a}, Mar 2, 09:05 UTC"
    old = datetime(2020, 1, 15, 23, 30, tzinfo=UTC)
    assert format_datetime(old, TimePreferences("Asia/Kolkata", "12h")) == "Thu, Jan 16, 2020, 5:00 AM IST"


def test_unknown_or_missing_zone_falls_back_to_labelled_utc_and_naive_is_utc() -> None:
    naive = datetime(2026, 9, 28, 10, 42)
    assert format_time(naive, TimePreferences("Not/AZone", "24h")) == "10:42 UTC"
    assert format_time(naive) == "10:42 UTC"


def test_zones_without_an_abbreviation_show_a_utc_offset() -> None:
    assert format_time(datetime(2026, 9, 28, 10, 0, tzinfo=UTC), TimePreferences("Asia/Dubai", "24h")) == "14:00 UTC+4"
    assert zone_abbreviation(datetime(2026, 1, 1, tzinfo=UTC).astimezone(__import__("zoneinfo").ZoneInfo("America/St_Johns"))) == "NST"
    assert format_time(datetime(2026, 9, 28, 10, 0, tzinfo=UTC), TimePreferences("Asia/Kathmandu", "24h")) == "15:45 UTC+5:45"


def test_auto_clock_follows_the_zones_usual_convention() -> None:
    assert uses_twelve_hour_clock(TimePreferences("America/New_York", "auto"))
    assert uses_twelve_hour_clock(TimePreferences("Asia/Kolkata", "auto"))
    assert not uses_twelve_hour_clock(TimePreferences("Europe/Berlin", "auto"))
    assert not uses_twelve_hour_clock(TimePreferences("America/Sao_Paulo", "auto"))
    assert not uses_twelve_hour_clock(TimePreferences("America/New_York", "24h"))
    assert uses_twelve_hour_clock(TimePreferences("Europe/Berlin", "12h"))


def test_timezone_validation_accepts_iana_names_and_normalises_legacy_aliases() -> None:
    assert valid_timezone("Asia/Kolkata") == "Asia/Kolkata"
    assert valid_timezone(" Asia/Calcutta ") == "Asia/Kolkata"
    for bad in ("", "Mars/Olympus", "localtime", "Factory", "../../etc/passwd", "A" * 80):
        with pytest.raises(InvalidTimezoneError):
            valid_timezone(bad)


# ----- API ---------------------------------------------------------------------------------
def _app(tmp_path, monkeypatch):
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER[1])
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "preferences-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER[0])
    return create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'prefs.db'}", credential_key="test-credential-key")


def _add_user(app, email: str, role: str, password: str = "member-password-for-test") -> str:
    user_id, now = str(uuid4()), datetime.now(UTC)
    with app.state.database.session_factory.begin() as session:
        session.add(UserRow(id=user_id, email=email, display_name=email.split("@")[0].title(),
                            auth_subject=f"local:{user_id}", status="active", created_at=now, updated_at=now))
        session.flush()
        session.add(OrganizationMembershipRow(organization_id=str(LEGACY_ORG), user_id=user_id, role=role, created_at=now))
        session.add(UserCredentialRow(user_id=user_id, password_hash=_hash_password(password),
                                      must_change_password=False, session_version=1, created_at=now, updated_at=now))
    return user_id


def _login(app, email: str, password: str) -> TestClient:
    client = TestClient(app)
    client.__enter__()
    assert client.post("/v1/auth/login", json={"email": email, "password": password}).status_code == 200
    return client


def test_defaults_detection_manual_override_and_back_to_browser(tmp_path, monkeypatch) -> None:
    app = _app(tmp_path, monkeypatch)
    client = _login(app, *OWNER)
    assert client.get("/v1/me/preferences").json() == {
        "timezone": "UTC", "timezone_source": "browser", "detected_timezone": None, "time_format": "auto"}

    detected = client.post("/v1/me/preferences/detected", json={"timezone": "Asia/Calcutta"})
    assert detected.status_code == 200
    assert detected.json() == {"timezone": "Asia/Kolkata", "timezone_source": "browser",
                               "detected_timezone": "Asia/Kolkata", "time_format": "auto"}

    manual = client.put("/v1/me/preferences", json={"timezone": "America/New_York"}).json()
    assert (manual["timezone"], manual["timezone_source"], manual["detected_timezone"]) == (
        "America/New_York", "manual", "Asia/Kolkata")
    # Travelling: the browser reports a new zone, but the manual choice still wins.
    travelled = client.post("/v1/me/preferences/detected", json={"timezone": "Europe/London"}).json()
    assert (travelled["timezone"], travelled["detected_timezone"]) == ("America/New_York", "Europe/London")

    clock = client.put("/v1/me/preferences", json={"time_format": "24h"}).json()
    assert (clock["timezone"], clock["time_format"]) == ("America/New_York", "24h")  # untouched field kept
    following = client.put("/v1/me/preferences", json={"timezone": None}).json()
    assert (following["timezone"], following["timezone_source"], following["time_format"]) == (
        "Europe/London", "browser", "24h")


def test_detected_report_is_idempotent_and_not_audited(tmp_path, monkeypatch) -> None:
    app = _app(tmp_path, monkeypatch)
    client = _login(app, *OWNER)
    client.post("/v1/me/preferences/detected", json={"timezone": "Asia/Kolkata"})
    with app.state.database.session_factory() as session:
        first = session.query(UserPreferenceRow).one().updated_at
    client.post("/v1/me/preferences/detected", json={"timezone": "Asia/Kolkata"})
    with app.state.database.session_factory() as session:
        assert session.query(UserPreferenceRow).one().updated_at == first
    client.put("/v1/me/preferences", json={"time_format": "12h"})
    with app.state.database.session_factory() as session:
        actions = {row.action for row in session.query(AuditEventRow)}
    assert "PUT /v1/me/preferences" in actions  # a deliberate change is workspace activity
    assert not any("preferences/detected" in action for action in actions)


@pytest.mark.parametrize(("method", "path", "payload"), [
    ("put", "/v1/me/preferences", {"timezone": "Mars/Olympus"}),
    ("put", "/v1/me/preferences", {"time_format": "36h"}),
    ("put", "/v1/me/preferences", {"theme": "dark"}),
    ("put", "/v1/me/preferences", {"timezone": "X" * 200}),
    ("post", "/v1/me/preferences/detected", {"timezone": "Not/AZone"}),
    ("post", "/v1/me/preferences/detected", {"timezone": ""}),
    ("post", "/v1/me/preferences/detected", {}),
])
def test_invalid_input_is_rejected_with_422(tmp_path, monkeypatch, method, path, payload) -> None:
    app = _app(tmp_path, monkeypatch)
    client = _login(app, *OWNER)
    response = getattr(client, method)(path, json=payload)
    assert response.status_code == 422, response.text
    assert client.get("/v1/me/preferences").json()["timezone"] == "UTC"


def test_preferences_are_per_person_and_open_to_every_role(tmp_path, monkeypatch) -> None:
    app = _app(tmp_path, monkeypatch)
    owner = _login(app, *OWNER)
    for role in ("member", "viewer", "admin"):
        _add_user(app, f"{role}@example.test", role)
    clients = {role: _login(app, f"{role}@example.test", "member-password-for-test") for role in ("member", "viewer", "admin")}
    zones = {"member": "Europe/Berlin", "viewer": "Asia/Tokyo", "admin": "America/Chicago"}
    for role, client in clients.items():
        assert client.post("/v1/me/preferences/detected", json={"timezone": "UTC"}).status_code == 200
        response = client.put("/v1/me/preferences", json={"timezone": zones[role], "time_format": "12h"})
        assert response.status_code == 200, (role, response.text)
    owner.put("/v1/me/preferences", json={"timezone": "Asia/Kolkata"})
    for role, client in clients.items():
        assert client.get("/v1/me/preferences").json()["timezone"] == zones[role]
    assert owner.get("/v1/me/preferences").json() == {
        "timezone": "Asia/Kolkata", "timezone_source": "manual", "detected_timezone": None, "time_format": "auto"}


def test_preferences_require_sign_in(tmp_path, monkeypatch) -> None:
    app = _app(tmp_path, monkeypatch)
    with TestClient(app) as anonymous:
        assert anonymous.get("/v1/me/preferences").status_code == 401
        assert anonymous.put("/v1/me/preferences", json={"time_format": "24h"}).status_code == 401
        assert anonymous.post("/v1/me/preferences/detected", json={"timezone": "UTC"}).status_code == 401


def test_saved_calendar_window_defaults_to_the_effective_timezone(tmp_path, monkeypatch) -> None:
    app = _app(tmp_path, monkeypatch)
    client = _login(app, *OWNER)
    owner_id = client.get("/v1/auth/me").json()["user_id"]
    now = datetime.now(UTC)
    with app.state.database.session_factory.begin() as session:
        session.add(CalendarSyncStateRow(organization_id=str(LEGACY_ORG), user_id=owner_id, connection_id="conn",
                                         last_synced_at=now, range_start=now, range_end=now, truncated=False))
        session.add(CalendarEventCacheRow(
            id=str(uuid4()), organization_id=str(LEGACY_ORG), user_id=owner_id, connection_id="conn",
            provider="googlecalendar", event_id="evt", starts_at=datetime(2026, 9, 28, 20, 0, tzinfo=UTC),
            ends_at=datetime(2026, 9, 28, 21, 0, tzinfo=UTC), synced_at=now, payload={
                "connection_id": "conn", "provider": "googlecalendar", "event_id": "evt", "title": "Late call",
                "starts_at": "2026-09-28T20:00:00Z", "ends_at": "2026-09-28T21:00:00Z",
                "meeting_url": "https://meet.google.com/abc-defg-hij", "platform": "google_meet"}))
    query = {"start_date": date(2026, 9, 29).isoformat(), "end_date": date(2026, 9, 29).isoformat()}
    assert client.get("/v1/calendar/synced", params=query).json()["events"] == []  # UTC: still Sep 28
    client.put("/v1/me/preferences", json={"timezone": "Asia/Kolkata"})  # 01:30 on Sep 29 in India
    assert [item["title"] for item in client.get("/v1/calendar/synced", params=query).json()["events"]] == ["Late call"]
    explicit = client.get("/v1/calendar/synced", params={**query, "timezone": "UTC"}).json()["events"]
    assert explicit == []  # an explicit zone from the browser still wins


# ----- notifications rendered per reader ---------------------------------------------------
def test_schedule_notifications_render_in_each_recipients_zone_and_clock(tmp_path, monkeypatch) -> None:
    app = _app(tmp_path, monkeypatch)
    owner = _login(app, *OWNER)
    admin_id = _add_user(app, "admin@example.test", "admin")
    admin = _login(app, "admin@example.test", "member-password-for-test")
    owner.put("/v1/me/preferences", json={"timezone": "Asia/Kolkata", "time_format": "12h"})
    admin.put("/v1/me/preferences", json={"timezone": "America/New_York", "time_format": "24h"})

    events: NotificationEvents = app.state.notification_events
    meeting_id = uuid4()
    starts_at = datetime(2026, 11, 2, 15, 30, tzinfo=UTC)
    events.schedule_created(LEGACY_ORG, meeting_id, "Planning", starts_at)
    owner_note = owner.get("/v1/notifications").json()["items"][0]
    admin_note = admin.get("/v1/notifications").json()["items"][0]
    assert owner_note["body"].endswith("9:00 PM IST.") and "Nov 2" in owner_note["body"]
    assert admin_note["body"].endswith("10:30 EST.") and "Nov 2" in admin_note["body"]
    assert load_time_preferences(app.state.database, [admin_id])[admin_id] == TimePreferences("America/New_York", "24h")

    meeting = owner.post("/v1/meetings", json={"meeting_url": "https://meet.google.com/abc-defg-hij", "title": "Sync"}).json()
    now = datetime(2026, 7, 1, 12, 0, tzinfo=UTC)
    with app.state.database.session_factory.begin() as session:
        session.add(CalendarScheduleRow(
            meeting_id=meeting["id"], organization_id=str(LEGACY_ORG), user_id=admin_id, connection_id="manual",
            provider="manual", event_id=meeting["id"], starts_at=now + timedelta(minutes=5),
            ends_at=now + timedelta(hours=1), status="pending", attempts=0, last_error=None, created_at=now, updated_at=now))
    assert events.schedule_reminders(now) == 2
    assert owner.get("/v1/notifications").json()["items"][0]["body"] == "The assistant joins automatically at 5:35 PM IST."
    assert admin.get("/v1/notifications").json()["items"][0]["body"] == "The assistant joins automatically at 08:05 EDT."


def test_reminder_and_people_without_preferences_read_labelled_utc(tmp_path) -> None:
    database = Database(f"sqlite+pysqlite:///{tmp_path / 'notes.db'}")
    database.migrate()
    events = NotificationEvents(NotificationService(database), database)
    now = datetime.now(UTC)
    people = {"plain": str(uuid4()), "india": str(uuid4())}
    with database.session_factory.begin() as session:
        for name, user_id in people.items():
            session.add(UserRow(id=user_id, email=f"{name}@example.test", display_name=name,
                                auth_subject=f"local:{user_id}", status="active", created_at=now, updated_at=now))
            session.flush()
            session.add(OrganizationMembershipRow(organization_id=str(LEGACY_ORG), user_id=user_id, role="owner", created_at=now))
        session.add(UserPreferenceRow(user_id=people["india"], timezone=None, detected_timezone="Asia/Kolkata",
                                      time_format="auto", updated_at=now))
    starts_at = datetime(2026, 9, 28, 10, 42, tzinfo=UTC)
    events.schedule_created(LEGACY_ORG, uuid4(), "Standup", starts_at)
    with database.session_factory() as session:
        bodies = {row.user_id: row.body for row in session.query(NotificationRow)}
    assert bodies[people["plain"]].endswith("Sep 28, 10:42 UTC.")
    assert bodies[people["india"]].endswith("Sep 28, 4:12 PM IST.")  # auto clock for India is 12-hour


@pytest.mark.parametrize("zone", ["", "..", "../../etc/passwd", "/etc/passwd", "Z" * 300, "Mars/Olympus"])
def test_malformed_calendar_time_zones_are_a_clean_400(tmp_path, monkeypatch, zone) -> None:
    app = _app(tmp_path, monkeypatch)
    client = _login(app, *OWNER)
    query = {"start_date": "2026-09-28", "end_date": "2026-09-28", "timezone": zone or " "}
    response = client.get("/v1/calendar/synced", params=query)
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == "choose a valid IANA time zone"
