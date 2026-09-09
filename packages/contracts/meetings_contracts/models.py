"""Provider-agnostic domain models.

These are deliberately independent of HTTP and SDK concerns. Credentials live only
on the internal profile model and are excluded from its repr.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID, uuid4

from .schemas import Capability, ExecutionLocation, FallbackPolicy, ProviderType


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
