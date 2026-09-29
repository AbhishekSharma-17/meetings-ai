"""Apollo through Composio: request shapes, connect/test/replace/disconnect, roles, secrecy, credits, v29."""

import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text

from account_links import accept_invite
from app.apollo_composio import ApolloComposio, ApolloError, classify_tool_error, workspace_user_id
from app.apollo_parsing import parse_credit_stats
from app.database import LEGACY_ORGANIZATION_ID, Database, SchemaVersionRow, UsageEventRow, WorkspaceIntegrationRow
from app.main import create_app

OWNER_EMAIL = "developer@genaiprotos.com"
OWNER_PASSWORD = "owner-password-for-test"
APOLLO_KEY = "apollo-secret-key-9876"
NEW_KEY = "apollo-new-secret-5432"
COMPOSIO_KEY = "composio-project-key"
CREDITS = {"balances": {
    "email": {"used": 40, "limit": 100},
    "export": {"used": 95, "limit": 100},
    "mobile": {"used": 0, "limit": 20},
    "dialer": {"used": 10, "limit": 60},
}}


class FakeComposio:
    """Records every Composio request; answers like the v3.1 API (never contacts the network)."""

    def __init__(self, *, reject_keys: frozenset[str] = frozenset(), existing_config: bool = False,
                 credits: dict | None = None) -> None:
        self.calls: list[tuple[str, str, dict, dict]] = []
        self.reject_keys = reject_keys
        self.existing_config = existing_config
        self.credits = credits if credits is not None else CREDITS
        self.accounts: dict[str, dict] = {}
        self.deleted: list[str] = []
        self.tool_results: dict[str, object] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        self.calls.append((request.method, request.url.path, body, dict(request.url.params)))
        assert request.headers["x-api-key"] == COMPOSIO_KEY
        path = request.url.path.removeprefix("/api/v3.1")
        if path == "/auth_configs" and request.method == "GET":
            items = [{"id": "ac_existing", "name": "Meetings AI Apollo", "toolkit": {"slug": "apollo"},
                      "status": "ENABLED"}] if self.existing_config else []
            return httpx.Response(200, json={"items": items})
        if path == "/auth_configs" and request.method == "POST":
            return httpx.Response(201, json={"toolkit": {"slug": "apollo"}, "auth_config": {"id": "ac_created"}})
        if path == "/connected_accounts" and request.method == "POST":
            account_id = f"ca_{len(self.accounts) + 1}"
            key = body["connection"]["state"]["val"]["api_key"]
            self.accounts[account_id] = {"id": account_id, "user_id": body["connection"]["user_id"], "key": key}
            return httpx.Response(201, json={"id": account_id, "status": "ACTIVE"})
        if path.startswith("/connected_accounts/"):
            account_id = path.rsplit("/", 1)[1]
            account = self.accounts.get(account_id)
            if account is None:
                return httpx.Response(404, json={"error": "not found"})
            if request.method == "GET":
                return httpx.Response(200, json={"id": account_id, "user_id": account["user_id"]})
            self.deleted.append(account_id)
            self.accounts.pop(account_id)
            return httpx.Response(200, json={"success": True})
        if path.startswith("/tools/execute/"):
            tool = path.rsplit("/", 1)[1]
            account = self.accounts.get(body["connected_account_id"])
            if account is None or account["key"] in self.reject_keys:
                return httpx.Response(200, json={"successful": False, "data": {},
                                                 "error": f"401 Unauthorized: invalid api key {account and account['key']}"})
            if tool == "APOLLO_VIEW_CREDIT_USAGE_STATS":
                return httpx.Response(200, json={"successful": True, "data": self.credits})
            result = self.tool_results.get(tool, {})
            if isinstance(result, httpx.Response):
                return result
            return httpx.Response(200, json={"successful": True, "data": result})
        return httpx.Response(404, json={})

    def paths(self, method: str | None = None) -> list[str]:
        return [path.removeprefix("/api/v3.1") for verb, path, _, _ in self.calls if method in {None, verb}]


def _app(tmp_path, fake: FakeComposio, name: str = "apollo.db", environ: dict | None = None):
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / name}", credential_key="test-credential-key")
    app.state.apollo.client = ApolloComposio(COMPOSIO_KEY, transport=httpx.MockTransport(fake), environ=environ or {})
    return app


def _all_text(app) -> str:
    """Every row of every table, for "the key is never stored" checks."""
    chunks = []
    with app.state.database.engine.connect() as connection:
        for table in app.state.database.engine.dialect.get_table_names(connection):
            chunks.extend(str(row) for row in connection.execute(text(f"SELECT * FROM {table}")))
    return "\n".join(chunks)


# ----- Composio request shapes ---------------------------------------------------------------
@pytest.mark.asyncio
async def test_connect_creates_auth_config_once_then_api_key_connected_account() -> None:
    fake = FakeComposio()
    client = ApolloComposio(COMPOSIO_KEY, transport=httpx.MockTransport(fake), environ={})
    account = await client.connect(LEGACY_ORGANIZATION_ID, APOLLO_KEY)
    assert account == "ca_1"
    method, path, body, params = fake.calls[0]
    assert (method, path) == ("GET", "/api/v3.1/auth_configs")
    assert params["toolkit_slug"] == "apollo" and params["search"] == "Meetings AI Apollo"
    assert fake.calls[1][:3] == ("POST", "/api/v3.1/auth_configs", {
        "toolkit": {"slug": "apollo"},
        "auth_config": {"type": "use_custom_auth", "authScheme": "API_KEY", "name": "Meetings AI Apollo",
                        "credentials": {}},
    })
    assert fake.calls[2][:3] == ("POST", "/api/v3.1/connected_accounts", {
        "auth_config": {"id": "ac_created"},
        "connection": {"user_id": f"meetings-ai:org:{LEGACY_ORGANIZATION_ID}", "alias": "Meetings AI workspace Apollo",
                       "state": {"authScheme": "API_KEY", "val": {"status": "ACTIVE", "api_key": APOLLO_KEY}}},
    })
    await client.connect(LEGACY_ORGANIZATION_ID, NEW_KEY)
    assert fake.paths("POST").count("/auth_configs") == 1  # created once, then reused


@pytest.mark.asyncio
async def test_env_auth_config_and_version_are_used_and_existing_config_is_reused() -> None:
    fake = FakeComposio()
    client = ApolloComposio(COMPOSIO_KEY, transport=httpx.MockTransport(fake),
                            environ={"COMPOSIO_APOLLO_AUTH_CONFIG_ID": "ac_env", "COMPOSIO_APOLLO_VERSION": "20270101_00"})
    await client.connect("org-1", APOLLO_KEY)
    assert fake.paths() == ["/connected_accounts"]
    assert fake.calls[0][2]["auth_config"] == {"id": "ac_env"}
    fake.tool_results["APOLLO_ORGANIZATION_ENRICHMENT"] = {"organization": {"name": "Acme"}}
    await client.execute("org-1", "ca_1", "APOLLO_ORGANIZATION_ENRICHMENT", {"domain": "acme.example"})
    execute = fake.calls[-1]
    assert execute[1] == "/api/v3.1/tools/execute/APOLLO_ORGANIZATION_ENRICHMENT"
    assert execute[2] == {"user_id": "meetings-ai:org:org-1", "connected_account_id": "ca_1",
                          "version": "20270101_00", "arguments": {"domain": "acme.example"}}
    existing = FakeComposio(existing_config=True)
    reused = ApolloComposio(COMPOSIO_KEY, transport=httpx.MockTransport(existing), environ={})
    assert await reused.auth_config_id() == "ac_existing"
    assert "POST" not in {verb for verb, *_ in existing.calls}


def test_tool_errors_are_classified_without_provider_text() -> None:
    assert classify_tool_error("HTTP 401 Unauthorized") == "invalid_key"
    assert classify_tool_error("402 Payment Required: insufficient credits") == "out_of_credit"
    assert classify_tool_error("429 Too Many Requests") == "rate_limited"
    assert classify_tool_error("403 Forbidden - requires a paid plan") == "plan"
    assert classify_tool_error("something odd") == "error"
    assert str(ApolloError("invalid_key")) == "Apollo rejected the API key"
    assert workspace_user_id("abc") == "meetings-ai:org:abc"


def test_credit_stats_parse_whatever_keys_come_back() -> None:
    lines = {line.credit_type: line for line in parse_credit_stats(CREDITS)}
    assert lines["export"].remaining == 5 and lines["export"].label == "Export credits"
    assert lines["dialer"].unit == "minutes" and lines["dialer"].label == "Dialer minutes"
    listed = parse_credit_stats({"data": [{"credit_type": "email_credits", "balance": 30, "limit": 50},
                                          {"type": "ai", "used": 1}]})
    assert [(line.credit_type, line.used, line.remaining) for line in listed] == [("email_credits", 20, 30), ("ai", 1, None)]
    assert parse_credit_stats({"team_id": 7, "unexpected": "shape"}) == []


# ----- HTTP routes -----------------------------------------------------------------------------
def test_connect_test_replace_disconnect_and_key_never_persisted_or_logged(tmp_path, caplog) -> None:
    caplog.set_level(logging.DEBUG)
    fake = FakeComposio()
    app = _app(tmp_path, fake)
    with TestClient(app) as client:
        assert client.get("/v1/workspace/integrations/apollo").json()["connected"] is False
        saved = client.put("/v1/workspace/integrations/apollo", json={"api_key": APOLLO_KEY})
        assert saved.status_code == 200, saved.text
        view = saved.json()
        assert view["connected"] and view["status"] == "active" and view["hint"] == "••••9876"
        assert {line["credit_type"] for line in view["credits"]} == {"email", "export", "mobile", "dialer"}
        assert APOLLO_KEY not in saved.text
        assert client.get("/v1/workspace/integrations/apollo").json()["hint"] == "••••9876"

        tested = client.post("/v1/workspace/integrations/apollo/test")
        assert tested.status_code == 200 and tested.json()["credits"]

        replaced = client.put("/v1/workspace/integrations/apollo", json={"api_key": NEW_KEY})
        assert replaced.status_code == 200 and replaced.json()["hint"] == "••••5432"
        assert fake.deleted == ["ca_1"]  # the replaced connection is removed from Composio

        with app.state.database.session_factory() as session:
            row = session.execute(select(WorkspaceIntegrationRow)).scalar_one()
            assert row.connected_account_id == "ca_2" and row.provider == "apollo"
        with app.state.database.session_factory() as session:
            ledger = session.execute(select(UsageEventRow).where(UsageEventRow.kind == "apollo")).scalars().all()
        assert {event.purpose for event in ledger} == {"apollo_connection_test"}
        assert all(event.provider == "apollo" and event.estimated_usd is None and event.unit_type == "records"
                   and event.model == "apollo_view_credit_usage_stats" for event in ledger)

        stored = _all_text(app)
        assert APOLLO_KEY not in stored and NEW_KEY not in stored

        assert client.delete("/v1/workspace/integrations/apollo").status_code == 204
        assert fake.deleted == ["ca_1", "ca_2"]
        assert client.get("/v1/workspace/integrations/apollo").json()["connected"] is False
    assert APOLLO_KEY not in caplog.text and NEW_KEY not in caplog.text


def test_bad_key_is_rejected_plainly_and_nothing_is_stored(tmp_path, caplog) -> None:
    caplog.set_level(logging.DEBUG)
    fake = FakeComposio(reject_keys=frozenset({APOLLO_KEY}))
    app = _app(tmp_path, fake, "bad-key.db")
    with TestClient(app) as client:
        response = client.put("/v1/workspace/integrations/apollo", json={"api_key": APOLLO_KEY})
        assert response.status_code == 400
        assert "Apollo rejected this API key" in response.json()["detail"]
        assert APOLLO_KEY not in response.text
        assert client.get("/v1/workspace/integrations/apollo").json()["connected"] is False
        assert fake.deleted == ["ca_1"]  # the rejected connected account is cleaned up in Composio
        short = client.put("/v1/workspace/integrations/apollo", json={"api_key": "short"})
        assert short.status_code == 400 and "short" not in short.text
    assert APOLLO_KEY not in _all_text(app)
    assert APOLLO_KEY not in caplog.text


def test_unconfigured_composio_explains_instead_of_calling(tmp_path) -> None:
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'unconfigured.db'}", credential_key="k" * 20)
    app.state.apollo.client = ApolloComposio("", environ={})
    with TestClient(app) as client:
        assert client.get("/v1/workspace/integrations/apollo").json()["available"] is False
        response = client.put("/v1/workspace/integrations/apollo", json={"api_key": APOLLO_KEY})
        assert response.status_code == 409 and "Composio is not configured" in response.json()["detail"]


def _login(client, email: str, password: str) -> None:
    assert client.post("/v1/auth/login", json={"email": email, "password": password}).status_code == 200


def _invite(client, email: str, role: str) -> None:
    invited = client.post("/v1/workspace/invite", json={"email": email, "display_name": "Team Mate", "role": role})
    assert invited.status_code == 201, invited.text
    client.post("/v1/auth/logout")
    accept_invite(client, invited.json(), f"{role}-long-password-123")
    client.post("/v1/auth/logout")


def test_only_owners_and_admins_manage_apollo_and_it_is_workspace_scoped(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER_PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER_EMAIL)
    fake = FakeComposio()
    app = _app(tmp_path, fake, "roles.db")
    with TestClient(app) as client:
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        _invite(client, "admin@example.com", "admin")
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        _invite(client, "member@example.com", "member")

        _login(client, "admin@example.com", "admin-long-password-123")
        assert client.put("/v1/workspace/integrations/apollo", json={"api_key": APOLLO_KEY}).status_code == 200
        client.post("/v1/auth/logout")

        _login(client, "member@example.com", "member-long-password-123")
        for method, path in (("GET", ""), ("PUT", ""), ("DELETE", ""), ("POST", "/test")):
            response = client.request(method, f"/v1/workspace/integrations/apollo{path}",
                                      json={"api_key": NEW_KEY} if method == "PUT" else None)
            assert response.status_code == 403, (method, path)
        client.post("/v1/auth/logout")

        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        other = client.post("/v1/workspaces", json={"display_name": "Second workspace"})
        assert other.status_code == 201
        assert client.get("/v1/workspace/integrations/apollo").json()["connected"] is False  # tenant scoped


# ----- provider credits ------------------------------------------------------------------------
def test_apollo_credits_row_in_provider_balances(tmp_path) -> None:
    fake = FakeComposio()
    app = _app(tmp_path, fake, "credits.db")
    with TestClient(app) as client:
        assert client.put("/v1/workspace/integrations/apollo", json={"api_key": APOLLO_KEY}).status_code == 200
        overview = client.get("/v1/provider-balances").json()
        apollo = next(item for item in overview["items"] if item["provider"] == "apollo")
        assert apollo["status"] == "low"  # export credits: 5 of 100 left (<= 10%)
        assert apollo["hint"] == "••••9876" and apollo["label"] == "Apollo (workspace)"
        assert {line["credit_type"] for line in apollo["credits"]} == {"email", "export", "mobile", "dialer"}
        calls = fake.paths().count("/tools/execute/APOLLO_VIEW_CREDIT_USAGE_STATS")
        client.get("/v1/provider-balances")
        assert fake.paths().count("/tools/execute/APOLLO_VIEW_CREDIT_USAGE_STATS") == calls  # 10-minute cache
        client.post("/v1/provider-balances/refresh")
        assert fake.paths().count("/tools/execute/APOLLO_VIEW_CREDIT_USAGE_STATS") == calls + 1
        fake.credits = {"balances": {"email": {"used": 100, "limit": 100}}}
        refreshed = client.post("/v1/provider-balances/refresh").json()
        assert next(item for item in refreshed["items"] if item["provider"] == "apollo")["status"] == "exhausted"
        notes = client.get("/v1/notifications").json()
        titles = [item["title"] for item in (notes["items"] if isinstance(notes, dict) else notes)]
        assert "Apollo is out of credits" in titles


# ----- schema ----------------------------------------------------------------------------------
def test_v28_database_upgrades_to_v29_with_apollo_tables(tmp_path) -> None:
    url = f"sqlite+pysqlite:///{tmp_path / 'upgrade.db'}"
    database = Database(url)
    database.migrate()
    with database.engine.begin() as connection:
        connection.execute(text("DROP TABLE workspace_integrations"))
        connection.execute(text("DROP TABLE apollo_cache"))
        # Back to a real v28 database: later versions' tables go too (v30: in-person recording).
        connection.execute(text("DROP TABLE in_person_chunks"))
        connection.execute(text("DROP TABLE in_person_sessions"))
        connection.execute(text("DELETE FROM schema_version WHERE version >= 29"))
    database.engine.dispose()
    upgraded = Database(url)
    upgraded.migrate()
    with upgraded.session_factory() as session:
        # Later versions (v30+) are applied on top in the same upgrade.
        assert max(session.execute(select(SchemaVersionRow.version)).scalars().all()) == Database.SCHEMA_VERSION >= 29
    with upgraded.engine.connect() as connection:
        names = set(upgraded.engine.dialect.get_table_names(connection))
    assert {"workspace_integrations", "apollo_cache"} <= names
    upgraded.engine.dispose()
