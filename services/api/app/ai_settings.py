"""Owner-controlled, workspace-wide AI choices: Ask AI chat, vision/OCR and web research.

Only the workspace owner may change these. Everyone can read a display-only view of
which provider/model answers Ask AI; identifiers are returned to the owner only.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from meetings_contracts import Capability, ProviderProfile
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .credential_vault import CredentialNotFoundError
from .database import Database, OrganizationAiSettingsRow
from .repository import ProfileNotFoundError
from .tenant import tenant_scope

MAX_MODEL_ID_LENGTH = 200


class AiSettingsValidationError(ValueError):
    pass


class AiSettingsPermissionError(PermissionError):
    pass


class AiSettingsUnavailableError(RuntimeError):
    """A model could not be verified because the provider catalog is unreachable."""


@dataclass(frozen=True, slots=True)
class AiSettings:
    chat_profile_id: UUID | None = None
    chat_model: str | None = None
    vision_profile_id: UUID | None = None
    vision_model: str | None = None
    research_credential_id: UUID | None = None
    research_profile_id: UUID | None = None
    research_model: str | None = None
    updated_at: datetime | None = None
    updated_by: UUID | None = None


def _model_id(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    if len(cleaned) > MAX_MODEL_ID_LENGTH or any(char.isspace() for char in cleaned):
        raise ValueError("model ids must be at most 200 characters without spaces")
    return cleaned


class AiSettingsUpdate(BaseModel):
    """Full replacement (PUT): an omitted field clears that setting."""

    model_config = ConfigDict(extra="forbid")

    chat_profile_id: UUID | None = None
    chat_model: str | None = Field(default=None, max_length=MAX_MODEL_ID_LENGTH)
    vision_profile_id: UUID | None = None
    vision_model: str | None = Field(default=None, max_length=MAX_MODEL_ID_LENGTH)
    research_credential_id: UUID | None = None
    research_profile_id: UUID | None = None
    research_model: str | None = Field(default=None, max_length=MAX_MODEL_ID_LENGTH)

    @field_validator("chat_model", "vision_model", "research_model")
    @classmethod
    def clean_model(cls, value: str | None) -> str | None:
        return _model_id(value)


class AiRoutePublic(BaseModel):
    """Display-only description of the route that answers Ask AI."""

    profile_id: UUID | None = None  # owner only
    profile_name: str | None = None
    provider: str | None = None
    model: str | None = None
    source: Literal["workspace_settings", "workspace_default", "not_configured"]


class AiSettingsPublic(BaseModel):
    can_edit: bool
    chat_profile_id: UUID | None = None
    chat_model: str | None = None
    vision_profile_id: UUID | None = None
    vision_model: str | None = None
    research_credential_id: UUID | None = None
    research_credential_label: str | None = None
    research_profile_id: UUID | None = None
    research_model: str | None = None
    updated_at: datetime | None = None
    updated_by: UUID | None = None
    vision_configured: bool = False
    research_configured: bool = False
    effective_chat: AiRoutePublic
    # Owner only: what "Automatic" vision would use right now (from the default LLM).
    automatic_vision: AiRoutePublic | None = None


def _uuid(value: str | None) -> UUID | None:
    return UUID(value) if value else None


def _utc(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=UTC)


def provider_label(profile: ProviderProfile) -> str:
    base = (profile.base_url or "").lower()
    return "openrouter" if "openrouter.ai" in base else profile.provider_type.value


class AiSettingsService:
    def __init__(
        self, database: Database, repository: object, vault: object,
        model_catalog: object | None = None,
    ) -> None:
        self.database = database
        self.repository = repository
        self.vault = vault
        self.model_catalog = model_catalog
        self.vision: object | None = None  # VisionService, set at wiring time

    def get(self, organization_id: UUID) -> AiSettings:
        with self.database.session_factory() as session:
            row = session.get(OrganizationAiSettingsRow, str(organization_id))
            if row is None:
                return AiSettings()
            return AiSettings(
                chat_profile_id=_uuid(row.chat_profile_id), chat_model=row.chat_model,
                vision_profile_id=_uuid(row.vision_profile_id), vision_model=row.vision_model,
                research_credential_id=_uuid(row.research_credential_id),
                research_profile_id=_uuid(row.research_profile_id), research_model=row.research_model,
                updated_at=_utc(row.updated_at), updated_by=_uuid(row.updated_by),
            )

    def chat_route(self, organization_id: UUID) -> tuple[UUID, str | None] | None:
        """The owner-selected Ask AI profile and optional model override, if set."""
        settings = self.get(organization_id)
        if settings.chat_profile_id is None:
            return None
        return settings.chat_profile_id, settings.chat_model

    async def update(self, organization_id: UUID, request: AiSettingsUpdate, actor: object) -> AiSettings:
        if getattr(actor, "role", None) != "owner":
            raise AiSettingsPermissionError("only the workspace owner can change AI settings")
        with tenant_scope(organization_id):
            for prefix in ("chat", "vision", "research"):
                await self._validate_route(
                    prefix, getattr(request, f"{prefix}_profile_id"), getattr(request, f"{prefix}_model"),
                )
        if request.research_credential_id is not None:
            try:
                credential = self.vault.get(organization_id, request.research_credential_id)
            except CredentialNotFoundError as exc:
                raise AiSettingsValidationError("the selected research key was not found") from exc
            if credential.provider_type != "exa":
                raise AiSettingsValidationError("web research requires a saved Exa key")
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            row = session.get(OrganizationAiSettingsRow, str(organization_id))
            if row is None:
                row = OrganizationAiSettingsRow(organization_id=str(organization_id), updated_at=now)
                session.add(row)
            row.chat_profile_id = str(request.chat_profile_id) if request.chat_profile_id else None
            row.chat_model = request.chat_model
            row.vision_profile_id = str(request.vision_profile_id) if request.vision_profile_id else None
            row.vision_model = request.vision_model
            row.research_credential_id = str(request.research_credential_id) if request.research_credential_id else None
            row.research_profile_id = str(request.research_profile_id) if request.research_profile_id else None
            row.research_model = request.research_model
            row.updated_by = str(actor.user_id) if getattr(actor, "user_id", None) else None
            row.updated_at = now
        return self.get(organization_id)

    async def _validate_route(self, prefix: str, profile_id: UUID | None, model: str | None) -> None:
        if profile_id is None:
            if model is not None:
                raise AiSettingsValidationError(f"select a {prefix} provider before choosing a model")
            return
        try:
            profile = self.repository.get_profile(profile_id)
        except ProfileNotFoundError as exc:
            raise AiSettingsValidationError(f"the selected {prefix} provider was not found") from exc
        if not profile.supports(Capability.TEXT_GENERATION):
            raise AiSettingsValidationError(f"the selected {prefix} provider has no text-generation model")
        # A model id the live catalog does not list is still accepted: owners may type a
        # custom or newly released id. Its format was validated by AiSettingsUpdate.

    def effective_chat(self, organization_id: UUID, *, include_ids: bool) -> AiRoutePublic:
        settings = self.get(organization_id)
        with tenant_scope(organization_id):
            profile, source, model = None, "not_configured", None
            if settings.chat_profile_id is not None:
                try:
                    profile = self.repository.get_profile(settings.chat_profile_id)
                    source, model = "workspace_settings", settings.chat_model
                except ProfileNotFoundError:
                    profile = None
            if profile is None:
                selection = self.repository.get_default(Capability.TEXT_GENERATION)
                for candidate in (selection.ordered_profile_ids() if selection else ()):
                    try:
                        found = self.repository.get_profile(candidate)
                    except ProfileNotFoundError:
                        continue
                    if found.supports(Capability.TEXT_GENERATION):
                        profile, source = found, "workspace_default"
                        break
        if profile is None:
            return AiRoutePublic(source="not_configured")
        return AiRoutePublic(
            profile_id=profile.id if include_ids else None, profile_name=profile.name,
            provider=provider_label(profile),
            model=model or profile.models.get(Capability.TEXT_GENERATION), source=source,
        )

    def public(self, organization_id: UUID, actor: object) -> AiSettingsPublic:
        is_owner = getattr(actor, "role", None) == "owner"
        settings = self.get(organization_id)
        effective = self.effective_chat(organization_id, include_ids=is_owner)
        flags = {
            "vision_configured": settings.vision_profile_id is not None,
            "research_configured": settings.research_credential_id is not None,
        }
        if not is_owner:
            return AiSettingsPublic(can_edit=False, effective_chat=effective, **flags)
        label = None
        if settings.research_credential_id is not None:
            try:
                label = self.vault.get(organization_id, settings.research_credential_id).label
            except CredentialNotFoundError:
                label = None
        return AiSettingsPublic(
            can_edit=True, chat_profile_id=settings.chat_profile_id, chat_model=settings.chat_model,
            vision_profile_id=settings.vision_profile_id, vision_model=settings.vision_model,
            research_credential_id=settings.research_credential_id, research_credential_label=label,
            research_profile_id=settings.research_profile_id, research_model=settings.research_model,
            updated_at=settings.updated_at, updated_by=settings.updated_by,
            effective_chat=effective, **flags,
        )

    async def public_view(self, organization_id: UUID, actor: object) -> AiSettingsPublic:
        """``public`` plus, for the owner, the model that "Automatic" vision resolves to."""
        view = self.public(organization_id, actor)
        if not view.can_edit or self.vision is None:
            return view
        return view.model_copy(update={"automatic_vision": await self.automatic_vision(organization_id)})

    async def automatic_vision(self, organization_id: UUID) -> AiRoutePublic:
        with tenant_scope(organization_id):
            route = await self.vision.automatic()
            if route is None:
                return AiRoutePublic(source="not_configured")
            try:
                profile = self.repository.get_profile(route.profile_id)
            except ProfileNotFoundError:
                return AiRoutePublic(source="not_configured")
        return AiRoutePublic(
            profile_id=profile.id, profile_name=profile.name, provider=provider_label(profile),
            model=route.model, source="workspace_default",
        )
