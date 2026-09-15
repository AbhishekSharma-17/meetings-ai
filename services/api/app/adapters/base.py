"""Provider contracts used by orchestration code.

The MVP adapters expose configuration checks only. Runtime methods deliberately
raise until the corresponding workflow is wired, preventing accidental API calls.
"""

from typing import Protocol

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


class TranscriptionProvider(Protocol):
    async def transcribe(
        self, profile: ProviderProfile, request: TranscriptionRequest
    ) -> TranscriptionResult: ...


class TextGenerationProvider(Protocol):
    async def generate_text(
        self, profile: ProviderProfile, request: TextGenerationRequest
    ) -> TextGenerationResult: ...


class EmbeddingProvider(Protocol):
    async def embed(
        self, profile: ProviderProfile, request: EmbeddingRequest
    ) -> EmbeddingResult: ...


class ProviderAdapter(
    TranscriptionProvider, TextGenerationProvider, EmbeddingProvider, Protocol
):
    async def test_configuration(self, profile: ProviderProfile) -> AdapterTestResult: ...


class RuntimeAdapterNotImplementedError(NotImplementedError):
    """Raised when an MVP adapter is invoked for inference."""


class ProviderExecutionError(RuntimeError):
    """Safe provider runtime failure that never includes credentials."""
