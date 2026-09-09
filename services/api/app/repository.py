"""Repository errors plus the in-memory test implementation."""

from threading import RLock
from uuid import UUID

from meetings_contracts import Capability, DefaultSelection, ProviderProfile


class ProfileNotFoundError(KeyError):
    pass


class MeetingNotFoundError(KeyError):
    pass


class InMemoryProviderRepository:
    def __init__(self) -> None:
        self._profiles: dict[UUID, ProviderProfile] = {}
        self._defaults: dict[Capability, DefaultSelection] = {}
        self._lock = RLock()

    def list_profiles(self) -> list[ProviderProfile]:
        with self._lock:
            return sorted(self._profiles.values(), key=lambda profile: profile.created_at)

    def get_profile(self, profile_id: UUID) -> ProviderProfile:
        with self._lock:
            try:
                return self._profiles[profile_id]
            except KeyError as exc:
                raise ProfileNotFoundError(profile_id) from exc

    def save_profile(self, profile: ProviderProfile) -> ProviderProfile:
        with self._lock:
            self._profiles[profile.id] = profile
        return profile

    def save_default(self, selection: DefaultSelection) -> DefaultSelection:
        with self._lock:
            self._defaults[selection.capability] = selection
        return selection

    def list_defaults(self) -> list[DefaultSelection]:
        with self._lock:
            return [self._defaults[key] for key in sorted(self._defaults, key=lambda item: item.value)]

    def get_default(self, capability: Capability) -> DefaultSelection | None:
        with self._lock:
            return self._defaults.get(capability)
