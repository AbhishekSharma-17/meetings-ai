"""Opt-in voice samples: a 5–10 second clip of a person's own voice, per person per workspace.

A sample is used for one thing only: when that person is recorded in person in the same workspace and
the workspace's speech-to-text model accepts known-speaker references, it is sent with the final pass so
the provider can say which "Speaker A/B" is them. The result is still only a suggestion to approve.

Samples never leave their workspace, are never logged, and only their owner can listen to them.
Owners and admins can see who has one (never the audio). Removing a membership deletes the sample.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, select

from .database import Database, OrganizationMembershipRow, UserRow, VoiceSampleRow

MAX_SAMPLE_BYTES = 1024 * 1024
MIN_DURATION_MS = 5_000
MAX_DURATION_MS = 10_000
# Base types browsers record (MediaRecorder) plus WAV; all are accepted by OpenAI's transcription upload.
SAMPLE_TYPES = ("audio/webm", "audio/mp4", "audio/ogg", "audio/wav")
_ALIASES = {"audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4"}


class VoiceSampleError(ValueError):
    """The upload is rejected; the message is safe to show to the uploader."""

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class SampleInfo:
    mime_type: str
    byte_size: int
    duration_ms: int
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class StoredSample:
    user_id: UUID
    display_name: str
    email: str | None
    mime_type: str
    data: bytes
    duration_ms: int


@dataclass(frozen=True)
class SampleHolder:
    user_id: UUID
    display_name: str
    duration_ms: int
    updated_at: datetime


def base_type(content_type: str | None) -> str:
    """``"audio/webm;codecs=opus"`` → ``"audio/webm"``; unknown aliases map to their canonical type."""
    base = (content_type or "").split(";")[0].strip().lower()
    return _ALIASES.get(base, base)


def sniff_audio(data: bytes) -> str | None:
    """The container the bytes really are, from their magic numbers (never trust the declared type)."""
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "audio/webm"
    if data[:4] == b"OggS":
        return "audio/ogg"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data[4:8] == b"ftyp":
        return "audio/mp4"
    return None


def validate_sample(data: bytes, content_type: str | None, duration_ms: int) -> str:
    """The canonical mime type of a valid sample; VoiceSampleError explains what is wrong otherwise."""
    if not data:
        raise VoiceSampleError("record a voice sample first")
    if len(data) > MAX_SAMPLE_BYTES:
        raise VoiceSampleError("a voice sample can be at most 1 MB", status_code=413)
    declared = base_type(content_type)
    if declared not in SAMPLE_TYPES:
        raise VoiceSampleError("upload WebM, MP4, Ogg or WAV audio", status_code=415)
    if sniff_audio(data) != declared:
        raise VoiceSampleError("the audio does not match its declared type", status_code=415)
    if not MIN_DURATION_MS <= duration_ms <= MAX_DURATION_MS:
        raise VoiceSampleError("a voice sample must be between 5 and 10 seconds long")
    return declared


class VoiceSampleService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def save(self, organization_id: UUID, user_id: UUID, data: bytes, mime_type: str, duration_ms: int) -> SampleInfo:
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            if session.get(OrganizationMembershipRow, (str(organization_id), str(user_id))) is None:
                raise VoiceSampleError("you are not a member of this workspace", status_code=403)
            row = session.get(VoiceSampleRow, (str(organization_id), str(user_id)))
            if row is None:
                row = VoiceSampleRow(organization_id=str(organization_id), user_id=str(user_id), created_at=now)
                session.add(row)
            row.mime_type, row.bytes, row.byte_size = mime_type, data, len(data)
            row.duration_ms, row.updated_at = duration_ms, now
            return _info(row)

    def info(self, organization_id: UUID, user_id: UUID) -> SampleInfo | None:
        with self.database.session_factory() as session:
            row = session.execute(select(
                VoiceSampleRow.mime_type, VoiceSampleRow.byte_size, VoiceSampleRow.duration_ms,
                VoiceSampleRow.created_at, VoiceSampleRow.updated_at,
            ).where(VoiceSampleRow.organization_id == str(organization_id),
                    VoiceSampleRow.user_id == str(user_id))).first()
        return SampleInfo(*row) if row else None

    def audio(self, organization_id: UUID, user_id: UUID) -> tuple[str, bytes] | None:
        """The owner's own sample (callers pass the signed-in user; nobody else's audio is ever served)."""
        with self.database.session_factory() as session:
            row = session.get(VoiceSampleRow, (str(organization_id), str(user_id)))
            return (row.mime_type, bytes(row.bytes)) if row else None

    def delete(self, organization_id: UUID, user_id: UUID) -> bool:
        with self.database.session_factory.begin() as session:
            result = session.execute(delete(VoiceSampleRow).where(
                VoiceSampleRow.organization_id == str(organization_id), VoiceSampleRow.user_id == str(user_id)))
            return bool(result.rowcount)

    def holders(self, organization_id: UUID) -> list[SampleHolder]:
        """Who in the workspace has a sample (names and dates only, never audio)."""
        with self.database.session_factory() as session:
            rows = session.execute(self._members_with_samples(
                organization_id, VoiceSampleRow.user_id, UserRow.display_name, VoiceSampleRow.duration_ms,
                VoiceSampleRow.updated_at).order_by(UserRow.display_name)).all()
        return [SampleHolder(UUID(user_id), name, duration, updated) for user_id, name, duration, updated in rows]

    def identities(self, organization_id: UUID) -> list[tuple[UUID, str, str | None]]:
        """(user id, display name, email) of current members with a sample here; no audio is loaded."""
        with self.database.session_factory() as session:
            rows = session.execute(self._members_with_samples(
                organization_id, VoiceSampleRow.user_id, UserRow.display_name, UserRow.email,
            ).order_by(UserRow.display_name, VoiceSampleRow.user_id)).all()  # stable when more than the cap match
        return [(UUID(user_id), name, email) for user_id, name, email in rows]

    def load(self, organization_id: UUID, user_ids: list[UUID]) -> list[StoredSample]:
        """The samples of these members of this workspace (anyone else is silently left out)."""
        if not user_ids:
            return []
        with self.database.session_factory() as session:
            rows = session.execute(self._members_with_samples(
                organization_id, VoiceSampleRow.user_id, UserRow.display_name, UserRow.email,
                VoiceSampleRow.mime_type, VoiceSampleRow.bytes, VoiceSampleRow.duration_ms,
            ).where(VoiceSampleRow.user_id.in_([str(user_id) for user_id in user_ids]))).all()
        found = {user_id: StoredSample(UUID(user_id), name, email, mime, bytes(data), duration)
                 for user_id, name, email, mime, data, duration in rows}
        return [found[str(user_id)] for user_id in user_ids if str(user_id) in found]

    @staticmethod
    def _members_with_samples(organization_id: UUID, *columns):
        return (select(*columns).join(UserRow, UserRow.id == VoiceSampleRow.user_id)
                .join(OrganizationMembershipRow, (OrganizationMembershipRow.user_id == VoiceSampleRow.user_id)
                      & (OrganizationMembershipRow.organization_id == VoiceSampleRow.organization_id))
                .where(VoiceSampleRow.organization_id == str(organization_id)))


def _info(row: VoiceSampleRow) -> SampleInfo:
    return SampleInfo(row.mime_type, row.byte_size, row.duration_ms, row.created_at, row.updated_at)
