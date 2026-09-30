"""When every assistant is in a call, a join waits in line instead of failing; capacity is visible.

Vexa is a mocked transport with a configurable number of free slots (it answers 429 when full,
like its per-user ``max_concurrent_bots`` check).
"""

import asyncio
from datetime import UTC, datetime, timedelta

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app.adapters.vexa import ASSISTANTS_BUSY, VexaCaptureAdapter
from app.database import CalendarScheduleRow, NotificationRow
from app.main import create_app

LINK = "https://meet.google.com/abc-defg-hij"


class BusyVexa:
    def __init__(self, limit: int = 3, running: int = 3) -> None:
        self.limit, self.running, self.joins = limit, running, 0

    def adapter(self) -> VexaCaptureAdapter:
        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            if path == "/auth/me":
                return httpx.Response(200, json={"scopes": ["bot", "tx"], "max_concurrent": self.limit})
            if path == "/bots/status":
                return httpx.Response(200, json={"running_bots": [{"id": index} for index in range(self.running)]})
            if request.method == "POST" and path == "/bots":
                if self.running >= self.limit:
                    return httpx.Response(429, json={"detail": f"Maximum concurrent bots ({self.limit}) reached"})
                self.running += 1
                self.joins += 1
                return httpx.Response(201, json={"id": 500 + self.joins, "platform": "google_meet",
                                                 "native_meeting_id": "abc-defg-hij", "status": "requested"})
            if request.method == "GET" and path.startswith("/meetings/"):
                return httpx.Response(200, json={"id": int(path.rsplit("/", 1)[1]), "status": "requested"})
            raise AssertionError(f"unexpected Vexa request {request.method} {path}")
        return VexaCaptureAdapter("http://vexa.test", transport=httpx.MockTransport(handler))


def _app(tmp_path, vexa: BusyVexa):
    return create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'capacity.db'}", credential_key="test-key",
                      vexa_adapter=vexa.adapter())


def _schedule(app, meeting_id: str) -> CalendarScheduleRow | None:
    with app.state.database.session_factory() as session:
        return session.get(CalendarScheduleRow, meeting_id)


def _kinds(app) -> list[str]:
    with app.state.database.session_factory() as session:
        return [row.kind for row in session.execute(select(NotificationRow)).scalars()]


def test_capacity_shows_the_limit_what_is_in_use_and_what_waits(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("ASSISTANT_TESTED_CAPACITY", "6")
    vexa = BusyVexa(limit=3, running=2)
    app = _app(tmp_path, vexa)
    with TestClient(app) as client:
        capacity = client.get("/v1/assistants/capacity").json()
        assert (capacity["limit"], capacity["in_use"], capacity["available"], capacity["waiting"]) == (3, 2, 1, 0)
        assert capacity["tested_capacity"] == 6 and capacity["error"] is None


def test_a_join_when_every_assistant_is_busy_waits_and_joins_when_one_frees_up(tmp_path) -> None:
    vexa = BusyVexa(limit=3, running=3)
    app = _app(tmp_path, vexa)
    with TestClient(app) as client:
        meeting_id = client.post("/v1/meetings", json={"meeting_url": LINK, "title": "Board sync"}).json()["id"]
        joined = client.post(f"/v1/meetings/{meeting_id}/join")
        assert joined.status_code == 200, joined.text
        body = joined.json()
        assert body["status"] == "created"  # waiting, not failed
        assert body["schedule"]["status"] == "pending" and body["schedule"]["note"] == ASSISTANTS_BUSY
        assert _kinds(app).count("assistant.waiting") == 1
        assert "assistant.join_failed" not in _kinds(app)
        assert client.get("/v1/assistants/capacity").json()["waiting"] == 1

        asyncio.run(app.state.calendar_schedule.tick())  # still full: stays in line, no second notice
        assert _schedule(app, meeting_id).status == "pending"
        assert _kinds(app).count("assistant.waiting") == 1

        vexa.running = 2  # a call ended
        asyncio.run(app.state.calendar_schedule.tick())
        assert _schedule(app, meeting_id).status == "joined"
        assert client.get(f"/v1/meetings/{meeting_id}").json()["status"] != "failed"


def test_a_scheduled_join_waits_then_is_missed_if_nothing_frees_up(tmp_path) -> None:
    vexa = BusyVexa(limit=1, running=1)
    app = _app(tmp_path, vexa)
    with TestClient(app) as client:
        meeting_id = client.post("/v1/meetings", json={"meeting_url": LINK, "title": "Weekly"}).json()["id"]
        app.state.calendar_schedule.queue_until_free("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", meeting_id)
        asyncio.run(app.state.calendar_schedule.tick())
        assert _schedule(app, meeting_id).status == "pending"
        with app.state.database.session_factory.begin() as session:
            session.execute(update(CalendarScheduleRow).where(CalendarScheduleRow.meeting_id == meeting_id)
                            .values(starts_at=datetime.now(UTC) - timedelta(minutes=11)))
        asyncio.run(app.state.calendar_schedule.tick())
        row = _schedule(app, meeting_id)
        assert row.status == "missed" and row.last_error == "No assistant was free within 10 minutes of the start"
