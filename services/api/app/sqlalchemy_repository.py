import json
import re
from hashlib import sha256
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, select

from meetings_contracts import (
    ActionItem,
    AttributedQuestion,
    Capability,
    DefaultSelection,
    EmailDelivery,
    ExecutionLocation,
    FallbackPolicy,
    Meeting,
    MeetingDeliverySettings,
    MeetingMinutes,
    MeetingPlatform,
    MeetingStatus,
    MeetingTranscriptSegment,
    SpeakerContribution,
    SpeakerIdentityPublic,
    MinutesStatus,
    ProviderProfile,
    ProviderType,
)

from .database import (
    CalendarScheduleRow,
    Database,
    EmailDeliveryRow,
    MeetingRow,
    MeetingTranscriptionRouteRow,
    MeetingKnowledgeSettingsRow,
    MeetingKnowledgeBaseRow,
    KnowledgeEmbeddingRow,
    KnowledgeIndexJobRow,
    KnowledgeBaseRow,
    KnowledgeConversationRow,
    KnowledgeMessageRow,
    MeetingDeliverySettingsRow,
    MeetingMinutesRow,
    MeetingMinutesEvidenceRow,
    MeetingSpeakerIdentityRow,
    PostMeetingJobRow,
    ProviderTenantRow,
    OrganizationProviderDefaultRow,
    MeetingTenantRow,
    ProviderProfileRow,
    TranscriptSegmentRow,
    TranscriptSegmentMetadataRow,
    TranscriptSpeakerCorrectionRow,
    TranscriptReviewStateRow,
    MinutesSourceRow,
)
from .repository import MeetingNotFoundError, MinutesNotFoundError, ProfileNotFoundError
from .security import CredentialCipher
from .tenant import current_organization_id


class TranscriptSegmentNotFoundError(LookupError):
    pass


class TranscriptReviewConflictError(RuntimeError):
    pass


class SpeakerIdentityConflictError(RuntimeError):
    pass


class MinutesDeletionConflictError(RuntimeError):
    pass


def _utc(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=UTC)


def _trusted_speaker(raw: str | None, source: str | None = None) -> str | None:
    """A technical cluster label is not a person's identity."""
    value = (raw or "").strip()
    if not value or source == "provisional-cluster-id":
        return None
    if re.fullmatch(r"(?:seg|spk|speaker|cluster)[_ -]?\d+", value, re.IGNORECASE):
        return None
    return value


class SQLAlchemyRepository:
    def __init__(self, database: Database, cipher: CredentialCipher) -> None:
        self.database = database
        self.cipher = cipher

    @staticmethod
    def _purge_knowledge_embeddings(session: object, meeting_id: UUID) -> None:
        session.execute(delete(KnowledgeEmbeddingRow).where(
            KnowledgeEmbeddingRow.meeting_id == str(meeting_id),
            KnowledgeEmbeddingRow.organization_id == str(current_organization_id()),
        ))
        SQLAlchemyRepository._queue_knowledge_index(session, meeting_id)

    @staticmethod
    def _queue_knowledge_index(session: object, meeting_id: UUID) -> None:
        meeting = session.get(MeetingRow, str(meeting_id))
        association = session.get(MeetingKnowledgeBaseRow, str(meeting_id))
        if meeting is None or meeting.status != MeetingStatus.COMPLETED.value or association is None:
            return
        base = session.get(KnowledgeBaseRow, association.knowledge_base_id)
        if base is None or base.organization_id != str(current_organization_id()):
            return
        now = datetime.now(UTC)
        job = session.get(KnowledgeIndexJobRow, association.knowledge_base_id)
        if job is None:
            session.add(KnowledgeIndexJobRow(
                knowledge_base_id=association.knowledge_base_id,
                organization_id=base.organization_id, status="pending", attempts=0,
                requested_at=now, started_at=None, completed_at=None,
                next_retry_at=None, last_error=None,
            ))
        else:
            job.status = "pending"
            job.attempts = 0
            job.requested_at = now
            job.next_retry_at = None
            job.last_error = None

    @staticmethod
    def _delete_cited_conversations(session: object, meeting_id: UUID) -> None:
        key = str(meeting_id)
        messages = session.execute(select(KnowledgeMessageRow).join(
            KnowledgeConversationRow, KnowledgeMessageRow.conversation_id == KnowledgeConversationRow.id,
        ).join(KnowledgeBaseRow, KnowledgeConversationRow.knowledge_base_id == KnowledgeBaseRow.id).where(
            KnowledgeBaseRow.organization_id == str(current_organization_id()),
        )).scalars().all()
        cited_conversations = {
            message.conversation_id for message in messages
            if any(isinstance(citation, dict) and citation.get("meeting_id") == key
                   for citation in (message.citations or []))
        }
        if cited_conversations:
            session.execute(delete(KnowledgeMessageRow).where(
                KnowledgeMessageRow.conversation_id.in_(cited_conversations)))
            session.execute(delete(KnowledgeConversationRow).where(
                KnowledgeConversationRow.id.in_(cited_conversations)))

    def list_profiles(self) -> list[ProviderProfile]:
        with self.database.session_factory() as session:
            rows = session.query(ProviderProfileRow).join(
                ProviderTenantRow, ProviderTenantRow.provider_id == ProviderProfileRow.id
            ).filter(ProviderTenantRow.organization_id == str(current_organization_id())).order_by(ProviderProfileRow.created_at).all()
            return [self._profile_from_row(row) for row in rows]

    def get_profile(self, profile_id: UUID) -> ProviderProfile:
        with self.database.session_factory() as session:
            row = session.get(ProviderProfileRow, str(profile_id))
            owner = session.get(ProviderTenantRow, str(profile_id))
            if row is None or owner is None or owner.organization_id != str(current_organization_id()):
                raise ProfileNotFoundError(profile_id)
            return self._profile_from_row(row)

    def save_profile(self, profile: ProviderProfile) -> ProviderProfile:
        with self.database.session_factory.begin() as session:
            row = session.get(ProviderProfileRow, str(profile.id))
            owner = session.get(ProviderTenantRow, str(profile.id))
            if row is None:
                row = ProviderProfileRow(id=str(profile.id))
                session.add(row)
                session.add(ProviderTenantRow(
                    provider_id=str(profile.id), organization_id=str(current_organization_id()),
                ))
            elif owner is None or owner.organization_id != str(current_organization_id()):
                raise ProfileNotFoundError(profile.id)
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

    def delete_profile(self, profile_id: UUID) -> None:
        """Remove a configuration; preserve historical meeting/model snapshots."""
        with self.database.session_factory.begin() as session:
            row = session.get(ProviderProfileRow, str(profile_id))
            owner = session.get(ProviderTenantRow, str(profile_id))
            if row is None or owner is None or owner.organization_id != str(current_organization_id()):
                raise ProfileNotFoundError(profile_id)
            for default in session.query(OrganizationProviderDefaultRow).filter_by(
                organization_id=str(current_organization_id())
            ).all():
                if default.local_profile_id == str(profile_id):
                    default.local_profile_id = None
                if default.cloud_profile_id == str(profile_id):
                    default.cloud_profile_id = None
                if not default.local_profile_id and not default.cloud_profile_id:
                    session.delete(default)
                elif not default.local_profile_id:
                    default.policy = FallbackPolicy.CLOUD_ONLY.value
                elif not default.cloud_profile_id:
                    default.policy = FallbackPolicy.LOCAL_ONLY.value
            for base in session.query(KnowledgeBaseRow).filter_by(
                text_profile_id=str(profile_id), organization_id=str(current_organization_id())
            ).all():
                base.text_profile_id = None
            session.execute(delete(KnowledgeEmbeddingRow).where(
                KnowledgeEmbeddingRow.organization_id == str(current_organization_id()),
                KnowledgeEmbeddingRow.profile_id == str(profile_id),
            ))
            session.delete(owner)
            session.delete(row)

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
        for profile_id in selection.ordered_profile_ids():
            self.get_profile(profile_id)
        with self.database.session_factory.begin() as session:
            key = (str(current_organization_id()), selection.capability.value)
            row = session.get(OrganizationProviderDefaultRow, key)
            if row is None:
                row = OrganizationProviderDefaultRow(
                    organization_id=key[0], capability=key[1],
                )
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
            rows = session.query(OrganizationProviderDefaultRow).filter_by(
                organization_id=str(current_organization_id())
            ).order_by(OrganizationProviderDefaultRow.capability).all()
            return [self._default_from_row(row) for row in rows]

    def get_default(self, capability: Capability) -> DefaultSelection | None:
        with self.database.session_factory() as session:
            row = session.get(OrganizationProviderDefaultRow, (str(current_organization_id()), capability.value))
            return self._default_from_row(row) if row else None

    @staticmethod
    def _default_from_row(row: OrganizationProviderDefaultRow) -> DefaultSelection:
        return DefaultSelection(
            capability=Capability(row.capability),
            policy=FallbackPolicy(row.policy),
            local_profile_id=UUID(row.local_profile_id) if row.local_profile_id else None,
            cloud_profile_id=UUID(row.cloud_profile_id) if row.cloud_profile_id else None,
        )

    def list_meetings(self) -> list[Meeting]:
        with self.database.session_factory() as session:
            rows = session.query(MeetingRow).join(
                MeetingTenantRow, MeetingTenantRow.meeting_id == MeetingRow.id
            ).filter(MeetingTenantRow.organization_id == str(current_organization_id())).order_by(MeetingRow.created_at.desc()).all()
            settings = {
                row.meeting_id: row for row in session.query(MeetingKnowledgeSettingsRow)
                .filter(MeetingKnowledgeSettingsRow.meeting_id.in_([item.id for item in rows])).all()
            } if rows else {}
            bases = {
                row.meeting_id: row for row in session.query(MeetingKnowledgeBaseRow)
                .filter(MeetingKnowledgeBaseRow.meeting_id.in_([item.id for item in rows])).all()
            } if rows else {}
            return [self._meeting_from_row(row, settings.get(row.id), bases.get(row.id)) for row in rows]

    def get_meeting(self, meeting_id: UUID) -> Meeting:
        with self.database.session_factory() as session:
            row = session.get(MeetingRow, str(meeting_id))
            owner = session.get(MeetingTenantRow, str(meeting_id))
            if row is None or owner is None or owner.organization_id != str(current_organization_id()):
                raise MeetingNotFoundError(meeting_id)
            knowledge = session.get(MeetingKnowledgeSettingsRow, str(meeting_id))
            base = session.get(MeetingKnowledgeBaseRow, str(meeting_id))
            return self._meeting_from_row(row, knowledge, base)

    def delete_meeting(self, meeting_id: UUID) -> None:
        """Erase one tenant-owned meeting and all product-side derived copies.

        A saved answer can contain verbatim meeting evidence. Delete its whole
        conversation when any citation points at this meeting, rather than
        leaving an orphaned answer with missing source attribution.
        """
        key = str(meeting_id)
        org = str(current_organization_id())
        with self.database.session_factory.begin() as session:
            row = session.get(MeetingRow, key)
            owner = session.get(MeetingTenantRow, key)
            if row is None or owner is None or owner.organization_id != org:
                raise MeetingNotFoundError(meeting_id)
            self._queue_knowledge_index(session, meeting_id)
            self._delete_cited_conversations(session, meeting_id)
            for model in (
                CalendarScheduleRow, KnowledgeEmbeddingRow, MeetingKnowledgeBaseRow, MeetingKnowledgeSettingsRow,
                MeetingDeliverySettingsRow, PostMeetingJobRow, TranscriptSegmentRow,
                TranscriptSegmentMetadataRow, TranscriptSpeakerCorrectionRow,
                MeetingSpeakerIdentityRow, TranscriptReviewStateRow, MinutesSourceRow,
                MeetingMinutesEvidenceRow, MeetingMinutesRow, EmailDeliveryRow,
                MeetingTranscriptionRouteRow, MeetingTenantRow,
            ):
                session.execute(delete(model).where(model.meeting_id == key))
            session.delete(row)

    def list_worker_scopes(self) -> list[tuple[UUID, UUID]]:
        """Enumerate jobs for the worker; processing still runs in tenant scope."""
        with self.database.session_factory() as session:
            rows = session.execute(select(MeetingTenantRow.organization_id, MeetingTenantRow.meeting_id)
                                   .join(PostMeetingJobRow, PostMeetingJobRow.meeting_id == MeetingTenantRow.meeting_id)).all()
            return [(UUID(org_id), UUID(meeting_id)) for org_id, meeting_id in rows]

    def get_delivery_settings(self, meeting_id: UUID) -> MeetingDeliverySettings:
        self.get_meeting(meeting_id)
        with self.database.session_factory() as session:
            row = session.get(MeetingDeliverySettingsRow, str(meeting_id))
            if row is None:
                return MeetingDeliverySettings()
            return MeetingDeliverySettings(
                internal_recipients=row.internal_recipients,
                participant_recipients=row.participant_recipients,
                send_to_participants=row.send_to_participants,
                include_transcript=row.include_transcript,
            )

    def save_delivery_settings(
        self, meeting_id: UUID, settings: MeetingDeliverySettings
    ) -> MeetingDeliverySettings:
        self.get_meeting(meeting_id)
        with self.database.session_factory.begin() as session:
            row = session.get(MeetingDeliverySettingsRow, str(meeting_id))
            if row is None:
                row = MeetingDeliverySettingsRow(meeting_id=str(meeting_id))
                session.add(row)
            row.internal_recipients = settings.internal_recipients
            row.participant_recipients = settings.participant_recipients
            row.send_to_participants = settings.send_to_participants
            row.include_transcript = settings.include_transcript
        return settings

    def get_post_meeting_job(self, meeting_id: UUID) -> PostMeetingJobRow | None:
        self.get_meeting(meeting_id)
        with self.database.session_factory() as session:
            row = session.get(PostMeetingJobRow, str(meeting_id))
            if row is None:
                return None
            session.expunge(row)
            return row

    def initialize_post_meeting_job(self, meeting_id: UUID) -> None:
        self.get_meeting(meeting_id)
        with self.database.session_factory.begin() as session:
            if session.get(PostMeetingJobRow, str(meeting_id)) is None:
                session.add(PostMeetingJobRow(
                    meeting_id=str(meeting_id), attempts=0, next_retry_at=None,
                    last_error=None, completed_at=None,
                ))

    def save_post_meeting_job(
        self, meeting_id: UUID, *, attempts: int, next_retry_at: datetime | None,
        last_error: str | None, completed_at: datetime | None,
    ) -> None:
        self.get_meeting(meeting_id)
        with self.database.session_factory.begin() as session:
            row = session.get(PostMeetingJobRow, str(meeting_id))
            if row is None:
                row = PostMeetingJobRow(meeting_id=str(meeting_id))
                session.add(row)
            row.attempts = attempts
            row.next_retry_at = next_retry_at
            row.last_error = last_error
            row.completed_at = completed_at

    def replace_transcript(
        self, meeting_id: UUID, segments: list[MeetingTranscriptSegment]
    ) -> None:
        self.get_meeting(meeting_id)
        normalized = []
        for position, segment in enumerate(segments):
            if not segment.segment_id:
                identity = f"{position}:{segment.start_seconds}:{segment.end_seconds}:{segment.text}"
                segment = segment.model_copy(update={
                    "segment_id": f"legacy-{sha256(identity.encode()).hexdigest()[:32]}"
                })
            normalized.append(segment)
        fingerprint = sha256(json.dumps([
            [item.segment_id, item.start_seconds, item.end_seconds, item.text,
             item.speaker, item.completed, item.attribution_source]
            for item in normalized
        ], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        with self.database.session_factory.begin() as session:
            state = session.get(TranscriptReviewStateRow, str(meeting_id))
            if state is not None and state.fingerprint == fingerprint:
                return
            self._purge_knowledge_embeddings(session, meeting_id)
            self._delete_cited_conversations(session, meeting_id)
            session.query(TranscriptSegmentRow).filter_by(
                meeting_id=str(meeting_id)
            ).delete()
            session.query(TranscriptSegmentMetadataRow).filter_by(
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
                for position, segment in enumerate(normalized)
            )
            session.add_all(
                TranscriptSegmentMetadataRow(
                    meeting_id=str(meeting_id), segment_id=segment.segment_id,
                    position=position, speaker_key=segment.speaker_key,
                    attribution_source=segment.attribution_source,
                )
                for position, segment in enumerate(normalized)
            )
            if state is None:
                session.add(TranscriptReviewStateRow(
                    meeting_id=str(meeting_id), revision=1, fingerprint=fingerprint,
                ))
            elif state.fingerprint != fingerprint:
                state.revision += 1
                state.fingerprint = fingerprint
                self._invalidate_approved_minutes(session, meeting_id)

    def get_transcript(self, meeting_id: UUID) -> list[MeetingTranscriptSegment]:
        self.get_meeting(meeting_id)
        with self.database.session_factory() as session:
            rows = (
                session.query(TranscriptSegmentRow)
                .filter_by(meeting_id=str(meeting_id))
                .order_by(TranscriptSegmentRow.position)
                .all()
            )
            metadata = {
                row.position: row for row in session.query(TranscriptSegmentMetadataRow)
                .filter_by(meeting_id=str(meeting_id)).all()
            }
            corrections = {
                row.segment_id: row for row in session.query(TranscriptSpeakerCorrectionRow)
                .filter_by(meeting_id=str(meeting_id)).all()
            }
            return [
                MeetingTranscriptSegment(
                    segment_id=metadata[row.position].segment_id if row.position in metadata else None,
                    start_seconds=row.start_seconds,
                    end_seconds=row.end_seconds,
                    text=row.text,
                    speaker=(corrections[metadata[row.position].segment_id].display_name
                             if row.position in metadata and metadata[row.position].segment_id in corrections
                             else _trusted_speaker(row.speaker, metadata[row.position].attribution_source if row.position in metadata else None)),
                    raw_speaker=row.speaker,
                    speaker_key=metadata[row.position].speaker_key if row.position in metadata else None,
                    attribution_source=metadata[row.position].attribution_source if row.position in metadata else None,
                    speaker_reviewed=(row.position in metadata and metadata[row.position].segment_id in corrections),
                    language=row.language,
                    completed=row.completed,
                )
                for row in rows
            ]

    def correct_speaker(
        self, meeting_id: UUID, segment_id: str, display_name: str | None,
        apply_to_raw_label: bool = False,
    ) -> None:
        self.get_meeting(meeting_id)
        with self.database.session_factory.begin() as session:
            metadata = session.get(TranscriptSegmentMetadataRow, (str(meeting_id), segment_id))
            if metadata is None:
                raise TranscriptSegmentNotFoundError(segment_id)
            minutes = session.get(MeetingMinutesRow, str(meeting_id))
            if minutes and minutes.status == MinutesStatus.SENT.value:
                raise TranscriptReviewConflictError("sent MOM is locked; speaker corrections require a new version")
            raw = session.query(TranscriptSegmentRow).filter_by(
                meeting_id=str(meeting_id), position=metadata.position,
            ).one().speaker
            targets = [metadata]
            if apply_to_raw_label and raw:
                positions = [row.position for row in session.query(TranscriptSegmentRow)
                             .filter_by(meeting_id=str(meeting_id), speaker=raw).all()]
                targets = session.query(TranscriptSegmentMetadataRow).filter(
                    TranscriptSegmentMetadataRow.meeting_id == str(meeting_id),
                    TranscriptSegmentMetadataRow.position.in_(positions),
                ).all()
            changed = False
            for target in targets:
                key = (str(meeting_id), target.segment_id)
                existing = session.get(TranscriptSpeakerCorrectionRow, key)
                if display_name is None:
                    if existing:
                        session.delete(existing)
                        changed = True
                elif existing is None:
                    session.add(TranscriptSpeakerCorrectionRow(
                        meeting_id=str(meeting_id), segment_id=target.segment_id,
                        display_name=display_name, reviewed_at=datetime.now(UTC),
                    ))
                    changed = True
                elif existing.display_name != display_name:
                    existing.display_name = display_name
                    existing.reviewed_at = datetime.now(UTC)
                    changed = True
            if changed:
                self._purge_knowledge_embeddings(session, meeting_id)
                self._delete_cited_conversations(session, meeting_id)
                state = session.get(TranscriptReviewStateRow, str(meeting_id))
                if state is None:
                    state = TranscriptReviewStateRow(meeting_id=str(meeting_id), revision=0, fingerprint="")
                    session.add(state)
                state.revision += 1
                self._invalidate_approved_minutes(session, meeting_id)

    @staticmethod
    def _invalidate_approved_minutes(session: object, meeting_id: UUID) -> None:
        minutes = session.get(MeetingMinutesRow, str(meeting_id))
        if minutes and minutes.status == MinutesStatus.APPROVED.value:
            minutes.status = MinutesStatus.DRAFT.value
            minutes.approved_at = None
            minutes.last_error = "Transcript attribution changed; regenerate MOM before approval."
            minutes.updated_at = datetime.now(UTC)

    def get_transcript_revision(self, meeting_id: UUID) -> int:
        self.get_meeting(meeting_id)
        with self.database.session_factory() as session:
            state = session.get(TranscriptReviewStateRow, str(meeting_id))
            return state.revision if state else 0

    def list_speaker_identities(self, meeting_id: UUID) -> list[SpeakerIdentityPublic]:
        self.get_meeting(meeting_id)
        current = {segment.speaker for segment in self.get_transcript(meeting_id) if segment.speaker}
        with self.database.session_factory() as session:
            rows = session.query(MeetingSpeakerIdentityRow).filter_by(meeting_id=str(meeting_id)).all()
            return [SpeakerIdentityPublic(
                speaker=row.speaker, email=row.email, confirmed_at=_utc(row.confirmed_at),
            ) for row in rows if row.speaker in current]

    def save_speaker_identity(
        self, meeting_id: UUID, speaker: str, email: str | None
    ) -> list[SpeakerIdentityPublic]:
        self.get_meeting(meeting_id)
        current = {segment.speaker for segment in self.get_transcript(meeting_id) if segment.speaker}
        if speaker not in current:
            raise SpeakerIdentityConflictError("speaker must first be named in this meeting transcript")
        with self.database.session_factory.begin() as session:
            row = session.get(MeetingSpeakerIdentityRow, (str(meeting_id), speaker))
            if email is None:
                if row:
                    session.delete(row)
            elif row is None:
                session.add(MeetingSpeakerIdentityRow(
                    meeting_id=str(meeting_id), speaker=speaker,
                    email=email, confirmed_at=datetime.now(UTC),
                ))
            else:
                row.email = email
                row.confirmed_at = datetime.now(UTC)
        return self.list_speaker_identities(meeting_id)

    def save_minutes_source_revision(self, meeting_id: UUID, revision: int) -> None:
        self.get_meeting(meeting_id)
        with self.database.session_factory.begin() as session:
            row = session.get(MinutesSourceRow, str(meeting_id))
            if row is None:
                row = MinutesSourceRow(meeting_id=str(meeting_id))
                session.add(row)
            row.transcript_revision = revision

    def get_minutes_source_revision(self, meeting_id: UUID) -> int | None:
        self.get_meeting(meeting_id)
        with self.database.session_factory() as session:
            row = session.get(MinutesSourceRow, str(meeting_id))
            return row.transcript_revision if row else None

    def get_minutes(self, meeting_id: UUID) -> MeetingMinutes:
        self.get_meeting(meeting_id)
        with self.database.session_factory() as session:
            row = session.get(MeetingMinutesRow, str(meeting_id))
            if row is None:
                raise MinutesNotFoundError(meeting_id)
            evidence = session.get(MeetingMinutesEvidenceRow, str(meeting_id))
            minutes = self._minutes_from_row(row)
            if evidence:
                minutes.speaker_contributions = [
                    SpeakerContribution.model_validate(item)
                    for item in evidence.speaker_contributions or []
                ]
                minutes.questions_asked = [
                    AttributedQuestion.model_validate(item)
                    for item in evidence.questions_asked or []
                ]
            return minutes

    def delete_minutes(self, meeting_id: UUID) -> None:
        self.get_meeting(meeting_id)
        with self.database.session_factory.begin() as session:
            row = session.get(MeetingMinutesRow, str(meeting_id))
            if row is None:
                raise MinutesNotFoundError(meeting_id)
            if row.status == MinutesStatus.SENT.value:
                raise MinutesDeletionConflictError(
                    "a sent MOM cannot be removed alone; delete the entire meeting record after confirming email recipients"
                )
            self._purge_knowledge_embeddings(session, meeting_id)
            self._delete_cited_conversations(session, meeting_id)
            for model in (MeetingMinutesEvidenceRow, MinutesSourceRow):
                session.execute(delete(model).where(model.meeting_id == str(meeting_id)))
            session.delete(row)
            job = session.get(PostMeetingJobRow, str(meeting_id))
            if job is not None:
                job.completed_at = datetime.now(UTC)
                job.next_retry_at = None
                job.last_error = None

    def save_minutes(self, minutes: MeetingMinutes) -> MeetingMinutes:
        self.get_meeting(minutes.meeting_id)
        with self.database.session_factory.begin() as session:
            self._purge_knowledge_embeddings(session, minutes.meeting_id)
            self._delete_cited_conversations(session, minutes.meeting_id)
            row = session.get(MeetingMinutesRow, str(minutes.meeting_id))
            if row is None:
                row = MeetingMinutesRow(meeting_id=str(minutes.meeting_id))
                session.add(row)
            row.status = minutes.status.value
            row.title = minutes.title
            row.executive_summary = minutes.executive_summary
            row.discussion_points = minutes.discussion_points
            row.decisions = minutes.decisions
            row.action_items = [item.model_dump() for item in minutes.action_items]
            row.open_questions = minutes.open_questions
            row.provider_profile_id = (
                str(minutes.provider_profile_id) if minutes.provider_profile_id else None
            )
            row.provider = minutes.provider
            row.model = minutes.model
            row.last_error = minutes.last_error
            row.created_at = minutes.created_at
            row.updated_at = minutes.updated_at
            row.approved_at = minutes.approved_at
            row.sent_at = minutes.sent_at
            evidence = session.get(MeetingMinutesEvidenceRow, str(minutes.meeting_id))
            if evidence is None:
                evidence = MeetingMinutesEvidenceRow(meeting_id=str(minutes.meeting_id))
                session.add(evidence)
            evidence.speaker_contributions = [item.model_dump() for item in minutes.speaker_contributions]
            evidence.questions_asked = [item.model_dump() for item in minutes.questions_asked]
        return minutes

    def save_email_delivery(self, delivery: EmailDelivery) -> EmailDelivery:
        self.get_meeting(delivery.meeting_id)
        with self.database.session_factory.begin() as session:
            session.add(
                EmailDeliveryRow(
                    id=str(delivery.id),
                    meeting_id=str(delivery.meeting_id),
                    recipients=delivery.recipients,
                    status=delivery.status,
                    provider_message_id=delivery.provider_message_id,
                    error=delivery.error,
                    created_at=delivery.created_at,
                )
            )
        return delivery

    def save_meeting(self, meeting: Meeting) -> Meeting:
        with self.database.session_factory.begin() as session:
            row = session.get(MeetingRow, str(meeting.id))
            owner = session.get(MeetingTenantRow, str(meeting.id))
            if row is None:
                row = MeetingRow(id=str(meeting.id))
                session.add(row)
                session.add(MeetingTenantRow(
                    meeting_id=str(meeting.id), organization_id=str(current_organization_id()),
                ))
            elif owner is None or owner.organization_id != str(current_organization_id()):
                raise MeetingNotFoundError(meeting.id)
            row.meeting_url = meeting.meeting_url
            row.title = meeting.title
            row.bot_name = meeting.bot_name
            row.language = meeting.language
            row.transcribe_enabled = meeting.transcribe_enabled
            row.recording_enabled = meeting.recording_enabled
            row.platform = meeting.platform.value
            row.native_meeting_id = meeting.native_meeting_id
            was_completed = row.status == MeetingStatus.COMPLETED.value if row.status else False
            row.status = meeting.status.value
            row.vexa_meeting_id = meeting.vexa_meeting_id
            row.last_error = meeting.last_error
            row.created_at = meeting.created_at
            row.updated_at = meeting.updated_at
            row.joined_at = meeting.joined_at
            row.stopped_at = meeting.stopped_at
            row.last_refreshed_at = meeting.last_refreshed_at
            knowledge = session.get(MeetingKnowledgeSettingsRow, str(meeting.id))
            if knowledge is None:
                knowledge = MeetingKnowledgeSettingsRow(
                    meeting_id=str(meeting.id), organization_id=str(current_organization_id()),
                    tags=meeting.tags, knowledge_enabled=meeting.knowledge_enabled,
                    updated_at=datetime.now(UTC),
                )
                session.add(knowledge)
            if meeting.status is MeetingStatus.COMPLETED and not was_completed:
                self._queue_knowledge_index(session, meeting.id)
        return meeting

    def save_knowledge_settings(
        self, meeting_id: UUID, *, tags: list[str], knowledge_enabled: bool,
    ) -> None:
        self.get_meeting(meeting_id)
        with self.database.session_factory.begin() as session:
            self._purge_knowledge_embeddings(session, meeting_id)
            if not knowledge_enabled:
                self._delete_cited_conversations(session, meeting_id)
            row = session.get(MeetingKnowledgeSettingsRow, str(meeting_id))
            if row is None:
                row = MeetingKnowledgeSettingsRow(
                    meeting_id=str(meeting_id), organization_id=str(current_organization_id())
                )
                session.add(row)
            elif row.organization_id != str(current_organization_id()):
                raise MeetingNotFoundError(meeting_id)
            row.tags = tags
            row.knowledge_enabled = knowledge_enabled
            row.updated_at = datetime.now(UTC)

    def save_transcription_route(
        self, meeting_id: UUID, profile: ProviderProfile, endpoint_host: str,
    ) -> None:
        self.get_meeting(meeting_id)
        self.get_profile(profile.id)
        with self.database.session_factory.begin() as session:
            row = session.get(MeetingTranscriptionRouteRow, str(meeting_id))
            if row is None:
                row = MeetingTranscriptionRouteRow(meeting_id=str(meeting_id))
                session.add(row)
            row.profile_id = str(profile.id)
            row.profile_name = profile.name
            row.provider_type = profile.provider_type.value
            row.model = profile.models[Capability.TRANSCRIPTION]
            row.endpoint_host = endpoint_host
            row.selected_at = datetime.now(UTC)

    def get_transcription_route(self, meeting_id: UUID) -> dict[str, object] | None:
        self.get_meeting(meeting_id)
        with self.database.session_factory() as session:
            row = session.get(MeetingTranscriptionRouteRow, str(meeting_id))
            if row is None:
                return None
            return {
                "profile_id": row.profile_id,
                "profile_name": row.profile_name,
                "provider_type": row.provider_type,
                "model": row.model,
                "endpoint_host": row.endpoint_host,
                "selected_at": _utc(row.selected_at),
            }

    def clear_transcription_route(self, meeting_id: UUID) -> None:
        self.get_meeting(meeting_id)
        with self.database.session_factory.begin() as session:
            row = session.get(MeetingTranscriptionRouteRow, str(meeting_id))
            if row is not None:
                session.delete(row)

    @staticmethod
    def _meeting_from_row(
        row: MeetingRow, knowledge: MeetingKnowledgeSettingsRow | None = None,
        base: MeetingKnowledgeBaseRow | None = None,
    ) -> Meeting:
        return Meeting(
            id=UUID(row.id),
            meeting_url=row.meeting_url,
            title=row.title,
            bot_name=row.bot_name,
            language=row.language,
            transcribe_enabled=row.transcribe_enabled,
            recording_enabled=row.recording_enabled,
            tags=list(knowledge.tags) if knowledge else [],
            knowledge_enabled=knowledge.knowledge_enabled if knowledge else False,
            knowledge_base_id=UUID(base.knowledge_base_id) if base else None,
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

    @staticmethod
    def _minutes_from_row(row: MeetingMinutesRow) -> MeetingMinutes:
        return MeetingMinutes(
            meeting_id=UUID(row.meeting_id),
            title=row.title,
            executive_summary=row.executive_summary,
            discussion_points=list(row.discussion_points or []),
            decisions=list(row.decisions or []),
            action_items=[ActionItem.model_validate(item) for item in row.action_items or []],
            open_questions=list(row.open_questions or []),
            status=MinutesStatus(row.status),
            provider_profile_id=(UUID(row.provider_profile_id) if row.provider_profile_id else None),
            provider=row.provider,
            model=row.model,
            created_at=_utc(row.created_at),
            updated_at=_utc(row.updated_at),
            approved_at=_utc(row.approved_at),
            sent_at=_utc(row.sent_at),
            last_error=row.last_error,
        )
