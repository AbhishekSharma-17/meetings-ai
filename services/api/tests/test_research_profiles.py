"""Saved research profiles: save/refresh/delete permissions, history access rules, quotes, prepare, save to knowledge."""

from __future__ import annotations

import pytest
from research_helpers import (
    as_user, build_world, seed_base, seed_briefing, seed_event, seed_meeting, user_id,
)
from sqlalchemy import select

from app.database import KnowledgeDocumentRow, MeetingPrepInputRow, ResearchProfileRow


@pytest.fixture()
def world(tmp_path, monkeypatch):
    world = build_world(tmp_path, monkeypatch)
    yield world
    world["client"].__exit__(None, None, None)


def _save_acme(client) -> dict:
    response = client.post("/v1/research/profiles", json={"kind": "company", "apollo_id": "org_acme", "domain": "acme.example",
                                                          "name": "Acme Robotics"})
    assert response.status_code in {200, 201}, response.text
    return response.json()


def _save_asha(client) -> dict:
    response = client.post("/v1/research/profiles", json={"kind": "person", "apollo_id": "per_asha"})
    assert response.status_code in {200, 201}, response.text
    return response.json()


# ----- save, refresh, delete -------------------------------------------------------------------------------------------
def test_saving_a_company_fetches_facts_once_and_is_shared_with_the_workspace(world) -> None:
    client, fake = world["client"], world["fake"]
    as_user(client, "mo")
    saved = _save_acme(client)
    assert saved["created"] is True
    profile = saved["profile"]
    assert profile["name"] == "Acme Robotics" and profile["domain"] == "acme.example"
    assert profile["company_facts"]["total_funding"] == "$212M" and profile["company_facts"]["tech_stack"] == ["AWS", "Kubernetes"]
    assert profile["news"][0]["title"] == "Acme opens Rotterdam hub" and profile["hiring"]["open_roles"] == 2
    assert profile["logo_url"] == "https://logos.example/acme.png" and profile["apollo_calls"] == 3 and profile["can_delete"]
    assert fake.tool_calls("APOLLO_ORGANIZATION_ENRICHMENT") == [{"domain": "acme.example"}]
    assert fake.tool_calls("APOLLO_SEARCH_NEWS_ARTICLES")[0]["organization_ids"] == ["org_acme"]
    # Saving again returns the existing profile without spending Apollo calls.
    again = client.post("/v1/research/profiles", json={"kind": "company", "apollo_id": "org_acme", "domain": "acme.example"})
    assert again.status_code == 200 and again.json()["created"] is False and len(fake.tool_calls("APOLLO_ORGANIZATION_ENRICHMENT")) == 1
    as_user(client, "mia")
    listed = client.get("/v1/research/profiles").json()
    assert [item["name"] for item in listed] == ["Acme Robotics"] and listed[0]["can_delete"] is False
    assert listed[0]["created_by"]["name"] == "Mo"
    search = client.post("/v1/research/search/companies", json={"name": "Acme"}).json()
    assert search["items"][0]["saved_profile_id"] == profile["id"]


def test_refresh_asks_apollo_again_and_only_creator_or_admin_can_delete(world) -> None:
    client, fake = world["client"], world["fake"]
    as_user(client, "mo")
    profile = _save_acme(client)["profile"]
    refreshed = client.post(f"/v1/research/profiles/{profile['id']}/refresh")
    assert refreshed.status_code == 200 and len(fake.tool_calls("APOLLO_ORGANIZATION_ENRICHMENT")) == 2
    assert refreshed.json()["profile"]["apollo_calls"] == 6
    as_user(client, "mia")
    denied = client.delete(f"/v1/research/profiles/{profile['id']}")
    assert denied.status_code == 403
    as_user(client, "ada")
    assert client.delete(f"/v1/research/profiles/{profile['id']}").status_code == 204
    assert client.get(f"/v1/research/profiles/{profile['id']}").status_code == 404
    as_user(client, "mo")
    mine = _save_acme(client)["profile"]
    assert client.delete(f"/v1/research/profiles/{mine['id']}").status_code == 204


def test_person_profile_keeps_work_facts_only(world) -> None:
    client, app = world["client"], world["app"]
    as_user(client, "mo")
    saved = _save_asha(client)
    person = saved["profile"]
    assert person["name"] == "Asha Patel" and person["title"] == "Chief Technology Officer" and person["domain"] == "acme.example"
    assert person["person"]["past_roles"][0]["company"] == "Globex" and person["company"] == "Acme Robotics"
    with app.state.database.session_factory() as session:
        stored = str(session.execute(select(ResearchProfileRow.data)).scalar_one())
    assert "@" not in stored and "555" not in stored and "@" not in str(saved)
    as_user(client, "owner")
    company = _save_acme(client)["profile"]
    people = client.get(f"/v1/research/profiles/{company['id']}/people").json()
    assert [item["name"] for item in people] == ["Asha Patel"]


def test_profiles_are_tenant_scoped(world) -> None:
    client, app = world["client"], world["app"]
    as_user(client, "mo")
    profile = _save_acme(client)["profile"]
    created = client.post("/v1/workspaces", json={"display_name": "Other"})
    assert created.status_code in {200, 201}, created.text
    other = created.json()["organization_id"]
    assert client.post(f"/v1/workspaces/{other}/switch").status_code == 200
    assert client.get(f"/v1/research/profiles/{profile['id']}").status_code == 404
    assert client.get("/v1/research/profiles").json() == []


# ----- history ---------------------------------------------------------------------------------------------------------
def test_company_history_only_shows_meetings_and_briefings_the_viewer_can_already_see(world) -> None:
    client, app = world["client"], world["app"]
    mo, mia = user_id(app, "mo@example.com"), user_id(app, "mia@example.com")
    covered = seed_meeting(app, title="Acme discovery", invitees=[{"name": "Asha Patel", "email": "asha@acme.example"}], covered=[mo])
    hidden = seed_meeting(app, title="Pricing call", invitees=[{"name": "Chen Li", "email": "chen@sub.acme.example"}])
    shared_base = seed_base(app, name="Clients", created_by=mia, visibility="organization")
    shared = seed_meeting(app, title="Acme Robotics QBR", invitees=[], knowledge_base_id=shared_base)
    seed_meeting(app, title="Unrelated", invitees=[{"name": "Pat", "email": "pat@else.example"}], covered=[mo])
    my_event = seed_event(app, owner=mo, title="Acme follow-up", invitees=[{"name": "Asha Patel", "email": "asha@acme.example"}])
    their_event = seed_event(app, owner=mia, title="Mia's Acme prep", invitees=[])
    seed_briefing(app, owner=mo, event_id=my_event, target="Acme Robotics", website="https://acme.example")
    seed_briefing(app, owner=mia, event_id=their_event, target="Acme Robotics", website="https://acme.example")
    as_user(client, "mo")
    profile = _save_acme(client)["profile"]
    history = client.get(f"/v1/research/profiles/{profile['id']}/history").json()
    assert {item["meeting_id"] for item in history["meetings"]} == {covered, shared}
    assert hidden not in str(history) and "Pricing call" not in str(history)
    assert [item["title"] for item in history["briefings"]] == ["Acme follow-up"]
    assert "Mia's Acme prep" not in str(history)
    as_user(client, "ada")  # admins see every meeting in the workspace, but still only their own briefings
    admin = client.get(f"/v1/research/profiles/{profile['id']}/history").json()
    assert {item["meeting_id"] for item in admin["meetings"]} == {covered, hidden, shared} and admin["briefings"] == []


def test_our_own_company_never_matches_every_meeting(world) -> None:
    client, app = world["client"], world["app"]
    seed_meeting(app, title="Standup", invitees=[{"name": "Mo", "email": "mo@example.com"}])
    as_user(client, "owner")
    world["fake"].handlers["APOLLO_ORGANIZATION_ENRICHMENT"] = lambda args: {"organization": {"id": "org_us", "name": "Example",
                                                                                              "primary_domain": "example.com"}}
    ours = client.post("/v1/research/profiles", json={"kind": "company", "domain": "example.com"}).json()["profile"]
    history = client.get(f"/v1/research/profiles/{ours['id']}/history").json()
    assert history["our_company"] is True and history["meetings"] == []


def test_person_quotes_come_only_from_approved_speaker_identities(world) -> None:
    client, app = world["client"], world["app"]
    mo = user_id(app, "mo@example.com")
    approved = seed_meeting(app, title="Acme architecture", covered=[mo],
                            invitees=[{"name": "Asha Patel", "email": "asha@acme.example"}],
                            segments=[("Asha Patel", "We need the pilot to cover both Rotterdam and Reno sites."),
                                      ("Chen Li", "Budget approval lands in November for the whole program."),
                                      ("Asha Patel", "ok")],
                            identities={"Asha Patel": "asha@acme.example"})
    unreviewed = seed_meeting(app, title="Acme intro", covered=[mo], invitees=[{"name": "Asha Patel", "email": "asha@acme.example"}],
                              segments=[("Asha Patel", "This label was never confirmed, so it must not be quoted.")])
    as_user(client, "mo")
    person = _save_asha(client)["profile"]
    history = client.get(f"/v1/research/profiles/{person['id']}/history").json()
    by_id = {item["meeting_id"]: item for item in history["meetings"]}
    assert set(by_id) == {approved, unreviewed}
    assert [quote["text"] for quote in by_id[approved]["quotes"]] == ["We need the pilot to cover both Rotterdam and Reno sites."]
    assert by_id[unreviewed]["quotes"] == [] and "never confirmed" not in str(history)
    as_user(client, "mia")  # not covered and not shared: nothing leaks
    assert client.get(f"/v1/research/profiles/{person['id']}/history").json()["meetings"] == []


# ----- actions ---------------------------------------------------------------------------------------------------------
def test_prepare_a_meeting_writes_inputs_for_my_own_event_only(world) -> None:
    client, app = world["client"], world["app"]
    mo, mia = user_id(app, "mo@example.com"), user_id(app, "mia@example.com")
    mine = seed_event(app, owner=mo, title="Acme pilot scoping", invitees=[
        {"name": "Asha Patel", "email": "asha@acme.example"}, {"name": "Mo", "email": "mo@example.com"}])
    theirs = seed_event(app, owner=mia, title="Mia's call", invitees=[])
    as_user(client, "mo")
    company = _save_acme(client)["profile"]
    person = _save_asha(client)["profile"]
    prepared = client.post(f"/v1/research/profiles/{company['id']}/prepare",
                           json={"calendar_event_id": mine, "person_profile_ids": [person["id"]]})
    assert prepared.status_code == 200, prepared.text
    assert prepared.json()["attendee_sides"] == {"asha@acme.example": "theirs"}
    assert prepared.json()["matched_people"] == ["Asha Patel"]
    with app.state.database.session_factory() as session:
        inputs = session.get(MeetingPrepInputRow, mine)
    assert inputs.target_company == "Acme Robotics" and inputs.company_website.startswith("https://www.acme.example")
    assert "Asha Patel (Chief Technology Officer) will be on their side" in inputs.notes
    refused = client.post(f"/v1/research/profiles/{company['id']}/prepare", json={"calendar_event_id": theirs})
    assert refused.status_code == 404
    with app.state.database.session_factory() as session:
        assert session.get(MeetingPrepInputRow, theirs) is None
    as_user(client, "vic")
    assert client.post(f"/v1/research/profiles/{company['id']}/prepare", json={"calendar_event_id": mine}).status_code == 403


def test_save_to_knowledge_creates_an_indexable_document_in_a_writable_base_only(world) -> None:
    client, app = world["client"], world["app"]
    mo, mia = user_id(app, "mo@example.com"), user_id(app, "mia@example.com")
    mine = seed_base(app, name="Mo notes", created_by=mo)
    theirs = seed_base(app, name="Mia shared", created_by=mia, visibility="organization")
    as_user(client, "mo")
    company = _save_acme(client)["profile"]
    denied = client.post(f"/v1/research/profiles/{company['id']}/knowledge", json={"knowledge_base_id": theirs})
    assert denied.status_code == 403
    saved = client.post(f"/v1/research/profiles/{company['id']}/knowledge", json={"knowledge_base_id": mine})
    assert saved.status_code == 201, saved.text
    assert saved.json()["status"] == "pending" and saved.json()["scope_id"] == mine
    with app.state.database.session_factory() as session:
        document = session.execute(select(KnowledgeDocumentRow).where(KnowledgeDocumentRow.scope_id == mine)).scalar_one()
    assert document.content_type == "text/markdown" and "Source: Apollo, fetched" in document.extracted_text
    assert "Series C" in document.extracted_text and "Acme opens Rotterdam hub" in document.extracted_text
    as_user(client, "ada")  # admins may add to any base
    assert client.post(f"/v1/research/profiles/{company['id']}/knowledge", json={"knowledge_base_id": theirs}).status_code == 201


def test_open_roles_are_grouped_by_theme(world) -> None:
    client = world["client"]
    as_user(client, "mo")
    groups = _save_acme(client)["profile"]["job_groups"]
    assert {group["theme"]: [job["title"] for job in group["jobs"]] for group in groups} == {
        "AI & data": ["Senior ML Engineer"], "Sales": ["Account Executive"]}
