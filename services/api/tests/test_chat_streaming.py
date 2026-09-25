"""Real provider streams and the saved, cited Ask AI stream contract."""

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from meetings_contracts import Capability, ExecutionLocation, ProviderProfile, ProviderType, TextGenerationRequest, TextGenerationResult
from app.adapters.openai import OpenAIAdapter
from app.adapters.openai_compatible import OpenAICompatibleAdapter
from app.main import create_app

from test_knowledge import _create_completed_meeting


@pytest.mark.asyncio
async def test_openai_responses_stream_emits_real_text_and_usage() -> None:
    profile = ProviderProfile(name="OpenAI", provider_type=ProviderType.OPENAI,
        execution_location=ExecutionLocation.CLOUD, base_url=None,
        models={Capability.TEXT_GENERATION: "test-model"}, api_key="test-key")
    events = [
        {"type": "response.output_text.delta", "delta": '{"answer":"Hello'},
        {"type": "response.output_text.delta", "delta": '","citation_ids":["K1"]}'},
        {"type": "response.completed", "response": {"usage": {"input_tokens": 12, "output_tokens": 8}}},
    ]
    def respond(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["stream"] is True
        return httpx.Response(200, text="".join(f"data: {json.dumps(event)}\n\n" for event in events))
    deltas = []
    async def receive(delta: str) -> None:
        deltas.append(delta)
    result = await OpenAIAdapter(transport=httpx.MockTransport(respond)).generate_text_stream(
        profile, TextGenerationRequest(prompt="Question"), receive)
    assert deltas == ['{"answer":"Hello', '","citation_ids":["K1"]}']
    assert result.structured_output == {"answer": "Hello", "citation_ids": ["K1"]}
    assert (result.input_tokens, result.output_tokens) == (12, 8)


@pytest.mark.asyncio
async def test_openrouter_chat_stream_emits_text_and_usage() -> None:
    profile = ProviderProfile(name="OpenRouter", provider_type=ProviderType.OPENAI_COMPATIBLE,
        execution_location=ExecutionLocation.CLOUD, base_url="https://openrouter.ai/api/v1",
        models={Capability.TEXT_GENERATION: "test/model"}, api_key="test-key")
    events = [
        {"choices": [{"delta": {"content": '{"answer":"Hi'}, "finish_reason": None}]},
        {"choices": [{"delta": {"content": '","citation_ids":["K1"]}'}, "finish_reason": "stop"}]},
        {"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 7}},
    ]
    def respond(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["stream_options"] == {"include_usage": True}
        return httpx.Response(200, text="".join(f"data: {json.dumps(event)}\n\n" for event in events) + "data: [DONE]\n\n")
    deltas = []
    async def receive(delta: str) -> None:
        deltas.append(delta)
    result = await OpenAICompatibleAdapter(transport=httpx.MockTransport(respond)).generate_text_stream(
        profile, TextGenerationRequest(prompt="Question"), receive)
    assert "".join(deltas) == '{"answer":"Hi","citation_ids":["K1"]}'
    assert (result.input_tokens, result.output_tokens) == (5, 7)


def test_knowledge_stream_saves_only_validated_final_answer(tmp_path) -> None:
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'stream.db'}", credential_key="test-credential-key")
    with TestClient(app) as client:
        base_id = client.post("/v1/knowledge-bases", json={"name": "Project"}).json()["id"]
        _create_completed_meeting(client, app.state.repository, opted_in=True, title="Roadmap", base_id=base_id)

        async def generated(_request, *, on_delta):
            pieces = ['{"answer":"Alice ', 'owns the roadmap.","citation_ids":["K1"]}']
            for piece in pieces:
                await on_delta(piece)
                await asyncio.sleep(0)
            return object(), TextGenerationResult(text="".join(pieces), provider="test", model="test-model")

        app.state.profile_service.generate_text = generated
        response = client.post("/v1/knowledge/chat/stream", json={
            "query": "who owns roadmap?", "knowledge_base_id": base_id,
        })
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.text.count("event: delta") == 2
        assert "event: final" in response.text
        final = json.loads(response.text.split("event: final\ndata: ")[1].split("\n\n")[0])
        assert final["answer"] == "Alice owns the roadmap."
        assert final["citations"][0]["segment_id"] == "segment-1"
        conversation = client.get(f"/v1/knowledge-bases/{base_id}/conversations/{final['conversation_id']}").json()
        assert len(conversation["messages"]) == 2

        async def invalid(_request, *, on_delta):
            await on_delta('{"answer":"Unsupported"')
            return object(), TextGenerationResult(text='{"answer":"Unsupported","citation_ids":["K99"]}', provider="test", model="test-model")

        app.state.profile_service.generate_text = invalid
        failed = client.post("/v1/knowledge/chat/stream", json={
            "query": "who owns roadmap?", "knowledge_base_id": base_id,
        })
        assert "event: error" in failed.text
        assert "event: final" not in failed.text
        conversations = client.get(f"/v1/knowledge-bases/{base_id}/conversations").json()
        assert len(conversations) == 1
