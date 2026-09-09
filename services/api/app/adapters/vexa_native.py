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


class VexaNativeAdapter:
    """Boundary for Vexa's configured OpenAI-shaped transcription service.

    The actual multipart/network implementation lands with the capture slice. This
    adapter is intentionally distinct from a generic compatible endpoint because
    Vexa's request and verbose-segment response contract must be verified.
    """

    async def test_configuration(self, profile: ProviderProfile) -> AdapterTestResult:
        valid = bool(profile.base_url)
        return AdapterTestResult(
            profile_id=profile.id,
            status="configuration_valid" if valid else "configuration_invalid",
            capabilities=list(profile.models),
            message=(
                "Vexa-native transcription endpoint is configured; no network call was performed."
                if valid
                else "A base URL is required for a Vexa-native transcription provider."
            ),
        )

    async def transcribe(
        self, profile: ProviderProfile, request: TranscriptionRequest
    ) -> TranscriptionResult:
        raise RuntimeAdapterNotImplementedError(
            "Vexa-native transcription is not wired in this foundation slice"
        )

    async def generate_text(
        self, profile: ProviderProfile, request: TextGenerationRequest
    ) -> TextGenerationResult:
        raise RuntimeAdapterNotImplementedError(
            "Vexa-native profiles do not provide text generation"
        )

    async def embed(
        self, profile: ProviderProfile, request: EmbeddingRequest
    ) -> EmbeddingResult:
        raise RuntimeAdapterNotImplementedError(
            "Vexa-native profiles do not provide embeddings"
        )
