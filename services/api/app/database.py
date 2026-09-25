"""SQLAlchemy database and additive, versioned product schema migrations."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    inspect,
    insert,
    select,
    text,
)
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from sqlalchemy.pool import StaticPool


class Base(DeclarativeBase):
    pass


class ProviderProfileRow(Base):
    __tablename__ = "provider_profiles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    provider_type: Mapped[str] = mapped_column(String(40), nullable=False)
    execution_location: Mapped[str] = mapped_column(String(20), nullable=False)
    base_url: Mapped[str | None] = mapped_column(Text)
    capabilities: Mapped[dict[str, str]] = mapped_column(JSON, nullable=False)
    credential_ciphertext: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ProviderDefaultRow(Base):
    __tablename__ = "provider_defaults"

    capability: Mapped[str] = mapped_column(String(40), primary_key=True)
    policy: Mapped[str] = mapped_column(String(40), nullable=False)
    local_profile_id: Mapped[str | None] = mapped_column(String(36))
    cloud_profile_id: Mapped[str | None] = mapped_column(String(36))


class ProviderTenantRow(Base):
    __tablename__ = "provider_tenants"

    provider_id: Mapped[str] = mapped_column(String(36), ForeignKey("provider_profiles.id"), primary_key=True)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), nullable=False, index=True)


class OrganizationProviderDefaultRow(Base):
    __tablename__ = "organization_provider_defaults"

    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), primary_key=True)
    capability: Mapped[str] = mapped_column(String(40), primary_key=True)
    policy: Mapped[str] = mapped_column(String(40), nullable=False)
    local_profile_id: Mapped[str | None] = mapped_column(String(36))
    cloud_profile_id: Mapped[str | None] = mapped_column(String(36))


class MeetingRow(Base):
    __tablename__ = "meetings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    meeting_url: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(String(200))
    bot_name: Mapped[str] = mapped_column(String(100), nullable=False)
    language: Mapped[str | None] = mapped_column(String(35))
    transcribe_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    recording_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    platform: Mapped[str] = mapped_column(String(30), nullable=False)
    native_meeting_id: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    vexa_meeting_id: Mapped[int | None] = mapped_column(BigInteger, index=True)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    joined_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    stopped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_refreshed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MeetingTenantRow(Base):
    __tablename__ = "meeting_tenants"

    meeting_id: Mapped[str] = mapped_column(String(36), ForeignKey("meetings.id"), primary_key=True)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), nullable=False, index=True)


class MeetingTranscriptionRouteRow(Base):
    __tablename__ = "meeting_transcription_routes"

    meeting_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    profile_id: Mapped[str] = mapped_column(String(36), nullable=False)
    profile_name: Mapped[str] = mapped_column(String(100), nullable=False)
    provider_type: Mapped[str] = mapped_column(String(40), nullable=False)
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    endpoint_host: Mapped[str] = mapped_column(String(255), nullable=False)
    selected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class MeetingKnowledgeSettingsRow(Base):
    __tablename__ = "meeting_knowledge_settings"

    meeting_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), nullable=False, index=True)
    tags: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    knowledge_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class KnowledgeBaseRow(Base):
    __tablename__ = "knowledge_bases"
    __table_args__ = (UniqueConstraint("organization_id", "name"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))
    created_by: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    visibility: Mapped[str] = mapped_column(String(20), nullable=False)
    text_profile_id: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class KnowledgeBaseAccessRow(Base):
    __tablename__ = "knowledge_base_access"

    knowledge_base_id: Mapped[str] = mapped_column(String(36), ForeignKey("knowledge_bases.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), primary_key=True)
    access: Mapped[str] = mapped_column(String(20), nullable=False)


class KnowledgeEmbeddingRow(Base):
    __tablename__ = "knowledge_embeddings"
    __table_args__ = (UniqueConstraint("organization_id", "knowledge_base_id", "source_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), nullable=False, index=True)
    knowledge_base_id: Mapped[str] = mapped_column(String(36), ForeignKey("knowledge_bases.id"), nullable=False, index=True)
    meeting_id: Mapped[str] = mapped_column(String(36), ForeignKey("meetings.id"), nullable=False, index=True)
    source_id: Mapped[str] = mapped_column(String(40), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    profile_id: Mapped[str] = mapped_column(String(36), nullable=False)
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    dimensions: Mapped[int] = mapped_column(Integer, nullable=False)
    vector: Mapped[list[float]] = mapped_column(JSON, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class KnowledgeIndexJobRow(Base):
    __tablename__ = "knowledge_index_jobs"

    knowledge_base_id: Mapped[str] = mapped_column(String(36), ForeignKey("knowledge_bases.id"), primary_key=True)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)


class CalendarScheduleRow(Base):
    __tablename__ = "calendar_schedules"
    __table_args__ = (UniqueConstraint("organization_id", "connection_id", "event_id", "starts_at"),)

    meeting_id: Mapped[str] = mapped_column(String(36), ForeignKey("meetings.id"), primary_key=True)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    connection_id: Mapped[str] = mapped_column(String(100), nullable=False)
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    event_id: Mapped[str] = mapped_column(String(255), nullable=False)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class MeetingSourceRow(Base):
    __tablename__ = "meeting_sources"

    meeting_id: Mapped[str] = mapped_column(String(36), ForeignKey("meetings.id"), primary_key=True)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), nullable=False, index=True)
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    connection_id: Mapped[str] = mapped_column(String(100), nullable=False)
    event_id: Mapped[str] = mapped_column(String(255), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    meeting_url: Mapped[str] = mapped_column(Text, nullable=False)
    platform: Mapped[str] = mapped_column(String(30), nullable=False)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    agenda: Mapped[str | None] = mapped_column(Text)
    organizer: Mapped[str | None] = mapped_column(String(160))
    invitees: Mapped[list[dict]] = mapped_column(JSON, nullable=False)
    saved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class MeetingKnowledgeBaseRow(Base):
    __tablename__ = "meeting_knowledge_bases"

    meeting_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    knowledge_base_id: Mapped[str] = mapped_column(String(36), ForeignKey("knowledge_bases.id"), nullable=False, index=True)


class KnowledgeConversationRow(Base):
    __tablename__ = "knowledge_conversations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    knowledge_base_id: Mapped[str] = mapped_column(String(36), ForeignKey("knowledge_bases.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class KnowledgeMessageRow(Base):
    __tablename__ = "knowledge_messages"
    __table_args__ = (UniqueConstraint("conversation_id", "position"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(String(36), ForeignKey("knowledge_conversations.id"), nullable=False, index=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    citations: Mapped[list[dict]] = mapped_column(JSON, nullable=False)
    provider: Mapped[str | None] = mapped_column(String(100))
    model: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class MeetingDeliverySettingsRow(Base):
    __tablename__ = "meeting_delivery_settings"

    meeting_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    internal_recipients: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    participant_recipients: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    send_to_participants: Mapped[bool] = mapped_column(Boolean, nullable=False)
    include_transcript: Mapped[bool] = mapped_column(Boolean, nullable=False)


class PostMeetingJobRow(Base):
    __tablename__ = "post_meeting_jobs"

    meeting_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TranscriptSegmentRow(Base):
    __tablename__ = "transcript_segments"
    __table_args__ = (UniqueConstraint("meeting_id", "position"),)

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), primary_key=True)
    meeting_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    start_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    end_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    speaker: Mapped[str | None] = mapped_column(String(255))
    language: Mapped[str | None] = mapped_column(String(35))
    completed: Mapped[bool] = mapped_column(Boolean, nullable=False)


class TranscriptSegmentMetadataRow(Base):
    __tablename__ = "transcript_segment_metadata"
    __table_args__ = (UniqueConstraint("meeting_id", "position"),)

    meeting_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    segment_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    speaker_key: Mapped[str | None] = mapped_column(String(255))
    attribution_source: Mapped[str | None] = mapped_column(String(80))


class TranscriptSpeakerCorrectionRow(Base):
    __tablename__ = "transcript_speaker_corrections"

    meeting_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    segment_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    reviewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class MeetingSpeakerIdentityRow(Base):
    __tablename__ = "meeting_speaker_identities"

    meeting_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    speaker: Mapped[str] = mapped_column(String(200), primary_key=True)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    confirmed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class TranscriptReviewStateRow(Base):
    __tablename__ = "transcript_review_state"

    meeting_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)


class MinutesSourceRow(Base):
    __tablename__ = "minutes_source"

    meeting_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    transcript_revision: Mapped[int] = mapped_column(Integer, nullable=False)


class MeetingMinutesEvidenceRow(Base):
    __tablename__ = "meeting_minutes_evidence"

    meeting_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    speaker_contributions: Mapped[list[dict]] = mapped_column(JSON, nullable=False)
    questions_asked: Mapped[list[dict]] = mapped_column(JSON, nullable=False)


class MeetingMinutesRow(Base):
    __tablename__ = "meeting_minutes"

    meeting_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    status: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    executive_summary: Mapped[str] = mapped_column(Text, nullable=False)
    discussion_points: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    decisions: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    action_items: Mapped[list[dict[str, str | None]]] = mapped_column(JSON, nullable=False)
    open_questions: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    provider_profile_id: Mapped[str | None] = mapped_column(String(36))
    provider: Mapped[str | None] = mapped_column(String(100))
    model: Mapped[str | None] = mapped_column(String(200))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class EmailDeliveryRow(Base):
    __tablename__ = "email_deliveries"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    meeting_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    recipients: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    provider_message_id: Mapped[str | None] = mapped_column(String(255))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


LEGACY_ORGANIZATION_ID = UUID("00000000-0000-4000-8000-000000000001")
LEGACY_ADMIN_USER_ID = UUID("00000000-0000-4000-8000-000000000002")


class OrganizationRow(Base):
    __tablename__ = "organizations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    slug: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    contact_email: Mapped[str | None] = mapped_column(String(320))
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class CalendarEventCacheRow(Base):
    __tablename__ = "calendar_event_cache"
    __table_args__ = (UniqueConstraint("organization_id", "user_id", "connection_id", "event_id", "starts_at", name="uq_calendar_event_occurrence"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    connection_id: Mapped[str] = mapped_column(String(160), nullable=False)
    provider: Mapped[str] = mapped_column(String(40), nullable=False)
    event_id: Mapped[str] = mapped_column(String(500), nullable=False)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class CalendarSyncStateRow(Base):
    __tablename__ = "calendar_sync_state"

    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), primary_key=True)
    connection_id: Mapped[str] = mapped_column(String(160), primary_key=True)
    last_synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    range_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    range_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    truncated: Mapped[bool] = mapped_column(Boolean, nullable=False)


class OrganizationBriefRow(Base):
    __tablename__ = "organization_briefs"

    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), primary_key=True)
    website: Mapped[str | None] = mapped_column(String(500))
    overview: Mapped[str] = mapped_column(Text, nullable=False)
    services: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    products: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    differentiators: Mapped[str] = mapped_column(Text, nullable=False)
    positioning: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class OrganizationBriefDocumentRow(Base):
    __tablename__ = "organization_brief_documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), nullable=False, index=True)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), nullable=False)
    extracted_text: Mapped[str] = mapped_column(Text, nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class MeetingPrepRow(Base):
    __tablename__ = "meeting_preps"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    calendar_event_id: Mapped[str] = mapped_column(String(36), ForeignKey("calendar_event_cache.id"), nullable=False, index=True)
    context: Mapped[str] = mapped_column(Text, nullable=False)
    profile_urls: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    report: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class WorkspaceRetentionRow(Base):
    __tablename__ = "workspace_retention"

    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    meeting_days: Mapped[int | None] = mapped_column(Integer)
    chat_days: Mapped[int | None] = mapped_column(Integer)
    audit_days: Mapped[int | None] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class UserRow(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    email: Mapped[str | None] = mapped_column(String(320), unique=True)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    auth_subject: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class UserCredentialRow(Base):
    __tablename__ = "user_credentials"

    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), primary_key=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False)
    session_version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class OrganizationMembershipRow(Base):
    __tablename__ = "organization_memberships"

    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AuthRateLimitBucketRow(Base):
    __tablename__ = "auth_rate_limit_buckets"

    bucket_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False)
    expires_at_epoch: Mapped[int] = mapped_column(BigInteger, nullable=False)


class AuditEventRow(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    organization_id: Mapped[str | None] = mapped_column(String(36), index=True)
    actor_user_id: Mapped[str | None] = mapped_column(String(36))
    action: Mapped[str] = mapped_column(String(100), nullable=False)
    resource_path: Mapped[str] = mapped_column(String(255), nullable=False)
    resource_id: Mapped[str | None] = mapped_column(String(36))
    status_code: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)


class ModelUsageRow(Base):
    __tablename__ = "model_usage"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    organization_id: Mapped[str] = mapped_column(String(36), ForeignKey("organizations.id"), nullable=False, index=True)
    meeting_id: Mapped[str | None] = mapped_column(String(36), index=True)
    knowledge_base_id: Mapped[str | None] = mapped_column(String(36), index=True)
    purpose: Mapped[str] = mapped_column(String(60), nullable=False)
    provider: Mapped[str] = mapped_column(String(40), nullable=False)
    model: Mapped[str] = mapped_column(String(200), nullable=False)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    estimated_usd: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class MeetingMomGuidanceRow(Base):
    __tablename__ = "meeting_mom_guidance"

    meeting_id: Mapped[str] = mapped_column(String(36), ForeignKey("meetings.id"), primary_key=True)
    template: Mapped[str] = mapped_column(String(30), nullable=False)
    instructions: Mapped[str] = mapped_column(Text, nullable=False)
    focus_fields: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class SchemaVersionRow(Base):
    __tablename__ = "schema_version"

    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    applied_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class SchemaMigrationError(RuntimeError):
    """An unknown or incomplete schema must be repaired before serving traffic."""


# Version 3 is the last schema in the original checked-in application. Versions
# 4–19 add only tables, so they can be applied to an existing version-3 database
# without rewriting its meeting or credential rows. Keep this manifest frozen:
# adding a model column requires a new version and an explicit migration.
SCHEMA_TABLES_BY_VERSION: dict[int, tuple[str, ...]] = {
    3: (
        "provider_profiles", "provider_defaults", "meetings", "transcript_segments",
        "meeting_minutes", "email_deliveries", "schema_version",
    ),
    4: ("meeting_delivery_settings", "post_meeting_jobs"),
    5: (
        "transcript_segment_metadata", "transcript_speaker_corrections",
        "meeting_speaker_identities", "transcript_review_state",
    ),
    6: ("minutes_source", "meeting_minutes_evidence"),
    7: ("meeting_transcription_routes",),
    8: ("organizations", "users", "organization_memberships"),
    9: ("meeting_knowledge_settings",),
    10: ("knowledge_bases", "knowledge_base_access", "meeting_knowledge_bases", "knowledge_conversations", "knowledge_messages"),
    11: ("user_credentials",),
    12: ("auth_rate_limit_buckets", "audit_events"),
    13: ("provider_tenants", "meeting_tenants", "organization_provider_defaults"),
    14: ("knowledge_embeddings",),
    15: ("knowledge_index_jobs",),
    16: ("workspace_retention",),
    17: ("calendar_schedules",),
    18: ("model_usage",),
    19: ("meeting_mom_guidance",),
    20: ("meeting_sources",),
    21: ("calendar_event_cache", "calendar_sync_state", "organization_briefs", "organization_brief_documents", "meeting_preps"),
}

SCHEMA_COLUMNS: dict[str, tuple[str, ...]] = {
    "provider_profiles": ("id", "name", "provider_type", "execution_location", "base_url", "capabilities", "credential_ciphertext", "created_at", "updated_at"),
    "provider_defaults": ("capability", "policy", "local_profile_id", "cloud_profile_id"),
    "provider_tenants": ("provider_id", "organization_id"),
    "organization_provider_defaults": ("organization_id", "capability", "policy", "local_profile_id", "cloud_profile_id"),
    "meetings": ("id", "meeting_url", "title", "bot_name", "language", "transcribe_enabled", "recording_enabled", "platform", "native_meeting_id", "status", "vexa_meeting_id", "last_error", "created_at", "updated_at", "joined_at", "stopped_at", "last_refreshed_at"),
    "meeting_tenants": ("meeting_id", "organization_id"),
    "transcript_segments": ("id", "meeting_id", "position", "start_seconds", "end_seconds", "text", "speaker", "language", "completed"),
    "meeting_minutes": ("meeting_id", "status", "title", "executive_summary", "discussion_points", "decisions", "action_items", "open_questions", "provider_profile_id", "provider", "model", "last_error", "created_at", "updated_at", "approved_at", "sent_at"),
    "email_deliveries": ("id", "meeting_id", "recipients", "status", "provider_message_id", "error", "created_at"),
    "schema_version": ("version", "applied_at"),
    "meeting_delivery_settings": ("meeting_id", "internal_recipients", "participant_recipients", "send_to_participants", "include_transcript"),
    "post_meeting_jobs": ("meeting_id", "attempts", "next_retry_at", "last_error", "completed_at"),
    "transcript_segment_metadata": ("meeting_id", "segment_id", "position", "speaker_key", "attribution_source"),
    "transcript_speaker_corrections": ("meeting_id", "segment_id", "display_name", "reviewed_at"),
    "meeting_speaker_identities": ("meeting_id", "speaker", "email", "confirmed_at"),
    "transcript_review_state": ("meeting_id", "revision", "fingerprint"),
    "minutes_source": ("meeting_id", "transcript_revision"),
    "meeting_minutes_evidence": ("meeting_id", "speaker_contributions", "questions_asked"),
    "meeting_transcription_routes": ("meeting_id", "profile_id", "profile_name", "provider_type", "model", "endpoint_host", "selected_at"),
    "organizations": ("id", "slug", "display_name", "contact_email", "status", "created_at", "updated_at"),
    "workspace_retention": ("organization_id", "enabled", "meeting_days", "chat_days", "audit_days", "updated_at"),
    "users": ("id", "email", "display_name", "auth_subject", "status", "created_at", "updated_at"),
    "user_credentials": ("user_id", "password_hash", "must_change_password", "session_version", "created_at", "updated_at"),
    "organization_memberships": ("organization_id", "user_id", "role", "created_at"),
    "meeting_knowledge_settings": ("meeting_id", "organization_id", "tags", "knowledge_enabled", "updated_at"),
    "knowledge_bases": ("id", "organization_id", "name", "description", "created_by", "visibility", "text_profile_id", "created_at", "updated_at"),
    "knowledge_base_access": ("knowledge_base_id", "user_id", "access"),
    "knowledge_embeddings": ("id", "organization_id", "knowledge_base_id", "meeting_id", "source_id", "fingerprint", "profile_id", "model", "dimensions", "vector", "updated_at"),
    "knowledge_index_jobs": ("knowledge_base_id", "organization_id", "status", "attempts", "requested_at", "started_at", "completed_at", "next_retry_at", "last_error"),
    "calendar_schedules": ("meeting_id", "organization_id", "user_id", "connection_id", "provider", "event_id", "starts_at", "ends_at", "status", "attempts", "last_error", "created_at", "updated_at"),
    "meeting_sources": ("meeting_id", "organization_id", "provider", "connection_id", "event_id", "title", "meeting_url", "platform", "starts_at", "ends_at", "agenda", "organizer", "invitees", "saved_at"),
    "meeting_knowledge_bases": ("meeting_id", "knowledge_base_id"),
    "knowledge_conversations": ("id", "knowledge_base_id", "user_id", "title", "created_at", "updated_at"),
    "knowledge_messages": ("id", "conversation_id", "position", "role", "content", "citations", "provider", "model", "created_at"),
    "auth_rate_limit_buckets": ("bucket_key", "attempts", "expires_at_epoch"),
    "audit_events": ("id", "organization_id", "actor_user_id", "action", "resource_path", "resource_id", "status_code", "created_at"),
    "model_usage": ("id", "organization_id", "meeting_id", "knowledge_base_id", "purpose", "provider", "model", "input_tokens", "output_tokens", "estimated_usd", "created_at"),
    "meeting_mom_guidance": ("meeting_id", "template", "instructions", "focus_fields", "updated_at"),
    "calendar_event_cache": ("id", "organization_id", "user_id", "connection_id", "provider", "event_id", "starts_at", "ends_at", "payload", "synced_at"),
    "calendar_sync_state": ("organization_id", "user_id", "connection_id", "last_synced_at", "range_start", "range_end", "truncated"),
    "organization_briefs": ("organization_id", "website", "overview", "services", "products", "differentiators", "positioning", "updated_at"),
    "organization_brief_documents": ("id", "organization_id", "filename", "content_type", "extracted_text", "uploaded_at"),
    "meeting_preps": ("id", "organization_id", "user_id", "calendar_event_id", "context", "profile_urls", "report", "created_at"),
}


def _validate_model_manifest() -> None:
    described = {
        table.name: tuple(column.name for column in table.columns)
        for table in Base.metadata.sorted_tables
    }
    if described != SCHEMA_COLUMNS:
        raise SchemaMigrationError(
            "SQLAlchemy models changed without a matching versioned schema migration"
        )
    if set(described) != {
        name for tables in SCHEMA_TABLES_BY_VERSION.values() for name in tables
    }:
        raise SchemaMigrationError("schema migration manifest does not cover every model")


def _validate_database_schema(connection, version: int) -> None:
    inspector = inspect(connection)
    existing = set(inspector.get_table_names())
    required = {
        name for step, tables in SCHEMA_TABLES_BY_VERSION.items()
        if step <= version for name in tables
    }
    missing_tables = required - existing
    if missing_tables:
        raise SchemaMigrationError(
            f"database schema version {version} is missing tables: {', '.join(sorted(missing_tables))}"
        )
    for name in sorted(required):
        actual = {column["name"] for column in inspector.get_columns(name)}
        missing_columns = set(SCHEMA_COLUMNS[name]) - actual
        if missing_columns:
            raise SchemaMigrationError(
                f"database table {name} is missing columns: {', '.join(sorted(missing_columns))}"
            )


class Database:
    """Upgrades known schemas and rejects unknown or incomplete ones."""

    SCHEMA_VERSION = 21

    def __init__(self, url: str) -> None:
        engine_options: dict[str, object] = {"pool_pre_ping": True}
        if url in {"sqlite://", "sqlite+pysqlite:///:memory:"}:
            engine_options.update(
                connect_args={"check_same_thread": False}, poolclass=StaticPool
            )
        self.engine: Engine = create_engine(url, **engine_options)
        self.session_factory = sessionmaker(
            bind=self.engine, expire_on_commit=False, autoflush=False
        )

    def migrate(self) -> None:
        _validate_model_manifest()
        if sorted(SCHEMA_TABLES_BY_VERSION) != list(range(3, self.SCHEMA_VERSION + 1)):
            raise SchemaMigrationError("schema migration steps must be contiguous through the current version")
        with self.engine.begin() as connection:
            if self.engine.dialect.name == "postgresql":
                # Two API replicas must not stamp or create the same version at once.
                connection.execute(text("SELECT pg_advisory_xact_lock(73906412)"))
            existing = set(inspect(connection).get_table_names())
            if not existing:
                for name in SCHEMA_TABLES_BY_VERSION[3]:
                    Base.metadata.tables[name].create(connection, checkfirst=True)
                connection.execute(insert(SchemaVersionRow).values(
                    version=3, applied_at=datetime.now(UTC),
                ))
                current = 3
            else:
                if "schema_version" not in existing:
                    raise SchemaMigrationError(
                        "existing database has no schema_version; back it up and migrate explicitly"
                    )
                versions = connection.execute(select(SchemaVersionRow.version)).scalars().all()
                if not versions:
                    raise SchemaMigrationError("existing database has no recorded schema version")
                current = max(versions)
                if current < 3 or current > self.SCHEMA_VERSION:
                    raise SchemaMigrationError(
                        f"unsupported database schema version {current}; app supports 3–{self.SCHEMA_VERSION}"
                    )
                _validate_database_schema(connection, current)
            for version in range(current + 1, self.SCHEMA_VERSION + 1):
                for name in SCHEMA_TABLES_BY_VERSION[version]:
                    Base.metadata.tables[name].create(connection, checkfirst=True)
                if version == 8:
                    now = datetime.now(UTC)
                    connection.execute(insert(OrganizationRow).values(
                        id=str(LEGACY_ORGANIZATION_ID), slug="legacy-workspace",
                        display_name="GenAI Protos", contact_email=None,
                        status="active", created_at=now, updated_at=now,
                    ))
                    connection.execute(insert(UserRow).values(
                        id=str(LEGACY_ADMIN_USER_ID), email=None,
                        display_name="Local administrator", auth_subject="local-admin",
                        status="active", created_at=now, updated_at=now,
                    ))
                    connection.execute(insert(OrganizationMembershipRow).values(
                        organization_id=str(LEGACY_ORGANIZATION_ID),
                        user_id=str(LEGACY_ADMIN_USER_ID), role="owner", created_at=now,
                    ))
                if version == 13:
                    # Existing rows were created in the original workspace. New
                    # writes must add their ownership record in the same transaction.
                    connection.execute(insert(ProviderTenantRow).from_select(
                        ["provider_id", "organization_id"],
                        select(ProviderProfileRow.id, text(f"'{LEGACY_ORGANIZATION_ID}'")),
                    ))
                    connection.execute(insert(MeetingTenantRow).from_select(
                        ["meeting_id", "organization_id"],
                        select(MeetingRow.id, text(f"'{LEGACY_ORGANIZATION_ID}'")),
                    ))
                    connection.execute(insert(OrganizationProviderDefaultRow).from_select(
                        ["organization_id", "capability", "policy", "local_profile_id", "cloud_profile_id"],
                        select(text(f"'{LEGACY_ORGANIZATION_ID}'"), ProviderDefaultRow.capability,
                               ProviderDefaultRow.policy, ProviderDefaultRow.local_profile_id,
                               ProviderDefaultRow.cloud_profile_id),
                    ))
                if version == 15:
                    now = datetime.now(UTC)
                    bases = connection.execute(select(
                        MeetingKnowledgeBaseRow.knowledge_base_id, KnowledgeBaseRow.organization_id,
                    ).join(KnowledgeBaseRow, KnowledgeBaseRow.id == MeetingKnowledgeBaseRow.knowledge_base_id)
                     .join(MeetingRow, MeetingRow.id == MeetingKnowledgeBaseRow.meeting_id)
                     .where(MeetingRow.status == "completed").distinct()).all()
                    for base_id, organization_id in bases:
                        connection.execute(insert(KnowledgeIndexJobRow).values(
                            knowledge_base_id=base_id, organization_id=organization_id,
                            status="pending", attempts=0, requested_at=now,
                            started_at=None, completed_at=None, next_retry_at=None,
                            last_error=None,
                        ))
                _validate_database_schema(connection, version)
                connection.execute(insert(SchemaVersionRow).values(
                    version=version, applied_at=datetime.now(UTC),
                ))
            _validate_database_schema(connection, self.SCHEMA_VERSION)
            if connection.execute(select(OrganizationRow.id).where(
                OrganizationRow.id == str(LEGACY_ORGANIZATION_ID)
            )).scalar_one_or_none() is None:
                raise SchemaMigrationError("legacy workspace is missing from the recorded schema")
