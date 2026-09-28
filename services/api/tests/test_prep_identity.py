"""Our company identity API and who's-who wiring through meeting prep (prompts, research, report)."""

import json
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from app.accounts import Actor
from app.database import LEGACY_ORGANIZATION_ID, OrganizationMembershipRow
from app.organization_identity import IdentityPermissionError, OrganizationIdentityInput
from app.exa_client import ExaResult
from app.prep_parties import OurIdentity
from app.prep_research import ResearchAttendee, match_person, our_terms

from test_prep_research import FakeLLM, _app, _exa_handler, _setup, _synthesis

OWNER_EMAIL = "owner@ourco.example"
OWNER_PASSWORD = "owner-password-for-test"


def _signed_in_app(tmp_path, monkeypatch, invitees=None):
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER_PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER_EMAIL)
    return _app(tmp_path, invitees)


def _set_role(app, role):
    with app.state.database.session_factory.begin() as session:
        session.execute(update(OrganizationMembershipRow).values(role=role))


def test_identity_prefills_suggestions_and_validates_domains(tmp_path, monkeypatch):
    app = _signed_in_app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        assert client.post("/v1/auth/login", json={"email": OWNER_EMAIL, "password": OWNER_PASSWORD}).status_code == 200
        assert client.put("/v1/workspace/brief", json={"website": "https://www.ourbrand.example"}).status_code == 200
        first = client.get("/v1/workspace/identity").json()
        assert first["configured"] is False and first["can_edit"] is True
        assert first["company_name"] == first["suggestions"]["company_name"] and first["company_name"]
        assert first["domains"] == ["ourbrand.example", "ourco.example"]

        bad = client.put("/v1/workspace/identity", json={"company_name": "Our Co", "domains": ["gmail.com"]})
        assert bad.status_code == 422 and "personal email provider" in bad.text
        assert client.put("/v1/workspace/identity", json={"domains": ["not a domain"]}).status_code == 422

        saved = client.put("/v1/workspace/identity", json={
            "company_name": "  Our Co ", "aliases": ["OC", "oc", "Our Co", ""],
            "domains": ["https://www.OurCo.example/about", "@ourco.io", "ourco.io"],
        })
        assert saved.status_code == 200, saved.text
        body = saved.json()
        assert body["company_name"] == "Our Co" and body["aliases"] == ["OC"]
        assert body["domains"] == ["ourco.example", "ourco.io"] and body["configured"] is True
        assert client.get("/v1/workspace/identity").json()["domains"] == ["ourco.example", "ourco.io"]


def test_identity_is_readable_by_members_and_writable_only_by_admins(tmp_path, monkeypatch):
    app = _signed_in_app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        assert client.post("/v1/auth/login", json={"email": OWNER_EMAIL, "password": OWNER_PASSWORD}).status_code == 200
        assert client.put("/v1/workspace/identity", json={"company_name": "Our Co"}).status_code == 200
        _set_role(app, "admin")
        assert client.put("/v1/workspace/identity", json={"company_name": "Our Co Ltd"}).status_code == 200
        for role in ("member", "viewer"):
            _set_role(app, role)
            view = client.get("/v1/workspace/identity")
            assert view.status_code == 200 and view.json()["company_name"] == "Our Co Ltd"
            assert view.json()["can_edit"] is False
            assert client.put("/v1/workspace/identity", json={"company_name": "Hijack"}).status_code == 403
    # The service enforces the same rule without the middleware.
    actor = Actor(user_id=uuid4(), organization_id=LEGACY_ORGANIZATION_ID, email="m@ourco.example",
                  display_name="Member", role="member", must_change_password=False, session_version=0)
    with pytest.raises(IdentityPermissionError):
        app.state.organization_identity.save(actor, OrganizationIdentityInput(company_name="Hijack"))


def test_whos_who_preview_never_targets_us_and_applies_overrides(tmp_path):
    invitees = [{"name": "Our Colleague", "email": "colleague@ourco.example"},
                {"name": "Asha Patel", "email": "asha@acme.example"},
                {"name": "Val Vendor", "email": "val@globex.example"},
                {"name": "Gee Mail", "email": "gee@gmail.com"},
                {"name": "Room 1", "email": "c_123@resource.calendar.google.com"}]
    app = _app(tmp_path, invitees)
    with TestClient(app) as client:
        event_id, _ = _setup(client, app, FakeLLM(_synthesis()))
        assert client.put("/v1/workspace/identity", json={"company_name": "OurCo", "aliases": ["OC"]}).status_code == 200
        preview = client.post(f"/v1/calendar/events/{event_id}/prep/whos-who",
                              json={"target_company": "Our-Co Inc.", "company_website": "https://half"})
        assert preview.status_code == 200, preview.text
        body = preview.json()
        assert [warning["code"] for warning in body["warnings"]] == ["target_is_us"]
        assert body["target"]["domains"] == ["acme.example"] and body["target"]["source"] == "email_domain"
        assert body["our_company"]["name"] == "OurCo" and "ourco.example" in body["our_company"]["domains"]
        sides = {person["name"]: person["side"] for person in body["attendees"]}
        assert sides == {"Our Colleague": "ours", "Asha Patel": "theirs", "Val Vendor": "other_external",
                         "Gee Mail": "unknown"}
        assert body["ignored"] == ["c_123@resource.calendar.google.com"]
        corrected = client.post(f"/v1/calendar/events/{event_id}/prep/whos-who", json={
            "attendee_sides": {"GEE@gmail.com": "theirs", "val@globex.example": "ours"}}).json()
        sides = {person["name"]: person["side"] for person in corrected["attendees"]}
        assert sides["Gee Mail"] == "theirs" and sides["Val Vendor"] == "ours"
        too_many = client.post(f"/v1/calendar/events/{event_id}/prep/whos-who",
                               json={"attendee_sides": {f"p{index}@x.example": "ours" for index in range(101)}})
        assert too_many.status_code == 422


def test_prompts_label_sides_and_our_people_are_never_researched(tmp_path):
    invitees = [{"name": "Our Colleague", "email": "colleague@ourco.example"},
                {"name": "Asha Patel", "email": "asha@acme.example"},
                {"name": "Gee Mail", "email": "gee@gmail.com"}]
    app = _app(tmp_path, invitees)
    captured = []
    app.state.meeting_prep.exa_transport = httpx.MockTransport(_exa_handler(captured))
    app.state.meeting_prep.environ = {"EXA_API_KEY": "exa-key"}
    llm = FakeLLM(_synthesis(), plan={"learning_goals": [], "queries": [
        {"purpose": "news", "query": "Acme OurCo partnership news"},
        {"purpose": "ai", "query": "Acme machine learning vendors"},
    ]})
    with TestClient(app) as client:
        event_id, profile_id = _setup(client, app, llm)
        assert client.put("/v1/workspace/identity", json={"company_name": "OurCo"}).status_code == 200
        response = client.post(f"/v1/calendar/events/{event_id}/prep", json={
            "text_profile_id": profile_id, "target_company": "OurCo",
            "attendee_sides": {"gee@gmail.com": "theirs"},
        })
        assert response.status_code == 200, response.text
        report = response.json()

    plan, synthesis = llm.requests[0].prompt, llm.requests[1].prompt
    assert "OUR company: OurCo" in plan and "TARGET company to research: acme.example" in plan
    assert "OUR company: OurCo" in synthesis and "TARGET company: acme.example" in synthesis
    assert 'Our attendees (our colleagues; never research, profile or pitch to them): ["Our Colleague"]' in synthesis
    assert "Their attendees (the TARGET company's people)" in synthesis and "Gee Mail" in synthesis
    assert "must never be described as the client" in llm.requests[1].system_prompt
    sent = json.dumps([body for _, body, _ in captured])
    assert "OurCo" not in sent and "Colleague" not in sent  # we are never researched
    assert "Acme machine learning vendors" in sent
    people_queries = [body["query"] for _, body, _ in captured if body.get("category") == "people"]
    assert people_queries == ["Asha Patel acme.example", "Gee Mail acme.example"]

    assert report["target_company"] == "acme.example"
    assert report["whos_who"]["warnings"][0]["code"] == "target_is_us"
    sides = {person["name"]: person["side"] for person in report["whos_who"]["attendees"]}
    assert sides == {"Our Colleague": "ours", "Asha Patel": "theirs", "Gee Mail": "theirs"}
    assert {person["name"]: person["side"] for person in report["attendees"]} == {
        "Asha Patel": "theirs", "Gee Mail": "theirs"}


def test_person_matching_never_labels_our_people_as_the_client():
    identity = OurIdentity(name="OurCo", domains=frozenset({"ourco.example"}))
    person = ResearchAttendee(name="Asha Patel", email=None, company="Acme", searchable=True)
    ours = ExaResult(url="u", title="Asha Patel - Engineer at OurCo | LinkedIn", highlights=("Previously at Acme",))
    assert match_person(person, ours, {"Acme", "acme.example"}, our_terms(identity)) == "unconfirmed"
    both = ExaResult(url="u", title="Asha Patel - Acme partner lead, ex-OurCo")
    assert match_person(person, both, {"Acme"}, our_terms(identity)) == "confirmed"
    assert match_person(person, ours, {"Acme"}) == "likely"  # without our terms the old behaviour holds
