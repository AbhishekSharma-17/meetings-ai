"""Pydantic request/response contracts shared by the API and future workers."""

from datetime import datetime
from enum import Enum
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, SecretStr, model_validator


class ProviderType(str, Enum):
    OPENAI = "openai"
    OPENAI_COMPATIBLE = "openai_compatible"
    VEXA_NATIVE = "vexa_native"


class ExecutionLocation(str, Enum):
    LOCAL = "local"
    CLOUD = "cloud"


class Capability(str, Enum):
    TRANSCRIPTION = "transcription"
    TEXT_GENERATION = "text_generation"
    EMBEDDINGS = "embeddings"


class FallbackPolicy(str, Enum):
    LOCAL_ONLY = "local_only"
    LOCAL_THEN_CLOUD = "local_then_cloud"
    CLOUD_ONLY = "cloud_only"
    CLOUD_THEN_LOCAL = "cloud_then_local"


class CapabilityConfig(BaseModel):
    capability: Capability
    model: Annotated[str, Field(min_length=1, max_length=200)]


class ProfileCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, Field(min_length=1, max_length=100)]
    provider_type: ProviderType
    execution_location: ExecutionLocation
    base_url: HttpUrl | None = None
    capabilities: Annotated[list[CapabilityConfig], Field(min_length=1)]
    api_key: SecretStr | None = Field(default=None, repr=False)

    @model_validator(mode="after")
    def validate_provider(self) -> "ProfileCreate":
        capability_names = [item.capability for item in self.capabilities]
        if len(set(capability_names)) != len(capability_names):
            raise ValueError("each capability may be configured only once")
        if self.provider_type is ProviderType.OPENAI_COMPATIBLE and self.base_url is None:
            raise ValueError("base_url is required for an OpenAI-compatible provider")
        if self.provider_type is ProviderType.VEXA_NATIVE and self.base_url is None:
            raise ValueError("base_url is required for a Vexa-native provider")
        if self.provider_type is ProviderType.VEXA_NATIVE and set(capability_names) != {
            Capability.TRANSCRIPTION
        }:
            raise ValueError("a Vexa-native profile supports transcription only")
        if self.provider_type is ProviderType.OPENAI and self.execution_location is ExecutionLocation.LOCAL:
            raise ValueError("the OpenAI provider must use cloud execution")
        return self


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str | None, Field(default=None, min_length=1, max_length=100)]
    provider_type: ProviderType | None = None
    execution_location: ExecutionLocation | None = None
    base_url: HttpUrl | None = None
    capabilities: Annotated[list[CapabilityConfig] | None, Field(default=None, min_length=1)]
    api_key: SecretStr | None = Field(default=None, repr=False)

    @model_validator(mode="after")
    def validate_capabilities(self) -> "ProfileUpdate":
        if self.capabilities is not None:
            names = [item.capability for item in self.capabilities]
            if len(set(names)) != len(names):
                raise ValueError("each capability may be configured only once")
        return self


class ProfilePublic(BaseModel):
    """Safe profile representation. It intentionally has no credential field."""

    id: UUID
    name: str
    provider_type: ProviderType
    execution_location: ExecutionLocation
    base_url: str | None
    capabilities: list[CapabilityConfig]
    credential_configured: bool
    created_at: datetime
    updated_at: datetime


class AdapterTestResult(BaseModel):
    profile_id: UUID
    status: Literal["configuration_valid", "configuration_invalid"]
    network_call_performed: Literal[False] = False
    capabilities: list[Capability]
    message: str


class DefaultSelectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    policy: FallbackPolicy
    local_profile_id: UUID | None = None
    cloud_profile_id: UUID | None = None

    @model_validator(mode="after")
    def validate_required_profiles(self) -> "DefaultSelectionRequest":
        if self.policy in {FallbackPolicy.LOCAL_ONLY, FallbackPolicy.LOCAL_THEN_CLOUD}:
            if self.local_profile_id is None:
                raise ValueError("the selected policy requires local_profile_id")
        if self.policy in {FallbackPolicy.CLOUD_ONLY, FallbackPolicy.CLOUD_THEN_LOCAL}:
            if self.cloud_profile_id is None:
                raise ValueError("the selected policy requires cloud_profile_id")
        if self.policy is FallbackPolicy.LOCAL_THEN_CLOUD and self.cloud_profile_id is None:
            raise ValueError("local_then_cloud requires cloud_profile_id")
        if self.policy is FallbackPolicy.CLOUD_THEN_LOCAL and self.local_profile_id is None:
            raise ValueError("cloud_then_local requires local_profile_id")
        return self


class DefaultSelectionResponse(DefaultSelectionRequest):
    capability: Capability
    ordered_profile_ids: list[UUID]


class TranscriptionRequest(BaseModel):
    audio_uri: Annotated[str, Field(min_length=1)]
    language: str | None = None
    prompt: str | None = None
    diarize: bool = True
    metadata: dict[str, Any] = Field(default_factory=dict)


class TranscriptionSegment(BaseModel):
    start_seconds: Annotated[float, Field(ge=0)]
    end_seconds: Annotated[float, Field(ge=0)]
    text: str
    speaker: str | None = None

    @model_validator(mode="after")
    def validate_timestamps(self) -> "TranscriptionSegment":
        if self.end_seconds < self.start_seconds:
            raise ValueError("end_seconds must not precede start_seconds")
        return self


class TranscriptionResult(BaseModel):
    text: str
    language: str | None = None
    duration_seconds: float | None = Field(default=None, ge=0)
    segments: list[TranscriptionSegment] = Field(default_factory=list)
    provider: str
    model: str


class TextGenerationRequest(BaseModel):
    system_prompt: str | None = None
    prompt: Annotated[str, Field(min_length=1)]
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_output_tokens: int | None = Field(default=None, gt=0)
    response_schema: dict[str, Any] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class TextGenerationResult(BaseModel):
    text: str
    structured_output: dict[str, Any] | None = None
    provider: str
    model: str
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)


class EmbeddingRequest(BaseModel):
    inputs: Annotated[list[str], Field(min_length=1)]
    dimensions: int | None = Field(default=None, gt=0)
    metadata: dict[str, Any] = Field(default_factory=dict)


class EmbeddingResult(BaseModel):
    vectors: list[list[float]]
    provider: str
    model: str
    dimensions: Annotated[int, Field(gt=0)]
