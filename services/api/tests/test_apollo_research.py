"""Apollo as a research source in meeting prep: sides, privacy, batching, cache, cap, citations, failures."""

import json

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.apollo_composio import ApolloComposio
from app.database import UsageEventRow, WorkspaceIntegrationRow
from test_apollo_integration import APOLLO_KEY, COMPOSIO_KEY, FakeComposio
from test_prep_research import FakeLLM, _app, _exa_handler, _setup, _synthesis

ACME = [f"Person{index} Acme{index}" for index in range(11)]
INVITEES = [
    {"name": "Our Colleague", "email": "colleague@ourco.example"},
    {"name": "Asha Patel", "email": "asha@acme.example"},
    *({"name": name, "email": f"p{index}@acme.example"} for index, name in enumerate(ACME)),
    {"name": "Gina Third", "email": "gina@globex.example"},
    {"name": "Guest Person", "email": "guest@gmail.com"},
]
ORG = {"organization": {
    "id": "org_acme", "name": "Acme Robotics", "primary_domain": "acme.example", "website_url": "http://www.acme.example",
    "linkedin_url": "http://www.linkedin.com/company/acme-robotics", "industry": "Robotics",
    "estimated_num_employees": 1200, "annual_revenue_printed": "$50M-$100M", "total_funding_printed": "$120M",
    "latest_funding_stage": "Series C", "latest_funding_round_date": "2025-06-01T00:00:00.000+00:00",
    "founded_year": 2012, "city": "Austin", "state": "Texas", "country": "United States",
    "current_technologies": [{"name": "AWS"}, {"name": "Snowflake"}], "technology_names": ["AWS", "Kubernetes"],
    "phone": "+1 555 0100",
}}


def _bulk(request_body: dict) -> dict:
    matches = []
    for detail in request_body["arguments"]["details"]:
        if detail.get("email") == "asha@acme.example":
            matches.append({"id": "p1", "name": "Asha Patel", "title": "Chief Technology Officer", "seniority": "c_suite",
                            "departments": ["master_engineering_technical"], "linkedin_url": "http://www.linkedin.com/in/asha",
                            "email": "asha.personal@example.com", "phone_numbers": [{"raw_number": "+1 555"}],
                            "city": "Austin", "country": "United States",
                            "employment_history": [
                                {"organization_name": "Acme Robotics", "title": "CTO", "start_date": "2022-03-01", "current": True},
                                {"organization_name": "Initech", "title": "VP Engineering", "start_date": "2018-01-01",
                                 "end_date": "2022-02-01", "current": False}]})
        else:
            matches.append(None)
    return {"matches": matches}


class ApolloTools(FakeComposio):
    """FakeComposio plus Apollo tool answers; ``fail`` makes one tool return an error."""

    def __init__(self, fail: dict[str, object] | None = None) -> None:
        super().__init__()
        self.fail = fail or {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if "/tools/execute/" in path and not path.endswith("APOLLO_VIEW_CREDIT_USAGE_STATS"):
            tool = path.rsplit("/", 1)[1]
            body = json.loads(request.content)
            self.calls.append((request.method, path, body, {}))
            failure = self.fail.get(tool)
            if isinstance(failure, Exception):
                raise failure
            if failure:
                return httpx.Response(200, json={"successful": False, "data": {}, "error": failure})
            answers = {
                "APOLLO_ORGANIZATION_ENRICHMENT": ORG,
                "APOLLO_BULK_PEOPLE_ENRICHMENT": _bulk(body) if "details" in body["arguments"] else {},
                "APOLLO_PEOPLE_ENRICHMENT": {"person": None},
                "APOLLO_SEARCH_NEWS_ARTICLES": {"news_articles": [
                    {"title": "Acme opens Rotterdam hub", "url": "https://news.example/acme-hub", "published_at": "2026-09-01"}]},
                "APOLLO_GET_ORGANIZATION_JOB_POSTINGS": {"organization_job_postings": [
                    {"title": "Senior Machine Learning Engineer", "url": "https://jobs.example/1"},
                    {"title": "Account Executive", "url": "https://jobs.example/2"},
                    {"title": "Backend Software Engineer", "url": "https://jobs.example/3"}]},
                "APOLLO_SEARCH_ACCOUNTS": {"accounts": [{"name": "Acme Robotics", "domain": "acme.example",
                                                         "account_stage": {"name": "Prospect"},
                                                         "last_activity_date": "2026-08-20"}]},
                "APOLLO_SEARCH_CONTACTS": {"contacts": [
                    {"name": "Asha Patel", "title": "CTO", "email": "asha@acme.example", "organization_name": "Acme Robotics"},
                    {"name": "Someone Else", "title": "CFO", "email": "x@other.example", "organization_name": "Other"}]},
            }
            return httpx.Response(200, json={"successful": True, "data": answers[tool]})
        return super().__call__(request)

    def tool_calls(self, tool: str | None = None) -> list[dict]:
        return [body for _, path, body, _ in self.calls
                if "/tools/execute/" in path and not path.endswith("APOLLO_VIEW_CREDIT_USAGE_STATS")
                and (tool is None or path.endswith(tool))]


def _synthesis_citing_apollo() -> dict:
    body = _synthesis()
    body["company"]["source_ids"] = ["A1", "W1"]
    return body


def _connected_app(tmp_path, tools: ApolloTools, name: str, environ: dict | None = None):
    folder = tmp_path / name.removesuffix(".db")
    folder.mkdir()
    app = _app(folder, INVITEES)
    app.state.apollo.client = ApolloComposio(COMPOSIO_KEY, transport=httpx.MockTransport(tools), environ={})
    app.state.meeting_prep.exa_transport = httpx.MockTransport(_exa_handler([]))
    app.state.meeting_prep.environ = {"EXA_API_KEY": "exa-secret-key-123"}
    return app


def _connect(client) -> None:
    assert client.put("/v1/workspace/integrations/apollo", json={"api_key": APOLLO_KEY}).status_code == 200


def _brief(client, event_id: str, profile_id: str, **extra) -> dict:
    response = client.post(f"/v1/calendar/events/{event_id}/prep", json={"text_profile_id": profile_id, **extra})
    assert response.status_code == 200, response.text
    return response.json()


def test_apollo_enriches_only_their_side_with_batching_citations_ledger_and_cache(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("APOLLO_MAX_CALLS_PER_PREP", raising=False)
    tools = ApolloTools()
    app = _connected_app(tmp_path, tools, "apollo-prep.db")
    llm = FakeLLM(_synthesis_citing_apollo())
    with TestClient(app) as client:
        event_id, profile_id = _setup(client, app, llm)
        _connect(client)
        report = _brief(client, event_id, profile_id)

        # Sides: the target domain and their/third-party people only; never us, never unknown guests.
        sent = json.dumps(tools.tool_calls())
        assert "ourco.example" not in sent and "Colleague" not in sent and "gmail.com" not in sent
        assert tools.tool_calls("APOLLO_ORGANIZATION_ENRICHMENT")[0]["arguments"] == {"domain": "acme.example"}
        batches = [body["arguments"]["details"] for body in tools.tool_calls("APOLLO_BULK_PEOPLE_ENRICHMENT")]
        assert [len(batch) for batch in batches] == [10, 3]  # 12 Acme people + 1 third party, <= 10 per call
        assert {"email": "gina@globex.example"} in batches[1]
        assert "reveal" not in sent  # never reveal_personal_emails / reveal_phone_number
        news = tools.tool_calls("APOLLO_SEARCH_NEWS_ARTICLES")[0]["arguments"]
        assert news["organization_ids"] == ["org_acme"] and news["per_page"] == 5 and news["published_at_min"]
        assert tools.tool_calls("APOLLO_GET_ORGANIZATION_JOB_POSTINGS")[0]["arguments"] == {
            "organization_id": "org_acme", "per_page": 10}

        # Report: labelled Apollo sources cited like web sources, structured snapshot, enriched people.
        origins = {source["id"]: source for source in report["sources"]}
        assert origins["A1"]["origin"] == "apollo" and origins["A1"]["title"] == "Apollo · Acme Robotics company profile"
        assert origins["A1"]["url"] == "http://www.linkedin.com/company/acme-robotics"
        assert report["company"]["source_ids"] == ["A1", "W1"]
        snapshot = report["apollo"]
        assert snapshot["company"]["employee_count"] == 1200 and snapshot["company"]["source_id"] == "A1"
        assert snapshot["company"]["tech_stack"] == ["AWS", "Snowflake", "Kubernetes"]
        assert snapshot["hiring"]["open_roles"] == 3 and snapshot["news"][0]["source_id"].startswith("A")
        assert snapshot["relationship"]["stage"] == "Prospect"
        assert [contact["name"] for contact in snapshot["relationship"]["contacts"]] == ["Asha Patel"]
        people = {person["name"]: person for person in report["attendees"]}
        asha = people["Asha Patel"]
        assert asha["apollo"]["title"] == "Chief Technology Officer" and asha["apollo"]["role_started"] == "2022-03-01"
        assert asha["apollo"]["past_roles"][0]["company"] == "Initech"
        assert any(source_id.startswith("A") for source_id in asha["source_ids"])
        assert "Our Colleague" not in people
        assert "asha.personal@example.com" not in json.dumps(report) and "555" not in json.dumps(snapshot)
        synthesis_prompt = llm.requests[-1].prompt
        assert "apollo" in synthesis_prompt and "Apollo structured B2B data" in synthesis_prompt
        assert "structured B2B data provider" in llm.requests[-1].system_prompt

        first_calls = len(tools.tool_calls())
        assert report["usage"]["apollo_calls"] == first_calls == 7  # org, 2 bulk, news, jobs, accounts, contacts
        with app.state.database.session_factory() as session:
            rows = session.execute(select(UsageEventRow).where(UsageEventRow.kind == "apollo",
                                                               UsageEventRow.purpose == "meeting_prep_research")).scalars().all()
        assert len(rows) == first_calls and all(row.prep_event_id == event_id and row.provider == "apollo" for row in rows)
        assert {row.model for row in rows} >= {"apollo_organization_enrichment", "apollo_bulk_people_enrichment"}
        assert all(row.estimated_usd is None and row.unit_type == "records" for row in rows)

        # Second briefing: everything from the 30-day cache; refresh asks Apollo again.
        again = _brief(client, event_id, profile_id)
        assert len(tools.tool_calls()) == first_calls and again["apollo"]["cached_results"] > 0
        assert again["apollo"]["company"]["name"] == "Acme Robotics"
        _brief(client, event_id, profile_id, apollo_refresh=True)
        assert len(tools.tool_calls()) == 2 * first_calls


def test_per_briefing_call_cap(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("APOLLO_MAX_CALLS_PER_PREP", "2")
    tools = ApolloTools()
    app = _connected_app(tmp_path, tools, "apollo-cap.db")
    with TestClient(app) as client:
        event_id, profile_id = _setup(client, app, FakeLLM(_synthesis()))
        _connect(client)
        report = _brief(client, event_id, profile_id)
    assert len(tools.tool_calls()) == 2
    skipped = [step for step in report["research_steps"] if step["stage"] == "apollo" and step["status"] == "skipped"]
    assert skipped and skipped[0]["note"] == "Apollo call limit for this briefing reached"


def _failing(tmp_path, monkeypatch, failure: object, name: str):
    monkeypatch.delenv("APOLLO_MAX_CALLS_PER_PREP", raising=False)
    tools = ApolloTools(fail={"APOLLO_ORGANIZATION_ENRICHMENT": failure})
    app = _connected_app(tmp_path, tools, name)
    with TestClient(app) as client:
        event_id, profile_id = _setup(client, app, FakeLLM(_synthesis()))
        _connect(client)
        report = _brief(client, event_id, profile_id)
        notes = client.get("/v1/notifications").json()
    titles = [item["title"] for item in (notes["items"] if isinstance(notes, dict) else notes)]
    return app, tools, report, titles


def test_invalid_key_degrades_to_exa_marks_connection_and_notifies(tmp_path, monkeypatch) -> None:
    app, tools, report, titles = _failing(tmp_path, monkeypatch, "HTTP 401 Unauthorized", "apollo-401.db")
    assert report["public_research_performed"] and report["apollo"]["notice"] == "Apollo unavailable: Apollo rejected the API key"
    assert any(step.get("note") == report["apollo"]["notice"] for step in report["research_steps"])
    assert len(tools.tool_calls()) == 1  # nothing else is attempted after a fatal error
    assert "Apollo rejected the workspace key" in titles
    with app.state.database.session_factory() as session:
        assert session.execute(select(WorkspaceIntegrationRow)).scalar_one().status == "invalid"
        failed = session.execute(select(UsageEventRow).where(UsageEventRow.kind == "apollo",
                                                             UsageEventRow.status == "failed")).scalars().all()
    assert len(failed) == 1


def test_out_of_credit_rate_limit_and_timeout_skip_apollo(tmp_path, monkeypatch) -> None:
    _, _, report, titles = _failing(tmp_path, monkeypatch, "402 insufficient credits", "apollo-402.db")
    assert report["apollo"]["notice"] == "Apollo unavailable: Apollo reports no credits left"
    assert "Apollo is out of credits" in titles
    _, _, limited, titles = _failing(tmp_path, monkeypatch, "429 Too Many Requests", "apollo-429.db")
    assert limited["apollo"]["notice"] == "Apollo unavailable: Apollo rate limit reached" and not any("Apollo" in t for t in titles)
    _, tools, slow, _ = _failing(tmp_path, monkeypatch, httpx.ReadTimeout("slow"), "apollo-timeout.db")
    assert slow["apollo"]["notice"] == "Apollo unavailable: Apollo did not answer in time"
    assert slow["public_research_performed"] and len(tools.tool_calls()) == 1


def test_plan_restricted_crm_is_skipped_silently(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("APOLLO_MAX_CALLS_PER_PREP", raising=False)
    tools = ApolloTools(fail={"APOLLO_SEARCH_ACCOUNTS": "403 Forbidden: requires a paid plan",
                              "APOLLO_SEARCH_CONTACTS": "403 Forbidden: requires a paid plan"})
    app = _connected_app(tmp_path, tools, "apollo-plan.db")
    with TestClient(app) as client:
        event_id, profile_id = _setup(client, app, FakeLLM(_synthesis()))
        _connect(client)
        report = _brief(client, event_id, profile_id)
    assert report["apollo"]["notice"] is None and report["apollo"]["relationship"] is None
    assert report["apollo"]["company"]["name"] == "Acme Robotics"
    crm = [step for step in report["research_steps"] if step["purpose"].startswith("crm")]
    assert crm and all(step["status"] == "skipped" and step["note"] is None for step in crm)


def test_without_apollo_nothing_changes(tmp_path) -> None:
    tools = ApolloTools()
    app = _connected_app(tmp_path, tools, "apollo-off.db")
    with TestClient(app) as client:
        event_id, profile_id = _setup(client, app, FakeLLM(_synthesis()))
        report = _brief(client, event_id, profile_id)
    assert report["apollo"] is None and not tools.tool_calls()
    assert not any(source["origin"] == "apollo" for source in report["sources"])


def test_known_out_of_credit_skips_apollo_until_rechecked(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("APOLLO_MAX_CALLS_PER_PREP", raising=False)
    tools = ApolloTools(fail={"APOLLO_ORGANIZATION_ENRICHMENT": "402 insufficient credits"})
    app = _connected_app(tmp_path, tools, "apollo-402-again.db")
    with TestClient(app) as client:
        event_id, profile_id = _setup(client, app, FakeLLM(_synthesis()))
        _connect(client)
        first = _brief(client, event_id, profile_id)
        second = _brief(client, event_id, profile_id)
    assert first["apollo"]["notice"] == "Apollo unavailable: Apollo reports no credits left"
    assert second["apollo"] is None and len(tools.tool_calls()) == 1  # no second 402 spent
