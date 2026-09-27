"""Owner-controlled workspace AI settings and server-enforced Ask AI provider/model."""

from uuid import uuid4

import httpx
from fastapi.testclient import TestClient

from meetings_contracts import TextGenerationResult
from app.main import create_app
from app.model_catalog import ModelCatalogService

from test_credential_vault import OWNER_EMAIL, OWNER_PASSWORD, _invite, _login
from test_knowledge import _create_completed_meeting


def _profile(client, name: str, model: str = "openai/gpt-6-luna", capability: str = "text_generation") -> str:
    response = client.post("/v1/provider-profiles", json={
        "name": name, "provider_type": "openai_compatible", "execution_location": "cloud",
        "base_url": "https://openrouter.ai/api/v1", "api_key": "sk-or-profile-key-1234",
        "capabilities": [{"capability": capability, "model": model}],
    })
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _catalog(*model_ids: str) -> ModelCatalogService:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer sk-or-profile-key-1234"
        return httpx.Response(200, json={"data": [
            {"id": item, "architecture": {"output_modalities": ["text"]}} for item in model_ids
        ]})
    return ModelCatalogService(transport=httpx.MockTransport(respond))


def _capture_generation(app) -> list[dict]:
    calls: list[dict] = []

    async def generated(_request, **options):
        calls.append(options)
        if options.get("on_delta"):
            await options["on_delta"]('{"answer":"Alice owns it.","citation_ids":["K1"]}')
        return object(), TextGenerationResult(
            text='{"answer":"Alice owns it.","citation_ids":["K1"]}', provider="openrouter",
            model=options.get("model_override") or "configured",
        )

    app.state.profile_service.generate_text = generated
    return calls


def test_settings_validation_and_owner_view(tmp_path) -> None:
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'settings.db'}", credential_key="test-credential-key")
    with TestClient(app) as client:
        app.state.ai_settings.model_catalog = _catalog("openai/gpt-6-luna", "anthropic/claude-lite")
        chat_id = _profile(client, "Router chat")
        embed_id = _profile(client, "Embeddings", "openai/text-embedding-3-small", "embeddings")
        exa = client.post("/v1/credentials", json={"label": "Exa", "provider_type": "exa", "secret": "exa-secret-1234"}).json()
        router = client.post("/v1/credentials", json={
            "label": "Router", "provider_type": "openrouter", "secret": "sk-or-vault-key-1234",
        }).json()

        initial = client.get("/v1/ai/settings").json()
        assert initial["can_edit"] is True and initial["chat_profile_id"] is None
        assert initial["effective_chat"]["source"] == "not_configured"

        for invalid in (
            {"chat_profile_id": str(uuid4())},
            {"chat_profile_id": embed_id},
            {"chat_model": "openai/gpt-6-luna"},
            {"chat_profile_id": chat_id, "chat_model": "has space"},
            {"research_credential_id": router["id"]},
            {"research_credential_id": str(uuid4())},
            {"vision_profile_id": embed_id},
        ):
            assert client.put("/v1/ai/settings", json=invalid).status_code == 422, invalid

        # Owners may type a custom or newly released model id the live catalog does not list.
        custom = client.put("/v1/ai/settings", json={"chat_profile_id": chat_id, "chat_model": "vendor/custom-model"})
        assert custom.status_code == 200 and custom.json()["chat_model"] == "vendor/custom-model"

        saved = client.put("/v1/ai/settings", json={
            "chat_profile_id": chat_id, "chat_model": "anthropic/claude-lite",
            "vision_profile_id": chat_id, "research_credential_id": exa["id"],
        })
        assert saved.status_code == 200, saved.text
        body = saved.json()
        assert body["chat_model"] == "anthropic/claude-lite"
        assert body["research_credential_label"] == "Exa"
        assert body["vision_configured"] is True and body["research_configured"] is True
        assert body["effective_chat"] == {
            "profile_id": chat_id, "profile_name": "Router chat", "provider": "openrouter",
            "model": "anthropic/claude-lite", "source": "workspace_settings",
        }
        from app.database import LEGACY_ORGANIZATION_ID
        settings = app.state.ai_settings.get(LEGACY_ORGANIZATION_ID)
        assert str(settings.chat_profile_id) == chat_id and str(settings.research_credential_id) == exa["id"]

        in_use = client.delete(f"/v1/credentials/{exa['id']}")
        assert in_use.status_code == 409
        assert in_use.json()["detail"]["used_by"] == ["workspace AI settings (web research)"]

        # Deleting the chat profile clears the owner's choice instead of leaving a dangling route.
        assert client.delete(f"/v1/provider-profiles/{chat_id}").status_code == 204
        cleared = client.get("/v1/ai/settings").json()
        assert cleared["chat_profile_id"] is None and cleared["vision_profile_id"] is None
        assert cleared["research_credential_id"] == exa["id"]


def test_ask_ai_ignores_client_provider_and_model(tmp_path) -> None:
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'enforce.db'}", credential_key="test-credential-key")
    with TestClient(app) as client:
        app.state.ai_settings.model_catalog = _catalog("openai/gpt-6-luna", "anthropic/claude-lite")
        owner_choice = _profile(client, "Owner choice")
        base_choice = _profile(client, "Base choice")
        client_choice = _profile(client, "Client choice")
        base_id = client.post("/v1/knowledge-bases", json={"name": "Project", "text_profile_id": base_choice}).json()["id"]
        _create_completed_meeting(client, app.state.repository, opted_in=True, title="Roadmap", base_id=base_id)
        calls = _capture_generation(app)
        question = {
            "query": "who owns roadmap?", "knowledge_base_id": base_id,
            "text_profile_id": client_choice, "model_id": "attacker/expensive-model",
        }

        # Without workspace settings, the knowledge base's provider wins over the client.
        assert client.post("/v1/knowledge/chat", json=question).status_code == 200
        assert str(calls[-1]["profile_id"]) == base_choice and "model_override" not in calls[-1]

        assert client.put("/v1/ai/settings", json={
            "chat_profile_id": owner_choice, "chat_model": "anthropic/claude-lite",
        }).status_code == 200
        answered = client.post("/v1/knowledge/chat", json=question)
        assert answered.status_code == 200
        assert answered.json()["model"] == "anthropic/claude-lite"
        assert str(calls[-1]["profile_id"]) == owner_choice
        assert calls[-1]["model_override"] == "anthropic/claude-lite"

        streamed = client.post("/v1/knowledge/chat/stream", json=question)
        assert streamed.status_code == 200 and "event: final" in streamed.text
        assert str(calls[-1]["profile_id"]) == owner_choice
        assert calls[-1]["model_override"] == "anthropic/claude-lite"


def test_non_owners_read_display_only_settings(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER_PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER_EMAIL)
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'roles.db'}", credential_key="test-credential-key")
    with TestClient(app) as client:
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        chat_id = _profile(client, "Router chat")
        assert client.put("/v1/ai/settings", json={"chat_profile_id": chat_id}).status_code == 200
        _invite(client, "admin@example.com", "admin")
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        _invite(client, "member@example.com", "member")

        _login(client, "member@example.com", "member-long-password-123")
        view = client.get("/v1/ai/settings")
        assert view.status_code == 200
        body = view.json()
        assert body["can_edit"] is False and body["chat_profile_id"] is None
        assert body["effective_chat"] == {
            "profile_id": None, "profile_name": "Router chat", "provider": "openrouter",
            "model": "openai/gpt-6-luna", "source": "workspace_settings",
        }
        assert client.put("/v1/ai/settings", json={}).status_code == 403
        assert client.get("/v1/knowledge/text-profiles").status_code == 200  # meeting prep still lists providers
        assert client.get(f"/v1/knowledge/text-profiles/{chat_id}/models").status_code == 403
        client.post("/v1/auth/logout")

        _login(client, "admin@example.com", "admin-long-password-123")
        assert client.get("/v1/ai/settings").json()["can_edit"] is False
        assert client.put("/v1/ai/settings", json={"chat_profile_id": chat_id}).status_code == 403
