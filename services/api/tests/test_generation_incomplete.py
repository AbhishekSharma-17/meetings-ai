import asyncio

import httpx
import pytest
from meetings_contracts import Capability, ExecutionLocation, ProviderProfile, ProviderType, TextGenerationRequest

from app.adapters.base import ProviderExecutionError
from app.adapters.openai import OpenAIAdapter
from app.adapters.openai_compatible import OpenAICompatibleAdapter


def test_openai_incomplete_structured_output_has_actionable_error() -> None:
    profile = ProviderProfile(
        name="Minutes", provider_type=ProviderType.OPENAI,
        execution_location=ExecutionLocation.CLOUD, base_url=None,
        models={Capability.TEXT_GENERATION: "test-model"}, api_key="test-key",
    )
    adapter = OpenAIAdapter(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={
        "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"},
        "output": [{"content": [{"text": "{\"title\":\"unfinished"}]}],
    })))
    with pytest.raises(ProviderExecutionError, match="output token limit"):
        asyncio.run(adapter.generate_text(profile, TextGenerationRequest(prompt="Summarize", max_output_tokens=12000)))


def test_compatible_length_finish_is_not_parsed_as_valid_minutes() -> None:
    profile = ProviderProfile(
        name="Minutes", provider_type=ProviderType.OPENAI_COMPATIBLE,
        execution_location=ExecutionLocation.CLOUD, base_url="https://compatible.test/v1",
        models={Capability.TEXT_GENERATION: "test-model"}, api_key="test-key",
    )
    adapter = OpenAICompatibleAdapter(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={
        "choices": [{"message": {"content": "{\"title\":\"unfinished"}, "finish_reason": "length"}],
    })))
    with pytest.raises(ProviderExecutionError, match="output token limit"):
        asyncio.run(adapter.generate_text(profile, TextGenerationRequest(prompt="Summarize", max_output_tokens=12000)))
