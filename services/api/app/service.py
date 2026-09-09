from datetime import UTC, datetime
from uuid import UUID

from meetings_contracts import (
    AdapterTestResult,
    Capability,
    CapabilityConfig,
    DefaultSelection,
    DefaultSelectionRequest,
    DefaultSelectionResponse,
    ExecutionLocation,
    ProfileCreate,
    ProfilePublic,
    ProfileUpdate,
    ProviderProfile,
    ProviderType,
)

from .adapters import OpenAIAdapter, OpenAICompatibleAdapter, VexaNativeAdapter
from .adapters.base import ProviderAdapter
from .repository import InMemoryProviderRepository


class ProfileValidationError(ValueError):
    pass


class ProviderProfileService:
    def __init__(self, repository: InMemoryProviderRepository) -> None:
        self.repository = repository
        self.adapters: dict[ProviderType, ProviderAdapter] = {
            ProviderType.OPENAI: OpenAIAdapter(),
            ProviderType.OPENAI_COMPATIBLE: OpenAICompatibleAdapter(),
            ProviderType.VEXA_NATIVE: VexaNativeAdapter(),
        }

    @staticmethod
    def to_public(profile: ProviderProfile) -> ProfilePublic:
        return ProfilePublic(
            id=profile.id,
            name=profile.name,
            provider_type=profile.provider_type,
            execution_location=profile.execution_location,
            base_url=profile.base_url,
            capabilities=[
                CapabilityConfig(capability=capability, model=model)
                for capability, model in profile.models.items()
            ],
            credential_configured=bool(profile.api_key),
            created_at=profile.created_at,
            updated_at=profile.updated_at,
        )

    def create(self, request: ProfileCreate) -> ProviderProfile:
        profile = ProviderProfile(
            name=request.name,
            provider_type=request.provider_type,
            execution_location=request.execution_location,
            base_url=str(request.base_url) if request.base_url else None,
            models={item.capability: item.model for item in request.capabilities},
            api_key=request.api_key.get_secret_value() if request.api_key else None,
        )
        return self.repository.save_profile(profile)

    def update(self, profile_id: UUID, request: ProfileUpdate) -> ProviderProfile:
        profile = self.repository.get_profile(profile_id)
        fields = request.model_fields_set

        name = request.name if request.name is not None else profile.name
        provider_type = request.provider_type or profile.provider_type
        execution_location = request.execution_location or profile.execution_location
        base_url = profile.base_url
        if "base_url" in fields:
            base_url = str(request.base_url) if request.base_url else None
        models = profile.models
        if request.capabilities is not None:
            models = {item.capability: item.model for item in request.capabilities}
        api_key = profile.api_key
        if "api_key" in fields:
            api_key = request.api_key.get_secret_value() if request.api_key else None

        # Reuse create-schema cross-field validation against the merged state.
        try:
            ProfileCreate(
                name=name,
                provider_type=provider_type,
                execution_location=execution_location,
                base_url=base_url,
                capabilities=[
                    CapabilityConfig(capability=capability, model=model)
                    for capability, model in models.items()
                ],
                api_key=api_key,
            )
        except ValueError as exc:
            raise ProfileValidationError(str(exc)) from exc

        profile.name = name
        profile.provider_type = provider_type
        profile.execution_location = execution_location
        profile.base_url = base_url
        profile.models = models
        profile.api_key = api_key
        profile.updated_at = datetime.now(UTC)
        return self.repository.save_profile(profile)

    async def test(self, profile_id: UUID) -> AdapterTestResult:
        profile = self.repository.get_profile(profile_id)
        return await self.adapters[profile.provider_type].test_configuration(profile)

    def select_default(
        self, capability: Capability, request: DefaultSelectionRequest
    ) -> DefaultSelectionResponse:
        local = self._validate_selected_profile(
            request.local_profile_id, ExecutionLocation.LOCAL, capability
        )
        cloud = self._validate_selected_profile(
            request.cloud_profile_id, ExecutionLocation.CLOUD, capability
        )
        selection = DefaultSelection(
            capability=capability,
            policy=request.policy,
            local_profile_id=local.id if local else None,
            cloud_profile_id=cloud.id if cloud else None,
        )
        self.repository.save_default(selection)
        return self.to_default_response(selection)

    def _validate_selected_profile(
        self,
        profile_id: UUID | None,
        expected_location: ExecutionLocation,
        capability: Capability,
    ) -> ProviderProfile | None:
        if profile_id is None:
            return None
        profile = self.repository.get_profile(profile_id)
        if profile.execution_location is not expected_location:
            raise ProfileValidationError(
                f"profile {profile_id} is not a {expected_location.value} provider"
            )
        if not profile.supports(capability):
            raise ProfileValidationError(
                f"profile {profile_id} does not support {capability.value}"
            )
        return profile

    @staticmethod
    def to_default_response(selection: DefaultSelection) -> DefaultSelectionResponse:
        return DefaultSelectionResponse(
            capability=selection.capability,
            policy=selection.policy,
            local_profile_id=selection.local_profile_id,
            cloud_profile_id=selection.cloud_profile_id,
            ordered_profile_ids=list(selection.ordered_profile_ids()),
        )
