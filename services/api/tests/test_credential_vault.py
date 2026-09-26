"""Workspace key vault: encryption at rest, write-only secrets, tenancy, roles and profile links."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from meetings_contracts import ProviderType, TextGenerationRequest
from app.adapters.openai_compatible import OpenAICompatibleAdapter
from app.credential_vault import EXA_SEARCH_USD_PER_REQUEST, CredentialVault
from app.database import LEGACY_ORGANIZATION_ID, ProviderCredentialRow, ProviderProfileCredentialRow, ProviderProfileRow, UsageEventRow
from app.main import create_app
from app.tenant import tenant_scope

OPENROUTER_SECRET = "sk-or-v1-vault-secret-9f2a"
EXA_SECRET = "exa-live-secret-7c1d"
OWNER_EMAIL = "developer@genaiprotos.com"
OWNER_PASSWORD = "owner-password-for-test"


def _local_app(tmp_path, name: str = "vault.db"):
    return create_app(database_url=f"sqlite+pysqlite:///{tmp_path / name}", credential_key="test-credential-key")


def _create_key(client, **overrides) -> dict:
    body = {"label": "OpenRouter team", "provider_type": "openrouter", "secret": OPENROUTER_SECRET, **overrides}
    response = client.post("/v1/credentials", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _profile_body(**overrides) -> dict:
    return {
        "name": "OpenRouter chat", "provider_type": "openai_compatible", "execution_location": "cloud",
        "capabilities": [{"capability": "text_generation", "model": "openai/gpt-6-luna"}], **overrides,
    }


def test_vault_encrypts_at_rest_and_never_returns_secret(tmp_path) -> None:
    app = _local_app(tmp_path)
    with TestClient(app) as client:
        created = _create_key(client, secret=f"  {OPENROUTER_SECRET}\n")
        assert created["hint"] == "••••9f2a"
        assert created["base_url"] == "https://openrouter.ai/api/v1"
        assert created["used_by_profiles"] == 0
        with app.state.database.session_factory() as session:
            row = session.get(ProviderCredentialRow, created["id"])
            assert row.credential_ciphertext != OPENROUTER_SECRET
            assert OPENROUTER_SECRET not in row.credential_ciphertext
        vault = app.state.credential_vault
        assert vault.resolve_secret(LEGACY_ORGANIZATION_ID, created["id"]) == OPENROUTER_SECRET
        assert vault.get(LEGACY_ORGANIZATION_ID, created["id"]).last_used_at is not None
        first = vault.first_for(LEGACY_ORGANIZATION_ID, "openrouter")
        assert first is not None and str(first[0]) == created["id"] and first[1] == OPENROUTER_SECRET
        assert vault.first_for(LEGACY_ORGANIZATION_ID, "exa") is None

        listed = client.get("/v1/credentials")
        renamed = client.patch(f"/v1/credentials/{created['id']}", json={"label": "Router main"})
        rotated = client.patch(f"/v1/credentials/{created['id']}", json={"secret": "sk-or-v1-rotated-0b3e"})
        for response in (listed, renamed, rotated):
            assert response.status_code == 200
            assert OPENROUTER_SECRET not in response.text and "rotated-0b3e" not in response.text
        assert rotated.json()["hint"] == "••••0b3e"
        assert renamed.json()["label"] == "Router main"
        assert vault.resolve_secret(LEGACY_ORGANIZATION_ID, created["id"]) == "sk-or-v1-rotated-0b3e"

        bad = client.post("/v1/credentials", json={
            "label": "Bad", "provider_type": "openai", "secret": "has inner space",
        })
        assert bad.status_code == 422 and "has inner space" not in bad.text
        assert client.post("/v1/credentials", json={
            "label": "Short", "provider_type": "openai", "secret": "abc",
        }).status_code == 422
        assert client.post("/v1/credentials", json={
            "label": "router main", "provider_type": "openai", "secret": "sk-another-key-1234",
        }).status_code == 422  # duplicate label
        assert client.post("/v1/credentials", json={
            "label": "Evil router", "provider_type": "openrouter", "secret": "sk-or-another-1234",
            "base_url": "https://evil.example.com/v1",
        }).status_code == 422
        assert client.post("/v1/credentials", json={
            "label": "Local", "provider_type": "openai_compatible", "secret": "local-key-1234",
        }).status_code == 422  # base_url required
        assert client.post("/v1/credentials", json={
            "label": "Anthropic", "provider_type": "anthropic", "secret": "sk-ant-12345678",
        }).status_code == 422


def test_profile_links_vault_key_and_uses_it_for_generation(tmp_path) -> None:
    app = _local_app(tmp_path)
    seen: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["Authorization"])
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "hello"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2},
        })

    with TestClient(app) as client:
        key = _create_key(client)
        profile = client.post("/v1/provider-profiles", json=_profile_body(credential_id=key["id"]))
        assert profile.status_code == 201, profile.text
        body = profile.json()
        assert body["credential_id"] == key["id"]
        assert body["credential_label"] == "OpenRouter team"
        assert body["credential_configured"] is True
        assert body["credential_hint"] == "••••9f2a"
        assert body["base_url"] == "https://openrouter.ai/api/v1"
        assert OPENROUTER_SECRET not in profile.text
        with app.state.database.session_factory() as session:
            assert session.get(ProviderProfileRow, body["id"]).credential_ciphertext is None
            assert session.get(ProviderProfileCredentialRow, body["id"]).credential_id == key["id"]
        assert client.get("/v1/credentials").json()[0]["used_by_profiles"] == 1

        service = app.state.profile_service
        service.adapters[ProviderType.OPENAI_COMPATIBLE] = OpenAICompatibleAdapter(transport=httpx.MockTransport(respond))
        import asyncio

        async def generate() -> None:
            await service.generate_text(TextGenerationRequest(prompt="hi"), profile_id=body["id"])

        asyncio.run(generate())
        client.patch(f"/v1/credentials/{key['id']}", json={"secret": "sk-or-v1-rotated-0b3e"})
        asyncio.run(generate())
        assert seen == [f"Bearer {OPENROUTER_SECRET}", "Bearer sk-or-v1-rotated-0b3e"]

        # A saved key cannot be pointed at another host by editing the profile.
        moved = client.patch(f"/v1/provider-profiles/{body['id']}", json={"base_url": "https://evil.example.com/v1"})
        assert moved.status_code == 422
        exa = _create_key(client, label="Exa", provider_type="exa", secret=EXA_SECRET)
        assert client.post("/v1/provider-profiles", json=_profile_body(credential_id=exa["id"])).status_code == 422
        assert client.post("/v1/provider-profiles", json=_profile_body(
            provider_type="openai", credential_id=key["id"],
        )).status_code == 422
        assert client.post("/v1/provider-profiles", json=_profile_body(
            credential_id=key["id"], api_key="sk-both-at-once",
        )).status_code == 422

        # Deleting a linked key is refused and lists what uses it.
        conflict = client.delete(f"/v1/credentials/{key['id']}")
        assert conflict.status_code == 409
        assert conflict.json()["detail"]["used_by"] == ["provider profile 'OpenRouter chat'"]

        # Unlinking must not copy the vault secret onto the profile.
        unlinked = client.patch(f"/v1/provider-profiles/{body['id']}", json={"credential_id": None})
        assert unlinked.status_code == 200
        assert unlinked.json()["credential_configured"] is False
        assert unlinked.json()["credential_id"] is None
        relinked = client.patch(f"/v1/provider-profiles/{body['id']}", json={"credential_id": key["id"]})
        assert relinked.json()["credential_id"] == key["id"]
        assert client.delete(f"/v1/provider-profiles/{body['id']}").status_code == 204
        with app.state.database.session_factory() as session:
            assert session.execute(select(ProviderProfileCredentialRow)).first() is None
        assert client.delete(f"/v1/credentials/{key['id']}").status_code == 204


def test_pasted_key_can_be_saved_to_vault_once(tmp_path) -> None:
    app = _local_app(tmp_path)
    with TestClient(app) as client:
        created = client.post("/v1/provider-profiles", json=_profile_body(
            base_url="https://openrouter.ai/api/v1", api_key=OPENROUTER_SECRET,
            save_to_vault=True, credential_label="Shared router",
        ))
        assert created.status_code == 201, created.text
        assert created.json()["credential_label"] == "Shared router"
        keys = client.get("/v1/credentials").json()
        assert [(item["label"], item["provider_type"], item["used_by_profiles"]) for item in keys] == [
            ("Shared router", "openrouter", 1),
        ]
        second = client.post("/v1/provider-profiles", json=_profile_body(
            name="Second profile", credential_id=keys[0]["id"],
        ))
        assert second.status_code == 201
        assert client.get("/v1/credentials").json()[0]["used_by_profiles"] == 2
        assert client.post("/v1/provider-profiles", json=_profile_body(
            base_url="https://openrouter.ai/api/v1", save_to_vault=True,
        )).status_code == 422


@pytest.mark.asyncio
async def test_live_key_checks_and_exa_usage_is_recorded(tmp_path) -> None:
    from app.database import Database
    from app.model_catalog import ModelCatalogService
    from app.security import CredentialCipher
    from app.usage import UsageLedger
    from app.credential_vault import CredentialCreate

    calls: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.host == "api.exa.ai":
            assert json.loads(request.content)["numResults"] == 1
            return httpx.Response(200, json={"results": [], "costDollars": {"total": 0.005}})
        if request.url.path == "/api/v1/key":
            return httpx.Response(401, json={"error": "invalid"})
        return httpx.Response(200, json={"data": []})

    database = Database(f"sqlite+pysqlite:///{tmp_path / 'live.db'}")
    database.migrate()
    vault = CredentialVault(database, CredentialCipher("k"), UsageLedger(database, ModelCatalogService()),
                            transport=httpx.MockTransport(respond))
    org = LEGACY_ORGANIZATION_ID
    exa = vault.create(org, CredentialCreate(label="Exa", provider_type="exa", secret=EXA_SECRET))
    router = vault.create(org, CredentialCreate(label="Router", provider_type="openrouter", secret=OPENROUTER_SECRET))
    openai = vault.create(org, CredentialCreate(label="OpenAI", provider_type="openai", secret="sk-openai-key-5555"))
    local = vault.create(org, CredentialCreate(label="Local", provider_type="openai_compatible",
                                               secret="local-key-1234", base_url="http://localhost:8000/v1/"))
    assert local.base_url == "http://localhost:8000/v1"
    assert (await vault.test(org, exa.id)).status == "valid"
    assert (await vault.test(org, router.id)).status == "invalid"
    assert (await vault.test(org, openai.id)).status == "valid"
    unverified = await vault.test(org, local.id)
    assert unverified.status == "unverified" and unverified.network_call_performed is False
    assert calls[0].headers["x-api-key"] == EXA_SECRET
    assert calls[2].url == httpx.URL("https://api.openai.com/v1/models")
    with database.session_factory() as session:
        events = session.execute(select(UsageEventRow)).scalars().all()
    assert [(item.kind, item.provider, item.estimated_usd, item.price_source) for item in events] == [
        ("search", "exa", 0.005, "exa_reported_cost"),
    ]
    assert EXA_SEARCH_USD_PER_REQUEST == 0.007
    database.engine.dispose()


def _login(client, email: str, password: str) -> None:
    assert client.post("/v1/auth/login", json={"email": email, "password": password}).status_code == 200


def _invite(client, email: str, role: str) -> None:
    invited = client.post("/v1/workspace/invite", json={"email": email, "display_name": "Team Mate", "role": role})
    assert invited.status_code == 201, invited.text
    temporary = invited.json()["temporary_password"]
    client.post("/v1/auth/logout")
    _login(client, email, temporary)
    assert client.post("/v1/auth/change-password", json={
        "current_password": temporary, "new_password": f"{role}-long-password-123",
    }).status_code == 200
    client.post("/v1/auth/logout")


def test_owner_only_secret_writes_and_tenant_isolation(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER_PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER_EMAIL)
    app = _local_app(tmp_path, "roles.db")
    with TestClient(app) as client:
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        key = _create_key(client)
        _invite(client, "admin@example.com", "admin")
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        _invite(client, "member@example.com", "member")

        _login(client, "admin@example.com", "admin-long-password-123")
        assert [item["id"] for item in client.get("/v1/credentials").json()] == [key["id"]]
        assert client.post("/v1/credentials", json={
            "label": "Admin key", "provider_type": "openai", "secret": "sk-admin-key-1234",
        }).status_code == 403
        assert client.patch(f"/v1/credentials/{key['id']}", json={"label": "x"}).status_code == 403
        assert client.delete(f"/v1/credentials/{key['id']}").status_code == 403
        assert client.post(f"/v1/credentials/{key['id']}/test").status_code == 403
        # Admins manage profiles with their own pasted keys; saved keys are the owner's spend.
        linked = client.post("/v1/provider-profiles", json=_profile_body(credential_id=key["id"]))
        assert linked.status_code == 403
        assert client.post("/v1/provider-profiles", json=_profile_body(
            name="Admin paste", base_url="https://openrouter.ai/api/v1", api_key="sk-or-admin-1234",
            save_to_vault=True,
        )).status_code == 403
        client.post("/v1/auth/logout")

        _login(client, "member@example.com", "member-long-password-123")
        assert client.get("/v1/credentials").status_code == 403
        assert client.post("/v1/credentials", json={
            "label": "Member key", "provider_type": "openai", "secret": "sk-member-key-1234",
        }).status_code == 403
        client.post("/v1/auth/logout")

        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        other = client.post("/v1/workspaces", json={"display_name": "Second workspace"})
        assert other.status_code == 201
        assert client.get("/v1/credentials").json() == []
        assert client.patch(f"/v1/credentials/{key['id']}", json={"label": "stolen"}).status_code == 404
        assert client.delete(f"/v1/credentials/{key['id']}").status_code == 404
        assert client.post(f"/v1/credentials/{key['id']}/test").status_code == 404
        assert client.post("/v1/provider-profiles", json=_profile_body(credential_id=key["id"])).status_code == 422
        vault = app.state.credential_vault
        from uuid import UUID
        with pytest.raises(LookupError):
            vault.resolve_secret(UUID(other.json()["organization_id"]), key["id"])
        with tenant_scope(UUID(other.json()["organization_id"])):
            assert app.state.repository.list_profiles() == []
