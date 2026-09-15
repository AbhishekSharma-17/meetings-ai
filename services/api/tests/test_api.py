import asyncio
import json

import httpx
from fastapi.testclient import TestClient
from meetings_contracts import (
    Capability,
    ExecutionLocation,
    ProviderProfile,
    ProviderType,
    TextGenerationRequest,
)

from app.adapters.openai import OpenAIAdapter
from app.adapters.openai_compatible import OpenAICompatibleAdapter
from app.main import create_app


def make_client() -> TestClient:
    return TestClient(create_app())


def local_profile_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": "Local models",
        "provider_type": "openai_compatible",
        "execution_location": "local",
        "base_url": "http://localhost:11434/v1",
        "capabilities": [
            {"capability": "text_generation", "model": "qwen-local"},
            {"capability": "embeddings", "model": "nomic-embed-text"},
        ],
    }
    payload.update(overrides)
    return payload


def cloud_profile_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": "Cloud models",
        "provider_type": "openai",
        "execution_location": "cloud",
        "api_key": "test-secret-never-return",
        "capabilities": [
            {"capability": "text_generation", "model": "configured-text-model"},
            {"capability": "transcription", "model": "configured-stt-model"},
        ],
    }
    payload.update(overrides)
    return payload


def vexa_profile_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": "Vexa local transcription",
        "provider_type": "vexa_native",
        "execution_location": "local",
        "base_url": "http://localhost:8083/v1/audio/transcriptions",
        "capabilities": [
            {"capability": "transcription", "model": "whisper-1"},
        ],
    }
    payload.update(overrides)
    return payload


def test_health() -> None:
    response = make_client().get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "meetings-ai-api"}


def test_create_list_update_and_test_profile_without_leaking_secret() -> None:
    client = make_client()
    secret = "test-secret-never-return"

    created = client.post("/v1/provider-profiles", json=cloud_profile_payload())
    assert created.status_code == 201
    profile_id = created.json()["id"]
    assert created.json()["credential_configured"] is True
    assert "api_key" not in created.json()
    assert secret not in created.text

    listed = client.get("/v1/provider-profiles")
    assert listed.status_code == 200
    assert listed.json()[0]["id"] == profile_id
    assert secret not in listed.text
    assert "api_key" not in listed.text

    # Omitting api_key retains it; explicitly sending null clears it.
    renamed = client.patch(
        f"/v1/provider-profiles/{profile_id}", json={"name": "Renamed cloud"}
    )
    assert renamed.status_code == 200
    assert renamed.json()["credential_configured"] is True
    cleared = client.patch(
        f"/v1/provider-profiles/{profile_id}", json={"api_key": None}
    )
    assert cleared.status_code == 200
    assert cleared.json()["credential_configured"] is False

    test_result = client.post(f"/v1/provider-profiles/{profile_id}/test")
    assert test_result.status_code == 200
    assert test_result.json()["status"] == "configuration_invalid"
    assert test_result.json()["network_call_performed"] is False


def test_validation_enforces_provider_and_capability_rules_and_redacts_input() -> None:
    client = make_client()
    secret = "must-not-appear-in-validation-response"
    invalid = cloud_profile_payload(
        execution_location="local",
        api_key=secret,
        capabilities=[
            {"capability": "text_generation", "model": "one"},
            {"capability": "text_generation", "model": "two"},
        ],
    )

    response = client.post("/v1/provider-profiles", json=invalid)

    assert response.status_code == 422
    assert secret not in response.text
    assert "api_key" in response.text
    assert "[REDACTED]" in response.text


def test_openai_compatible_profile_requires_base_url() -> None:
    response = make_client().post(
        "/v1/provider-profiles", json=local_profile_payload(base_url=None)
    )

    assert response.status_code == 422
    assert "base_url is required" in response.text


def test_vexa_native_profile_is_transcription_only_and_write_only() -> None:
    client = make_client()
    created = client.post("/v1/provider-profiles", json=vexa_profile_payload())
    assert created.status_code == 201
    assert created.json()["provider_type"] == "vexa_native"
    assert created.json()["credential_configured"] is False

    invalid = client.post(
        "/v1/provider-profiles",
        json=vexa_profile_payload(
            capabilities=[{"capability": "text_generation", "model": "not-valid"}]
        ),
    )
    assert invalid.status_code == 422
    assert "supports transcription only" in invalid.text


def test_local_then_cloud_default_returns_resolution_order() -> None:
    client = make_client()
    local = client.post("/v1/provider-profiles", json=local_profile_payload()).json()
    cloud = client.post("/v1/provider-profiles", json=cloud_profile_payload()).json()

    selected = client.put(
        "/v1/provider-defaults/text_generation",
        json={
            "policy": "local_then_cloud",
            "local_profile_id": local["id"],
            "cloud_profile_id": cloud["id"],
        },
    )

    assert selected.status_code == 200
    assert selected.json()["ordered_profile_ids"] == [local["id"], cloud["id"]]
    assert client.get("/v1/provider-defaults").json() == [selected.json()]


def test_default_rejects_wrong_location_and_missing_capability() -> None:
    client = make_client()
    local = client.post("/v1/provider-profiles", json=local_profile_payload()).json()
    cloud = client.post("/v1/provider-profiles", json=cloud_profile_payload()).json()

    wrong_location = client.put(
        "/v1/provider-defaults/text_generation",
        json={"policy": "local_only", "local_profile_id": cloud["id"]},
    )
    assert wrong_location.status_code == 422
    assert "not a local provider" in wrong_location.json()["detail"]

    missing_capability = client.put(
        "/v1/provider-defaults/transcription",
        json={"policy": "local_only", "local_profile_id": local["id"]},
    )
    assert missing_capability.status_code == 422
    assert "does not support transcription" in missing_capability.json()["detail"]


def test_openai_text_runtime_uses_responses_structured_output() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "output": [{"content": [{"type": "output_text", "text": '{"title":"MOM"}'}]}],
                "usage": {"input_tokens": 10, "output_tokens": 4},
            },
        )

    async def scenario() -> None:
        profile = ProviderProfile(
            name="OpenAI",
            provider_type=ProviderType.OPENAI,
            execution_location=ExecutionLocation.CLOUD,
            base_url=None,
            models={Capability.TEXT_GENERATION: "economy-model"},
            api_key="secret-key",
        )
        result = await OpenAIAdapter(transport=httpx.MockTransport(handler)).generate_text(
            profile,
            TextGenerationRequest(
                prompt="Create MOM",
                response_schema={"type": "object", "properties": {"title": {"type": "string"}}},
            ),
        )
        assert result.structured_output == {"title": "MOM"}
        assert result.input_tokens == 10

    asyncio.run(scenario())
    assert requests[0].url.path == "/v1/responses"
    assert requests[0].headers["authorization"] == "Bearer secret-key"
    payload = json.loads(requests[0].content)
    assert payload["store"] is False
    assert payload["text"]["format"]["type"] == "json_schema"


def test_compatible_text_runtime_uses_chat_completions() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": '{"title":"Compatible MOM"}'}}],
                "usage": {"prompt_tokens": 8, "completion_tokens": 3},
            },
        )

    async def scenario() -> None:
        profile = ProviderProfile(
            name="Compatible",
            provider_type=ProviderType.OPENAI_COMPATIBLE,
            execution_location=ExecutionLocation.CLOUD,
            base_url="https://provider.example/v1",
            models={Capability.TEXT_GENERATION: "compatible-model"},
            api_key="compatible-secret",
        )
        result = await OpenAICompatibleAdapter(
            transport=httpx.MockTransport(handler)
        ).generate_text(profile, TextGenerationRequest(prompt="Create MOM"))
        assert result.structured_output == {"title": "Compatible MOM"}
        assert result.output_tokens == 3

    asyncio.run(scenario())
    assert requests[0].url.path == "/v1/chat/completions"
    assert requests[0].headers["authorization"] == "Bearer compatible-secret"
