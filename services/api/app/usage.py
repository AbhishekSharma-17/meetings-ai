"""Provider-reported token usage and explicitly estimated model spend."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID, uuid4

from meetings_contracts import EmbeddingRequest, EmbeddingResult, ProviderProfile, TextGenerationRequest, TextGenerationResult
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

from .database import Database, ModelUsageRow
from .model_catalog import ModelCatalogService
from .tenant import current_organization_id

logger = logging.getLogger(__name__)


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


class UsageSummary(BaseModel):
    total_requests: int
    input_tokens: int
    output_tokens: int
    estimated_usd: float
    unpriced_requests: int
    recent: list[ModelUsageEvent]
    by_meeting: list["MeetingUsageTotal"]


class MeetingUsageTotal(BaseModel):
    meeting_id: UUID
    requests: int
    input_tokens: int
    output_tokens: int
    estimated_usd: float
    unpriced_requests: int


class UsageLedger:
    def __init__(self, database: Database, catalog: ModelCatalogService) -> None:
        self.database = database
        self.catalog = catalog

    def record(self, profile: ProviderProfile, request: TextGenerationRequest, result: TextGenerationResult) -> None:
        metadata = request.metadata
        price = self.catalog.cached_price(profile, result.model)
        # Current published list rate; estimates exclude provider taxes, routing,
        # discounts and cache pricing. Unknown models stay unpriced.
        if price is None and result.provider == "openai" and result.model == "gpt-6-luna":
            price = (0.10, 0.50)
        estimated = None
        if price and result.input_tokens is not None and result.output_tokens is not None:
            estimated = round((result.input_tokens * price[0] + result.output_tokens * price[1]) / 1_000_000, 8)
        try:
            with self.database.session_factory.begin() as session:
                session.add(ModelUsageRow(
                    id=str(uuid4()), organization_id=str(current_organization_id()),
                    meeting_id=_uuid_text(metadata.get("meeting_id")),
                    knowledge_base_id=_uuid_text(metadata.get("knowledge_base_id")),
                    purpose=str(metadata.get("purpose") or "mom_generation")[:60],
                    provider=result.provider, model=result.model,
                    input_tokens=result.input_tokens, output_tokens=result.output_tokens,
                    estimated_usd=estimated, created_at=datetime.now(UTC),
                ))
        except SQLAlchemyError:
            # A usage write must not destroy a successfully generated MOM or answer.
            logger.exception("could not persist model usage")

    def record_embedding(self, profile: ProviderProfile, request: EmbeddingRequest, result: EmbeddingResult) -> None:
        price = 0.02 if result.provider == "openai" and result.model == "text-embedding-3-small" else None
        if result.provider == "openai" and result.model == "text-embedding-3-large":
            price = 0.13
        estimated = round(result.input_tokens * price / 1_000_000, 8) if price is not None and result.input_tokens is not None else None
        try:
            with self.database.session_factory.begin() as session:
                session.add(ModelUsageRow(
                    id=str(uuid4()), organization_id=str(current_organization_id()),
                    meeting_id=_uuid_text(request.metadata.get("meeting_id")),
                    knowledge_base_id=_uuid_text(request.metadata.get("knowledge_base_id")),
                    purpose=str(request.metadata.get("purpose") or "knowledge_embedding")[:60],
                    provider=result.provider, model=result.model, input_tokens=result.input_tokens,
                    output_tokens=0, estimated_usd=estimated, created_at=datetime.now(UTC),
                ))
        except SQLAlchemyError:
            logger.exception("could not persist embedding usage")

    def summary(self, organization_id: UUID) -> UsageSummary:
        with self.database.session_factory() as session:
            rows = session.execute(select(ModelUsageRow).where(
                ModelUsageRow.organization_id == str(organization_id),
            ).order_by(ModelUsageRow.created_at.desc()).limit(100)).scalars().all()
            totals = session.execute(select(
                func.count(ModelUsageRow.id),
                func.coalesce(func.sum(ModelUsageRow.input_tokens), 0),
                func.coalesce(func.sum(ModelUsageRow.output_tokens), 0),
                func.coalesce(func.sum(ModelUsageRow.estimated_usd), 0),
                func.count(ModelUsageRow.id).filter(ModelUsageRow.estimated_usd.is_(None)),
            ).where(ModelUsageRow.organization_id == str(organization_id))).one()
            meeting_totals = session.execute(select(
                ModelUsageRow.meeting_id,
                func.count(ModelUsageRow.id),
                func.coalesce(func.sum(ModelUsageRow.input_tokens), 0),
                func.coalesce(func.sum(ModelUsageRow.output_tokens), 0),
                func.coalesce(func.sum(ModelUsageRow.estimated_usd), 0),
                func.count(ModelUsageRow.id).filter(ModelUsageRow.estimated_usd.is_(None)),
            ).where(
                ModelUsageRow.organization_id == str(organization_id),
                ModelUsageRow.meeting_id.is_not(None),
            ).group_by(ModelUsageRow.meeting_id).order_by(func.sum(ModelUsageRow.estimated_usd).desc()).limit(50)).all()
        return UsageSummary(
            total_requests=totals[0], input_tokens=totals[1], output_tokens=totals[2],
            estimated_usd=round(float(totals[3]), 6), unpriced_requests=totals[4],
            recent=[ModelUsageEvent(
                id=UUID(row.id), meeting_id=UUID(row.meeting_id) if row.meeting_id else None,
                knowledge_base_id=UUID(row.knowledge_base_id) if row.knowledge_base_id else None,
                purpose=row.purpose, provider=row.provider, model=row.model,
                input_tokens=row.input_tokens, output_tokens=row.output_tokens,
                estimated_usd=row.estimated_usd, created_at=row.created_at,
            ) for row in rows],
            by_meeting=[MeetingUsageTotal(
                meeting_id=UUID(row[0]), requests=row[1], input_tokens=row[2],
                output_tokens=row[3], estimated_usd=round(float(row[4]), 6),
                unpriced_requests=row[5],
            ) for row in meeting_totals],
        )


def _uuid_text(value: object) -> str | None:
    try:
        return str(UUID(str(value))) if value else None
    except ValueError:
        return None
