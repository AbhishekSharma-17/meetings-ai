"""Shared fixtures for Research (Apollo Explorer) tests: a workspace with every role, a fake Composio/Apollo,
a fake chat model, a fake Exa, and helpers that seed meetings, transcripts, briefings and calendar events.

Nothing here reaches the network: Composio, Exa and the model are all in-process fakes.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any, Callable
from uuid import uuid4

import httpx
from account_links import accept_invite
from fastapi.testclient import TestClient
from meetings_contracts import ProviderType, TextGenerationResult
from sqlalchemy import select
from test_apollo_integration import COMPOSIO_KEY, FakeComposio

from app.apollo_composio import ApolloComposio
from app.database import (
    CalendarEventCacheRow, KnowledgeBaseRow, MeetingCoverageRow, MeetingKnowledgeBaseRow, MeetingKnowledgeSettingsRow,
    MeetingMinutesRow, MeetingPrepRow, MeetingRow, MeetingSourceRow, MeetingSpeakerIdentityRow, MeetingTenantRow,
    TranscriptSegmentRow, UserRow,
)
from app.main import create_app

OWNER_EMAIL, OWNER_PASSWORD = "developer@genaiprotos.com", "owner-password-for-test"
APOLLO_KEY = "apollo-research-key-4411"
ACME_ORG = {"id": "org_acme", "name": "Acme Robotics", "primary_domain": "acme.example", "website_url": "https://www.acme.example",
            "linkedin_url": "https://www.linkedin.com/company/acme", "logo_url": "https://logos.example/acme.png",
            "industry": "industrial automation", "estimated_num_employees": 540, "city": "Austin", "state": "Texas",
            "country": "United States", "primary_phone": {"number": "+1 555 0100"}}
ASHA = {"id": "per_asha", "first_name": "Asha", "last_name": "Patel", "name": "Asha Patel", "title": "Chief Technology Officer",
        "seniority": "c_suite", "departments": ["master_engineering_technical"], "linkedin_url": "https://www.linkedin.com/in/asha",
        "city": "Austin", "state": "Texas", "country": "United States", "email": "asha@acme.example",
        "personal_emails": ["asha.home@gmail.example"], "phone_numbers": [{"raw_number": "+1 555 0199"}],
        "organization": {"id": "org_acme", "name": "Acme Robotics", "primary_domain": "acme.example", "phone": "+1 555 0100"},
        "employment_history": [{"organization_name": "Acme Robotics", "title": "Chief Technology Officer", "current": True,
                                "start_date": "2022-03-01"},
                               {"organization_name": "Globex", "title": "VP Data Platforms", "current": False,
                                "start_date": "2018-01-01", "end_date": "2022-02-01"}]}


class FakeApollo(FakeComposio):
    """FakeComposio plus per-tool handlers ``tool -> (arguments) -> data`` for the Research tools."""

    def __init__(self) -> None:
        super().__init__()
        self.handlers: dict[str, Callable[[dict], Any]] = {
            "APOLLO_ORGANIZATION_SEARCH": lambda args: {
                "organizations": [ACME_ORG, {"id": "org_globex", "name": "Globex", "primary_domain": "globex.example"}],
                "accounts": [{"id": "acc_1", "organization_id": "org_acme", "name": "Acme Robotics", "domain": "acme.example"}],
                "pagination": {"page": args.get("page", 1), "per_page": 25, "total_entries": 2, "total_pages": 1}},
            "APOLLO_PEOPLE_SEARCH": lambda args: {
                "people": [{"id": "per_asha", "first_name": "Asha", "last_name_obfuscated": "Pa***l", "title": "CTO",
                            "email": "hidden@acme.example", "organization": {"name": "Acme Robotics", "primary_domain": "acme.example"}},
                           {"id": "per_chen", "first_name": "Chen", "last_name": "Li", "title": "Director of Operations",
                            "organization": {"name": "Acme Robotics"}}],
                "total_entries": 2},
            "APOLLO_PEOPLE_ENRICHMENT": lambda args: {"person": {**ASHA, "id": args["id"]}},
            "APOLLO_BULK_PEOPLE_ENRICHMENT": lambda args: {"matches": [{**ASHA, "id": item["id"]} for item in args["details"]]},
            "APOLLO_ORGANIZATION_ENRICHMENT": lambda args: {"organization": {
                **ACME_ORG, "short_description": "Warehouse robots.", "annual_revenue_printed": "$50M-$100M",
                "total_funding_printed": "$212M", "latest_funding_stage": "Series C", "founded_year": 2016,
                "current_technologies": [{"name": "AWS"}, {"name": "Kubernetes"}]}},
            "APOLLO_SEARCH_NEWS_ARTICLES": lambda args: {"news_articles": [
                {"title": "Acme opens Rotterdam hub", "url": "https://news.example/acme", "published_at": "2026-09-10"}]},
            "APOLLO_GET_ORGANIZATION_JOB_POSTINGS": lambda args: {"organization_job_postings": [
                {"title": "Senior ML Engineer", "city": "Austin"}, {"title": "Account Executive"}],
                "pagination": {"total_entries": 2}},
        }

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v3.1")
        tool = path.rsplit("/", 1)[1] if path.startswith("/tools/execute/") else None
        if tool in self.handlers:
            body = json.loads(request.content) if request.content else {}
            self.calls.append((request.method, request.url.path, body, dict(request.url.params)))
            return httpx.Response(200, json={"successful": True, "data": self.handlers[tool](body["arguments"])})
        return super().__call__(request)

    def tool_calls(self, tool: str) -> list[dict]:
        return [body["arguments"] for _, path, body, _ in self.calls if path.endswith(f"/tools/execute/{tool}")]


class FakeResearchModel:
    """Answers research_chat prompts citing the first two sources; records every prompt."""

    def __init__(self) -> None:
        self.requests: list = []

    async def generate_text(self, profile, request):
        self.requests.append(request)
        labels = [line.split("]")[0][1:] for line in request.prompt.splitlines() if line.startswith("[S")]
        cited = labels[:2]
        payload = {"answer": " ".join(f"Fact [{label}]." for label in cited) or "Not enough information.",
                   "citation_ids": [*cited, "S999"]}
        return TextGenerationResult(text=json.dumps(payload), structured_output=payload, provider="fake",
                                    model="fake-chat", input_tokens=100, output_tokens=20)


class FakeExa:
    def __init__(self) -> None:
        self.requests: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        return httpx.Response(200, json={"results": [{"url": "https://web.example/acme", "title": "Acme expands",
                                                      "highlights": ["Acme is expanding in Europe."]}],
                                         "costDollars": {"total": 0.007}})


def login(client: TestClient, email: str, password: str) -> dict:
    client.post("/v1/auth/logout")
    response = client.post("/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return client.get("/v1/auth/me").json()


def as_user(client: TestClient, who: str) -> dict:
    if who == "owner":
        return login(client, OWNER_EMAIL, OWNER_PASSWORD)
    return login(client, f"{who}@example.com", f"{who}-password-long-enough")


def build_world(tmp_path, monkeypatch, *, connect: bool = True, daily: str | None = None) -> dict:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER_PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "research-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER_EMAIL)
    monkeypatch.setenv("IN_PERSON_CLEANUP_ENABLED", "0")
    monkeypatch.delenv("EXA_API_KEY", raising=False)
    if daily:
        monkeypatch.setenv("APOLLO_DAILY_CALLS_PER_USER", daily)
    else:
        monkeypatch.delenv("APOLLO_DAILY_CALLS_PER_USER", raising=False)
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'research.db'}", credential_key="test-key")
    fake, model, exa = FakeApollo(), FakeResearchModel(), FakeExa()
    app.state.apollo.client = ApolloComposio(COMPOSIO_KEY, transport=httpx.MockTransport(fake), environ={})
    app.state.research.chat_engine.exa_transport = httpx.MockTransport(exa)
    app.state.research.chat_engine.environ = {}
    client = TestClient(app)
    client.__enter__()
    login(client, OWNER_EMAIL, OWNER_PASSWORD)
    app.state.profile_service.adapters[ProviderType.OPENAI] = model
    text_profile = client.post("/v1/provider-profiles", json={
        "name": "Text", "provider_type": "openai", "execution_location": "cloud", "api_key": "text-key",
        "capabilities": [{"capability": "text_generation", "model": "gpt-6-luna"}]}).json()
    assert client.put("/v1/provider-defaults/text_generation", json={
        "policy": "cloud_only", "cloud_profile_id": text_profile["id"]}).status_code == 200
    invites = {key: client.post("/v1/workspace/invite", json={"email": f"{key}@example.com", "display_name": key.title(),
                                                                "role": role}).json()
               for key, role in (("ada", "admin"), ("mo", "member"), ("mia", "member"), ("vic", "viewer"))}
    for key, invited in invites.items():
        client.post("/v1/auth/logout")
        accept_invite(client, invited, f"{key}-password-long-enough")
    login(client, OWNER_EMAIL, OWNER_PASSWORD)
    if connect:
        assert client.put("/v1/workspace/integrations/apollo", json={"api_key": APOLLO_KEY}).status_code == 200
    return {"app": app, "client": client, "fake": fake, "model": model, "exa": exa}


def user_id(app, email: str) -> str:
    with app.state.database.session_factory() as session:
        return session.execute(select(UserRow.id).where(UserRow.email == email)).scalar_one()


def org_id(app) -> str:
    with app.state.database.session_factory() as session:
        from app.database import OrganizationMembershipRow
        return session.execute(select(OrganizationMembershipRow.organization_id).where(
            OrganizationMembershipRow.user_id == user_id(app, "mo@example.com"))).scalar_one()


def seed_meeting(app, *, title: str, invitees: list[dict] | None = None, status: str = "completed",
                 covered: list[str] = (), knowledge_base_id: str | None = None,
                 segments: list[tuple[str, str]] = (), identities: dict[str, str] | None = None,
                 minutes: str | None = None, days_ago: int = 3) -> str:
    """A meeting in the workspace; ``covered`` user ids get owner coverage (read access)."""
    meeting_id, org, now = str(uuid4()), org_id(app), datetime.now(UTC)
    when = now - timedelta(days=days_ago)
    with app.state.database.session_factory.begin() as session:
        session.add(MeetingRow(id=meeting_id, meeting_url="https://meet.google.com/abc-defg-hij", title=title, bot_name="Meetings AI",
                               language="en", transcribe_enabled=True, recording_enabled=False, platform="google_meet",
                               native_meeting_id="abc-defg-hij", status=status, vexa_meeting_id=None, last_error=None,
                               created_at=when, updated_at=when))
        session.flush()
        session.add(MeetingTenantRow(meeting_id=meeting_id, organization_id=org))
        if invitees is not None:
            session.add(MeetingSourceRow(meeting_id=meeting_id, organization_id=org, provider="googlecalendar", connection_id="c1",
                                         event_id=f"e-{meeting_id}", title=title, meeting_url="https://meet.google.com/abc-defg-hij",
                                         platform="google_meet", starts_at=when, ends_at=when + timedelta(hours=1), agenda=None,
                                         organizer=None, invitees=invitees, saved_at=when))
        for user in covered:
            session.add(MeetingCoverageRow(meeting_id=meeting_id, user_id=user, organization_id=org, role="owner",
                                           decision=None, handed_to_meeting_id=None, receive_recap=True, decided_at=now,
                                           decided_by=user))
        if knowledge_base_id:
            session.add(MeetingKnowledgeSettingsRow(meeting_id=meeting_id, organization_id=org, tags=[], knowledge_enabled=True,
                                                    updated_at=now))
            session.add(MeetingKnowledgeBaseRow(meeting_id=meeting_id, knowledge_base_id=knowledge_base_id))
        for position, (speaker, text) in enumerate(segments):
            session.add(TranscriptSegmentRow(meeting_id=meeting_id, position=position, start_seconds=position * 10.0,
                                             end_seconds=position * 10.0 + 9, text=text, speaker=speaker, language="en",
                                             completed=True))
        for speaker, email in (identities or {}).items():
            session.add(MeetingSpeakerIdentityRow(meeting_id=meeting_id, speaker=speaker, email=email, confirmed_at=now))
        if minutes:
            session.add(MeetingMinutesRow(meeting_id=meeting_id, status="approved", title=title, executive_summary=minutes,
                                          discussion_points=[], decisions=["Run a pilot"], action_items=[], open_questions=[],
                                          provider_profile_id=None, provider=None, model=None, last_error=None,
                                          created_at=now, updated_at=now, approved_at=now, sent_at=None))
    return meeting_id


def seed_base(app, *, name: str, created_by: str, visibility: str = "private") -> str:
    base_id, now = str(uuid4()), datetime.now(UTC)
    with app.state.database.session_factory.begin() as session:
        session.add(KnowledgeBaseRow(id=base_id, organization_id=org_id(app), name=name, description=None, created_by=created_by,
                                     visibility=visibility, text_profile_id=None, created_at=now, updated_at=now))
    return base_id


def seed_event(app, *, owner: str, title: str, invitees: list[dict], days_ahead: int = 2) -> str:
    event_id, now = str(uuid4()), datetime.now(UTC)
    starts = now + timedelta(days=days_ahead)
    payload = {"connection_id": "c1", "provider": "googlecalendar", "event_id": f"ev-{event_id}", "title": title,
               "starts_at": starts.isoformat(), "ends_at": (starts + timedelta(hours=1)).isoformat(),
               "meeting_url": "https://meet.google.com/abc-defg-hij", "platform": "google_meet", "invitees": invitees}
    with app.state.database.session_factory.begin() as session:
        session.add(CalendarEventCacheRow(id=event_id, organization_id=org_id(app), user_id=owner, connection_id="c1",
                                          provider="googlecalendar", event_id=f"ev-{event_id}", starts_at=starts,
                                          ends_at=starts + timedelta(hours=1), payload=payload, synced_at=now))
    return event_id


def seed_briefing(app, *, owner: str, event_id: str, target: str, website: str) -> None:
    with app.state.database.session_factory.begin() as session:
        session.add(MeetingPrepRow(id=str(uuid4()), organization_id=org_id(app), user_id=owner, calendar_event_id=event_id,
                                   context="", profile_urls=[], created_at=datetime.now(UTC),
                                   report={"report_version": 2, "target_company": target, "company_website": website,
                                           "executive_brief": f"{target} is scaling robots."}))
