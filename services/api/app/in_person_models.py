"""Contracts and limits for recording face-to-face meetings from a phone or laptop browser.

The browser records one continuous stream (MediaRecorder with ~15 s timeslices) and uploads
numbered chunks. Nothing here is audio or transcript text; see ``in_person_service`` for the flow.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ----- limits (documented in docs/product/in-person-recording.md) -------------------------------
CHUNK_MS = 15_000
MAX_CHUNK_BYTES = 2 * 1024 * 1024          # one 15 s opus chunk is ~60 KB; 2 MB leaves room for mp4/aac
MAX_CHUNK_DURATION_MS = 20_000             # a 15 s timeslice plus scheduling slack
MAX_TOTAL_BYTES = 400 * 1024 * 1024
MAX_DURATION_MS = 4 * 60 * 60 * 1000       # 4 hours, the same cap as an online capture
MAX_EXPECTED_PEOPLE = 30
MAX_MOMENTS = 50
MAX_CAPTIONS = 40
ABANDONED_AFTER_HOURS = 24                 # audio of a session idle this long is deleted by the cleanup loop

InPersonStatus = Literal["recording", "paused", "finalizing", "done", "failed"]
InPersonDevice = Literal["phone", "laptop", "unknown"]
FinalizeStage = Literal["queued", "assembling", "transcribing", "reconciling", "naming", "saving", "done", "failed"]
OPEN_STATUSES = frozenset({"recording", "paused"})

# Container base types the browser may send (codec parameters are ignored).
ACCEPTED_MIME_TYPES = frozenset({"audio/webm", "audio/mp4", "audio/ogg"})
_MIME = re.compile(r"^\s*([a-z0-9.+-]+/[a-z0-9.+-]+)\s*(?:;.*)?$", re.IGNORECASE)


def base_mime_type(value: str | None) -> str | None:
    """``audio/webm;codecs=opus`` → ``audio/webm``; None for anything that is not an accepted audio type."""
    match = _MIME.match(value or "")
    base = match.group(1).lower() if match else None
    if base == "video/webm":  # some browsers label audio-only webm recordings as video/webm
        base = "audio/webm"
    return base if base in ACCEPTED_MIME_TYPES else None


class ConsentInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    everyone_agreed: bool
    notice_shown: bool = False


class CalendarEventReference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    connection_id: Annotated[str, Field(min_length=1, max_length=100)]
    event_id: Annotated[str, Field(min_length=1, max_length=255)]
    event_date: date
    timezone: Annotated[str, Field(min_length=1, max_length=64)] = "UTC"


class InPersonCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Annotated[str | None, Field(default=None, max_length=200)]
    language: Annotated[str | None, Field(default=None, min_length=2, max_length=35)]
    device: InPersonDevice = "unknown"
    mime_type: Annotated[str, Field(min_length=3, max_length=100)]
    consent: ConsentInput
    expected_people: list[Annotated[str, Field(min_length=1, max_length=120)]] = Field(
        default_factory=list, max_length=MAX_EXPECTED_PEOPLE,
    )
    calendar_event: CalendarEventReference | None = None

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str | None) -> str | None:
        cleaned = " ".join((value or "").split())
        return cleaned or None

    @field_validator("expected_people")
    @classmethod
    def clean_people(cls, values: list[str]) -> list[str]:
        cleaned = [" ".join(value.split()) for value in values]
        return list(dict.fromkeys(value for value in cleaned if value))


class MomentInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    at_ms: Annotated[int, Field(ge=0, le=MAX_DURATION_MS)]
    label: Annotated[str | None, Field(default=None, max_length=120)]


class StopInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    final_seq: Annotated[int, Field(ge=-1, le=100_000)]


class RecorderPublic(BaseModel):
    user_id: UUID
    display_name: str | None = None


class ConsentPublic(BaseModel):
    everyone_agreed: Literal[True] = True
    notice_shown: bool
    agreed_at: datetime


class CaptionPublic(BaseModel):
    seq: int
    start_ms: int
    text: str


class MomentPublic(BaseModel):
    at_ms: int
    label: str | None = None


class FinalizePublic(BaseModel):
    stage: FinalizeStage
    message: str | None = None
    parts_total: int = 0
    parts_done: int = 0


class LimitsPublic(BaseModel):
    max_chunk_bytes: int = MAX_CHUNK_BYTES
    max_total_bytes: int = MAX_TOTAL_BYTES
    max_duration_ms: int = MAX_DURATION_MS
    chunk_ms: int = CHUNK_MS


class InPersonSessionPublic(BaseModel):
    meeting_id: UUID
    title: str
    status: InPersonStatus
    device: InPersonDevice
    recorded_by: RecorderPublic
    is_recorder: bool
    consent: ConsentPublic
    mime_type: str
    started_at: datetime
    stopped_at: datetime | None = None
    last_seq: int
    received_chunks: int
    duration_ms: int
    total_bytes: int
    captions: list[CaptionPublic] = Field(default_factory=list)
    moments: list[MomentPublic] = Field(default_factory=list)
    finalize: FinalizePublic | None = None
    speaker_labels: Literal["diarized", "single"] | None = None
    error: str | None = None
    limits: LimitsPublic = Field(default_factory=LimitsPublic)


class CalendarLink(BaseModel):
    """An in-person recording started from a calendar event (for the "In person" mark on that event)."""

    meeting_id: UUID
    connection_id: str
    event_id: str
    status: InPersonStatus
    title: str | None = None


class ChunkAccepted(BaseModel):
    seq: int
    duplicate: bool
    last_seq: int
    received_chunks: int
    duration_ms: int
    total_bytes: int


# ----- speaker naming -----------------------------------------------------------------------------
# voice_sample: the provider matched this speaker to a saved voice sample (never proposed by the text model).
EvidenceKind = Literal["addressed", "self_introduction", "expected_person", "invitee", "voice_sample"]


class SpeakerNameEvidence(BaseModel):
    quote: Annotated[str, Field(max_length=300)]
    at_seconds: Annotated[float, Field(ge=0)]
    kind: EvidenceKind


class SpeakerNameSuggestion(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=120)]
    confidence: Literal["high", "medium", "low"]
    reason: Annotated[str, Field(max_length=300)]
    evidence: list[SpeakerNameEvidence] = Field(default_factory=list, max_length=5)


class SpeakerNameRow(BaseModel):
    speaker: str
    segments: int
    first_at_seconds: float
    sample: str | None = None
    current_name: str | None = None
    state: Literal["suggested", "approved", "dismissed", "none"]
    suggestion: SpeakerNameSuggestion | None = None


class SpeakerNamesView(BaseModel):
    status: Literal["pending", "ready", "unavailable", "not_applicable"]
    message: str | None = None
    single_speaker: bool = False
    speakers: list[SpeakerNameRow] = Field(default_factory=list)


class SpeakerNameApproval(BaseModel):
    model_config = ConfigDict(extra="forbid")

    speaker: Annotated[str, Field(min_length=1, max_length=40)]
    name: Annotated[str, Field(min_length=1, max_length=120)]

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("name is required")
        return cleaned


class SpeakerNameApprovals(BaseModel):
    model_config = ConfigDict(extra="forbid")

    approvals: Annotated[list[SpeakerNameApproval], Field(min_length=1, max_length=20)]


class SpeakerNameDismissal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    speaker: Annotated[str, Field(min_length=1, max_length=40)]
