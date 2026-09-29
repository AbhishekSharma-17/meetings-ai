"""Provider credit balances: API, caching, refresh limits, billing keys, permissions and alerts.

Every provider call goes to an ``httpx.MockTransport``; no real provider is ever contacted.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from account_links import accept_invite
from app.database import (
    LEGACY_ORGANIZATION_ID,
    NotificationRow,
    UsageEventRow,
)
from app.exa_client import ExaClient, ExaError, UsageContext
from app.main import create_app
from app.tenant import tenant_scope

OWNER_EMAIL = "developer@genaiprotos.com"
OWNER_PASSWORD = "owner-password-for-test"
ROUTER_SECRET = "sk-or-v1-router-secret-1111"
COMPAT_SECRET = "sk-or-v1-compat-secret-2222"
OPENAI_SECRET = "sk-proj-openai-secret-3333"
EXA_SECRET = "exa-secret-4444"
MGMT_SECRET = "sk-or-v1-management-5555"
ADMIN_SECRET = "sk-admin-openai-6666"
SERVICE_SECRET = "exa-service-secret-7777"
ALL_SECRETS = (ROUTER_SECRET, COMPAT_SECRET, OPENAI_SECRET, EXA_SECRET, MGMT_SECRET, ADMIN_SECRET, SERVICE_SECRET)


class FakeProviders:
    """Answers the fixed provider hosts; tests override per-secret responses."""

    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []
        self.overrides: dict[str, httpx.Response | Exception] = {}
        self.router_remaining = 12.0

    def secret(self, request: httpx.Request) -> str:
        return request.headers.get("x-api-key") or request.headers.get("authorization", "").removeprefix("Bearer ")

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        assert request.url.host in {"openrouter.ai", "api.openai.com", "admin-api.exa.ai"}, request.url
        override = self.overrides.get(self.secret(request))
        if isinstance(override, Exception):
            raise override
        if override is not None:
            return override
        path = request.url.path
        if path == "/api/v1/key":
            return httpx.Response(200, json={"data": {"label": "k", "limit": 20, "limit_remaining": self.router_remaining,
                                                      "usage": 8, "usage_monthly": 8, "is_free_tier": False}})
        if path == "/api/v1/credits":
            return httpx.Response(200, json={"data": {"total_credits": 100, "total_usage": 30}})
        if path == "/v1/models":
            return httpx.Response(200, json={"data": []})
        if path == "/v1/organization/costs":
            return httpx.Response(200, json={"object": "page", "has_more": False, "data": [
                {"results": [{"amount": {"value": 12.4, "currency": "usd"}}]}]})
        if path.endswith("/api-keys"):
            return httpx.Response(200, json={"apiKeys": [{"id": "exa-1", "name": "Exa research", "budgetCents": 5000}]})
        if path.endswith("/usage"):
            return httpx.Response(200, json={"total_cost_usd": 3.5})
        return httpx.Response(404, json={})

    def count(self, path_suffix: str) -> int:
        return sum(1 for request in self.calls if request.url.path.endswith(path_suffix))


def _app(tmp_path, name: str = "balances.db"):
    return create_app(database_url=f"sqlite+pysqlite:///{tmp_path / name}", credential_key="test-credential-key")


def _wire(app, fake: FakeProviders) -> None:
    transport = httpx.MockTransport(fake)
    app.state.provider_balances.transport = transport
    app.state.credential_vault.transport = transport


def _key(client, label: str, provider_type: str, secret: str, base_url: str | None = None) -> dict:
    body = {"label": label, "provider_type": provider_type, "secret": secret}
    if base_url:
        body["base_url"] = base_url
    response = client.post("/v1/credentials", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _by_label(payload: dict) -> dict[str, dict]:
    return {item["label"]: item for item in payload["items"]}


def test_each_provider_is_normalized_and_secrets_never_leave_the_server(tmp_path) -> None:
    app, fake = _app(tmp_path), FakeProviders()
    _wire(app, fake)
    with TestClient(app) as client:
        _key(client, "OpenRouter team", "openrouter", ROUTER_SECRET)
        _key(client, "Router via compatible", "openai_compatible", COMPAT_SECRET, "https://openrouter.ai/api/v1")
        _key(client, "Local model", "openai_compatible", "local-secret-8888", "http://localhost:9000/v1")
        _key(client, "OpenAI production", "openai", OPENAI_SECRET)
        _key(client, "Exa research", "exa", EXA_SECRET)

        before = client.get("/v1/provider-balances")
        assert before.status_code == 200, before.text
        items = _by_label(before.json())
        assert set(items) == {"OpenRouter team", "Router via compatible", "OpenAI production", "Exa research"}
        router = items["OpenRouter team"]
        assert (router["provider"], router["remaining_usd"], router["limit_usd"], router["status"]) == ("openrouter", 12.0, 20.0, "ok")
        assert "Add an OpenRouter management key" in router["note"]
        assert items["Router via compatible"]["provider"] == "openrouter"
        openai = items["OpenAI production"]
        assert openai["status"] == "unknown" and openai["remaining_usd"] is None and openai["source"] == "our_ledger"
        assert openai["dashboard_url"] == "https://platform.openai.com/settings/organization/billing"
        assert items["Exa research"]["source"] == "our_ledger"
        assert fake.count("/costs") == 0 and fake.count("/api-keys") == 0  # nothing without billing keys
        assert [item["configured"] for item in before.json()["billing_keys"]] == [False, False, False]

        _key(client, "Router management", "openrouter_management", MGMT_SECRET)
        _key(client, "OpenAI admin", "openai_admin", ADMIN_SECRET)
        _key(client, "Exa service", "exa_service", SERVICE_SECRET)
        after = client.get("/v1/provider-balances")  # new billing keys invalidate the cache
        items = _by_label(after.json())
        assert items["OpenRouter team"]["balance_usd"] == 70.0 and items["OpenRouter team"]["source"] == "admin_key"
        assert items["OpenAI production"]["spent_usd"] == 12.4 and items["OpenAI production"]["source"] == "admin_key"
        exa = items["Exa research"]
        assert (exa["limit_usd"], exa["spent_usd"], exa["status"]) == (50.0, 3.5, "unknown")
        assert all(item["configured"] for item in after.json()["billing_keys"])
        assert "Router management" not in items  # billing keys are not listed as balances themselves

        for response in (before, after, client.get("/v1/credentials")):
            assert not any(secret in response.text for secret in ALL_SECRETS)
        # A balance check is not "use" of a key.
        assert all(item["last_used_at"] is None for item in client.get("/v1/credentials").json())


def test_cache_manual_refresh_and_per_workspace_rate_limit(tmp_path) -> None:
    app, fake = _app(tmp_path), FakeProviders()
    _wire(app, fake)
    ticks = [0.0]
    app.state.provider_balances._clock = lambda: ticks[0]
    with TestClient(app) as client:
        router = _key(client, "OpenRouter team", "openrouter", ROUTER_SECRET)
        _key(client, "OpenAI production", "openai", OPENAI_SECRET)
        client.get("/v1/provider-balances")
        assert (fake.count("/api/v1/key"), fake.count("/v1/models")) == (1, 1)
        client.get("/v1/provider-balances")
        assert (fake.count("/api/v1/key"), fake.count("/v1/models")) == (1, 1)  # served from cache
        ticks[0] = 601.0
        client.get("/v1/provider-balances")
        assert fake.count("/api/v1/key") == 2  # 10 minute TTL

        one = client.post(f"/v1/provider-balances/refresh?credential_id={router['id']}")
        assert one.status_code == 200
        assert (fake.count("/api/v1/key"), fake.count("/v1/models")) == (3, 2)  # only the chosen key
        for _ in range(5):
            assert client.post("/v1/provider-balances/refresh").status_code == 200
        limited = client.post("/v1/provider-balances/refresh")
        assert limited.status_code == 429 and "try again" in limited.json()["detail"]


def test_provider_errors_become_friendly_states(tmp_path) -> None:
    app, fake = _app(tmp_path), FakeProviders()
    _wire(app, fake)
    fake.overrides[ROUTER_SECRET] = httpx.Response(401, json={"error": {"message": "bad key"}})
    fake.overrides[COMPAT_SECRET] = httpx.Response(402, json={"error": {"message": "no credits"}})
    fake.overrides[OPENAI_SECRET] = httpx.ReadTimeout("slow")
    with TestClient(app) as client:
        _key(client, "Bad router", "openrouter", ROUTER_SECRET)
        _key(client, "Empty router", "openai_compatible", COMPAT_SECRET, "https://openrouter.ai/api/v1")
        _key(client, "Slow OpenAI", "openai", OPENAI_SECRET)
        items = _by_label(client.get("/v1/provider-balances").json())
    assert items["Bad router"]["status"] == "invalid_key" and "Replace it" in items["Bad router"]["note"]
    assert items["Empty router"]["status"] == "exhausted"
    assert items["Slow OpenAI"]["status"] == "error" and "Try again" in items["Slow OpenAI"]["note"]


def test_billing_keys_are_validated_tested_and_never_selectable(tmp_path) -> None:
    app, fake = _app(tmp_path), FakeProviders()
    _wire(app, fake)
    with TestClient(app) as client:
        wrong = client.post("/v1/credentials", json={"label": "Admin", "provider_type": "openai_admin", "secret": OPENAI_SECRET})
        assert wrong.status_code == 422 and "sk-admin-" in wrong.text and OPENAI_SECRET not in wrong.text
        assert client.post("/v1/credentials", json={
            "label": "Mgmt", "provider_type": "openrouter_management", "secret": "not-an-openrouter-key"}).status_code == 422
        assert client.post("/v1/credentials", json={"label": "Mgmt", "provider_type": "openrouter_management",
                                                    "secret": MGMT_SECRET, "base_url": "https://evil.example"}).status_code == 422
        admin = _key(client, "OpenAI admin", "openai_admin", ADMIN_SECRET)
        service = _key(client, "Exa service", "exa_service", SERVICE_SECRET)
        management = _key(client, "Router management", "openrouter_management", MGMT_SECRET)
        assert admin["billing_only"] is True and admin["base_url"] is None

        tested = client.post(f"/v1/credentials/{admin['id']}/test").json()
        assert tested["status"] == "valid" and fake.calls[-1].url.path == "/v1/organization/costs"
        fake.overrides[SERVICE_SECRET] = httpx.Response(401, json={"error": "Unauthorized"})
        assert client.post(f"/v1/credentials/{service['id']}/test").json()["status"] == "invalid"

        profile = {"name": "Chat", "provider_type": "openai_compatible", "execution_location": "cloud",
                   "capabilities": [{"capability": "text_generation", "model": "openai/gpt-6-luna"}]}
        for billing in (admin, management):
            linked = client.post("/v1/provider-profiles", json={**profile, "credential_id": billing["id"]})
            assert linked.status_code == 422 and "billing key" in linked.text
            catalog = client.get("/v1/model-catalog", params={"capability": "text_generation", "credential_id": billing["id"]})
            assert catalog.status_code == 422
        research = client.put("/v1/ai/settings", json={"research_credential_id": service["id"]})
        assert research.status_code == 422
        assert app.state.credential_vault.first_for(LEGACY_ORGANIZATION_ID, "exa") is None
        rotated = client.patch(f"/v1/credentials/{admin['id']}", json={"secret": "sk-proj-not-admin-0000"})
        assert rotated.status_code == 422


def _login(client, email: str, password: str) -> None:
    assert client.post("/v1/auth/login", json={"email": email, "password": password}).status_code == 200


def _invite(client, email: str, role: str) -> None:
    invited = client.post("/v1/workspace/invite", json={"email": email, "display_name": "Team Mate", "role": role})
    assert invited.status_code == 201, invited.text
    client.post("/v1/auth/logout")
    accept_invite(client, invited.json(), f"{role}-long-password-123")
    client.post("/v1/auth/logout")


def test_only_owners_and_admins_see_balances(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER_PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER_EMAIL)
    app, fake = _app(tmp_path, "roles.db"), FakeProviders()
    _wire(app, fake)
    with TestClient(app) as client:
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        _key(client, "OpenRouter team", "openrouter", ROUTER_SECRET)
        _invite(client, "admin@example.com", "admin")
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        _invite(client, "member@example.com", "member")

        _login(client, "admin@example.com", "admin-long-password-123")
        assert client.get("/v1/provider-balances").status_code == 200
        assert client.post("/v1/credentials", json={
            "label": "Admin billing", "provider_type": "openai_admin", "secret": ADMIN_SECRET}).status_code == 403
        client.post("/v1/auth/logout")

        _login(client, "member@example.com", "member-long-password-123")
        assert client.get("/v1/provider-balances").status_code == 403
        assert client.post("/v1/provider-balances/refresh").status_code == 403
        client.post("/v1/auth/logout")

        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        other = client.post("/v1/workspaces", json={"display_name": "Second workspace"})
        assert other.status_code == 201
        assert client.get("/v1/provider-balances").json()["items"] == []  # tenant scoped


def _notifications(app) -> list[NotificationRow]:
    with app.state.database.session_factory() as session:
        return list(session.query(NotificationRow).filter(NotificationRow.kind == "provider_credit").all())


def test_low_balance_alert_is_deduplicated_per_key_per_day(tmp_path) -> None:
    app, fake = _app(tmp_path), FakeProviders()
    _wire(app, fake)
    fake.router_remaining = 4.2
    with TestClient(app) as client:
        _key(client, "OpenRouter team", "openrouter", ROUTER_SECRET)
        status = _by_label(client.get("/v1/provider-balances").json())["OpenRouter team"]
        assert status["status"] == "low"
        client.post("/v1/provider-balances/refresh")
        client.post("/v1/provider-balances/refresh")
        alerts = _notifications(app)
        assert len(alerts) == 1
        assert alerts[0].severity == "warning" and "$4.20 left" in alerts[0].title and alerts[0].link_view == "providers"
        fake.router_remaining = 0.0
        client.post("/v1/provider-balances/refresh")
        alerts = _notifications(app)
        assert len(alerts) == 2 and alerts[-1].severity == "danger" and "out of credit" in alerts[-1].title


def test_real_call_failures_raise_one_out_of_credit_alert(tmp_path) -> None:
    app, fake = _app(tmp_path), FakeProviders()
    _wire(app, fake)
    with TestClient(app) as client:
        key = _key(client, "OpenAI production", "openai", OPENAI_SECRET)
        exa = _key(client, "Exa research", "exa", EXA_SECRET)
        created = client.post("/v1/provider-profiles", json={
            "name": "Minutes", "provider_type": "openai", "execution_location": "cloud", "credential_id": key["id"],
            "capabilities": [{"capability": "text_generation", "model": "gpt-6-luna"}]})
        assert created.status_code == 201, created.text
        balances = app.state.provider_balances
        with tenant_scope(LEGACY_ORGANIZATION_ID):
            profile = app.state.repository.get_profile(UUID(created.json()["id"]))
            quota = RuntimeError('OpenAI request failed (429): {"error": {"code": "insufficient_quota"}}')
            balances.observe_profile_failure(profile, quota, "llm")
            balances.observe_profile_failure(profile, quota, "llm")
            balances.observe_profile_failure(profile, RuntimeError("OpenAI request failed (500)"), "llm")
        alerts = _notifications(app)
        assert len(alerts) == 1 and "“OpenAI production” is out of credit" in alerts[0].title
        status = _by_label(client.get("/v1/provider-balances").json())["OpenAI production"]
        assert status["status"] == "exhausted" and "recent OpenAI call failed" in status["note"]

        def no_credit(request: httpx.Request) -> httpx.Response:
            return httpx.Response(402, json={"error": "insufficient credits"})

        async def research() -> None:
            async with ExaClient(EXA_SECRET, transport=httpx.MockTransport(no_credit), max_retries=0,
                                 usage=UsageContext(organization_id=LEGACY_ORGANIZATION_ID),
                                 on_out_of_credit=balances.report_exa_out_of_credit) as client_:
                await client_.search("acme", purpose="company")

        with pytest.raises(ExaError):
            asyncio.run(research())
        titles = [alert.title for alert in _notifications(app)]
        assert "Exa key “Exa research” is out of credit" in titles
        assert exa["id"]


def test_our_tracked_spend_is_attributed_to_saved_keys(tmp_path) -> None:
    app, fake = _app(tmp_path), FakeProviders()
    _wire(app, fake)
    with TestClient(app) as client:
        openai = _key(client, "OpenAI production", "openai", OPENAI_SECRET)
        exa = _key(client, "Exa research", "exa", EXA_SECRET)
        created = client.post("/v1/provider-profiles", json={
            "name": "Minutes", "provider_type": "openai", "execution_location": "cloud", "credential_id": openai["id"],
            "capabilities": [{"capability": "text_generation", "model": "gpt-6-luna"}]}).json()
        now = datetime.now(UTC)
        rows = [
            ("llm", "openai", 1.25, {"profile_id": created["id"]}, now),
            ("llm", "openai", 0.75, {"profile_id": str(uuid4())}, now),  # a profile with its own key
            ("search", "exa", 0.007, {}, now),  # research resolves to the workspace Exa key
            ("search", "exa", 0.005, {"credential_id": exa["id"]}, now),
            ("llm", "openai", 9.0, {"profile_id": created["id"]}, now.replace(year=now.year - 1)),  # last year
        ]
        with app.state.database.session_factory.begin() as session:
            for kind, provider, amount, details, at in rows:
                session.add(UsageEventRow(id=str(uuid4()), organization_id=str(LEGACY_ORGANIZATION_ID), kind=kind,
                                          purpose="test", provider=provider, model="m", estimated_usd=amount,
                                          status="succeeded", details=details, created_at=at))
        items = _by_label(client.get("/v1/provider-balances").json())
    assert items["OpenAI production"]["our_tracked_spend_usd"] == 1.25
    assert items["OpenAI production"]["spent_usd"] == 1.25  # no admin key: our ledger is the spend shown
    assert items["Exa research"]["our_tracked_spend_usd"] == 0.012
