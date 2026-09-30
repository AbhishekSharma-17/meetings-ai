"""Research "Save to Apollo": roles, duplicate check first, link vs create, request shapes, failures, audit, ledger, cap."""

from __future__ import annotations

import httpx
import pytest
from app.database import AuditEventRow, UsageEventRow
from research_helpers import OWNER_EMAIL, as_user, build_world, org_id, user_id
from sqlalchemy import select

CONTACT_TOOLS = ("APOLLO_SEARCH_CONTACTS", "APOLLO_LIST_CONTACT_STAGES", "APOLLO_CREATE_CONTACT")
CONTACT_KEYS_FORBIDDEN = {"email", "home_phone", "other_phone", "direct_phone", "mobile_phone", "corporate_phone",
                          "present_raw_address", "label_names"}


def _crm_handlers(fake) -> None:
    fake.handlers.update({
        "APOLLO_SEARCH_CONTACTS": lambda args: {"contacts": [
            {"id": "con_1", "name": "Asha Patel", "title": "CTO", "organization_name": "Acme Robotics",
             "email": "asha@acme.example", "mobile_phone": "+1 555 0199"},
            {"id": "con_2", "first_name": "Asha", "last_name": "Patel", "organization_name": "Other Co"},
            {"id": "con_3", "name": "Bob Smith", "organization_name": "Acme Robotics"}],
            "pagination": {"total_entries": 3}},
        "APOLLO_SEARCH_ACCOUNTS": lambda args: {"accounts": [
            {"id": "acc_1", "name": "Acme Robotics, Inc.", "domain": "acme.example", "phone": "+1 555 0100"},
            {"id": "acc_9", "name": "Acme Rocketry", "domain": "rocketry.example"}]},
        "APOLLO_LIST_CONTACT_STAGES": lambda args: {"contact_stages": [
            {"id": "cs_cold", "name": "Cold", "display_order": 1}, {"id": "cs_new", "name": "New", "display_order": 0}]},
        "APOLLO_LIST_ACCOUNT_STAGES": lambda args: {"account_stages": [{"id": "as_target", "name": "Target", "display_order": 0}]},
        "APOLLO_LIST_USERS": lambda args: {"users": [
            {"id": "usr_olive", "first_name": "Olive", "last_name": "Owner", "name": "Olive Owner", "email": "olive@team.example"},
            {"id": "usr_gone", "name": "Gone User", "deleted": True}]},
        "APOLLO_CREATE_CONTACT": lambda args: {"contact": {"id": "con_new", "name": f"{args['first_name']} {args['last_name']}"}},
        "APOLLO_CREATE_ACCOUNT": lambda args: {"account": {"id": "acc_new", "name": args["name"]}},
    })


@pytest.fixture()
def world(tmp_path, monkeypatch):
    world = build_world(tmp_path, monkeypatch)
    _crm_handlers(world["fake"])
    yield world
    world["client"].__exit__(None, None, None)


def _save_profiles(client) -> tuple[str, str]:
    person = client.post("/v1/research/profiles", json={"kind": "person", "apollo_id": "per_asha"})
    company = client.post("/v1/research/profiles", json={"kind": "company", "domain": "acme.example"})
    assert person.status_code == 201 and company.status_code == 201, (person.text, company.text)
    return person.json()["profile"]["id"], company.json()["profile"]["id"]


def _rows(app, row_type, **where):
    with app.state.database.session_factory() as session:
        query = select(row_type)
        for key, value in where.items():
            query = query.where(getattr(row_type, key) == value)
        return list(session.execute(query).scalars())


def _fail(world, tool: str, error: str) -> None:
    world["fake"].handlers.pop(tool)
    world["fake"].tool_results[tool] = httpx.Response(200, json={"successful": False, "data": {}, "error": error})


# ----- roles --------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("who", ["mo", "vic"])
def test_members_and_viewers_cannot_preview_or_save_to_apollo(world, who) -> None:
    client, fake = world["client"], world["fake"]
    person, _ = _save_profiles(client)
    as_user(client, who)
    assert client.get(f"/v1/research/profiles/{person}/apollo").status_code == 403
    assert client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "create", "create_anyway": True}).status_code == 403
    assert not any(fake.tool_calls(tool) for tool in CONTACT_TOOLS)


def test_admin_preview_checks_duplicates_first_and_shows_exactly_what_is_written(world) -> None:
    client, fake, app = world["client"], world["fake"], world["app"]
    person, _ = _save_profiles(client)
    as_user(client, "ada")
    response = client.get(f"/v1/research/profiles/{person}/apollo")
    assert response.status_code == 200, response.text
    preview = response.json()
    tools = [path.rsplit("/", 1)[1] for path in fake.paths("POST") if "/tools/execute/APOLLO_" in path][-2:]
    assert tools == ["APOLLO_SEARCH_CONTACTS", "APOLLO_LIST_CONTACT_STAGES"]
    assert fake.tool_calls("APOLLO_SEARCH_CONTACTS") == [{"q_keywords": "Asha Patel", "page": 1, "per_page": 25}]
    assert preview["record_type"] == "contact"
    assert [(field["label"], field["value"]) for field in preview["fields"]] == [
        ("First name", "Asha"), ("Last name", "Patel"), ("Title", "Chief Technology Officer"),
        ("Company", "Acme Robotics"), ("Company website", "https://acme.example")]
    assert any("LinkedIn" in note for note in preview["not_sent"])
    # Same name at another company, or another name, is not a likely duplicate.
    assert [(item["id"], item["detail"]) for item in preview["matches"]] == [("con_1", "CTO at Acme Robotics")]
    assert preview["matches"][0]["url"] == "https://app.apollo.io/#/contacts/con_1"
    assert [stage["name"] for stage in preview["stages"]] == ["New", "Cold"] and preview["owners"] == []
    assert "@" not in response.text and "555" not in response.text
    assert not fake.tool_calls("APOLLO_CREATE_CONTACT")
    ledger = _rows(app, UsageEventRow, purpose="research_save_to_apollo")
    assert sorted(row.model for row in ledger) == ["apollo_list_contact_stages", "apollo_search_contacts"]
    assert all(row.kind == "apollo" and row.actor_user_id == user_id(app, "ada@example.com") for row in ledger)


def test_link_to_existing_writes_nothing_to_apollo_and_records_the_link(world) -> None:
    client, fake, app = world["client"], world["fake"], world["app"]
    person, _ = _save_profiles(client)
    client.get(f"/v1/research/profiles/{person}/apollo")
    saved = client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "link", "record_id": "con_1"})
    assert saved.status_code == 200, saved.text
    link = saved.json()["profile"]["apollo_crm"]
    assert link["record_type"] == "contact" and link["record_id"] == "con_1" and link["action"] == "linked"
    assert link["url"] == "https://app.apollo.io/#/contacts/con_1" and link["record_name"] == "Asha Patel"
    assert link["by"]["id"] == user_id(app, OWNER_EMAIL) and link["at"]
    assert not fake.tool_calls("APOLLO_CREATE_CONTACT")
    audit = _rows(app, AuditEventRow, action="research.apollo.contact_linked")
    assert len(audit) == 1 and audit[0].resource_id == person and audit[0].organization_id == org_id(app)
    # The middleware's generic row is skipped for this route: one descriptive event per save.
    assert not _rows(app, AuditEventRow, resource_path="/v1/research/profiles/{profile_id}/apollo")
    # It shows on the profile for everyone in the workspace, and survives a refresh from Apollo.
    as_user(client, "mo")
    assert client.get(f"/v1/research/profiles/{person}").json()["apollo_crm"]["record_id"] == "con_1"
    as_user(client, "owner")
    refreshed = client.post(f"/v1/research/profiles/{person}/refresh")
    assert refreshed.json()["profile"]["apollo_crm"]["record_id"] == "con_1"
    again = client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "link", "record_id": "con_1"})
    assert again.status_code == 409
    # Rejected before the save even starts, and still on the record.
    assert [row.status_code for row in _rows(app, AuditEventRow, action="research.apollo.contact_save_failed")] == [409]


def test_link_only_to_a_record_the_duplicate_check_returned(world) -> None:
    client = world["client"]
    person, _ = _save_profiles(client)
    no_check = client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "link", "record_id": "con_1"})
    assert no_check.status_code == 409 and "Check Apollo again" in no_check.json()["detail"]
    client.get(f"/v1/research/profiles/{person}/apollo")
    other = client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "link", "record_id": "con_3"})
    assert other.status_code == 422
    bad = client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "link", "record_id": "../evil"})
    assert bad.status_code == 422
    assert client.get(f"/v1/research/profiles/{person}").json()["apollo_crm"] is None


def test_create_refuses_while_a_likely_duplicate_exists_then_creates_anyway_without_contact_details(world) -> None:
    client, fake, app = world["client"], world["fake"], world["app"]
    person, _ = _save_profiles(client)
    client.get(f"/v1/research/profiles/{person}/apollo")
    refused = client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "create"})
    assert refused.status_code == 409 and "likely match" in refused.json()["detail"]
    assert not fake.tool_calls("APOLLO_CREATE_CONTACT")
    created = client.post(f"/v1/research/profiles/{person}/apollo",
                          json={"action": "create", "create_anyway": True, "stage_id": "cs_new"})
    assert created.status_code == 200, created.text
    assert fake.tool_calls("APOLLO_CREATE_CONTACT") == [{
        "first_name": "Asha", "last_name": "Patel", "title": "Chief Technology Officer",
        "organization_name": "Acme Robotics", "website_url": "https://acme.example", "contact_stage_id": "cs_new"}]
    assert not CONTACT_KEYS_FORBIDDEN & set(fake.tool_calls("APOLLO_CREATE_CONTACT")[0])
    link = created.json()["profile"]["apollo_crm"]
    assert (link["record_id"], link["action"], created.json()["created"]) == ("con_new", "created", True)
    assert [row.status_code for row in _rows(app, AuditEventRow, action="research.apollo.contact_save_failed")] == [409]
    assert len(_rows(app, AuditEventRow, action="research.apollo.contact_created")) == 1
    write = _rows(app, UsageEventRow, model="apollo_create_contact")
    assert len(write) == 1 and write[0].purpose == "research_save_to_apollo" and write[0].status == "succeeded"


def test_create_without_a_preview_still_checks_apollo_first(world) -> None:
    client, fake = world["client"], world["fake"]
    fake.handlers["APOLLO_SEARCH_CONTACTS"] = lambda args: {"contacts": []}
    person, _ = _save_profiles(client)
    created = client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "create"})
    assert created.status_code == 200, created.text
    tools = [path.rsplit("/", 1)[1] for path in fake.paths("POST") if "/tools/execute/APOLLO_" in path][-2:]
    assert tools == ["APOLLO_SEARCH_CONTACTS", "APOLLO_CREATE_CONTACT"]


def test_stage_must_come_from_apollos_list(world) -> None:
    client, fake = world["client"], world["fake"]
    fake.handlers["APOLLO_SEARCH_CONTACTS"] = lambda args: {"contacts": []}
    person, _ = _save_profiles(client)
    client.get(f"/v1/research/profiles/{person}/apollo")
    wrong = client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "create", "stage_id": "cs_made_up"})
    assert wrong.status_code == 422 and not fake.tool_calls("APOLLO_CREATE_CONTACT")


def test_stage_is_checked_even_without_a_preview_first(world) -> None:
    client, fake = world["client"], world["fake"]
    fake.handlers["APOLLO_SEARCH_CONTACTS"] = lambda args: {"contacts": []}
    person, _ = _save_profiles(client)
    wrong = client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "create", "stage_id": "cs_made_up"})
    assert wrong.status_code == 422 and not fake.tool_calls("APOLLO_CREATE_CONTACT")
    right = client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "create", "stage_id": "cs_new"})
    assert right.status_code == 200, right.text


def test_company_becomes_an_account_with_stage_and_owner_and_its_people_attach_to_it(world) -> None:
    client, fake = world["client"], world["fake"]
    person, company = _save_profiles(client)
    preview = client.get(f"/v1/research/profiles/{company}/apollo").json()
    assert fake.tool_calls("APOLLO_SEARCH_ACCOUNTS") == [{"q_organization_name": "Acme Robotics", "page": 1, "per_page": 25}]
    assert fake.tool_calls("APOLLO_LIST_USERS") == [{"page": 1, "per_page": 100}]
    assert [(item["id"], item["name"]) for item in preview["matches"]] == [("acc_1", "Acme Robotics, Inc.")]
    assert [(field["label"], field["value"]) for field in preview["fields"]] == [("Account name", "Acme Robotics"), ("Domain", "acme.example")]
    assert preview["owners"] == [{"id": "usr_olive", "name": "Olive Owner"}] and "olive@" not in str(preview)
    created = client.post(f"/v1/research/profiles/{company}/apollo", json={
        "action": "create", "create_anyway": True, "stage_id": "as_target", "owner_id": "usr_olive"})
    assert created.status_code == 200, created.text
    assert fake.tool_calls("APOLLO_CREATE_ACCOUNT") == [{"name": "Acme Robotics", "domain": "acme.example",
                                                         "account_stage_id": "as_target", "owner_id": "usr_olive"}]
    assert created.json()["profile"]["apollo_crm"]["url"] == "https://app.apollo.io/#/accounts/acc_new"
    # A person at that company is now created under the account.
    fake.handlers["APOLLO_SEARCH_CONTACTS"] = lambda args: {"contacts": []}
    person_preview = client.get(f"/v1/research/profiles/{person}/apollo").json()
    assert ("Apollo account", "Acme Robotics") in [(field["label"], field["value"]) for field in person_preview["fields"]]
    client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "create"})
    assert fake.tool_calls("APOLLO_CREATE_CONTACT")[0]["account_id"] == "acc_new"


def test_stage_and_owner_lists_apollo_will_not_share_do_not_block_a_save(world) -> None:
    client = world["client"]
    _fail(world, "APOLLO_LIST_ACCOUNT_STAGES", "403 Forbidden: This API key is not authorized to access api/v1/account_stages")
    _fail(world, "APOLLO_LIST_USERS", "403 Forbidden")
    _, company = _save_profiles(client)
    preview = client.get(f"/v1/research/profiles/{company}/apollo")
    assert preview.status_code == 200, preview.text
    assert preview.json()["stages"] == [] and "stages" in preview.json()["stages_note"]
    assert preview.json()["owners"] == [] and preview.json()["owners_note"]


@pytest.mark.parametrize(("error", "expected"), [
    ("403 Forbidden: Your team is not permitted to call this endpoint", "doesn't allow creating contacts"),
    ("422 Unprocessable Entity: contact_stage_id is invalid", "didn't accept these details"),
])
def test_apollo_refusing_the_write_is_said_plainly_audited_and_ledgered(world, error, expected) -> None:
    client, app = world["client"], world["app"]
    world["fake"].handlers["APOLLO_SEARCH_CONTACTS"] = lambda args: {"contacts": []}
    _fail(world, "APOLLO_CREATE_CONTACT", error)
    person, _ = _save_profiles(client)
    response = client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "create"})
    assert response.status_code == 409 and expected in response.json()["detail"]
    assert "Unprocessable" not in response.text and "permitted" not in response.text  # never Apollo's own text
    assert client.get(f"/v1/research/profiles/{person}").json()["apollo_crm"] is None
    assert len(_rows(app, AuditEventRow, action="research.apollo.contact_save_failed")) == 1
    failed = _rows(app, UsageEventRow, model="apollo_create_contact")
    assert len(failed) == 1 and failed[0].status == "failed"


def test_duplicate_check_refused_blocks_the_save(world) -> None:
    client, fake = world["client"], world["fake"]
    _fail(world, "APOLLO_SEARCH_CONTACTS", "403 Forbidden")
    person, _ = _save_profiles(client)
    response = client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "create", "create_anyway": True})
    assert response.status_code == 409 and "doesn't allow searching contacts" in response.json()["detail"]
    assert not fake.tool_calls("APOLLO_CREATE_CONTACT")


def test_invalid_key_goes_through_the_existing_failure_path(world) -> None:
    client, app = world["client"], world["app"]
    world["fake"].handlers["APOLLO_SEARCH_CONTACTS"] = lambda args: {"contacts": []}
    _fail(world, "APOLLO_CREATE_CONTACT", "401 Unauthorized: invalid api key")
    person, _ = _save_profiles(client)
    response = client.post(f"/v1/research/profiles/{person}/apollo", json={"action": "create"})
    assert response.status_code == 409 and "reconnect Apollo" in response.json()["detail"]
    assert client.get("/v1/research/status").json()["status"] == "invalid"
    assert app.state.apollo.row(org_id(app)).status == "invalid"


def test_save_to_apollo_counts_toward_the_daily_cap(tmp_path, monkeypatch) -> None:
    world = build_world(tmp_path, monkeypatch, daily="4")
    try:
        _crm_handlers(world["fake"])
        client, fake = world["client"], world["fake"]
        person = client.post("/v1/research/profiles", json={"kind": "person", "apollo_id": "per_asha"})
        profile_id, used = person.json()["profile"]["id"], person.json()["usage"]["used_today"]
        assert used == 2  # the connection check and the person look-up
        preview = client.get(f"/v1/research/profiles/{profile_id}/apollo")  # 2 more: duplicate search + stages
        assert preview.json()["usage"] == {"used_today": 4, "daily_limit": 4}
        capped = client.post(f"/v1/research/profiles/{profile_id}/apollo", json={"action": "create", "create_anyway": True})
        assert capped.status_code == 429 and "today's limit" in capped.json()["detail"]
        assert not fake.tool_calls("APOLLO_CREATE_CONTACT")
    finally:
        world["client"].__exit__(None, None, None)


def test_a_person_without_a_full_name_cannot_become_a_contact(world) -> None:
    client, fake = world["client"], world["fake"]
    fake.handlers["APOLLO_PEOPLE_ENRICHMENT"] = lambda args: {"person": {"id": args["id"], "name": "Cher", "first_name": "Cher"}}
    person = client.post("/v1/research/profiles", json={"kind": "person", "apollo_id": "per_cher"}).json()["profile"]["id"]
    response = client.get(f"/v1/research/profiles/{person}/apollo")
    assert response.status_code == 422 and "first and last name" in response.json()["detail"]
    assert not fake.tool_calls("APOLLO_SEARCH_CONTACTS")
