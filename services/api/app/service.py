import time
from datetime import UTC, datetime
from dataclasses import replace
from collections.abc import Awaitable, Callable
from uuid import UUID

from meetings_contracts import (
    AdapterTestResult,
    Capability,
    CapabilityConfig,
    DefaultSelection,
    DefaultSelectionRequest,
    DefaultSelectionResponse,
    ExecutionLocation,
    EmbeddingRequest,
    EmbeddingResult,
    ProfileCreate,
    ProfilePublic,
    ProfileUpdate,
    ProviderProfile,
    ProviderType,
    TextGenerationRequest,
    TextGenerationResult,
)

from .adapters import OpenAIAdapter, OpenAICompatibleAdapter, VexaNativeAdapter
from .adapters.base import ProviderAdapter
from .adapters.base import ProviderExecutionError
from .credential_vault import (
    CredentialCreate,
    CredentialNotFoundError,
    CredentialValidationError,
    profile_link_base_url,
    vault_type_for_profile,
)
from .tenant import current_organization_id


class ProfileValidationError(ValueError):
    pass


class ProfilePermissionError(PermissionError):
    pass


class ProviderSelectionError(RuntimeError):
    pass


class ProviderProfileService:
    def __init__(self, repository: object, usage: object | None = None, vault: object | None = None) -> None:
        self.repository = repository
        self.usage = usage
        self.vault = vault
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
            credential_hint=(f"••••{profile.api_key[-4:]}" if profile.api_key and len(profile.api_key) >= 8
                             else "••••" if profile.api_key else None),
            credential_id=profile.credential_id,
            credential_label=profile.credential_label,
            created_at=profile.created_at,
            updated_at=profile.updated_at,
        )

    def create(self, request: ProfileCreate, actor: object | None = None) -> ProviderProfile:
        base_url = str(request.base_url) if request.base_url else None
        api_key = request.api_key.get_secret_value() if request.api_key else None
        credential_id = request.credential_id
        if request.save_to_vault:
            credential_id = self._save_to_vault(
                request.provider_type, base_url, api_key, request.credential_label or request.name, actor,
            )
            api_key = None
        credential_label = None
        if credential_id is not None:
            if request.credential_id is not None:
                self._require_owner_link(actor)
            base_url, credential_label = self._bind_credential(credential_id, request.provider_type, base_url)
        profile = ProviderProfile(
            name=request.name,
            provider_type=request.provider_type,
            execution_location=request.execution_location,
            base_url=base_url,
            models={item.capability: item.model for item in request.capabilities},
            api_key=api_key,
            credential_id=credential_id,
            credential_label=credential_label,
        )
        return self._save(profile)

    def update(self, profile_id: UUID, request: ProfileUpdate, actor: object | None = None) -> ProviderProfile:
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
        # A linked profile's api_key is the vault secret; it must never become the
        # profile's own stored key when the link is changed or removed.
        credential_id = profile.credential_id
        api_key = profile.api_key if credential_id is None else None
        if "api_key" in fields:
            api_key = request.api_key.get_secret_value() if request.api_key else None
            credential_id = None
        if "credential_id" in fields:
            if request.credential_id is not None and request.credential_id != profile.credential_id:
                self._require_owner_link(actor)
            credential_id = request.credential_id
            if credential_id is not None:
                api_key = None
        if request.save_to_vault:
            credential_id = self._save_to_vault(
                provider_type, base_url, api_key, request.credential_label or name, actor,
            )
            api_key = None
        credential_label = None
        if credential_id is not None:
            base_url, credential_label = self._bind_credential(credential_id, provider_type, base_url)

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
                credential_id=credential_id,
            )
        except ValueError as exc:
            raise ProfileValidationError(str(exc)) from exc

        profile.name = name
        profile.provider_type = provider_type
        profile.execution_location = execution_location
        profile.base_url = base_url
        profile.models = models
        profile.api_key = api_key
        profile.credential_id = credential_id
        profile.credential_label = credential_label
        profile.updated_at = datetime.now(UTC)
        return self._save(profile)

    def _save(self, profile: ProviderProfile) -> ProviderProfile:
        saved = self.repository.save_profile(profile)
        # Reload a vault-linked profile so the response reflects the resolved key hint.
        return self.repository.get_profile(saved.id) if saved.credential_id is not None else saved

    @staticmethod
    def _require_owner_link(actor: object | None) -> None:
        # Saved keys are the owner's spend: an admin must not route workspace AI
        # calls onto one. Admins can still paste their own key into a profile.
        if actor is not None and getattr(actor, "role", None) != "owner":
            raise ProfilePermissionError("only the workspace owner can attach a saved API key to a profile")

    def _save_to_vault(
        self, provider_type: ProviderType, base_url: str | None, api_key: str | None,
        label: str, actor: object | None,
    ) -> UUID:
        if self.vault is None:
            raise ProfileValidationError("the workspace key vault is not available")
        if actor is not None and getattr(actor, "role", None) != "owner":
            raise ProfilePermissionError("only the workspace owner can save keys to the vault")
        if not api_key:
            raise ProfileValidationError("save_to_vault requires a pasted api_key")
        try:
            saved = self.vault.create(current_organization_id(), CredentialCreate(
                label=label[:100], provider_type=vault_type_for_profile(provider_type, base_url),
                secret=api_key, base_url=base_url,
            ), getattr(actor, "user_id", None))
        except CredentialValidationError as exc:
            raise ProfileValidationError(str(exc)) from exc
        return saved.id

    def _bind_credential(
        self, credential_id: UUID, provider_type: ProviderType, base_url: str | None,
    ) -> tuple[str | None, str]:
        """Validate a vault link; the key may only be sent to the host it was saved for."""
        if self.vault is None:
            raise ProfileValidationError("the workspace key vault is not available")
        try:
            credential = self.vault.get(current_organization_id(), credential_id)
            return profile_link_base_url(credential, provider_type, base_url), credential.label
        except CredentialNotFoundError as exc:
            raise ProfileValidationError("the selected saved key was not found") from exc
        except CredentialValidationError as exc:
            raise ProfileValidationError(str(exc)) from exc

    def _record_failure(self, profile: ProviderProfile, metadata: dict, kind: str, capability: Capability,
                        error: BaseException, started: float) -> None:
        if self.usage is not None and hasattr(self.usage, "record_failure"):
            self.usage.record_failure(profile, metadata, kind=kind, model=profile.models.get(capability),
                                      error=error, duration_ms=_elapsed_ms(started))

    def _record_key_use(self, profile: ProviderProfile) -> None:
        if self.vault is not None and profile.credential_id is not None:
            self.vault.touch(current_organization_id(), profile.credential_id)

    def delete(self, profile_id: UUID) -> None:
        self.repository.delete_profile(profile_id)

    async def test(self, profile_id: UUID) -> AdapterTestResult:
        profile = self.repository.get_profile(profile_id)
        return await self.adapters[profile.provider_type].test_configuration(profile)

    async def generate_text(
        self, request: TextGenerationRequest, *, profile_id: UUID | None = None,
        model_override: str | None = None,
        on_delta: Callable[[str], Awaitable[None]] | None = None,
    ) -> tuple[ProviderProfile, TextGenerationResult]:
        if model_override and (not profile_id or len(model_override) > 200 or any(char.isspace() for char in model_override)):
            raise ProviderSelectionError("a valid model override requires a selected provider")
        if profile_id is not None:
            profile = self.repository.get_profile(profile_id)
            if not profile.supports(Capability.TEXT_GENERATION):
                raise ProviderSelectionError("selected profile does not support text generation")
            runtime_profile = replace(profile, models={**profile.models, Capability.TEXT_GENERATION: model_override}) if model_override else profile
            adapter = self.adapters[profile.provider_type]
            stream = getattr(adapter, "generate_text_stream", None) if on_delta else None
            started = time.monotonic()
            try:
                result = await stream(runtime_profile, request, on_delta) if stream else await adapter.generate_text(runtime_profile, request)
            except (ProviderExecutionError, RuntimeError) as exc:
                self._record_failure(runtime_profile, request.metadata, "llm", Capability.TEXT_GENERATION, exc, started)
                raise
            if on_delta and not stream:
                await on_delta(result.text)
            if self.usage:
                self.usage.record(profile, request, result, duration_ms=_elapsed_ms(started))
            self._record_key_use(profile)
            return profile, result
        selection = self.repository.get_default(Capability.TEXT_GENERATION)
        if selection is None or not selection.ordered_profile_ids():
            raise ProviderSelectionError("no default MOM text-generation provider is selected")

        failures: list[str] = []
        for profile_id in selection.ordered_profile_ids():
            profile = self.repository.get_profile(profile_id)
            if not profile.supports(Capability.TEXT_GENERATION):
                failures.append(f"{profile.name}: text generation is not configured")
                continue
            try:
                adapter = self.adapters[profile.provider_type]
                stream = getattr(adapter, "generate_text_stream", None) if on_delta else None
                emitted = False

                async def emit(value: str) -> None:
                    nonlocal emitted
                    emitted = True
                    if on_delta:
                        await on_delta(value)

                started = time.monotonic()
                result = await stream(profile, request, emit) if stream else await adapter.generate_text(profile, request)
                if on_delta and not stream:
                    await on_delta(result.text)
                if self.usage:
                    self.usage.record(profile, request, result, duration_ms=_elapsed_ms(started))
                self._record_key_use(profile)
                return profile, result
            except (ProviderExecutionError, RuntimeError) as exc:
                self._record_failure(profile, request.metadata, "llm", Capability.TEXT_GENERATION, exc, started)
                if on_delta and emitted:
                    raise
                failures.append(f"{profile.name}: {exc}")
        raise ProviderExecutionError("; ".join(failures) or "all selected providers failed")

    async def embed(
        self, request: EmbeddingRequest, *, profile_id: UUID | None = None,
    ) -> tuple[ProviderProfile, EmbeddingResult]:
        if profile_id is not None:
            profile = self.repository.get_profile(profile_id)
            if not profile.supports(Capability.EMBEDDINGS):
                raise ProviderSelectionError("selected profile does not support embeddings")
            started = time.monotonic()
            try:
                result = await self.adapters[profile.provider_type].embed(profile, request)
            except (ProviderExecutionError, RuntimeError) as exc:
                self._record_failure(profile, request.metadata, "embedding", Capability.EMBEDDINGS, exc, started)
                raise
            if self.usage:
                self.usage.record_embedding(profile, request, result, duration_ms=_elapsed_ms(started))
            self._record_key_use(profile)
            return profile, result
        selection = self.repository.get_default(Capability.EMBEDDINGS)
        if selection is None or not selection.ordered_profile_ids():
            raise ProviderSelectionError("no default embedding provider is selected")
        failures: list[str] = []
        for candidate_id in selection.ordered_profile_ids():
            profile = self.repository.get_profile(candidate_id)
            if not profile.supports(Capability.EMBEDDINGS):
                failures.append(f"{profile.name}: embeddings are not configured")
                continue
            started = time.monotonic()
            try:
                result = await self.adapters[profile.provider_type].embed(profile, request)
                if self.usage:
                    self.usage.record_embedding(profile, request, result, duration_ms=_elapsed_ms(started))
                self._record_key_use(profile)
                return profile, result
            except (ProviderExecutionError, RuntimeError) as exc:
                self._record_failure(profile, request.metadata, "embedding", Capability.EMBEDDINGS, exc, started)
                failures.append(f"{profile.name}: {exc}")
        raise ProviderExecutionError("; ".join(failures) or "all selected embedding providers failed")

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

    def resolve_transcription_profile(self) -> ProviderProfile | None:
        """Choose one configured route before spawn; no mid-meeting fallback."""
        selection = self.repository.get_default(Capability.TRANSCRIPTION)
        if selection is None:
            return None  # An operator may still use Vexa's deployment STT default.
        failures: list[str] = []
        for profile_id in selection.ordered_profile_ids():
            profile = self.repository.get_profile(profile_id)
            if not profile.supports(Capability.TRANSCRIPTION):
                failures.append(f"{profile.name}: transcription model is missing")
            elif profile.execution_location is ExecutionLocation.CLOUD and not profile.api_key:
                failures.append(f"{profile.name}: API credential is missing")
            else:
                return profile
        raise ProviderSelectionError(
            "; ".join(failures) or "no usable default transcription profile is selected"
        )

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


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
