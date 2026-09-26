"""Usage ledger coverage (LLM, embeddings, transcription), summary breakdowns, event paging and CSV."""

import asyncio
import csv
import io
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from meetings_contracts import (
    EmbeddingRequest, MeetingStatus, ProviderType, TextGenerationRequest,
)
from sqlalchemy import select

from app.accounts import _hash_password
from app.adapters.base import ProviderExecutionError
from app.adapters.vexa import VexaCaptureAdapter
from app.database import (
    LEGACY_ADMIN_USER_ID, LEGACY_ORGANIZATION_ID, CalendarEventCacheRow, MeetingPrepRow,
    OrganizationMembershipRow, OrganizationRow, UsageEventRow, UserCredentialRow, UserRow,
)
from app.main import create_app
from app.tenant import tenant_scope
from app.usage import transcript_audio_seconds, usage_request_scope


def _app(tmp_path, name: str = "usage.db", vexa: VexaCaptureAdapter | None = None):
    return create_app(database_url=f"sqlite+pysqlite:///{tmp_path / name}",
                      credential_key="test-credential-key", vexa_adapter=vexa)


def _events(app, **where) -> list[UsageEventRow]:
    with app.state.database.session_factory() as session:
        query = select(UsageEventRow).order_by(UsageEventRow.created_at)
        for key, value in where.items():
            query = query.where(getattr(UsageEventRow, key) == value)
        return session.execute(query).scalars().all()


def test_text_and_embedding_calls_record_success_failure_and_duration(tmp_path) -> None:
    app = _app(tmp_path)
    responses = iter([
        httpx.Response(200, json={"output": [{"content": [{"type": "output_text", "text": "Summary"}]}],
                                  "usage": {"input_tokens": 1000, "output_tokens": 200}}),
        httpx.Response(500, json={"error": {"message": "overloaded"}}),
        httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.1, 0.2]}], "usage": {"prompt_tokens": 50}}),
    ])
    transport = httpx.MockTransport(lambda request: next(responses))
    service = app.state.profile_service
    service.adapters[ProviderType.OPENAI].transport = transport
    with TestClient(app) as client:
        created = client.post("/v1/provider-profiles", json={
            "name": "OpenAI main", "provider_type": "openai", "execution_location": "cloud", "api_key": "sk-test-secret",
            "capabilities": [{"capability": "text_generation", "model": "gpt-6-luna"},
                             {"capability": "embeddings", "model": "text-embedding-3-small"}],
        })
        assert created.status_code == 201, created.text
        profile_id = UUID(created.json()["id"])

    async def scenario() -> None:
        with tenant_scope(LEGACY_ORGANIZATION_ID):
            await service.generate_text(TextGenerationRequest(prompt="Summarize", metadata={
                "purpose": "knowledge_answer", "actor_user_id": str(LEGACY_ADMIN_USER_ID)}), profile_id=profile_id)
            with pytest.raises(ProviderExecutionError):
                await service.generate_text(TextGenerationRequest(prompt="Again", metadata={"purpose": "knowledge_answer"}),
                                            profile_id=profile_id)
            await service.embed(EmbeddingRequest(inputs=["notes"], metadata={"purpose": "knowledge_index"}),
                                profile_id=profile_id)

    asyncio.run(scenario())
    llm = _events(app, kind="llm")
    assert [row.status for row in llm] == ["succeeded", "failed"]
    ok, failed = llm
    assert (ok.input_tokens, ok.output_tokens, ok.model) == (1000, 200, "gpt-6-luna")
    assert ok.estimated_usd == pytest.approx(0.0002)  # $0.10 in + $0.50 out per 1M tokens
    assert ok.duration_ms is not None and ok.actor_user_id == str(LEGACY_ADMIN_USER_ID)
    assert ok.details["profile_name"] == "OpenAI main"
    assert ok.details["endpoint_host"] == "api.openai.com"
    assert failed.estimated_usd is None and failed.details["error_type"] == "ProviderExecutionError"
    embedding = _events(app, kind="embedding")[0]
    assert embedding.input_tokens == 50 and embedding.estimated_usd == pytest.approx(0.000001)
    assert embedding.details["dimensions"] == 2
    serialized = str([row.details for row in _events(app)])
    assert "sk-test-secret" not in serialized


def test_transcription_is_recorded_once_per_capture_and_priced_only_for_openai(tmp_path) -> None:
    def vexa_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "completed", "segments": [
            {"segment_id": "a", "start": 3, "end": 60, "text": "Hello", "speaker": "A", "completed": True},
            {"segment_id": "b", "start": 60, "end": 123, "text": "Bye", "speaker": "B", "completed": True},
        ]})

    vexa = VexaCaptureAdapter("http://vexa.test", "key", transport=httpx.MockTransport(vexa_handler))
    app = _app(tmp_path, vexa=vexa)
    with TestClient(app) as client:
        profile = client.post("/v1/provider-profiles", json={
            "name": "Whisper cloud", "provider_type": "openai", "execution_location": "cloud", "api_key": "sk-stt",
            "capabilities": [{"capability": "transcription", "model": "gpt-4o-mini-transcribe"}],
        }).json()
        routed, unrouted = (client.post("/v1/meetings", json={
            "meeting_url": f"https://meet.google.com/abc-defg-hi{suffix}", "title": title,
        }).json()["id"] for suffix, title in (("j", "Routed"), ("k", "Default route")))
        repository = app.state.repository
        for index, meeting_id in enumerate((routed, unrouted)):
            meeting = repository.get_meeting(UUID(meeting_id))
            meeting.status = MeetingStatus.COMPLETED
            meeting.vexa_meeting_id = 40 + index
            repository.save_meeting(meeting)
        repository.save_transcription_route(UUID(routed), repository.get_profile(UUID(profile["id"])), "api.openai.com")
        for meeting_id in (routed, routed, unrouted):
            assert client.get(f"/v1/meetings/{meeting_id}/transcript").status_code == 200
    rows = _events(app, kind="transcription")
    assert len(rows) == 2
    priced = next(row for row in rows if row.meeting_id == routed)
    assert (priced.provider, priced.model, priced.unit_type) == ("openai", "gpt-4o-mini-transcribe", "audio_seconds")
    assert priced.units == 120 and priced.estimated_usd == pytest.approx(0.006)
    assert priced.details["measure"] == "transcript_span" and priced.details["profile_name"] == "Whisper cloud"
    default = next(row for row in rows if row.meeting_id == unrouted)
    assert (default.provider, default.model, default.estimated_usd) == ("vexa", "unknown", None)
    summary = app.state.profile_service.usage.summary(LEGACY_ORGANIZATION_ID)
    assert summary.transcription.meetings == 2
    assert summary.transcription.audio_seconds == 240
    assert summary.transcription.unpriced == 1


def test_audio_seconds_fall_back_to_capture_window() -> None:
    start = datetime(2026, 9, 1, tzinfo=UTC)
    assert transcript_audio_seconds([], start, start + timedelta(minutes=2)) == (120.0, "capture_window")
    assert transcript_audio_seconds([], None, None) == (None, "unknown")


def _seed_prep(app, organization_id: UUID = LEGACY_ORGANIZATION_ID) -> str:
    event_id = str(uuid4())
    now = datetime.now(UTC)
    with app.state.database.session_factory.begin() as session:
        session.add(CalendarEventCacheRow(
            id=event_id, organization_id=str(organization_id), user_id=str(LEGACY_ADMIN_USER_ID),
            connection_id="conn-1", provider="googlecalendar", event_id="evt-1", starts_at=now, ends_at=now,
            payload={"title": "Acme discovery"}, synced_at=now))
        session.add(MeetingPrepRow(
            id=str(uuid4()), organization_id=str(organization_id), user_id=str(LEGACY_ADMIN_USER_ID),
            calendar_event_id=event_id, context="", profile_urls=[], report={}, created_at=now))
    return event_id


def test_summary_breaks_down_kinds_models_and_prep_sessions(tmp_path) -> None:
    app = _app(tmp_path)
    ledger = app.state.profile_service.usage
    event_id = _seed_prep(app)
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        ledger.record_event(kind="search", purpose="meeting_prep_research", provider="exa", model="auto",
                            units=10, unit_type="results", estimated_usd=0.007, prep_event_id=event_id)
        ledger.record_event(kind="contents", purpose="meeting_prep_research", provider="exa", model="contents",
                            units=4, unit_type="pages", estimated_usd=0.004, prep_event_id=event_id)
        ledger.record_event(kind="llm", purpose="meeting_prep", provider="openai", model="gpt-6-luna",
                            input_tokens=900, output_tokens=300, estimated_usd=0.00024, prep_event_id=event_id)
        ledger.record_event(kind="llm", purpose="knowledge_answer", provider="openrouter", model="some/model",
                            input_tokens=10, output_tokens=5)
    summary = ledger.summary(LEGACY_ORGANIZATION_ID)
    assert summary.total_requests == 4 and summary.unpriced_requests == 1
    assert {item.name: item.requests for item in summary.by_kind} == {"llm": 2, "search": 1, "contents": 1}
    model = next(item for item in summary.by_model if item.model == "auto")
    assert (model.kind, model.provider, model.units, model.unit_type) == ("search", "exa", 10, "results")
    assert summary.prep.sessions == 1 and summary.prep.events_prepared == 1
    assert summary.prep.briefings_generated == 1 and summary.prep.searches == 1
    assert summary.prep.input_tokens == 900 and summary.prep.output_tokens == 300
    assert summary.prep.estimated_usd == pytest.approx(0.01124)
    future = ledger.summary(LEGACY_ORGANIZATION_ID, since=datetime.now(UTC) + timedelta(hours=1))
    assert future.total_requests == 0 and future.prep.briefings_generated == 0


def test_events_endpoint_filters_pages_labels_and_isolates_tenants(tmp_path) -> None:
    app = _app(tmp_path)
    ledger = app.state.profile_service.usage
    other_org = uuid4()
    now = datetime.now(UTC)
    with app.state.database.session_factory.begin() as session:
        session.add(OrganizationRow(id=str(other_org), slug="other", display_name="Other", contact_email=None,
                                    status="active", created_at=now, updated_at=now))
    with TestClient(app) as client:
        meeting_id = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij", "title": "Quarterly board review",
        }).json()["id"]
        event_id = _seed_prep(app)
        with tenant_scope(LEGACY_ORGANIZATION_ID):
            for index in range(3):
                ledger.record_event(kind="llm", purpose="mom_generation", provider="openai", model="gpt-6-luna",
                                    input_tokens=index, output_tokens=1, meeting_id=meeting_id,
                                    actor_user_id=LEGACY_ADMIN_USER_ID)
            ledger.record_event(kind="search", purpose="meeting_prep_research", provider="exa", model="=HYPERLINK()",
                                prep_event_id=event_id, details={"query_purpose": "news"})
        ledger.record_event(kind="llm", purpose="mom_generation", provider="openai", model="gpt-6-luna",
                            organization_id=other_org)

        first = client.get("/v1/workspace/usage/events", params={"limit": 2})
        assert first.status_code == 200, first.text
        body = first.json()
        assert body["total"] == 4 and len(body["items"]) == 2 and body["next_cursor"]
        second = client.get("/v1/workspace/usage/events", params={"limit": 2, "cursor": body["next_cursor"]}).json()
        assert second["next_cursor"] is None
        ids = [item["id"] for item in body["items"] + second["items"]]
        assert len(set(ids)) == 4

        by_meeting = client.get("/v1/workspace/usage/events", params={"meeting_id": meeting_id}).json()
        assert by_meeting["total"] == 3
        item = by_meeting["items"][0]
        assert item["meeting_title"] == "Quarterly board review"
        assert item["actor_display_name"] == "Local administrator"
        search = client.get("/v1/workspace/usage/events", params={"kind": "search"}).json()["items"][0]
        assert search["prep_event_title"] == "Acme discovery" and search["details"]["query_purpose"] == "news"
        assert client.get("/v1/workspace/usage/events", params={"q": "board"}).json()["total"] == 3
        assert client.get("/v1/workspace/usage/events", params={"provider": "exa"}).json()["total"] == 1
        later = (datetime.now(UTC) + timedelta(minutes=5)).isoformat()
        assert client.get("/v1/workspace/usage/events", params={"since": later}).json()["total"] == 0
        assert client.get("/v1/workspace/usage/events", params={"cursor": "not-a-cursor"}).status_code == 400
        assert client.get("/v1/workspace/usage/events", params={"kind": "DROP TABLE"}).status_code == 422

        summary = client.get("/v1/workspace/usage").json()
        assert summary["total_requests"] == 4 and "by_model" in summary and summary["prep"]["searches"] == 1
        assert {"recent", "by_meeting", "by_purpose", "by_provider"} <= set(summary)

        exported = client.get("/v1/workspace/usage/export.csv", params={"kind": "search"})
        assert exported.status_code == 200
        assert exported.headers["content-type"].startswith("text/csv")
        assert "attachment" in exported.headers["content-disposition"]
        rows = list(csv.DictReader(io.StringIO(exported.text)))
        assert len(rows) == 1 and rows[0]["model"] == "'=HYPERLINK()"
        assert rows[0]["prep_event_title"] == "Acme discovery"


def test_ledger_attributes_rows_to_the_signed_in_request_actor(tmp_path) -> None:
    app = _app(tmp_path)
    ledger = app.state.profile_service.usage

    @app.post("/v1/test-only/usage")
    def write_usage() -> dict:
        ledger.record_event(kind="llm", purpose="probe", provider="test", model="probe")
        return {"ok": True}

    with TestClient(app) as client:
        assert client.post("/v1/test-only/usage").status_code == 200
    assert _events(app, purpose="probe")[0].actor_user_id == str(LEGACY_ADMIN_USER_ID)
    actor_id = uuid4()
    with tenant_scope(LEGACY_ORGANIZATION_ID), usage_request_scope(SimpleNamespace(actor=SimpleNamespace(user_id=actor_id))):
        ledger.record_event(kind="llm", purpose="probe2", provider="test", model="probe")
    assert _events(app, purpose="probe2")[0].actor_user_id == str(actor_id)


def _auth_app(tmp_path, monkeypatch, role: str):
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "owner-password-for-test")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", "owner@example.test")
    app = _app(tmp_path, "auth.db")
    user_id, now = uuid4(), datetime.now(UTC)
    with app.state.database.session_factory.begin() as session:
        session.add(UserRow(id=str(user_id), email=f"{role}@example.test", display_name=role.title(),
                            auth_subject=f"local:{user_id}", status="active", created_at=now, updated_at=now))
        session.flush()
        session.add(OrganizationMembershipRow(organization_id=str(LEGACY_ORGANIZATION_ID), user_id=str(user_id),
                                              role=role, created_at=now))
        session.add(UserCredentialRow(user_id=str(user_id), password_hash=_hash_password("member-password-123"),
                                      must_change_password=False, session_version=1, created_at=now, updated_at=now))
    return app


@pytest.mark.parametrize("role", ["member", "viewer"])
def test_usage_and_storage_endpoints_are_owner_admin_only(tmp_path, monkeypatch, role) -> None:
    app = _auth_app(tmp_path, monkeypatch, role)
    with TestClient(app) as member, TestClient(app) as owner:
        assert member.post("/v1/auth/login", json={"email": f"{role}@example.test",
                                                   "password": "member-password-123"}).status_code == 200
        assert owner.post("/v1/auth/login", json={"email": "owner@example.test",
                                                  "password": "owner-password-for-test"}).status_code == 200
        for path in ("/v1/workspace/usage", "/v1/workspace/usage/events", "/v1/workspace/usage/export.csv",
                     "/v1/workspace/storage", "/v1/workspace/storage/items?category=meetings"):
            assert member.get(path).status_code == 403, path
            assert owner.get(path).status_code == 200, path
        purge = {"category": "logs", "older_than_days": 30, "confirm": "DELETE"}
        assert member.post("/v1/workspace/storage/purge", json=purge).status_code == 403
        assert owner.post("/v1/workspace/storage/purge", json=purge).status_code == 200
