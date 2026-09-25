"""Catalog, emailed invitation, and measured-usage regression coverage."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from meetings_contracts import Capability, EmbeddingRequest, EmbeddingResult, ExecutionLocation, ProviderProfile, ProviderType, TextGenerationRequest, TextGenerationResult
from app.adapters.resend import ResendAdapter
from app.database import Database, LEGACY_ORGANIZATION_ID
from app.main import create_app
from app.model_catalog import ModelCatalogService
from app.tenant import tenant_scope
from app.usage import UsageLedger


@pytest.mark.asyncio
async def test_catalog_lists_models_without_exposing_credentials() -> None:
    requests = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"data": [
            {"id": "openai/gpt-6-luna", "name": "GPT-6 Luna", "architecture": {"output_modalities": ["text"]}, "pricing": {"prompt": "0.0000001", "completion": "0.0000005"}},
            {"id": "image-only", "architecture": {"output_modalities": ["image"]}},
        ]})

    profile = ProviderProfile(
        name="OpenRouter", provider_type=ProviderType.OPENAI_COMPATIBLE,
        execution_location=ExecutionLocation.CLOUD, base_url="https://openrouter.ai/api/v1",
        models={Capability.TEXT_GENERATION: "openai/gpt-6-luna"}, api_key="test-secret",
    )
    catalog = ModelCatalogService(transport=httpx.MockTransport(respond))
    found = await catalog.list_for(profile)
    assert found.live_catalog
    assert [model.id for model in found.models] == ["openai/gpt-6-luna"]
    assert found.models[0].input_per_million_usd == 0.1
    assert "test-secret" not in found.model_dump_json()
    assert catalog.cached_price(profile, "openai/gpt-6-luna") == (0.1, 0.5)
    await catalog.list_for(profile)
    assert len(requests) == 1


def test_invitation_sends_temporary_password_and_sign_in_link(tmp_path) -> None:
    sent = []

    def respond(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "email_test"})

    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'invite.db'}",
        credential_key="test-credential-key",
        resend_adapter=ResendAdapter("test-key", "Meetings AI <meetings@example.com>", transport=httpx.MockTransport(respond)),
    )
    with TestClient(app) as client:
        response = client.post("/v1/workspace/invite", json={
            "email": "teammate@example.com", "display_name": "Test Teammate", "role": "member",
        })
        assert response.status_code == 201
        body = response.json()
        assert body["email_sent"] is True
        assert body["temporary_password"] is None
        assert len(sent) == 1
        assert "Temporary password:" in sent[0]["text"]
        assert "http://localhost:3020/?invite=teammate%40example.com" in sent[0]["text"]
        assert "Change your temporary password" not in sent[0]["text"]  # exact UI copy is not needed
        assert "new password" in sent[0]["text"]


def test_usage_ledger_records_reported_tokens_and_marks_unknown_price(tmp_path) -> None:
    database = Database(f"sqlite+pysqlite:///{tmp_path / 'usage.db'}")
    database.migrate()
    ledger = UsageLedger(database, ModelCatalogService())
    profile = ProviderProfile(
        name="OpenAI", provider_type=ProviderType.OPENAI,
        execution_location=ExecutionLocation.CLOUD, base_url=None,
        models={Capability.TEXT_GENERATION: "gpt-6-luna"}, api_key="test-secret",
    )
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        ledger.record(profile, TextGenerationRequest(prompt="Summarize", metadata={"purpose": "knowledge_answer"}),
                      TextGenerationResult(text="Summary", provider="openai", model="gpt-6-luna", input_tokens=1000, output_tokens=200))
        ledger.record(profile, TextGenerationRequest(prompt="Summarize"),
                      TextGenerationResult(text="Summary", provider="openai", model="unknown", input_tokens=100, output_tokens=20))
    summary = ledger.summary(LEGACY_ORGANIZATION_ID)
    assert summary.total_requests == 2
    assert summary.input_tokens == 1100
    assert summary.output_tokens == 220
    assert summary.unpriced_requests == 1
    assert summary.estimated_usd == 0.0002
    assert {row.name: row.requests for row in summary.by_purpose} == {"knowledge_answer": 1, "mom_generation": 1}
    assert summary.by_provider[0].name == "openai"
    assert summary.by_provider[0].requests == 2
    assert summary.by_provider[0].unpriced_requests == 1
    database.engine.dispose()


def test_embedding_usage_is_priced_only_when_provider_reports_tokens(tmp_path) -> None:
    database = Database(f"sqlite+pysqlite:///{tmp_path / 'embedding-usage.db'}")
    database.migrate()
    ledger = UsageLedger(database, ModelCatalogService())
    profile = ProviderProfile(
        name="Embeddings", provider_type=ProviderType.OPENAI,
        execution_location=ExecutionLocation.CLOUD, base_url=None,
        models={Capability.EMBEDDINGS: "text-embedding-3-small"}, api_key="test-secret",
    )
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        ledger.record_embedding(profile, EmbeddingRequest(inputs=["meeting notes"], metadata={"purpose": "knowledge_index"}),
                                EmbeddingResult(vectors=[[0.1]], dimensions=1, provider="openai", model="text-embedding-3-small", input_tokens=1000))
    summary = ledger.summary(LEGACY_ORGANIZATION_ID)
    assert summary.total_requests == 1
    assert summary.input_tokens == 1000
    assert summary.estimated_usd == 0.00002
    assert summary.recent[0].purpose == "knowledge_index"
    assert summary.by_purpose[0].estimated_usd == 0.00002
    database.engine.dispose()
