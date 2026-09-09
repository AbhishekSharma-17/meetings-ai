from datetime import UTC, datetime
from uuid import UUID

from meetings_contracts import (
    Capability,
    DefaultSelection,
    ExecutionLocation,
    FallbackPolicy,
    Meeting,
    MeetingPlatform,
    MeetingStatus,
    MeetingTranscriptSegment,
    ProviderProfile,
    ProviderType,
)

from .database import (
    Database,
    MeetingRow,
    ProviderDefaultRow,
    ProviderProfileRow,
    TranscriptSegmentRow,
)
from .repository import MeetingNotFoundError, ProfileNotFoundError
from .security import CredentialCipher


def _utc(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=UTC)


class SQLAlchemyRepository:
    def __init__(self, database: Database, cipher: CredentialCipher) -> None:
        self.database = database
        self.cipher = cipher

    def list_profiles(self) -> list[ProviderProfile]:
        with self.database.session_factory() as session:
            rows = session.query(ProviderProfileRow).order_by(ProviderProfileRow.created_at).all()
            return [self._profile_from_row(row) for row in rows]

    def get_profile(self, profile_id: UUID) -> ProviderProfile:
        with self.database.session_factory() as session:
            row = session.get(ProviderProfileRow, str(profile_id))
            if row is None:
                raise ProfileNotFoundError(profile_id)
            return self._profile_from_row(row)

    def save_profile(self, profile: ProviderProfile) -> ProviderProfile:
        with self.database.session_factory.begin() as session:
            row = session.get(ProviderProfileRow, str(profile.id))
            if row is None:
                row = ProviderProfileRow(id=str(profile.id))
                session.add(row)
            row.name = profile.name
            row.provider_type = profile.provider_type.value
            row.execution_location = profile.execution_location.value
            row.base_url = profile.base_url
            row.capabilities = {
                capability.value: model for capability, model in profile.models.items()
            }
            row.credential_ciphertext = self.cipher.encrypt(profile.api_key)
            row.created_at = profile.created_at
            row.updated_at = profile.updated_at
        return profile

    def _profile_from_row(self, row: ProviderProfileRow) -> ProviderProfile:
        return ProviderProfile(
            id=UUID(row.id),
            name=row.name,
            provider_type=ProviderType(row.provider_type),
            execution_location=ExecutionLocation(row.execution_location),
            base_url=row.base_url,
            models={Capability(key): value for key, value in row.capabilities.items()},
            api_key=self.cipher.decrypt(row.credential_ciphertext),
            created_at=_utc(row.created_at),
            updated_at=_utc(row.updated_at),
        )

    def save_default(self, selection: DefaultSelection) -> DefaultSelection:
        with self.database.session_factory.begin() as session:
            row = session.get(ProviderDefaultRow, selection.capability.value)
            if row is None:
                row = ProviderDefaultRow(capability=selection.capability.value)
                session.add(row)
            row.policy = selection.policy.value
            row.local_profile_id = (
                str(selection.local_profile_id) if selection.local_profile_id else None
            )
            row.cloud_profile_id = (
                str(selection.cloud_profile_id) if selection.cloud_profile_id else None
            )
        return selection

    def list_defaults(self) -> list[DefaultSelection]:
        with self.database.session_factory() as session:
            rows = session.query(ProviderDefaultRow).order_by(ProviderDefaultRow.capability).all()
            return [self._default_from_row(row) for row in rows]

    def get_default(self, capability: Capability) -> DefaultSelection | None:
        with self.database.session_factory() as session:
            row = session.get(ProviderDefaultRow, capability.value)
            return self._default_from_row(row) if row else None

    @staticmethod
    def _default_from_row(row: ProviderDefaultRow) -> DefaultSelection:
        return DefaultSelection(
            capability=Capability(row.capability),
            policy=FallbackPolicy(row.policy),
            local_profile_id=UUID(row.local_profile_id) if row.local_profile_id else None,
            cloud_profile_id=UUID(row.cloud_profile_id) if row.cloud_profile_id else None,
        )

    def list_meetings(self) -> list[Meeting]:
        with self.database.session_factory() as session:
            rows = session.query(MeetingRow).order_by(MeetingRow.created_at.desc()).all()
            return [self._meeting_from_row(row) for row in rows]

    def get_meeting(self, meeting_id: UUID) -> Meeting:
        with self.database.session_factory() as session:
            row = session.get(MeetingRow, str(meeting_id))
            if row is None:
                raise MeetingNotFoundError(meeting_id)
            return self._meeting_from_row(row)

    def replace_transcript(
        self, meeting_id: UUID, segments: list[MeetingTranscriptSegment]
    ) -> None:
        with self.database.session_factory.begin() as session:
            session.query(TranscriptSegmentRow).filter_by(
                meeting_id=str(meeting_id)
            ).delete()
            session.add_all(
                TranscriptSegmentRow(
                    meeting_id=str(meeting_id),
                    position=position,
                    start_seconds=segment.start_seconds,
                    end_seconds=segment.end_seconds,
                    text=segment.text,
                    speaker=segment.speaker,
                    language=segment.language,
                    completed=segment.completed,
                )
                for position, segment in enumerate(segments)
            )

    def get_transcript(self, meeting_id: UUID) -> list[MeetingTranscriptSegment]:
        with self.database.session_factory() as session:
            rows = (
                session.query(TranscriptSegmentRow)
                .filter_by(meeting_id=str(meeting_id))
                .order_by(TranscriptSegmentRow.position)
                .all()
            )
            return [
                MeetingTranscriptSegment(
                    start_seconds=row.start_seconds,
                    end_seconds=row.end_seconds,
                    text=row.text,
                    speaker=row.speaker,
                    language=row.language,
                    completed=row.completed,
                )
                for row in rows
            ]

    def save_meeting(self, meeting: Meeting) -> Meeting:
        with self.database.session_factory.begin() as session:
            row = session.get(MeetingRow, str(meeting.id))
            if row is None:
                row = MeetingRow(id=str(meeting.id))
                session.add(row)
            row.meeting_url = meeting.meeting_url
            row.title = meeting.title
            row.bot_name = meeting.bot_name
            row.language = meeting.language
            row.transcribe_enabled = meeting.transcribe_enabled
            row.recording_enabled = meeting.recording_enabled
            row.platform = meeting.platform.value
            row.native_meeting_id = meeting.native_meeting_id
            row.status = meeting.status.value
            row.vexa_meeting_id = meeting.vexa_meeting_id
            row.last_error = meeting.last_error
            row.created_at = meeting.created_at
            row.updated_at = meeting.updated_at
            row.joined_at = meeting.joined_at
            row.stopped_at = meeting.stopped_at
            row.last_refreshed_at = meeting.last_refreshed_at
        return meeting

    @staticmethod
    def _meeting_from_row(row: MeetingRow) -> Meeting:
        return Meeting(
            id=UUID(row.id),
            meeting_url=row.meeting_url,
            title=row.title,
            bot_name=row.bot_name,
            language=row.language,
            transcribe_enabled=row.transcribe_enabled,
            recording_enabled=row.recording_enabled,
            platform=MeetingPlatform(row.platform),
            native_meeting_id=row.native_meeting_id,
            status=MeetingStatus(row.status),
            vexa_meeting_id=row.vexa_meeting_id,
            last_error=row.last_error,
            created_at=_utc(row.created_at),
            updated_at=_utc(row.updated_at),
            joined_at=_utc(row.joined_at),
            stopped_at=_utc(row.stopped_at),
            last_refreshed_at=_utc(row.last_refreshed_at),
        )
