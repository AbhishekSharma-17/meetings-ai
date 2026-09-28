"""Agentic meeting-prep research: Exa client, budgets, people matching, citations, roles and history."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from account_links import accept_invite
from app.composio_calendar import CalendarConnection, CalendarEvent, CalendarEventsResponse
from app.database import LEGACY_ADMIN_USER_ID, LEGACY_ORGANIZATION_ID, KnowledgeDocumentRow, MeetingPrepRow, UsageEventRow
from app.exa_client import ExaClient, ExaError, ExaResult, UsageContext
from app.main import create_app
from app.prep_report import PrepSourceV2, SynthesisOutput, enforce_citations
from app.prep_research import (
    MAX_EXA_CALLS, PrepConfigError, ResearchAttendee, ResearchInputs, Target, match_person, resolve_exa_key,
    resolve_target,
)
from meetings_contracts import ProviderType, TextGenerationResult

WHEN = datetime(2026, 10, 6, 15, tzinfo=UTC)
AGENDA = "Private roadmap review for the Q4 budget\nConfidential pricing discussion"
TITLE = "Acme quarterly discovery"
EXTERNAL = [
    ("Asha Patel", "asha@acme.example"), ("Ben Ortiz", "ben@acme.example"), ("Chen Li", "chen@acme.example"),
    ("Dana Kim", "dana@acme.example"), ("Eli Novak", "eli@acme.example"), ("Fay Moreau", "fay@acme.example"),
    ("Gus Hale", "gus@acme.example"), ("Hana Sato", "hana@acme.example"),
]


class FakeLedger:
    def __init__(self):
        self.events = []

    def record_event(self, **kwargs):
        self.events.append(kwargs)


class FakeCalendar:
    def __init__(self, invitees):
        self.invitees = invitees

    async def connections(self, actor):
        return [CalendarConnection(id="google", provider="googlecalendar", status="ACTIVE", label="Work")]

    async def events_for_window(self, actor, connection_id, start, end, timezone, **kwargs):
        return CalendarEventsResponse(events=[CalendarEvent(
            connection_id=connection_id, provider="googlecalendar", event_id="evt-1", title=TITLE,
            starts_at=WHEN, ends_at=WHEN + timedelta(hours=1), meeting_url="https://meet.google.com/abc-defg-hij",
            platform="google_meet", agenda=AGENDA, organizer="Host", invitees=self.invitees,
        )], range_start=start, range_end=end, timezone=timezone)


class FakeLLM:
    """Stands in for the OpenAI adapter so ProviderProfileService still records usage."""

    def __init__(self, synthesis, plan=None, invalid_first=False):
        self.requests = []
        self.synthesis, self.plan, self.invalid_first = synthesis, plan, invalid_first

    async def generate_text(self, profile, request):
        self.requests.append(request)
        purpose = request.metadata["purpose"]
        if purpose == "meeting_prep_planning":
            body = self.plan or {"queries": [], "learning_goals": []}
        elif purpose == "meeting_prep" and self.invalid_first:
            return TextGenerationResult(text="not json", provider="openai", model="gpt-test",
                                        input_tokens=10, output_tokens=5)
        else:
            body = self.synthesis
        return TextGenerationResult(text=json.dumps(body), provider="openai", model="gpt-test",
                                    input_tokens=100, output_tokens=40)


def _exa_handler(captured):
    def respond(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        captured.append((request.url.path, body, dict(request.headers)))
        if request.url.path == "/contents":
            return httpx.Response(200, json={"requestId": "c", "results": [
                {"url": url, "title": f"Read {url}", "text": f"Full text of {url}"} for url in body["urls"]
            ], "costDollars": {"total": 0.001 * len(body["urls"])}})
        if body.get("category") == "people":
            query = body["query"]
            if query.startswith("Asha Patel"):
                results = [{"url": "https://www.linkedin.com/in/asha", "title": "Asha Patel - CTO at Acme Robotics | LinkedIn",
                            "highlights": ["Leads platform engineering"]}]
            elif query.startswith("Ben Ortiz"):
                results = [{"url": "https://www.linkedin.com/in/ben-globex", "title": "Ben Ortiz - VP Sales at Globex | LinkedIn",
                            "highlights": ["Sales leader at Globex"]}]
            elif query.startswith("Chen Li"):
                results = [{"url": "https://www.linkedin.com/in/chenli", "title": "Chen Li - Engineering Lead | LinkedIn",
                            "highlights": ["Works at Acme Robotics on perception systems"]}]
            else:
                results = []
            return httpx.Response(200, json={"results": results, "costDollars": {"total": 0.007}})
        slug = "-".join(body["query"].lower().split())[:60]
        return httpx.Response(200, json={"requestId": "s", "results": [
            {"id": f"{slug}-{index}", "url": f"https://source.example/{slug}/{index}", "title": f"{body['query']} #{index}",
             "publishedDate": "2026-08-01T00:00:00.000Z", "highlights": [f"Fact {index} about {body['query']}"]}
            for index in range(2)
        ], "costDollars": {"total": 0.009}})
    return respond


def _synthesis():
    return {
        "executive_brief": "Acme Robotics is expanding AI in warehouses.",
        "company": {"name": "Acme Robotics", "website": "https://acme.example", "what_they_do": "Warehouse robots.",
                    "industry": "Robotics", "size_signals": "500 staff", "headquarters": "Austin", "source_ids": ["W1"]},
        "recent_developments": [
            {"title": "MOU with Port of Rotterdam", "date": "2026-08-01", "type": "mou", "summary": "Signed an MOU.",
             "source_ids": ["L1"]},
            {"title": "Rumoured acquisition", "date": None, "type": "deal", "summary": "Unsourced.", "source_ids": []},
            {"title": "Invented funding", "date": None, "type": "funding", "summary": "Bad id.", "source_ids": ["W99"]},
        ],
        "ai_landscape": {"summary": "Active AI buyer.", "source_ids": ["W2"],
                         "initiatives": [{"statement": "Vision-based picking.", "source_ids": ["W2"]}],
                         "vendors": [{"statement": "Uses a secret vendor.", "source_ids": []}], "end_clients": []},
        "alignment": {"fit_summary": "Strong fit for retrieval work.", "relevant_services": [
            {"service": "RAG platforms", "why": "Knowledge search", "talking_point": "Pilot", "source_ids": ["W2"]},
            {"service": "Quantum consulting", "why": "Made up", "talking_point": "No", "source_ids": []},
            {"service": "Warehouse data pilot", "why": "From our proposal", "talking_point": "Scope", "source_ids": ["D1"]},
        ]},
        "attendees": [
            {"name": "Asha Patel", "email": None, "title": "CTO", "linkedin_url": "https://evil.example/fake",
             "match_confidence": "confirmed", "background": "Leads platform engineering.", "likely_interests": ["MLOps"],
             "persona": "technical", "angle": "Go deep on architecture.", "source_ids": ["P1"]},
            {"name": "Ben Ortiz", "email": None, "title": "VP Sales", "linkedin_url": "https://www.linkedin.com/in/ben-globex",
             "match_confidence": "confirmed", "background": "Sales leader.", "likely_interests": [],
             "persona": "sales", "angle": "Partnership angle.", "source_ids": []},
            {"name": "Zed Invented", "email": None, "title": "CEO", "linkedin_url": None, "match_confidence": "confirmed",
             "background": "", "likely_interests": [], "persona": "executive", "angle": "", "source_ids": []},
        ],
        "meeting_narrative": {"recommended_focus": "Technical depth", "opening": "Thank them",
                              "by_persona": [{"persona": "technical", "focus": "Architecture"}],
                              "agenda_suggestions": ["Discovery"]},
        "talking_points": ["Retrieval pilots"], "questions_to_ask": ["What is blocking AI rollout?"],
        "watchouts": ["Budget timing"],
    }


def _app(tmp_path, invitees=None):
    invitees = invitees if invitees is not None else [
        {"name": "Our Colleague", "email": "colleague@ourco.example"},
        *({"name": name, "email": email} for name, email in EXTERNAL),
    ]
    return create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'prep-research.db'}",
                      credential_key="test-only-credential-key", calendar_adapter=FakeCalendar(invitees))


def _setup(client, app, llm):
    assert client.put("/v1/workspace/brief", json={
        "website": "https://ourco.example", "overview": "We are an AI services company.",
        "services": ["AI strategy", "RAG platforms"], "products": [],
    }).status_code == 200
    profile = client.post("/v1/provider-profiles", json={
        "name": "Research LLM", "provider_type": "openai", "execution_location": "cloud", "api_key": "sk-test-llm",
        "capabilities": [{"capability": "text_generation", "model": "gpt-test"}],
    })
    assert profile.status_code == 201, profile.text
    app.state.profile_service.adapters[ProviderType.OPENAI] = llm
    event_id = client.post("/v1/calendar/sync", json={
        "start_date": "2026-10-01", "end_date": "2026-10-31", "timezone": "UTC",
    }).json()["events"][0]["id"]
    return event_id, profile.json()["id"]


def test_pipeline_budget_privacy_people_citations_usage_and_history(tmp_path):
    app = _app(tmp_path)
    captured = []
    app.state.meeting_prep.exa_transport = httpx.MockTransport(_exa_handler(captured))
    app.state.meeting_prep.environ = {"EXA_API_KEY": "exa-secret-key-123"}
    llm = FakeLLM(_synthesis(), plan={"learning_goals": ["AI roadmap"], "queries": [
        {"purpose": "news", "query": "Acme Robotics warehouse automation news"},
        {"purpose": "ai", "query": "Acme Robotics machine learning vendors"},
        {"purpose": "other", "query": "Acme Robotics private roadmap review for the Q4"},
        {"purpose": "other", "query": "asha@acme.example Acme Robotics"},
    ]})
    with TestClient(app) as client:
        event_id, profile_id = _setup(client, app, llm)
        with app.state.database.session_factory.begin() as session:
            session.add(KnowledgeDocumentRow(
                id=str(uuid4()), organization_id=str(LEGACY_ORGANIZATION_ID), scope="prep",
                scope_id=event_id, filename="acme-proposal.md", content_type="text/markdown", size_bytes=40,
                extracted_text="Our proposal for Acme: a warehouse data pilot.", status="indexed",
                created_at=datetime.now(UTC),
            ))
        saved = client.put(f"/v1/calendar/events/{event_id}/prep/inputs", json={
            "target_company": "Acme Robotics", "company_website": "https://www.acme.example",
            "links": ["https://acme.example/press/mou"], "notes": "Learn their AI roadmap and end clients",
        })
        assert saved.status_code == 200, saved.text
        assert client.get(f"/v1/calendar/events/{event_id}/prep/inputs").json()["links"] == ["https://acme.example/press/mou"]

        response = client.post(f"/v1/calendar/events/{event_id}/prep", json={"text_profile_id": profile_id})
        assert response.status_code == 200, response.text
        report = response.json()

    # Budget: at most 12 Exa calls (6 company + 5 people + 1 read) and 2 of 3 LLM calls.
    assert len(captured) == MAX_EXA_CALLS
    assert sum(1 for path, _, _ in captured if path == "/contents") == 1
    people_queries = [body["query"] for _, body, _ in captured if body.get("category") == "people"]
    assert len(people_queries) == 5 and not any("Colleague" in query for query in people_queries)
    assert len(llm.requests) == 2
    # Privacy: no emails, agenda or title reach Exa; the key travels only in the header.
    sent = json.dumps([body for _, body, _ in captured])
    assert "@" not in sent and "roadmap review" not in sent.lower() and TITLE not in sent
    assert "exa-secret-key-123" not in sent
    assert all(headers["x-api-key"] == "exa-secret-key-123" for _, _, headers in captured)
    plan_prompt = llm.requests[0].prompt
    assert "Private roadmap" not in plan_prompt and TITLE not in plan_prompt and "@acme.example" not in plan_prompt
    assert "@acme.example" not in llm.requests[1].prompt and "Private roadmap review" in llm.requests[1].prompt

    # v2 report with enforced citations.
    assert report["report_version"] == 2 and report["target_company"] == "Acme Robotics"
    assert report["company"]["what_they_do"] == "Warehouse robots."
    assert [item["title"] for item in report["recent_developments"]] == ["MOU with Port of Rotterdam"]
    assert report["ai_landscape"]["vendors"] == [] and len(report["ai_landscape"]["initiatives"]) == 1
    assert [item["service"] for item in report["alignment"]["relevant_services"]] == ["RAG platforms", "Warehouse data pilot"]
    origins = {source["id"]: source["origin"] for source in report["sources"]}
    assert origins["L1"] == "provided_link" and origins["D1"] == "prep_upload" and origins["B1"] == "organization_brief"
    assert origins["W1"] == "web"
    people = {person["name"]: person for person in report["attendees"]}
    assert "Zed Invented" not in people and "Our Colleague" not in people
    assert people["Asha Patel"]["match_confidence"] == "confirmed"
    assert people["Asha Patel"]["linkedin_url"] == "https://www.linkedin.com/in/asha"
    assert people["Asha Patel"]["email"] == "asha@acme.example"
    assert people["Ben Ortiz"]["match_confidence"] == "unconfirmed"
    assert people["Ben Ortiz"]["linkedin_url"] is None and people["Ben Ortiz"]["title"] is None
    assert people["Chen Li"]["match_confidence"] == "likely"
    assert report["relevant_offerings"] == ["RAG platforms", "Warehouse data pilot"]
    assert report["findings"] and all(finding["source_ids"] for finding in report["findings"])
    assert report["usage"]["exa_calls"] == MAX_EXA_CALLS and report["usage"]["llm_calls"] == 2
    assert report["usage"]["input_tokens"] == 200

    with app.state.database.session_factory() as session:
        rows = session.execute(select(UsageEventRow)).scalars().all()
    exa_rows = [row for row in rows if row.provider == "exa"]
    assert len(exa_rows) == MAX_EXA_CALLS and all(row.prep_event_id == event_id for row in exa_rows)
    assert {row.kind for row in exa_rows} == {"search", "contents"}
    assert all(row.estimated_usd is not None and row.price_source == "exa_reported_cost" for row in exa_rows)
    assert all("exa-secret-key-123" not in json.dumps(row.details) for row in exa_rows)
    assert {row.details.get("category") for row in exa_rows if row.kind == "search"} >= {"company", "news", "people"}
    llm_rows = [row for row in rows if row.kind == "llm" and row.prep_event_id == event_id]
    assert {row.purpose for row in llm_rows} == {"meeting_prep_planning", "meeting_prep"}

    with TestClient(app) as client:
        latest = client.get(f"/v1/calendar/events/{event_id}/prep").json()
        assert latest["id"] == report["id"] and latest["report_version"] == 2
        history = client.get(f"/v1/calendar/events/{event_id}/prep/history").json()
        assert [item["id"] for item in history["items"]] == [report["id"]]
        assert history["items"][0]["usage"]["exa_calls"] == MAX_EXA_CALLS
        assert history["totals"]["llm_calls"] == 2
        assert history["totals"]["estimated_usd"] == pytest.approx(report["usage"]["estimated_usd"])


def test_streaming_progress_and_repair_retry(tmp_path):
    app = _app(tmp_path, invitees=[{"name": "Asha Patel", "email": "asha@acme.example"}])
    captured = []
    app.state.meeting_prep.exa_transport = httpx.MockTransport(_exa_handler(captured))
    app.state.meeting_prep.environ = {"EXA_API_KEY": "exa-key"}
    llm = FakeLLM(_synthesis(), invalid_first=True)
    with TestClient(app) as client:
        event_id, profile_id = _setup(client, app, llm)
        with client.stream("POST", f"/v1/calendar/events/{event_id}/prep/stream",
                           json={"target_company": "Acme Robotics", "text_profile_id": profile_id}) as response:
            assert response.status_code == 200
            body = "".join(response.iter_text())
    events = [block for block in body.split("\n\n") if block.strip()]
    stages = [json.loads(block.split("data: ", 1)[1])["stage"] for block in events if block.startswith("event: progress")]
    assert stages == ["queued", "planning", "searching", "reading", "writing", "done"]
    final = json.loads(events[-1].split("data: ", 1)[1])
    assert events[-1].startswith("event: final") and final["report_version"] == 2
    purposes = [request.metadata["purpose"] for request in llm.requests]
    assert purposes == ["meeting_prep_planning", "meeting_prep", "meeting_prep_repair"]


def test_missing_exa_key_is_a_clear_conflict_and_legacy_reports_still_render(tmp_path):
    app = _app(tmp_path)
    app.state.meeting_prep.environ = {}
    with TestClient(app) as client:
        event_id, _ = _setup(client, app, FakeLLM(_synthesis()))
        key = (str(LEGACY_ORGANIZATION_ID), str(LEGACY_ADMIN_USER_ID), event_id)
        app.state.meeting_prep._active.add(key)
        busy = client.post(f"/v1/calendar/events/{event_id}/prep", json={"research_enabled": False})
        assert busy.status_code == 409 and "already being prepared" in busy.json()["detail"]
        app.state.meeting_prep._active.discard(key)
        missing = client.post(f"/v1/calendar/events/{event_id}/prep", json={"research_enabled": True})
        assert missing.status_code == 409
        assert "Add an Exa key in AI providers" in missing.json()["detail"]
        legacy_id = str(uuid4())
        legacy = {
            "id": legacy_id, "calendar_event_id": event_id, "target_company": "Acme", "executive_brief": "Old brief",
            "findings": [{"statement": "Acme sells widgets.", "source_ids": ["S1"]}], "relevant_offerings": ["AI"],
            "talking_points": [], "questions_to_ask": [], "watchouts": [], "people_notes": ["Asha — verify"],
            "sources": [{"id": "S1", "title": "About", "url": "https://acme.example/about"}],
            "public_research_performed": True, "generated_at": "2026-09-20T10:00:00+00:00",
            "provider": "openai", "model": "gpt-old",
        }
        with app.state.database.session_factory.begin() as session:
            session.add(MeetingPrepRow(id=legacy_id, organization_id=str(LEGACY_ORGANIZATION_ID),
                user_id=str(LEGACY_ADMIN_USER_ID), calendar_event_id=event_id, context="",
                profile_urls=[], report=legacy, created_at=datetime(2026, 9, 20, 10, tzinfo=UTC)))
        served = client.get(f"/v1/calendar/events/{event_id}/prep")
        assert served.status_code == 200, served.text
        assert served.json()["report_version"] == 1 and served.json()["people_notes"] == ["Asha — verify"]
        history = client.get(f"/v1/calendar/events/{event_id}/prep/history").json()
        assert history["items"][0]["report_version"] == 1 and history["items"][0]["model"] == "gpt-old"
        bad = client.put(f"/v1/calendar/events/{event_id}/prep/inputs", json={"links": ["http://insecure.example"]})
        assert bad.status_code == 422
        too_many = client.put(f"/v1/calendar/events/{event_id}/prep/inputs",
                              json={"links": [f"https://a{index}.example" for index in range(13)]})
        assert too_many.status_code == 422


def test_viewers_cannot_generate_or_edit_inputs(tmp_path, monkeypatch):
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "owner-password-for-test")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", "owner@ourco.example")
    app = _app(tmp_path)
    with TestClient(app) as owner, TestClient(app) as viewer:
        assert owner.post("/v1/auth/login", json={"email": "owner@ourco.example",
                                                  "password": "owner-password-for-test"}).status_code == 200
        invited = owner.post("/v1/workspace/invite", json={
            "email": "viewer@ourco.example", "display_name": "View Only", "role": "viewer"})
        assert invited.status_code == 201, invited.text
        accept_invite(viewer, invited.json(), "viewer-new-password-for-test")
        synced = viewer.post("/v1/calendar/sync", json={"start_date": "2026-10-01", "end_date": "2026-10-31", "timezone": "UTC"})
        assert synced.status_code == 200, synced.text
        event_id = synced.json()["events"][0]["id"]
        assert viewer.get(f"/v1/calendar/events/{event_id}/prep/inputs").status_code == 200
        assert viewer.get(f"/v1/calendar/events/{event_id}/prep/history").status_code == 200
        assert viewer.put(f"/v1/calendar/events/{event_id}/prep/inputs", json={"notes": "x"}).status_code == 403
        assert viewer.post(f"/v1/calendar/events/{event_id}/prep", json={"research_enabled": False}).status_code == 403
        assert viewer.post(f"/v1/calendar/events/{event_id}/prep/stream", json={"research_enabled": False}).status_code == 403
        # Another user's event is not visible at all.
        assert owner.get(f"/v1/calendar/events/{event_id}/prep/inputs").status_code == 404


def test_exa_client_retries_records_usage_and_hides_key():
    calls, sleeps = [], []

    def respond(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(429, headers={"retry-after": "0"})
        if request.url.path == "/contents":
            return httpx.Response(200, json={"results": [{"url": "https://a.example", "title": "A", "text": "t"}]})
        return httpx.Response(200, json={"results": [{"url": "https://a.example", "title": "A"}],
                                         "costDollars": {"total": 0.007}})

    async def sleep(seconds):
        sleeps.append(seconds)

    ledger = FakeLedger()
    event_id, org_id = uuid4(), uuid4()

    async def run():
        async with ExaClient("exa-key-xyz", ledger=ledger, transport=httpx.MockTransport(respond), sleep=sleep,
                             usage=UsageContext(organization_id=org_id, prep_event_id=event_id)) as exa:
            assert "exa-key-xyz" not in repr(exa)
            found = await exa.search("Acme Robotics", purpose="overview", category="company", num_results=3,
                                     start_published_date="2026-01-01T00:00:00.000Z", include_domains=["acme.example"])
            read = await exa.contents(["https://a.example"], purpose="read_sources")
            return found, read

    found, read = asyncio.run(run())
    assert len(calls) == 3 and sleeps == [0.0]
    body = json.loads(calls[1].content)
    assert body["type"] == "auto" and body["category"] == "company" and body["numResults"] == 3
    assert "startPublishedDate" not in body  # unsupported for the company category
    assert body["contents"]["highlights"]["maxCharacters"] == 1200
    assert found.results[0].url == "https://a.example" and read.cost_usd is None
    search_event, contents_event = ledger.events
    assert search_event["kind"] == "search" and search_event["provider"] == "exa" and search_event["model"] == "auto"
    assert search_event["estimated_usd"] == 0.007 and search_event["price_source"] == "exa_reported_cost"
    assert search_event["units"] == 1 and search_event["unit_type"] == "results"
    assert search_event["prep_event_id"] == event_id and search_event["organization_id"] == org_id
    assert search_event["details"] == {"query_purpose": "overview", "num_results": 3, "category": "company", "returned": 1}
    # /contents without costDollars falls back to the published $1 / 1k pages per content type.
    assert contents_event["kind"] == "contents" and contents_event["estimated_usd"] == 0.001
    assert contents_event["price_source"] == "exa_list_price" and contents_event["unit_type"] == "pages"
    assert "exa-key-xyz" not in json.dumps(ledger.events, default=str)


def test_exa_client_rejected_key_error_is_sanitized():
    ledger = FakeLedger()

    async def run():
        async with ExaClient("exa-key-xyz", ledger=ledger, usage=UsageContext(organization_id=uuid4()),
                             transport=httpx.MockTransport(lambda request: httpx.Response(401, text="bad exa-key-xyz"))) as exa:
            await exa.search("Acme", purpose="overview")

    with pytest.raises(ExaError) as raised:
        asyncio.run(run())
    assert raised.value.status_code == 401 and "exa-key-xyz" not in str(raised.value)
    assert ledger.events[0]["status"] == "failed"


def test_key_resolution_order():
    org, selected, fallback = uuid4(), uuid4(), uuid4()

    class Vault:
        def __init__(self, broken=False, empty=False):
            self.broken, self.empty = broken, empty

        def resolve_secret(self, organization_id, credential_id):
            if self.broken:
                raise LookupError(credential_id)
            assert credential_id == selected
            return "selected-key"

        def first_for(self, organization_id, provider_type):
            assert provider_type == "exa"
            return None if self.empty else (fallback, "first-key")

    settings = SimpleNamespace(get=lambda organization_id: SimpleNamespace(research_credential_id=selected))
    no_settings = SimpleNamespace(get=lambda organization_id: SimpleNamespace(research_credential_id=None))
    env = {"EXA_API_KEY": "env-key"}
    assert resolve_exa_key(org, vault=Vault(), ai_settings=settings, environ=env) == "selected-key"
    assert resolve_exa_key(org, vault=Vault(broken=True), ai_settings=settings, environ=env) == "first-key"
    assert resolve_exa_key(org, vault=Vault(), ai_settings=no_settings, environ=env) == "first-key"
    assert resolve_exa_key(org, vault=Vault(empty=True), ai_settings=no_settings, environ=env) == "env-key"
    with pytest.raises(PrepConfigError, match="Add an Exa key in AI providers"):
        resolve_exa_key(org, vault=Vault(empty=True), ai_settings=no_settings, environ={})


def test_vault_exa_key_is_used_through_the_api(tmp_path):
    app = _app(tmp_path, invitees=[])
    captured = []
    app.state.meeting_prep.exa_transport = httpx.MockTransport(_exa_handler(captured))
    app.state.meeting_prep.environ = {}
    org = uuid4()
    app.state.meeting_prep.vault = SimpleNamespace(
        resolve_secret=lambda organization_id, credential_id: "unused",
        first_for=lambda organization_id, provider_type: (org, "vault-exa-key"),
    )
    with TestClient(app) as client:
        event_id, profile_id = _setup(client, app, FakeLLM(_synthesis()))
        response = client.post(f"/v1/calendar/events/{event_id}/prep",
                               json={"target_company": "Acme Robotics", "text_profile_id": profile_id})
        assert response.status_code == 200, response.text
    assert captured and all(headers["x-api-key"] == "vault-exa-key" for _, _, headers in captured)


def test_people_matching_requires_name_and_company():
    person = ResearchAttendee(name="Asha Patel", email=None, company="Acme Robotics", searchable=True)
    terms = {"Acme Robotics", "acme"}
    hit = ExaResult(url="https://www.linkedin.com/in/asha", title="Asha Patel - CTO at Acme Robotics | LinkedIn")
    assert match_person(person, hit, terms) == "confirmed"
    body_only = ExaResult(url="u", title="Asha Patel | LinkedIn", highlights=("Engineer at Acme Robotics",))
    assert match_person(person, body_only, terms) == "likely"
    other_company = ExaResult(url="u", title="Asha Patel - CTO at Globex | LinkedIn")
    assert match_person(person, other_company, terms) == "unconfirmed"
    other_person = ExaResult(url="u", title="Asha Kumar - CTO at Acme Robotics | LinkedIn")
    assert match_person(person, other_person, terms) == "unconfirmed"
    accented = ResearchAttendee(name="José Álvarez", email=None, company="Acme", searchable=True)
    assert match_person(accented, ExaResult(url="u", title="Jose Alvarez - Acme Robotics"), terms) == "confirmed"


def test_target_inference_skips_our_domain_and_free_mail():
    invitees = [SimpleNamespace(name="Me", email="me@ourco.example"),
                SimpleNamespace(name="Gee", email="someone@gmail.com"),
                SimpleNamespace(name="A", email="a@acme.example"), SimpleNamespace(name="B", email="b@acme.example"),
                SimpleNamespace(name="C", email="c@globex.example")]
    target = resolve_target(ResearchInputs(), invitees, {"ourco.example"})
    assert target == Target(name=None, website="https://acme.example", domain="acme.example", inferred=True)
    given = resolve_target(ResearchInputs(target_company="Initech"), invitees, {"ourco.example"})
    assert given.name == "Initech" and not given.inferred
    assert resolve_target(ResearchInputs(), invitees[:2], {"ourco.example"}).label is None


def test_citation_enforcement_drops_uncited_claims():
    sources = [PrepSourceV2(id="W1", title="Web", url="https://x.example", origin="web"),
               PrepSourceV2(id="D1", title="Ours", origin="our_documents")]
    output = SynthesisOutput.model_validate(_synthesis())
    output = output.model_copy(update={"company": output.company.model_copy(update={"source_ids": ["W404"]})})
    cleaned = enforce_citations(output, sources, ["RAG platforms"])
    assert cleaned.company.what_they_do == "" and cleaned.company.name == "Acme Robotics"
    assert cleaned.recent_developments == []  # L1 is not a known source here
    assert cleaned.ai_landscape.summary == "" and cleaned.ai_landscape.initiatives == []
    assert [item.service for item in cleaned.alignment.relevant_services] == ["RAG platforms", "Warehouse data pilot"]
    assert cleaned.attendees[1].background == "" and cleaned.attendees[1].title is None


def test_retriever_supplies_our_documents_and_unindexed_uploads_are_kept(tmp_path):
    app = _app(tmp_path, invitees=[])
    calls = []

    class Retriever:
        async def search(self, organization_id, query, *, scopes, limit=12, source_types=None, actor=None, usage=None):
            calls.append({"scopes": scopes, "usage": usage, "actor": actor})
            return [SimpleNamespace(scope="organization", scope_id=None, document_id="doc-org", title="Services deck",
                                    context="Deck", content="We deliver RAG platforms.")]

    app.state.meeting_prep.retriever = Retriever()
    llm = FakeLLM(_synthesis())
    with TestClient(app) as client:
        event_id, profile_id = _setup(client, app, llm)
        with app.state.database.session_factory.begin() as session:
            session.add(KnowledgeDocumentRow(
                id=str(uuid4()), organization_id=str(LEGACY_ORGANIZATION_ID), scope="prep", scope_id=event_id,
                filename="fresh-notes.txt", content_type="text/plain", size_bytes=30,
                extracted_text="Fresh upload awaiting indexing.", status="pending", created_at=datetime.now(UTC),
            ))
        response = client.post(f"/v1/calendar/events/{event_id}/prep",
                               json={"research_enabled": False, "text_profile_id": profile_id})
        assert response.status_code == 200, response.text
    assert calls[0]["scopes"] == [("organization", None), ("prep", event_id)]
    assert calls[0]["usage"]["prep_event_id"] == event_id and calls[0]["actor"] is not None
    titles = {source["title"]: source["origin"] for source in response.json()["sources"]}
    assert titles == {"Our organization profile": "organization_brief", "Services deck": "our_documents",
                      "fresh-notes.txt": "prep_upload"}
    assert response.json()["public_research_performed"] is False
    assert len(llm.requests) == 1  # no planning call without public research
