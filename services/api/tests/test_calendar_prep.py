"""Calendar snapshots and meeting prep remain scoped, durable, and source-backed."""

import asyncio
import json
from datetime import UTC, datetime, timedelta

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app.composio_calendar import CalendarConnection, CalendarError, CalendarEvent, CalendarEventsResponse
from app.database import CalendarEventCacheRow, MeetingPrepRow
from app.main import create_app
from meetings_contracts import TextGenerationResult


WHEN = datetime(2026, 10, 6, 15, tzinfo=UTC)


class FakeCalendar:
    def __init__(self) -> None:
        self.available = {"google": True, "outlook": True}
        self.titles = {"google": "Acme discovery", "outlook": "Acme discovery"}
        self.fail_connection = None

    async def connections(self, actor):
        return [
            CalendarConnection(id="google", provider="googlecalendar", status="ACTIVE", label="Google work"),
            CalendarConnection(id="outlook", provider="outlook", status="ACTIVE", label="Outlook work"),
        ]

    async def events_for_window(self, actor, connection_id, start, end, timezone, **kwargs):
        if connection_id == self.fail_connection:
            raise CalendarError("upstream calendar unavailable")
        provider = "googlecalendar" if connection_id == "google" else "outlook"
        events = [CalendarEvent(
            connection_id=connection_id, provider=provider, event_id=f"meeting-{connection_id}",
            title=self.titles[connection_id], starts_at=WHEN, ends_at=WHEN + timedelta(hours=1),
            meeting_url="https://meet.google.com/abc-defg-hij", platform="google_meet",
            agenda="Private launch roadmap", organizer="Host",
            invitees=[{"name": "Asha Patel", "email": "asha@acme.example"}],
        )] if self.available[connection_id] else []
        return CalendarEventsResponse(events=events, range_start=start, range_end=end, timezone=timezone)


def _app(tmp_path, fake):
    return create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'calendar-prep.db'}",
                      credential_key="test-only-credential-key", calendar_adapter=fake)


def _sync(client):
    return client.post("/v1/calendar/sync", json={
        "start_date": "2026-10-01", "end_date": "2026-10-31", "timezone": "UTC",
    })


def test_sync_persists_overlaps_and_resync_removes_only_missing_account(tmp_path):
    fake = FakeCalendar()
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        synced = _sync(client)
        assert synced.status_code == 200, synced.text
        assert len(synced.json()["events"]) == 2
        assert {event["provider"] for event in synced.json()["events"]} == {"outlook", "googlecalendar"}
        initial_ids = {event["connection_id"]: event["id"] for event in synced.json()["events"]}

        saved = client.get("/v1/calendar/synced", params={
            "start_date": "2026-10-01", "end_date": "2026-10-31", "timezone": "UTC",
        })
        assert saved.status_code == 200
        assert {event["id"] for event in saved.json()["events"]} == set(initial_ids.values())
        assert len(saved.json()["syncs"]) == 2

        fake.titles["google"] = "Acme discovery — revised agenda"
        refreshed = client.post("/v1/calendar/sync", json={
            "connection_ids": ["google"], "start_date": "2026-10-01",
            "end_date": "2026-10-31", "timezone": "UTC",
        })
        assert refreshed.status_code == 200, refreshed.text
        revised = next(event for event in refreshed.json()["events"] if event["connection_id"] == "google")
        assert revised["id"] == initial_ids["google"]
        assert revised["title"] == "Acme discovery — revised agenda"

        fake.fail_connection = "google"
        unavailable = client.post("/v1/calendar/sync", json={
            "connection_ids": ["google"], "start_date": "2026-10-01",
            "end_date": "2026-10-31", "timezone": "UTC",
        })
        assert unavailable.status_code == 200
        assert unavailable.json()["errors"] == {"google": "upstream calendar unavailable"}
        assert next(event for event in unavailable.json()["events"] if event["connection_id"] == "google")["title"] == revised["title"]
        fake.fail_connection = None

        fake.available["google"] = False
        updated = client.post("/v1/calendar/sync", json={
            "connection_ids": ["google"], "start_date": "2026-10-01",
            "end_date": "2026-10-31", "timezone": "UTC",
        })
        assert updated.status_code == 200, updated.text
        assert [event["id"] for event in updated.json()["events"]] == [initial_ids["outlook"]]
        assert client.get(f"/v1/calendar/events/{initial_ids['google']}/prep").status_code == 404

    reopened = _app(tmp_path, fake)
    with TestClient(reopened) as client:
        saved = client.get("/v1/calendar/synced", params={
            "start_date": "2026-10-01", "end_date": "2026-10-31", "timezone": "UTC",
        })
        assert [event["id"] for event in saved.json()["events"]] == [initial_ids["outlook"]]


def test_company_brief_documents_and_context_only_prep(tmp_path):
    app = _app(tmp_path, FakeCalendar())
    with TestClient(app) as client:
        profile = client.put("/v1/workspace/brief", json={
            "website": "https://our-company.example", "overview": "We build useful software.",
            "services": ["AI research"], "products": ["Meetings AI"],
            "differentiators": "Source-backed summaries", "positioning": "Practical AI tools",
        })
        assert profile.status_code == 200, profile.text
        upload = client.post("/v1/workspace/brief/documents", files={
            "file": ("offerings.md", b"Our enterprise service includes meeting workflows and preparation guides.", "text/markdown"),
        })
        assert upload.status_code == 201, upload.text
        assert upload.json()["character_count"] > 30
        assert len(client.get("/v1/workspace/brief/documents").json()) == 1
        event_id = _sync(client).json()["events"][0]["id"]

        async def synthesize(request, profile_id=None):
            assert "We build useful software." in request.prompt
            assert "Our enterprise service" in request.prompt
            return None, TextGenerationResult(text="", provider="test", model="test-model", structured_output=_v2_output(
                executive_brief="Discuss the planned discovery call.",
                alignment={"fit_summary": "Good fit", "relevant_services": [
                    {"service": "AI research", "why": "They asked", "talking_point": "Offer a scan", "source_ids": []}]},
                talking_points=["Ask about requirements"], questions_to_ask=["What matters most?"],
            ))

        app.state.profile_service.generate_text = synthesize
        generated = client.post(f"/v1/calendar/events/{event_id}/prep", json={
            "research_enabled": False, "context": "Focus on a useful introduction",
        })
        assert generated.status_code == 200, generated.text
        assert generated.json()["report_version"] == 2
        assert generated.json()["public_research_performed"] is False
        assert generated.json()["relevant_offerings"] == ["AI research"]
        origins = {source["origin"] for source in generated.json()["sources"]}
        assert origins == {"organization_brief", "our_documents"}
        assert client.get(f"/v1/calendar/events/{event_id}/prep").json()["id"] == generated.json()["id"]
        assert client.delete(f"/v1/workspace/brief/documents/{upload.json()['id']}").status_code == 204
        assert client.get("/v1/workspace/brief/documents").json() == []

        # Meeting retention also removes old calendar attendee snapshots and
        # their dependent prep reports, without touching the org profile.
        with app.state.database.session_factory.begin() as session:
            session.execute(update(CalendarEventCacheRow).values(
                ends_at=datetime.now(UTC) - timedelta(days=45),
            ))
        assert client.put("/v1/workspace/retention", json={
            "enabled": True, "meeting_days": 30, "chat_days": None, "audit_days": None,
        }).status_code == 200
        asyncio.run(app.state.retention.tick())
        with app.state.database.session_factory() as session:
            assert session.execute(select(CalendarEventCacheRow.id)).scalars().all() == []
            assert session.execute(select(MeetingPrepRow.id)).scalars().all() == []
        assert client.get("/v1/workspace/brief").json()["overview"] == "We build useful software."


def test_public_research_uses_exa_without_private_brief_or_calendar_details(tmp_path):
    app = _app(tmp_path, FakeCalendar())
    captured = []

    def respond(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        captured.append((request.url.path, payload))
        if request.url.path == "/contents":
            return httpx.Response(200, json={"results": [], "costDollars": {"total": 0.0}})
        if payload.get("category") == "people":
            return httpx.Response(200, json={"results": [], "costDollars": {"total": 0.007}})
        return httpx.Response(200, json={"results": [{
            "id": "a", "url": "https://acme.example/about", "title": "About Acme",
            "highlights": ["Acme sells widgets."], "publishedDate": "2026-09-01T00:00:00.000Z",
        }], "costDollars": {"total": 0.008}})

    app.state.meeting_prep.exa_transport = httpx.MockTransport(respond)
    app.state.meeting_prep.environ = {"EXA_API_KEY": "exa-test-key"}
    with TestClient(app) as client:
        saved = client.put("/v1/workspace/brief", json={
            "website": "https://ours.example", "overview": "SECRET-PRIVATE-CONTEXT",
        })
        assert saved.status_code == 200
        event_id = _sync(client).json()["events"][0]["id"]

        async def synthesize(request, profile_id=None, **_):
            if request.metadata["purpose"] == "meeting_prep_planning":
                return None, TextGenerationResult(text="", provider="test", model="test-model",
                                                  structured_output={"queries": [], "learning_goals": []})
            assert "SECRET-PRIVATE-CONTEXT" in request.prompt
            return None, TextGenerationResult(text="", provider="test", model="test-model", structured_output=_v2_output(
                executive_brief="Acme discovery.",
                company={"name": "acme.example", "website": "https://acme.example", "what_they_do": "Acme sells widgets.",
                         "industry": "", "size_signals": "", "headquarters": "", "source_ids": ["W1"]},
            ))

        app.state.profile_service.generate_text = synthesize
        report = client.post(f"/v1/calendar/events/{event_id}/prep", json={"research_enabled": True})
        assert report.status_code == 200, report.text
        assert report.json()["sources"][0]["url"] == "https://acme.example/about"
        assert report.json()["findings"][0]["source_ids"] == ["W1"]
        assert report.json()["target_company"] == "acme.example"
        sent = json.dumps([body for _, body in captured])
        assert captured and all(path in {"/search", "/contents"} for path, _ in captured)
        assert "SECRET-PRIVATE-CONTEXT" not in sent
        assert "Private launch roadmap" not in sent
        assert "Acme discovery" not in sent
        assert "asha@acme.example" not in sent and "@" not in sent


def _v2_output(**overrides):
    base = {
        "executive_brief": "", "company": {"name": None, "website": None, "what_they_do": "", "industry": "",
                                           "size_signals": "", "headquarters": "", "source_ids": []},
        "recent_developments": [], "ai_landscape": {"summary": "", "initiatives": [], "vendors": [],
                                                    "end_clients": [], "source_ids": []},
        "alignment": {"fit_summary": "", "relevant_services": []}, "attendees": [],
        "meeting_narrative": {"recommended_focus": "", "by_persona": [], "opening": "", "agenda_suggestions": []},
        "talking_points": [], "questions_to_ask": [], "watchouts": [],
    }
    return {**base, **overrides}


class ShrinkingCalendar(FakeCalendar):
    """An account can disappear upstream (disconnected here, in Composio, or expired)."""

    def __init__(self) -> None:
        super().__init__()
        self.active = ["google", "outlook"]
        self.disconnected: list[str] = []

    async def connections(self, actor):
        return [item for item in await super().connections(actor) if item.id in self.active]

    async def disconnect(self, actor, connection_id):
        self.disconnected.append(connection_id)
        self.active = [item for item in self.active if item != connection_id]


def test_disconnected_account_meetings_leave_the_calendar(tmp_path):
    fake = ShrinkingCalendar()
    app = _app(tmp_path, fake)
    params = {"start_date": "2026-10-01", "end_date": "2026-10-31", "timezone": "UTC"}
    with TestClient(app) as client:
        assert {event["connection_id"] for event in _sync(client).json()["events"]} == {"google", "outlook"}

        # Disconnecting through the app hides the account's meetings immediately.
        assert client.delete("/v1/calendar/connections/google").status_code == 200
        listed = client.get("/v1/calendar/synced", params=params).json()
        assert {event["connection_id"] for event in listed["events"]} == {"outlook"}
        assert {state["connection_id"] for state in listed["syncs"]} == {"outlook"}

        # Google is reconnected while Outlook vanishes upstream (expired or removed
        # in the provider): the next sync keeps Google and cleans up Outlook.
        fake.active = ["google"]
        synced = _sync(client).json()
        assert {event["connection_id"] for event in synced["events"]} == {"google"}
        with app.state.database.session_factory() as session:
            leftovers = session.execute(select(CalendarEventCacheRow.connection_id)).scalars().all()
        assert "outlook" not in leftovers
