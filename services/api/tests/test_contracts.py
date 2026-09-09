import pytest
from pydantic import ValidationError

from meetings_contracts import (
    EmbeddingRequest,
    TextGenerationRequest,
    TranscriptionRequest,
    TranscriptionSegment,
)


def test_provider_agnostic_operation_contracts() -> None:
    transcription = TranscriptionRequest(audio_uri="s3://bucket/meeting.wav")
    generation = TextGenerationRequest(prompt="Produce minutes", max_output_tokens=1000)
    embedding = EmbeddingRequest(inputs=["decision one", "decision two"])

    assert transcription.diarize is True
    assert generation.prompt == "Produce minutes"
    assert len(embedding.inputs) == 2


def test_transcription_segment_rejects_reversed_timestamps() -> None:
    with pytest.raises(ValidationError, match="end_seconds"):
        TranscriptionSegment(start_seconds=2, end_seconds=1, text="invalid")
