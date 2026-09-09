from meetings_contracts import (
    AdapterTestResult,
    EmbeddingRequest,
    EmbeddingResult,
    ProviderProfile,
    TextGenerationRequest,
    TextGenerationResult,
    TranscriptionRequest,
    TranscriptionResult,
)

from .base import RuntimeAdapterNotImplementedError


class OpenAIAdapter:
    """Network-free OpenAI adapter foundation."""

    async def test_configuration(self, profile: ProviderProfile) -> AdapterTestResult:
        valid = bool(profile.api_key)
        return AdapterTestResult(
            profile_id=profile.id,
            status="configuration_valid" if valid else "configuration_invalid",
            capabilities=list(profile.models),
            message=(
                "OpenAI profile is configured; no network call was performed."
                if valid
                else "An API key is required for the OpenAI provider."
            ),
        )

    async def transcribe(
        self, profile: ProviderProfile, request: TranscriptionRequest
    ) -> TranscriptionResult:
        raise RuntimeAdapterNotImplementedError("OpenAI transcription is not wired in this MVP")

    async def generate_text(
        self, profile: ProviderProfile, request: TextGenerationRequest
    ) -> TextGenerationResult:
        raise RuntimeAdapterNotImplementedError("OpenAI text generation is not wired in this MVP")

    async def embed(
        self, profile: ProviderProfile, request: EmbeddingRequest
    ) -> EmbeddingResult:
        raise RuntimeAdapterNotImplementedError("OpenAI embeddings are not wired in this MVP")
