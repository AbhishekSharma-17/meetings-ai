"""Provider-agnostic domain models.

These are deliberately independent of HTTP and SDK concerns. Credentials live only
on the internal profile model and are excluded from its repr.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID, uuid4

from .schemas import (
    ActionItem,
    Capability,
    ExecutionLocation,
    FallbackPolicy,
    MeetingPlatform,
    MeetingStatus,
    MinutesStatus,
    ProviderType,
)


@dataclass(slots=True)
class ProviderProfile:
    name: str
    provider_type: ProviderType
    execution_location: ExecutionLocation
    base_url: str | None
    models: dict[Capability, str]
    api_key: str | None = field(default=None, repr=False)
    id: UUID = field(default_factory=uuid4)
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def supports(self, capability: Capability) -> bool:
        return bool(self.models.get(capability))


@dataclass(frozen=True, slots=True)
class DefaultSelection:
    capability: Capability
    policy: FallbackPolicy
    local_profile_id: UUID | None = None
    cloud_profile_id: UUID | None = None

    def ordered_profile_ids(self) -> tuple[UUID, ...]:
        if self.policy is FallbackPolicy.LOCAL_ONLY:
            candidates = (self.local_profile_id,)
        elif self.policy is FallbackPolicy.LOCAL_THEN_CLOUD:
            candidates = (self.local_profile_id, self.cloud_profile_id)
        elif self.policy is FallbackPolicy.CLOUD_ONLY:
            candidates = (self.cloud_profile_id,)
        else:
            candidates = (self.cloud_profile_id, self.local_profile_id)
        return tuple(candidate for candidate in candidates if candidate is not None)


@dataclass(slots=True)
class Meeting:
    meeting_url: str
    bot_name: str
    platform: MeetingPlatform
    native_meeting_id: str
    title: str | None = None
    language: str | None = None
    transcribe_enabled: bool = True
    recording_enabled: bool = False
    status: MeetingStatus = MeetingStatus.CREATED
    vexa_meeting_id: int | None = None
    last_error: str | None = None
    id: UUID = field(default_factory=uuid4)
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    joined_at: datetime | None = None
    stopped_at: datetime | None = None
    last_refreshed_at: datetime | None = None


@dataclass(slots=True)
class MeetingMinutes:
    meeting_id: UUID
    title: str
    executive_summary: str
    discussion_points: list[str] = field(default_factory=list)
    decisions: list[str] = field(default_factory=list)
    action_items: list[ActionItem] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)
    status: MinutesStatus = MinutesStatus.DRAFT
    provider_profile_id: UUID | None = None
    provider: str | None = None
    model: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    approved_at: datetime | None = None
    sent_at: datetime | None = None
    last_error: str | None = None


@dataclass(slots=True)
class EmailDelivery:
    meeting_id: UUID
    recipients: list[str]
    status: str
    provider_message_id: str | None = None
    error: str | None = None
    id: UUID = field(default_factory=uuid4)
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
