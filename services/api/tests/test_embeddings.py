"""Embedding adapters preserve profile routing and reject malformed vectors."""

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from meetings_contracts import (
    Capability, EmbeddingRequest, ExecutionLocation, ProviderProfile, ProviderType,
)

from app.adapters.base import ProviderExecutionError
from app.adapters.openai import OpenAIAdapter
from app.adapters.openai_compatible import OpenAICompatibleAdapter
from app.main import create_app


def _profile(provider_type: ProviderType, base_url: str | None = None) -> ProviderProfile:
    return ProviderProfile(
        name="Embedding route", provider_type=provider_type,
        execution_location=ExecutionLocation.CLOUD if provider_type is ProviderType.OPENAI else ExecutionLocation.LOCAL,
        base_url=base_url, models={Capability.EMBEDDINGS: "embedding-model"},
        api_key="test-embedding-secret" if provider_type is ProviderType.OPENAI else None,
    )


@pytest.mark.parametrize("provider_type", [ProviderType.OPENAI, ProviderType.OPENAI_COMPATIBLE])
def test_embedding_adapters_order_batch_vectors_and_send_profile_model(provider_type: ProviderType) -> None:
    captured = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"data": [
            {"index": 1, "embedding": [0.0, 1.0]},
            {"index": 0, "embedding": [1.0, 0.0]},
        ]})

    profile = _profile(provider_type, "http://localhost:11434/v1")
    adapter = (OpenAIAdapter if provider_type is ProviderType.OPENAI else OpenAICompatibleAdapter)(
        transport=httpx.MockTransport(handler),
    )
    result = asyncio.run(adapter.embed(profile, EmbeddingRequest(inputs=["first", "second"], dimensions=2)))
    assert result.vectors == [[1.0, 0.0], [0.0, 1.0]]
    assert result.dimensions == 2
    assert captured[0].url.path == "/v1/embeddings"
    assert json.loads(captured[0].content) == {
        "model": "embedding-model", "input": ["first", "second"],
        "encoding_format": "float", "dimensions": 2,
    }
    if provider_type is ProviderType.OPENAI:
        assert captured[0].headers["authorization"] == "Bearer test-embedding-secret"
    else:
        assert "authorization" not in captured[0].headers


def test_embedding_adapter_rejects_invalid_vectors_and_redacts_provider_errors() -> None:
    profile = _profile(ProviderType.OPENAI)

    def bad_vector(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b'{"data":[{"index":0,"embedding":[NaN]}]}')

    with pytest.raises(ProviderExecutionError, match="invalid embeddings"):
        asyncio.run(OpenAIAdapter(transport=httpx.MockTransport(bad_vector)).embed(
            profile, EmbeddingRequest(inputs=["private meeting text"]),
        ))

    def provider_error(_: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "private meeting text test-embedding-secret"})

    with pytest.raises(ProviderExecutionError) as error:
        asyncio.run(OpenAIAdapter(transport=httpx.MockTransport(provider_error)).embed(
            profile, EmbeddingRequest(inputs=["private meeting text"]),
        ))
    assert "private meeting text" not in str(error.value)
    assert "test-embedding-secret" not in str(error.value)


def test_embedding_default_falls_back_from_local_to_cloud() -> None:
    app = create_app(credential_key="test-credential-key")
    with TestClient(app) as client:
        local = client.post("/v1/provider-profiles", json={
            "name": "Local embeddings", "provider_type": "openai_compatible",
            "execution_location": "local", "base_url": "http://localhost:11434/v1",
            "capabilities": [{"capability": "embeddings", "model": "local-model"}],
        }).json()
        cloud = client.post("/v1/provider-profiles", json={
            "name": "Cloud embeddings", "provider_type": "openai",
            "execution_location": "cloud", "api_key": "test-cloud-secret",
            "capabilities": [{"capability": "embeddings", "model": "cloud-model"}],
        }).json()
        selected = client.put("/v1/provider-defaults/embeddings", json={
            "policy": "local_then_cloud", "local_profile_id": local["id"],
            "cloud_profile_id": cloud["id"],
        })
        assert selected.status_code == 200

        app.state.profile_service.adapters[ProviderType.OPENAI_COMPATIBLE] = OpenAICompatibleAdapter(
            transport=httpx.MockTransport(lambda _: httpx.Response(503, json={"error": "offline"})),
        )
        app.state.profile_service.adapters[ProviderType.OPENAI] = OpenAIAdapter(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"data": [
                {"index": 0, "embedding": [0.2, 0.8]},
            ]})),
        )
        profile, result = asyncio.run(app.state.profile_service.embed(EmbeddingRequest(inputs=["meeting knowledge"])))
        assert str(profile.id) == cloud["id"]
        assert result.vectors == [[0.2, 0.8]]
