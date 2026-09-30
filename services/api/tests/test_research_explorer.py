"""Research (Apollo Explorer) searches and look-ups: request shapes, parsing, caps, cache, roles, v31."""

from __future__ import annotations

import json

import pytest
from research_helpers import as_user, build_world, user_id
from sqlalchemy import select, text

from app.apollo_search_parsing import parse_company_search, parse_people_search
from app.database import Database, SchemaVersionRow, UsageEventRow

REVEAL_FLAGS = {"reveal_personal_emails", "reveal_phone_number"}


@pytest.fixture()
def world(tmp_path, monkeypatch):
    world = build_world(tmp_path, monkeypatch)
    yield world
    world["client"].__exit__(None, None, None)


def _ledger(app, purpose: str = "research_explorer") -> list[UsageEventRow]:
    with app.state.database.session_factory() as session:
        return list(session.execute(select(UsageEventRow).where(UsageEventRow.purpose == purpose)).scalars())


# ----- parsing ---------------------------------------------------------------------------------------------------------
def test_company_search_parsing_marks_apollo_accounts_and_keeps_only_https_logos() -> None:
    hits = parse_company_search({
        "accounts": [{"id": "acc", "organization_id": "org_1", "name": "Acme", "domain": "acme.example"}],
        "organizations": [
            {"id": "org_1", "name": "Acme", "primary_domain": "acme.example", "logo_url": "https://logo.example/a.png"},
            {"id": "org_2", "name": "Initech", "primary_domain": "www.initech.example", "logo_url": "http://insecure.example/i.png",
             "estimated_num_employees": "1,200", "city": "Austin", "country": "United States"},
            {"id": "org_3", "name": None}, "garbage"],
    })
    assert [(hit.name, hit.apollo_id, hit.in_apollo_account) for hit in hits] == [("Acme", "org_1", True), ("Initech", "org_2", False)]
    assert hits[1].domain == "initech.example" and hits[1].logo_url is None and hits[1].employee_count == 1200
    assert hits[1].headquarters == "Austin, United States"


def test_people_search_parsing_shows_obfuscated_names_and_never_reads_contact_details() -> None:
    hits = parse_people_search({
        "people": [{"id": "p1", "first_name": "Asha", "last_name_obfuscated": "Pa***l", "email": "a@x.example",
                    "phone_numbers": [{"raw_number": "+1"}], "organization": {"name": "Acme", "primary_domain": "acme.example"}},
                   {"id": "p2", "name": "Chen Li", "title": "Director"}, {"first_name": "No id"}],
        "contacts": [{"id": "c1", "person_id": "p2", "name": "Chen Li"}],
    })
    assert [(hit.apollo_id, hit.name, hit.name_partial, hit.in_apollo_contacts) for hit in hits] == [
        ("p2", "Chen Li", False, True), ("p1", "Asha Pa***l", True, False)]
    assert "@" not in json.dumps([hit.model_dump() for hit in hits]) and "+1" not in json.dumps([hit.model_dump() for hit in hits])


# ----- searches ----------------------------------------------------------------------------------------------------------
def test_company_search_sends_bounded_filters_caches_for_a_day_and_is_ledgered(world) -> None:
    client, fake, app = world["client"], world["fake"], world["app"]
    as_user(client, "mo")
    body = {"name": "Acme", "domains": ["https://www.Acme.example/about"], "industry_keywords": ["robotics"],
            "locations": ["Texas"], "employee_ranges": ["201-500", "10001+"]}
    first = client.post("/v1/research/search/companies", json=body)
    assert first.status_code == 200, first.text
    assert fake.tool_calls("APOLLO_ORGANIZATION_SEARCH") == [{
        "page": 1, "per_page": 25, "q_organization_name": "Acme", "q_organization_domains_list": ["acme.example"],
        "q_organization_keyword_tags": ["robotics"], "organization_locations": ["Texas"],
        "organization_num_employees_ranges": ["201,500", "10001,"]}]
    data = first.json()
    assert [item["name"] for item in data["items"]] == ["Acme Robotics", "Globex"]
    assert data["items"][0]["in_apollo_account"] is True and data["items"][0]["logo_url"] == "https://logos.example/acme.png"
    assert data["total"] == 2 and data["cached"] is False and data["usage"]["used_today"] == 1
    assert "555" not in first.text  # the company phone Apollo sent is never passed on
    # The same query (normalised) is served from the 24-hour cache without another Apollo call.
    again = client.post("/v1/research/search/companies", json={**body, "name": " acme ", "locations": ["texas"]})
    assert again.json()["cached"] is True and len(fake.tool_calls("APOLLO_ORGANIZATION_SEARCH")) == 1
    rows = _ledger(app)
    assert len(rows) == 1 and rows[0].kind == "apollo" and rows[0].actor_user_id == user_id(app, "mo@example.com")
    assert rows[0].model == "apollo_organization_search" and rows[0].status == "succeeded"


def test_people_search_shape_has_no_reveal_flags_and_results_are_not_enriched(world) -> None:
    client, fake = world["client"], world["fake"]
    as_user(client, "mo")
    response = client.post("/v1/research/search/people", json={
        "domains": ["acme.example"], "titles": ["CTO", "VP Engineering"], "seniorities": ["c_suite", "vp"],
        "locations": ["Austin"], "keywords": "robotics"})
    assert response.status_code == 200, response.text
    assert fake.tool_calls("APOLLO_PEOPLE_SEARCH") == [{
        "page": 1, "per_page": 25, "q_organization_domains": ["acme.example"], "person_titles": ["CTO", "VP Engineering"],
        "person_seniorities": ["c_suite", "vp"], "person_locations": ["Austin"], "q_keywords": "robotics"}]
    assert not fake.tool_calls("APOLLO_PEOPLE_ENRICHMENT") and not fake.tool_calls("APOLLO_BULK_PEOPLE_ENRICHMENT")
    names = [item["name"] for item in response.json()["items"]]
    assert names == ["Asha Pa***l", "Chen Li"] and "hidden@acme.example" not in response.text


@pytest.mark.parametrize("body", [
    {"name": "Acme", "domains": ["not a domain"]},
    {"name": "x" * 121},
    {"domains": [f"d{index}.example" for index in range(11)]},
    {"employee_ranges": ["huge"]},
    {"name": "Acme", "page": 41},
    {},
])
def test_company_search_validation_rejects_bad_input(world, body) -> None:
    as_user(world["client"], "mo")
    assert world["client"].post("/v1/research/search/companies", json=body).status_code == 422
    assert not world["fake"].tool_calls("APOLLO_ORGANIZATION_SEARCH")


def test_people_search_validation(world) -> None:
    client = world["client"]
    as_user(client, "mo")
    assert client.post("/v1/research/search/people", json={"seniorities": ["emperor"]}).status_code == 422
    assert client.post("/v1/research/search/people", json={"titles": ["t" * 81]}).status_code == 422
    assert client.post("/v1/research/search/people", json={"keywords": "  "}).status_code == 422


# ----- look-ups --------------------------------------------------------------------------------------------------------
def test_single_lookup_enriches_by_id_without_reveal_flags_and_hides_contact_details(world) -> None:
    client, fake = world["client"], world["fake"]
    as_user(client, "mo")
    response = client.post("/v1/research/people/lookup", json={"apollo_ids": ["per_asha"]})
    assert response.status_code == 200, response.text
    assert fake.tool_calls("APOLLO_PEOPLE_ENRICHMENT") == [{"id": "per_asha"}]
    person = response.json()["items"][0]
    assert person["person"]["name"] == "Asha Patel" and person["company_domain"] == "acme.example"
    assert "@" not in response.text and "555" not in response.text
    # Cached for 30 days: a second look-up costs nothing.
    client.post("/v1/research/people/lookup", json={"apollo_ids": ["per_asha"]})
    assert len(fake.tool_calls("APOLLO_PEOPLE_ENRICHMENT")) == 1
    with world["app"].state.database.engine.connect() as connection:
        cached = " ".join(str(row) for row in connection.execute(text("SELECT payload FROM apollo_cache")))
    assert "asha@acme.example" not in cached and "555 0199" not in cached


def test_bulk_lookup_over_ten_needs_confirmation_then_batches_of_ten(world) -> None:
    client, fake = world["client"], world["fake"]
    as_user(client, "mo")
    ids = [f"per_{index}" for index in range(12)]
    refused = client.post("/v1/research/people/lookup", json={"apollo_ids": ids})
    assert refused.status_code == 409 and "Confirm" in refused.json()["detail"]
    assert not fake.tool_calls("APOLLO_BULK_PEOPLE_ENRICHMENT")
    confirmed = client.post("/v1/research/people/lookup", json={"apollo_ids": ids, "confirm": True})
    assert confirmed.status_code == 200, confirmed.text
    batches = fake.tool_calls("APOLLO_BULK_PEOPLE_ENRICHMENT")
    assert [len(batch["details"]) for batch in batches] == [10, 2]
    assert all(set(batch) == {"details"} and not REVEAL_FLAGS & set(batch) for batch in batches)
    assert confirmed.json()["usage"]["used_today"] == 2
    assert client.post("/v1/research/people/lookup", json={"apollo_ids": [f"p{i}" for i in range(26)]}).status_code == 422


def test_daily_cap_per_person_counts_apollo_ledger_rows(tmp_path, monkeypatch) -> None:
    world = build_world(tmp_path, monkeypatch, daily="2")
    client = world["client"]
    try:
        as_user(client, "mo")
        assert client.post("/v1/research/search/companies", json={"name": "Acme"}).status_code == 200
        assert client.post("/v1/research/search/companies", json={"name": "Initech"}).status_code == 200
        capped = client.post("/v1/research/search/companies", json={"name": "Globex"})
        assert capped.status_code == 429 and "today's limit of 2 Apollo lookups" in capped.json()["detail"]
        assert client.post("/v1/research/search/companies", json={"name": "Acme"}).json()["cached"] is True  # cache is free
        assert client.get("/v1/research/status").json()["usage"] == {"used_today": 2, "daily_limit": 2}
        as_user(client, "mia")  # another person has their own allowance
        assert client.post("/v1/research/search/companies", json={"name": "Globex"}).status_code == 200
    finally:
        client.__exit__(None, None, None)


def test_apollo_failures_are_explained_and_invalid_keys_mark_the_connection(world) -> None:
    client, fake = world["client"], world["fake"]
    as_user(client, "mo")
    fake.handlers.pop("APOLLO_ORGANIZATION_SEARCH")
    fake.tool_results["APOLLO_ORGANIZATION_SEARCH"] = __import__("httpx").Response(
        200, json={"successful": False, "data": {}, "error": "401 Unauthorized: invalid api key"})
    failed = client.post("/v1/research/search/companies", json={"name": "Acme"})
    assert failed.status_code == 409 and "reconnect Apollo" in failed.json()["detail"]
    status = client.get("/v1/research/status").json()
    assert status["status"] == "invalid" and status["can_use"] is False
    assert client.post("/v1/research/search/companies", json={"name": "Initech"}).status_code == 409


# ----- roles and connection --------------------------------------------------------------------------------------------
def test_members_use_research_viewers_never(world) -> None:
    client = world["client"]
    as_user(client, "vic")
    assert client.get("/v1/research/status").status_code == 403
    assert client.post("/v1/research/search/companies", json={"name": "Acme"}).status_code == 403
    assert client.get("/v1/research/profiles").status_code == 403
    as_user(client, "mo")
    status = client.get("/v1/research/status").json()
    assert status["connected"] and status["can_use"] and not status["can_manage"]
    as_user(client, "ada")
    assert client.get("/v1/research/status").json()["can_manage"] is True


def test_not_connected_workspace_reports_it_and_refuses_searches(tmp_path, monkeypatch) -> None:
    world = build_world(tmp_path, monkeypatch, connect=False)
    client = world["client"]
    try:
        as_user(client, "mo")
        assert client.get("/v1/research/status").json() == {
            "connected": False, "status": None, "can_manage": False, "can_use": False, "usage": None, "bulk_confirm_over": 10}
        refused = client.post("/v1/research/search/companies", json={"name": "Acme"})
        assert refused.status_code == 409 and "isn't connected" in refused.json()["detail"]
        assert not world["fake"].tool_calls("APOLLO_ORGANIZATION_SEARCH")
    finally:
        client.__exit__(None, None, None)


# ----- schema ----------------------------------------------------------------------------------------------------------
def test_v30_database_upgrades_to_v31_with_research_tables(tmp_path) -> None:
    url = f"sqlite+pysqlite:///{tmp_path / 'upgrade.db'}"
    database = Database(url)
    database.migrate()
    with database.engine.begin() as connection:
        # Back to a real v30 database: later versions' tables go too (v32: meeting shares).
        for table in ("research_messages", "research_conversations", "research_profiles", "meeting_shares", "email_delivery_senders"):
            connection.execute(text(f"DROP TABLE {table}"))
        connection.execute(text("DELETE FROM schema_version WHERE version >= 31"))
    database.engine.dispose()
    upgraded = Database(url)
    upgraded.migrate()
    with upgraded.session_factory() as session:
        assert max(session.execute(select(SchemaVersionRow.version)).scalars().all()) == Database.SCHEMA_VERSION >= 31
    with upgraded.engine.connect() as connection:
        names = set(upgraded.engine.dialect.get_table_names(connection))
    assert {"research_profiles", "research_conversations", "research_messages"} <= names
    upgraded.engine.dispose()


def test_parallel_calls_never_overshoot_the_daily_cap(tmp_path) -> None:
    import asyncio
    from datetime import UTC, datetime
    from uuid import uuid4

    from app.accounts import Actor
    from app.apollo_cache import ApolloCache
    from app.research_apollo import ExplorerApollo, ExplorerError

    database = Database(f"sqlite+pysqlite:///{tmp_path / 'race.db'}")
    database.migrate()

    class Ledger:  # writes the same ledger rows the budget counts
        def record_event(self, **row):
            with database.session_factory.begin() as session:
                session.add(UsageEventRow(
                    id=str(uuid4()), organization_id=str(row["organization_id"]), kind="apollo", purpose="research_explorer",
                    provider="apollo", model=row["model"], input_tokens=None, output_tokens=None, units=row["units"],
                    unit_type="records", estimated_usd=None, price_source=None, duration_ms=row["duration_ms"],
                    status=row["status"], meeting_id=None, knowledge_base_id=None, prep_event_id=None,
                    actor_user_id=str(row["actor_user_id"]), details={}, created_at=datetime.now(UTC)))

    class SlowApollo:
        async def execute(self, organization_id, account_id, tool, arguments):
            await asyncio.sleep(0.05)  # every request passes the check before any finishes, without the lock
            return {"organizations": []}

    apollo = ExplorerApollo(database, lambda: SlowApollo(), ApolloCache(database), Ledger(),
                            environ={"APOLLO_DAILY_CALLS_PER_USER": "2"})
    actor = Actor(user_id=uuid4(), organization_id=uuid4(), email="a@example.test", display_name="A", role="member",
                  must_change_password=False, session_version=0)

    async def scenario():
        return await asyncio.gather(*(apollo.call(actor, "acct", "org_search", {"page": 1}) for _ in range(5)),
                                    return_exceptions=True)

    results = asyncio.run(scenario())
    assert sum(1 for item in results if isinstance(item, dict)) == 2
    assert all(isinstance(item, ExplorerError) and item.status_code == 429 for item in results if not isinstance(item, dict))
