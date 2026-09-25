"""Pydantic request/response contracts shared by the API and future workers."""

import re
from datetime import datetime
from enum import Enum
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, SecretStr, field_validator, model_validator


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
    """Safe profile representation with only a short, non-reusable key hint."""

    id: UUID
    name: str
    provider_type: ProviderType
    execution_location: ExecutionLocation
    base_url: str | None
    capabilities: list[CapabilityConfig]
    credential_configured: bool
    credential_hint: str | None = None
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


class MeetingPlatform(str, Enum):
    GOOGLE_MEET = "google_meet"
    TEAMS = "teams"
    ZOOM = "zoom"
    JITSI = "jitsi"


class MeetingStatus(str, Enum):
    CREATED = "created"
    REQUESTED = "requested"
    JOINING = "joining"
    AWAITING_ADMISSION = "awaiting_admission"
    ACTIVE = "active"
    NEEDS_HUMAN_HELP = "needs_human_help"
    STOPPING = "stopping"
    COMPLETED = "completed"
    FAILED = "failed"


class MeetingDeliverySettings(BaseModel):
    """Explicit, per-meeting email audience. Participant delivery is opt-in."""

    model_config = ConfigDict(extra="forbid")
    internal_recipients: list[str] = Field(default_factory=list, max_length=50)
    participant_recipients: list[str] = Field(default_factory=list, max_length=50)
    send_to_participants: bool = False
    include_transcript: bool = False

    @model_validator(mode="after")
    def validate_addresses(self) -> "MeetingDeliverySettings":
        for field_name in ("internal_recipients", "participant_recipients"):
            normalized: list[str] = []
            for recipient in getattr(self, field_name):
                value = recipient.strip().lower()
                if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
                    raise ValueError(f"invalid recipient email address: {recipient}")
                if value not in normalized:
                    normalized.append(value)
            setattr(self, field_name, normalized)
        if self.send_to_participants and not self.participant_recipients:
            raise ValueError("participant recipients are required when sharing is enabled")
        return self


class MeetingCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    meeting_url: HttpUrl
    title: Annotated[str | None, Field(default=None, max_length=200)]
    bot_name: Annotated[str, Field(default="Meetings AI", min_length=1, max_length=100)]
    language: Annotated[str | None, Field(default=None, min_length=2, max_length=35)]
    transcribe_enabled: bool = True
    recording_enabled: bool = False
    tags: list[str] = Field(default_factory=list, max_length=12)
    knowledge_enabled: bool = False
    knowledge_base_id: UUID | None = None
    delivery_settings: MeetingDeliverySettings = Field(default_factory=MeetingDeliverySettings)

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, tags: list[str]) -> list[str]:
        normalized: list[str] = []
        for tag in tags:
            value = tag.strip().lower()
            if not 2 <= len(value) <= 50 or not re.fullmatch(r"[\w][\w -]*[\w]", value):
                raise ValueError("tags must contain 2–50 letters, numbers, spaces, underscores, or hyphens")
            if value not in normalized:
                normalized.append(value)
        return normalized


class MeetingKnowledgeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tags: list[str] = Field(default_factory=list, max_length=12)
    knowledge_enabled: bool = False
    knowledge_base_id: UUID | None = None

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, tags: list[str]) -> list[str]:
        return MeetingCreate.normalize_tags(tags)


class MeetingPublic(BaseModel):
    id: UUID
    meeting_url: str
    title: str | None
    bot_name: str
    language: str | None
    transcribe_enabled: bool
    recording_enabled: bool
    tags: list[str]
    knowledge_enabled: bool
    knowledge_base_id: UUID | None
    platform: MeetingPlatform
    native_meeting_id: str
    status: MeetingStatus
    vexa_meeting_id: int | None
    last_error: str | None
    created_at: datetime
    updated_at: datetime
    joined_at: datetime | None
    stopped_at: datetime | None
    last_refreshed_at: datetime | None


class MeetingListResponse(BaseModel):
    items: list[MeetingPublic]
    count: int


class MeetingTranscriptSegment(BaseModel):
    segment_id: str | None = None
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(ge=0)
    text: str
    speaker: str | None = None
    raw_speaker: str | None = None
    speaker_key: str | None = None
    attribution_source: str | None = None
    speaker_reviewed: bool = False
    language: str | None = None
    completed: bool = True

    @model_validator(mode="after")
    def validate_timestamps(self) -> "MeetingTranscriptSegment":
        if self.end_seconds < self.start_seconds:
            raise ValueError("end_seconds must not precede start_seconds")
        return self


class MeetingTranscriptResponse(BaseModel):
    meeting_id: UUID
    vexa_meeting_id: int | None
    status: MeetingStatus
    segments: list[MeetingTranscriptSegment]
    segment_count: int


class SpeakerCorrectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    display_name: Annotated[str | None, Field(default=None, min_length=1, max_length=200)]
    apply_to_raw_label: bool = False


class MeetingParticipant(BaseModel):
    name: str
    email: str | None = None
    source: str
    response_status: str | None = None


class MeetingParticipantsResponse(BaseModel):
    meeting_id: UUID
    participants: list[MeetingParticipant]
    observed_roster: str = "not_recorded"
    upstream_available: bool = False


class SpeakerIdentityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    speaker: Annotated[str, Field(min_length=1, max_length=200)]
    email: str | None = None

    @model_validator(mode="after")
    def validate_email(self) -> "SpeakerIdentityRequest":
        self.speaker = self.speaker.strip()
        if not self.speaker:
            raise ValueError("speaker name is required")
        if self.email is not None:
            self.email = self.email.strip().lower()
            if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", self.email):
                raise ValueError("invalid speaker email address")
        return self


class SpeakerIdentityPublic(BaseModel):
    speaker: str
    email: str
    confirmed_at: datetime


class MinutesStatus(str, Enum):
    DRAFT = "draft"
    APPROVED = "approved"
    SENT = "sent"


class ActionItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: Annotated[str, Field(min_length=1, max_length=1000)]
    owner: Annotated[str | None, Field(default=None, max_length=200)]
    due_date: Annotated[str | None, Field(default=None, max_length=100)]
    evidence_segment_ids: list[str] = Field(default_factory=list, max_length=20)


class SpeakerContribution(BaseModel):
    model_config = ConfigDict(extra="forbid")

    speaker: Annotated[str, Field(min_length=1, max_length=200)]
    summary: Annotated[str, Field(min_length=1, max_length=2000)]
    evidence_segment_ids: Annotated[list[str], Field(min_length=1, max_length=20)]


class AttributedQuestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    speaker: Annotated[str | None, Field(default=None, max_length=200)]
    question: Annotated[str, Field(min_length=1, max_length=2000)]
    evidence_segment_ids: Annotated[list[str], Field(min_length=1, max_length=20)]


class MeetingMinutesDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Annotated[str, Field(min_length=1, max_length=300)]
    executive_summary: Annotated[str, Field(min_length=1, max_length=10000)]
    discussion_points: list[Annotated[str, Field(min_length=1, max_length=2000)]] = Field(
        default_factory=list, max_length=100
    )
    decisions: list[Annotated[str, Field(min_length=1, max_length=2000)]] = Field(
        default_factory=list, max_length=100
    )
    action_items: list[ActionItem] = Field(default_factory=list, max_length=100)
    open_questions: list[Annotated[str, Field(min_length=1, max_length=2000)]] = Field(
        default_factory=list, max_length=100
    )
    speaker_contributions: list[SpeakerContribution] = Field(default_factory=list, max_length=100)
    questions_asked: list[AttributedQuestion] = Field(default_factory=list, max_length=100)


class MeetingMinutesPublic(MeetingMinutesDraft):
    meeting_id: UUID
    status: MinutesStatus
    provider_profile_id: UUID | None
    provider: str | None
    model: str | None
    created_at: datetime
    updated_at: datetime
    approved_at: datetime | None
    sent_at: datetime | None
    last_error: str | None


class MinutesEmailRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recipients: Annotated[list[str], Field(min_length=1, max_length=50)]
    include_transcript: bool = False

    @model_validator(mode="after")
    def validate_recipients(self) -> "MinutesEmailRequest":
        normalized: list[str] = []
        for recipient in self.recipients:
            value = recipient.strip().lower()
            if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
                raise ValueError(f"invalid recipient email address: {recipient}")
            if value not in normalized:
                normalized.append(value)
        self.recipients = normalized
        return self


class EmailDeliveryPublic(BaseModel):
    id: UUID
    meeting_id: UUID
    recipients: list[str]
    status: Literal["sent", "failed"]
    provider_message_id: str | None
    error: str | None
    created_at: datetime
