"""Persistence for in-person recording sessions and their audio chunks (v30 tables).

Every read and write is scoped to one workspace (``organization_id``). Audio bytes are only
loaded for the chunk ranges being transcribed, so memory stays bounded by one part.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError

from .database import Database, InPersonChunkRow, InPersonSessionRow, MeetingRow, MeetingSourceRow, UserRow
from .in_person_models import (
    MAX_CAPTIONS,
    MAX_CHUNK_BYTES,
    MAX_CHUNK_DURATION_MS,
    MAX_DURATION_MS,
    MAX_MOMENTS,
    MAX_TOTAL_BYTES,
    OPEN_STATUSES,
    ChunkAccepted,
)


class InPersonError(Exception):
    """A request the session cannot accept; ``status_code`` and a user-safe ``detail``."""

    def __init__(self, status_code: int, detail: str | dict[str, Any]) -> None:
        super().__init__(detail if isinstance(detail, str) else detail.get("message", "request rejected"))
        self.status_code = status_code
        self.detail = detail


class SessionNotFoundError(LookupError):
    pass


@dataclass(frozen=True)
class SessionSnapshot:
    meeting_id: UUID
    organization_id: UUID
    recorded_by: UUID
    recorder_name: str | None
    device: str
    mime_type: str
    consent_at: datetime
    consent_notice_shown: bool
    status: str
    started_at: datetime
    stopped_at: datetime | None
    last_activity_at: datetime
    last_seq: int
    received_chunks: int
    duration_ms: int
    total_bytes: int
    expected_people: tuple[str, ...]
    moments: tuple[dict[str, Any], ...]
    finalize_stage: str | None
    finalize_message: str | None
    parts_total: int
    parts_done: int
    attempts: int
    speaker_labels: str | None
    name_suggestions: tuple[dict[str, Any], ...]
    error: str | None


@dataclass(frozen=True)
class ChunkMeta:
    seq: int
    byte_size: int
    duration_ms: int
    stream_start: bool
    start_ms: int = 0
    preview_text: str | None = None


@dataclass(frozen=True)
class NewSession:
    meeting_id: UUID
    recorded_by: UUID
    device: str
    mime_type: str
    notice_shown: bool
    expected_people: list[str] = field(default_factory=list)


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _now() -> datetime:
    return datetime.now(UTC)


def _snapshot(row: InPersonSessionRow, recorder_name: str | None) -> SessionSnapshot:
    return SessionSnapshot(
        meeting_id=UUID(row.meeting_id), organization_id=UUID(row.organization_id),
        recorded_by=UUID(row.recorded_by), recorder_name=recorder_name, device=row.device,
        mime_type=row.mime_type, consent_at=_utc(row.consent_at), consent_notice_shown=row.consent_notice_shown,
        status=row.status, started_at=_utc(row.started_at), stopped_at=_utc(row.stopped_at),
        last_activity_at=_utc(row.last_activity_at), last_seq=row.last_seq, received_chunks=row.received_chunks,
        duration_ms=row.duration_ms, total_bytes=row.total_bytes,
        expected_people=tuple(row.expected_people or ()), moments=tuple(row.moments or ()),
        finalize_stage=row.finalize_stage, finalize_message=row.finalize_message,
        parts_total=row.parts_total, parts_done=row.parts_done, attempts=row.attempts,
        speaker_labels=row.speaker_labels, name_suggestions=tuple(row.name_suggestions or ()), error=row.error,
    )


class InPersonStore:
    def __init__(self, database: Database) -> None:
        self.database = database

    # ----- sessions ------------------------------------------------------------------------
    def create(self, organization_id: UUID, new: NewSession) -> SessionSnapshot:
        now = _now()
        with self.database.session_factory.begin() as session:
            session.add(InPersonSessionRow(
                meeting_id=str(new.meeting_id), organization_id=str(organization_id),
                recorded_by=str(new.recorded_by), device=new.device, mime_type=new.mime_type,
                consent_at=now, consent_notice_shown=new.notice_shown, status="recording",
                started_at=now, stopped_at=None, last_activity_at=now, last_seq=-1, received_chunks=0,
                duration_ms=0, total_bytes=0, expected_people=list(new.expected_people), moments=[],
                finalize_stage=None, finalize_message=None, parts_total=0, parts_done=0, attempts=0,
                speaker_labels=None, name_suggestions=[], error=None,
            ))
        return self.get(organization_id, new.meeting_id)

    def get(self, organization_id: UUID, meeting_id: UUID) -> SessionSnapshot:
        with self.database.session_factory() as session:
            row = session.get(InPersonSessionRow, str(meeting_id))
            if row is None or row.organization_id != str(organization_id):
                raise SessionNotFoundError(meeting_id)
            user = session.get(UserRow, row.recorded_by)
            return _snapshot(row, user.display_name if user else None)

    def find(self, organization_id: UUID, meeting_id: UUID) -> SessionSnapshot | None:
        try:
            return self.get(organization_id, meeting_id)
        except SessionNotFoundError:
            return None

    def update(self, organization_id: UUID, meeting_id: UUID, *, allowed: frozenset[str] | None = None,
               touch: bool = True, **values: Any) -> SessionSnapshot:
        """Change session fields; with ``allowed`` the change only applies from those statuses (else 409)."""
        with self.database.session_factory.begin() as session:
            row = self._locked(session, organization_id, meeting_id)
            if allowed is not None and row.status not in allowed:
                raise InPersonError(409, _status_conflict(row.status))
            for key, value in values.items():
                setattr(row, key, value)
            if touch:
                row.last_activity_at = _now()
        return self.get(organization_id, meeting_id)

    def add_moment(self, organization_id: UUID, meeting_id: UUID, at_ms: int, label: str | None) -> SessionSnapshot:
        with self.database.session_factory.begin() as session:
            row = self._locked(session, organization_id, meeting_id)
            if row.status not in OPEN_STATUSES:
                raise InPersonError(409, _status_conflict(row.status))
            moments = list(row.moments or [])
            if len(moments) >= MAX_MOMENTS:
                raise InPersonError(409, f"a recording can mark at most {MAX_MOMENTS} moments")
            moments.append({"at_ms": at_ms, "label": label})
            row.moments = sorted(moments, key=lambda item: item["at_ms"])
            row.last_activity_at = _now()
        return self.get(organization_id, meeting_id)

    @staticmethod
    def _locked(session: Any, organization_id: UUID, meeting_id: UUID) -> InPersonSessionRow:
        row = session.execute(select(InPersonSessionRow).where(
            InPersonSessionRow.meeting_id == str(meeting_id),
            InPersonSessionRow.organization_id == str(organization_id),
        ).with_for_update()).scalar_one_or_none()
        if row is None:
            raise SessionNotFoundError(meeting_id)
        return row

    # ----- chunks --------------------------------------------------------------------------
    def add_chunk(self, organization_id: UUID, meeting_id: UUID, *, seq: int, data: bytes, duration_ms: int,
                  stream_start: bool, mime_type: str) -> ChunkAccepted:
        """Store chunk ``seq`` (must be the next one; a repeat of a stored one is a harmless duplicate)."""
        size = len(data)
        if size == 0:
            raise InPersonError(422, "the audio chunk is empty")
        if size > MAX_CHUNK_BYTES:
            raise InPersonError(413, f"an audio chunk can be at most {MAX_CHUNK_BYTES // (1024 * 1024)} MB")
        if not 0 < duration_ms <= MAX_CHUNK_DURATION_MS:
            raise InPersonError(422, "chunk duration must be between 1 ms and 20 seconds")
        try:
            with self.database.session_factory.begin() as session:
                row = self._locked(session, organization_id, meeting_id)
                if mime_type != row.mime_type:
                    raise InPersonError(415, f"this recording expects {row.mime_type} audio")
                if seq <= row.last_seq:
                    return _accepted(row, seq, duplicate=True)
                if row.status not in OPEN_STATUSES:
                    raise InPersonError(409, _status_conflict(row.status))
                if seq != row.last_seq + 1:
                    raise InPersonError(409, {"message": f"audio piece {row.last_seq + 1} is missing; send it first",
                                              "expected_seq": row.last_seq + 1})
                if seq == 0 and not stream_start:
                    stream_start = True  # the first piece always starts the stream (it carries the header)
                if row.total_bytes + size > MAX_TOTAL_BYTES:
                    raise InPersonError(413, "this recording reached its storage limit; stop to create the transcript")
                if row.duration_ms >= MAX_DURATION_MS:  # the piece that crosses 4 h is kept; later ones are not
                    raise InPersonError(413, "this recording reached the 4 hour limit; stop to create the transcript")
                session.add(InPersonChunkRow(
                    meeting_id=str(meeting_id), seq=seq, organization_id=str(organization_id), mime_type=mime_type,
                    stream_start=stream_start, bytes=data, byte_size=size, duration_ms=duration_ms,
                    received_at=_now(), preview_text=None,
                ))
                row.last_seq = seq
                row.received_chunks += 1
                row.total_bytes += size
                row.duration_ms += duration_ms
                row.last_activity_at = _now()
                return _accepted(row, seq, duplicate=False)
        except IntegrityError:
            # A concurrent retry stored the same piece first.
            snapshot = self.get(organization_id, meeting_id)
            return ChunkAccepted(seq=seq, duplicate=True, last_seq=snapshot.last_seq,
                                 received_chunks=snapshot.received_chunks, duration_ms=snapshot.duration_ms,
                                 total_bytes=snapshot.total_bytes)

    def chunk_meta(self, organization_id: UUID, meeting_id: UUID) -> list[ChunkMeta]:
        """Every stored chunk in order, with its start offset in the recording (no audio bytes)."""
        with self.database.session_factory() as session:
            rows = session.execute(select(
                InPersonChunkRow.seq, InPersonChunkRow.byte_size, InPersonChunkRow.duration_ms,
                InPersonChunkRow.stream_start, InPersonChunkRow.preview_text,
            ).where(
                InPersonChunkRow.meeting_id == str(meeting_id),
                InPersonChunkRow.organization_id == str(organization_id),
            ).order_by(InPersonChunkRow.seq)).all()
        offset, result = 0, []
        for seq, size, duration, stream_start, preview in rows:
            result.append(ChunkMeta(seq=seq, byte_size=size, duration_ms=duration, stream_start=stream_start,
                                    start_ms=offset, preview_text=preview))
            offset += duration
        return result

    def captions(self, organization_id: UUID, meeting_id: UUID) -> list[ChunkMeta]:
        return [item for item in self.chunk_meta(organization_id, meeting_id) if item.preview_text][-MAX_CAPTIONS:]

    def chunk_bytes(self, organization_id: UUID, meeting_id: UUID, seqs: list[int]) -> dict[int, bytes]:
        if not seqs:
            return {}
        with self.database.session_factory() as session:
            rows = session.execute(select(InPersonChunkRow.seq, InPersonChunkRow.bytes).where(
                InPersonChunkRow.meeting_id == str(meeting_id),
                InPersonChunkRow.organization_id == str(organization_id),
                InPersonChunkRow.seq.in_(seqs),
            )).all()
        return {seq: bytes(data) for seq, data in rows}

    def set_preview(self, organization_id: UUID, meeting_id: UUID, seq: int, text: str) -> None:
        with self.database.session_factory.begin() as session:
            session.execute(update(InPersonChunkRow).where(
                InPersonChunkRow.meeting_id == str(meeting_id), InPersonChunkRow.seq == seq,
                InPersonChunkRow.organization_id == str(organization_id),
            ).values(preview_text=text[:4000]))

    def delete_chunks(self, organization_id: UUID, meeting_id: UUID) -> int:
        with self.database.session_factory.begin() as session:
            return session.execute(delete(InPersonChunkRow).where(
                InPersonChunkRow.meeting_id == str(meeting_id),
                InPersonChunkRow.organization_id == str(organization_id),
            )).rowcount or 0

    def chunk_count(self, organization_id: UUID, meeting_id: UUID) -> int:
        with self.database.session_factory() as session:
            return session.execute(select(func.count()).select_from(InPersonChunkRow).where(
                InPersonChunkRow.meeting_id == str(meeting_id),
                InPersonChunkRow.organization_id == str(organization_id),
            )).scalar_one()

    # ----- cleanup (leader loop; crosses workspaces, one session at a time) -------------------
    def idle_sessions(self, older_than: timedelta, statuses: frozenset[str]) -> list[tuple[UUID, UUID, str]]:
        cutoff = _now() - older_than
        with self.database.session_factory() as session:
            rows = session.execute(select(
                InPersonSessionRow.organization_id, InPersonSessionRow.meeting_id, InPersonSessionRow.status,
            ).where(InPersonSessionRow.status.in_(statuses), InPersonSessionRow.last_activity_at < cutoff)).all()
        return [(UUID(org), UUID(meeting), status) for org, meeting, status in rows]

    def calendar_links(self, organization_id: UUID, recorded_by: UUID | None, limit: int = 200) -> list[dict[str, Any]]:
        """Recordings started from a calendar event, newest first (only the recorder's own unless ``recorded_by`` is None)."""
        query = (select(InPersonSessionRow.meeting_id, InPersonSessionRow.status, MeetingSourceRow.connection_id,
                        MeetingSourceRow.event_id, MeetingRow.title)
                 .join(MeetingSourceRow, MeetingSourceRow.meeting_id == InPersonSessionRow.meeting_id)
                 .join(MeetingRow, MeetingRow.id == InPersonSessionRow.meeting_id)
                 .where(InPersonSessionRow.organization_id == str(organization_id),
                        MeetingSourceRow.organization_id == str(organization_id))
                 .order_by(InPersonSessionRow.started_at.desc()).limit(limit))
        if recorded_by is not None:
            query = query.where(InPersonSessionRow.recorded_by == str(recorded_by))
        with self.database.session_factory() as session:
            rows = session.execute(query).all()
        return [{"meeting_id": UUID(meeting), "status": status, "connection_id": connection, "event_id": event,
                 "title": title} for meeting, status, connection, event, title in rows]

    def done_but_meeting_open(self) -> list[tuple[UUID, UUID]]:
        """Sessions whose final pass finished while their meeting was never marked completed."""
        with self.database.session_factory() as session:
            rows = session.execute(select(InPersonSessionRow.organization_id, InPersonSessionRow.meeting_id)
                                   .join(MeetingRow, MeetingRow.id == InPersonSessionRow.meeting_id)
                                   .where(InPersonSessionRow.status == "done",
                                          MeetingRow.status.not_in(("completed", "failed")))).all()
        return [(UUID(org), UUID(meeting)) for org, meeting in rows]

    def orphaned_chunk_meetings(self, statuses: frozenset[str]) -> list[tuple[UUID, UUID]]:
        """Meetings in a finished state that still hold audio (a crash between saving and deleting)."""
        with self.database.session_factory() as session:
            rows = session.execute(select(InPersonSessionRow.organization_id, InPersonSessionRow.meeting_id).where(
                InPersonSessionRow.status.in_(statuses),
                InPersonSessionRow.meeting_id.in_(select(InPersonChunkRow.meeting_id).distinct()),
            )).all()
        return [(UUID(org), UUID(meeting)) for org, meeting in rows]


def _accepted(row: InPersonSessionRow, seq: int, *, duplicate: bool) -> ChunkAccepted:
    return ChunkAccepted(seq=seq, duplicate=duplicate, last_seq=row.last_seq, received_chunks=row.received_chunks,
                         duration_ms=row.duration_ms, total_bytes=row.total_bytes)


def _status_conflict(status: str) -> str:
    return {
        "finalizing": "this recording has stopped and its transcript is being created",
        "done": "this recording is finished",
        "failed": "this recording stopped with an error",
        "paused": "this recording is paused",
        "recording": "this recording is still running",
    }.get(status, "this recording cannot change now")
