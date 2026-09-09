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


class OpenAICompatibleAdapter:
    """Foundation for local or hosted OpenAI-compatible endpoints."""

    async def test_configuration(self, profile: ProviderProfile) -> AdapterTestResult:
        valid = bool(profile.base_url)
        return AdapterTestResult(
            profile_id=profile.id,
            status="configuration_valid" if valid else "configuration_invalid",
            capabilities=list(profile.models),
            message=(
                "Compatible endpoint is configured; no network call was performed."
                if valid
                else "A base URL is required for an OpenAI-compatible provider."
            ),
        )

    async def transcribe(
        self, profile: ProviderProfile, request: TranscriptionRequest
    ) -> TranscriptionResult:
        raise RuntimeAdapterNotImplementedError(
            "OpenAI-compatible transcription is not wired in this MVP"
        )

    async def generate_text(
        self, profile: ProviderProfile, request: TextGenerationRequest
    ) -> TextGenerationResult:
        raise RuntimeAdapterNotImplementedError(
            "OpenAI-compatible text generation is not wired in this MVP"
        )

    async def embed(
        self, profile: ProviderProfile, request: EmbeddingRequest
    ) -> EmbeddingResult:
        raise RuntimeAdapterNotImplementedError(
            "OpenAI-compatible embeddings are not wired in this MVP"
        )
