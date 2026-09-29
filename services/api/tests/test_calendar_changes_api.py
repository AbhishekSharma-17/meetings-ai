"""Change history endpoints are scoped to the workspace, and synced events to their owner."""

import asyncio
from datetime import UTC, datetime, timedelta

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import inspect, insert, select

from account_links import accept_invite
from app.calendar_watch import WatchSettings
from app.composio_calendar import ComposioCalendar
from app.database import Base, Database, SCHEMA_TABLES_BY_VERSION, SchemaVersionRow
from app.main import create_app
from test_calendar_watch import FakeGoogle, _notifications, _schedule, _sync

OWNER, PASSWORD = "owner@example.test", "owner-password-for-test"


def _auth_app(tmp_path, monkeypatch, fake: FakeGoogle):
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER)
    calendar = ComposioCalendar("test-key", transport=httpx.MockTransport(fake.respond))
    calendar.auth_configs["googlecalendar"] = "ac_test"
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'changes-api.db'}",
                     credential_key="test-credential-key", calendar_adapter=calendar)
    app.state.calendar_watch.settings = WatchSettings()
    return app


def test_change_history_is_scoped_by_role_and_calendar_owner(tmp_path, monkeypatch) -> None:
    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(days=2)
    fake.add("evt-1", start)
    app = _auth_app(tmp_path, monkeypatch, fake)
    with TestClient(app) as owner, TestClient(app) as teammate:
        assert owner.post("/v1/auth/login", json={"email": OWNER, "password": PASSWORD}).status_code == 200
        invited = owner.post("/v1/workspace/invite", json={
            "email": "teammate@example.test", "display_name": "Team Mate", "role": "member",
        })
        assert invited.status_code == 201
        accept_invite(teammate, invited.json(), "teammate-new-password-for-test")

        (owner_event,) = _sync(owner, start, start + timedelta(days=5))["events"]
        (member_event,) = _sync(teammate, start, start + timedelta(days=5))["events"]
        meeting_id = _schedule(owner, start)
        fake.move("evt-1", start + timedelta(hours=2))
        asyncio.run(app.state.calendar_watch.tick())

        own = teammate.get(f"/v1/calendar/events/{member_event['id']}/changes")
        assert own.status_code == 200, own.text
        assert [item["kind"] for item in own.json()["items"]] == ["moved"]
        assert teammate.get(f"/v1/calendar/events/{owner_event['id']}/changes").status_code == 404
        assert teammate.get(f"/v1/meetings/{meeting_id}/schedule/changes").status_code == 403

        history = owner.get(f"/v1/meetings/{meeting_id}/schedule/changes")
        assert history.status_code == 200
        assert [item["kind"] for item in history.json()["items"]] == ["moved"]
        assert owner.get(f"/v1/calendar/events/{owner_event['id']}/changes").json()["items"][0]["meeting_id"] == meeting_id
        assert owner.get(f"/v1/calendar/events/{member_event['id']}/changes").status_code == 404
        assert owner.get("/v1/meetings/00000000-0000-4000-8000-00000000abcd/schedule/changes").status_code == 404

        # The teammate hears about their own synced event only; the owner about the schedule.
        assert [item["link_view"] for item in _notifications(teammate) if item["kind"] == "calendar.event_moved"] == ["prep"]
        owner_moves = [item for item in _notifications(owner) if item["kind"] == "calendar.event_moved"]
        assert [item["link_view"] for item in owner_moves] == ["meeting"]


def test_manual_sync_moves_a_pending_schedule_and_dedupes_with_the_watcher(tmp_path) -> None:
    from test_calendar_watch import _app, _changes

    fake = FakeGoogle()
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(days=2)
    fake.add("evt-1", start)
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        (event,) = _sync(client, start, start + timedelta(days=5))["events"]
        meeting_id = _schedule(client, start)
        later = start + timedelta(hours=3)
        fake.move("evt-1", later)
        _sync(client, start, start + timedelta(days=5))
        schedule = client.get(f"/v1/calendar/schedules/{meeting_id}").json()
        assert datetime.fromisoformat(schedule["starts_at"]) == later
        (change,) = _changes(app, meeting_id)
        assert change.source == "sync" and change.cache_event_id == event["id"]
        asyncio.run(app.state.calendar_watch.tick())
        assert len(_changes(app, meeting_id)) == 1
        moves = [item for item in _notifications(client) if item["kind"] == "calendar.event_moved"]
        assert [item["link_view"] for item in moves] == ["meeting"]


def test_version_25_database_upgrades_to_26_with_the_change_table(tmp_path) -> None:
    database = Database(f"sqlite+pysqlite:///{tmp_path / 'v25.db'}")
    with database.engine.begin() as connection:
        for version in range(3, 26):
            for name in SCHEMA_TABLES_BY_VERSION[version]:
                Base.metadata.tables[name].create(connection, checkfirst=True)
        for version in range(3, 26):
            connection.execute(insert(SchemaVersionRow).values(version=version, applied_at=datetime.now(UTC)))
    # A v25 database has the legacy workspace (seeded at v8).
    from app.database import LEGACY_ORGANIZATION_ID, OrganizationRow
    with database.engine.begin() as connection:
        connection.execute(insert(OrganizationRow).values(
            id=str(LEGACY_ORGANIZATION_ID), slug="legacy-workspace", display_name="Legacy", contact_email=None,
            status="active", created_at=datetime.now(UTC), updated_at=datetime.now(UTC)))
    assert "calendar_event_changes" not in inspect(database.engine).get_table_names()
    database.migrate()
    assert "calendar_event_changes" in inspect(database.engine).get_table_names()
    with database.engine.connect() as connection:
        assert max(connection.execute(select(SchemaVersionRow.version)).scalars().all()) == Database.SCHEMA_VERSION
    database.engine.dispose()
