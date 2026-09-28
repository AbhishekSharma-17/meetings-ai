"""Workspace usage summary: totals by kind, purpose, provider, model, meeting, prep and transcription."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from .database import Database, MeetingPrepRow, UsageEventRow

RECENT_LIMIT = 100
PREP_PURPOSE_PREFIX = "meeting_prep"
PREP_SYNTHESIS_PURPOSE = "meeting_prep"


class ModelUsageEvent(BaseModel):
    id: UUID
    meeting_id: UUID | None
    knowledge_base_id: UUID | None
    purpose: str
    provider: str
    model: str
    input_tokens: int | None
    output_tokens: int | None
    estimated_usd: float | None
    created_at: datetime
    kind: str = "llm"
    status: str = "succeeded"


class UsageGroupTotal(BaseModel):
    name: str
    requests: int
    input_tokens: int
    output_tokens: int
    estimated_usd: float
    unpriced_requests: int


class UsageModelTotal(UsageGroupTotal):
    kind: str
    provider: str
    model: str
    units: float
    unit_type: str | None
    failed_requests: int


class MeetingUsageTotal(BaseModel):
    meeting_id: UUID
    requests: int
    input_tokens: int
    output_tokens: int
    estimated_usd: float
    unpriced_requests: int


class PrepUsage(BaseModel):
    """Meeting preparation: ``sessions`` counts briefing runs (one synthesis call each)."""

    sessions: int = 0
    events_prepared: int = 0
    briefings_generated: int = 0
    requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    estimated_usd: float = 0.0
    unpriced_requests: int = 0
    searches: int = 0


class TranscriptionUsage(BaseModel):
    meetings: int = 0
    audio_seconds: float = 0.0
    estimated_usd: float = 0.0
    unpriced: int = 0


class UsageSummary(BaseModel):
    total_requests: int
    input_tokens: int
    output_tokens: int
    estimated_usd: float
    unpriced_requests: int
    recent: list[ModelUsageEvent]
    by_meeting: list[MeetingUsageTotal]
    by_purpose: list[UsageGroupTotal]
    by_provider: list[UsageGroupTotal]
    by_kind: list[UsageGroupTotal] = []
    by_model: list[UsageModelTotal] = []
    prep: PrepUsage = PrepUsage()
    transcription: TranscriptionUsage = TranscriptionUsage()
    failed_requests: int = 0
    since: datetime | None = None
    until: datetime | None = None


def _aggregates() -> tuple[Any, ...]:
    return (
        func.count(UsageEventRow.id),
        func.coalesce(func.sum(UsageEventRow.input_tokens), 0),
        func.coalesce(func.sum(UsageEventRow.output_tokens), 0),
        func.coalesce(func.sum(UsageEventRow.estimated_usd), 0),
        func.count(UsageEventRow.id).filter(UsageEventRow.estimated_usd.is_(None)),
    )


def _window(organization_id: UUID, since: datetime | None, until: datetime | None) -> list[Any]:
    conditions: list[Any] = [UsageEventRow.organization_id == str(organization_id)]
    if since is not None:
        conditions.append(UsageEventRow.created_at >= since)
    if until is not None:
        conditions.append(UsageEventRow.created_at < until)
    return conditions


def _vendor() -> Any:
    """The provider as people know it: OpenAI-compatible calls to openrouter.ai are OpenRouter."""
    return case(
        (and_(UsageEventRow.provider == "openai_compatible",
              UsageEventRow.details["endpoint_host"].as_string() == "openrouter.ai"), "openrouter"),
        else_=UsageEventRow.provider,
    )


def _row_vendor(row: UsageEventRow) -> str:
    """Python twin of :func:`_vendor` for rows already loaded."""
    host = (row.details or {}).get("endpoint_host")
    return "openrouter" if row.provider == "openai_compatible" and host == "openrouter.ai" else row.provider


def _group(row: Any, name: str) -> UsageGroupTotal:
    return UsageGroupTotal(name=name, requests=row[1], input_tokens=row[2], output_tokens=row[3],
                           estimated_usd=round(float(row[4]), 6), unpriced_requests=row[5])


def _grouped(session: Session, column: Any, where: list[Any]) -> list[UsageGroupTotal]:
    rows = session.execute(select(column, *_aggregates()).where(*where)
                           .group_by(column).order_by(func.count(UsageEventRow.id).desc())).all()
    return [_group(row, str(row[0])) for row in rows]


def _by_model(session: Session, where: list[Any]) -> list[UsageModelTotal]:
    vendor = _vendor()
    rows = session.execute(select(
        UsageEventRow.kind, vendor, UsageEventRow.model, *_aggregates(),
        func.coalesce(func.sum(UsageEventRow.units), 0), func.max(UsageEventRow.unit_type),
        func.count(UsageEventRow.id).filter(UsageEventRow.status != "succeeded"),
    ).where(*where).group_by(UsageEventRow.kind, vendor, UsageEventRow.model)
     .order_by(func.coalesce(func.sum(UsageEventRow.estimated_usd), 0).desc(), func.count(UsageEventRow.id).desc())).all()
    return [UsageModelTotal(
        name=f"{row[1]}/{row[2]}", kind=row[0], provider=row[1], model=row[2], requests=row[3],
        input_tokens=row[4], output_tokens=row[5], estimated_usd=round(float(row[6]), 6),
        unpriced_requests=row[7], units=round(float(row[8]), 3), unit_type=row[9], failed_requests=row[10],
    ) for row in rows]


def _prep(session: Session, organization_id: UUID, where: list[Any],
          since: datetime | None, until: datetime | None) -> PrepUsage:
    in_prep = or_(UsageEventRow.prep_event_id.is_not(None), UsageEventRow.purpose.like(f"{PREP_PURPOSE_PREFIX}%"))
    searches = func.count(UsageEventRow.id).filter(UsageEventRow.kind == "search")
    totals = session.execute(select(
        *_aggregates(), searches,
        func.count(UsageEventRow.id).filter(and_(UsageEventRow.purpose == PREP_SYNTHESIS_PURPOSE,
                                                 UsageEventRow.kind.in_(("llm", "vision")))),
        func.count(func.distinct(UsageEventRow.prep_event_id)),
    ).where(*where, in_prep)).one()
    reports = [MeetingPrepRow.organization_id == str(organization_id)]
    if since is not None:
        reports.append(MeetingPrepRow.created_at >= since)
    if until is not None:
        reports.append(MeetingPrepRow.created_at < until)
    briefings = session.execute(select(func.count(MeetingPrepRow.id)).where(*reports)).scalar_one()
    return PrepUsage(
        requests=totals[0], input_tokens=totals[1], output_tokens=totals[2],
        estimated_usd=round(float(totals[3]), 6), unpriced_requests=totals[4], searches=int(totals[5]),
        sessions=totals[6], events_prepared=totals[7], briefings_generated=briefings,
    )


def _transcription(session: Session, where: list[Any]) -> TranscriptionUsage:
    row = session.execute(select(
        func.count(func.distinct(UsageEventRow.meeting_id)),
        func.coalesce(func.sum(UsageEventRow.units).filter(UsageEventRow.unit_type == "audio_seconds"), 0),
        func.coalesce(func.sum(UsageEventRow.estimated_usd), 0),
        func.count(UsageEventRow.id).filter(UsageEventRow.estimated_usd.is_(None)),
    ).where(*where, UsageEventRow.kind == "transcription")).one()
    return TranscriptionUsage(meetings=row[0], audio_seconds=round(float(row[1]), 3),
                              estimated_usd=round(float(row[2]), 6), unpriced=row[3])


def summarize(database: Database, organization_id: UUID, *, since: datetime | None = None,
              until: datetime | None = None) -> UsageSummary:
    where = _window(organization_id, since, until)
    with database.session_factory() as session:
        recent = session.execute(select(UsageEventRow).where(*where)
                                 .order_by(UsageEventRow.created_at.desc(), UsageEventRow.id.desc())
                                 .limit(RECENT_LIMIT)).scalars().all()
        totals = session.execute(select(
            *_aggregates(), func.count(UsageEventRow.id).filter(UsageEventRow.status != "succeeded"),
        ).where(*where)).one()
        meeting_totals = session.execute(select(UsageEventRow.meeting_id, *_aggregates()).where(
            *where, UsageEventRow.meeting_id.is_not(None),
        ).group_by(UsageEventRow.meeting_id).order_by(
            func.coalesce(func.sum(UsageEventRow.estimated_usd), 0).desc())).all()
        by_purpose = _grouped(session, UsageEventRow.purpose, where)
        by_provider = _grouped(session, _vendor(), where)
        by_kind = _grouped(session, UsageEventRow.kind, where)
        by_model = _by_model(session, where)
        prep = _prep(session, organization_id, where, since, until)
        transcription = _transcription(session, where)
    return UsageSummary(
        total_requests=totals[0], input_tokens=totals[1], output_tokens=totals[2],
        estimated_usd=round(float(totals[3]), 6), unpriced_requests=totals[4], failed_requests=totals[5],
        recent=[ModelUsageEvent(
            id=UUID(row.id), meeting_id=UUID(row.meeting_id) if row.meeting_id else None,
            knowledge_base_id=UUID(row.knowledge_base_id) if row.knowledge_base_id else None,
            purpose=row.purpose, provider=_row_vendor(row), model=row.model, kind=row.kind, status=row.status,
            input_tokens=row.input_tokens, output_tokens=row.output_tokens,
            estimated_usd=row.estimated_usd, created_at=row.created_at,
        ) for row in recent],
        by_meeting=[MeetingUsageTotal(
            meeting_id=UUID(row[0]), requests=row[1], input_tokens=row[2], output_tokens=row[3],
            estimated_usd=round(float(row[4]), 6), unpriced_requests=row[5],
        ) for row in meeting_totals],
        by_purpose=by_purpose, by_provider=by_provider, by_kind=by_kind, by_model=by_model,
        prep=prep, transcription=transcription, since=since, until=until,
    )
