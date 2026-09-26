"""Provider-reported usage and explicitly estimated spend for every metered call.

Every model, embedding, transcription and web-research call is appended to
``usage_events``. Prices are *estimates* from published list prices; anything
without a verified price stays unpriced (``estimated_usd`` is None) rather than
guessed. Reports and exports live in ``usage_report`` / ``usage_events``.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from meetings_contracts import (
    EmbeddingRequest,
    EmbeddingResult,
    ProviderProfile,
    TextGenerationRequest,
    TextGenerationResult,
)
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from .database import Database, UsageEventRow
from .model_catalog import ModelCatalogService
from .tenant import current_organization_id
from .usage_report import (
    MeetingUsageTotal,
    ModelUsageEvent,
    PrepUsage,
    TranscriptionUsage,
    UsageGroupTotal,
    UsageModelTotal,
    UsageSummary,
    summarize,
)

logger = logging.getLogger(__name__)

__all__ = [
    "MeetingUsageTotal", "ModelUsageEvent", "PrepUsage", "TranscriptionUsage", "UsageGroupTotal",
    "UsageLedger", "UsageModelTotal", "UsageSummary", "transcript_audio_seconds", "usage_request_scope",
]

# --- Published list prices (estimates only; verified 2026-09-26) -------------------------
# Source for every OpenAI constant below: https://developers.openai.com/api/docs/pricing
OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing"
# Speech-to-text, USD per audio minute: "Whisper $0.006 / minute", "gpt-4o-transcribe
# $0.006 / minute", "gpt-4o-mini-transcribe $0.003 / minute".
OPENAI_TRANSCRIPTION_USD_PER_MINUTE: dict[str, float] = {
    "whisper-1": 0.006,
    "gpt-4o-transcribe": 0.006,
    "gpt-4o-mini-transcribe": 0.003,
}
# Embeddings, USD per 1M input tokens: text-embedding-3-small $0.02, text-embedding-3-large $0.13.
OPENAI_EMBEDDING_USD_PER_MILLION: dict[str, float] = {
    "text-embedding-3-small": 0.02,
    "text-embedding-3-large": 0.13,
}
# gpt-6-luna standard short-context list price, USD per 1M tokens (input, output): $0.10 / $0.50.
OPENAI_TEXT_FALLBACK_PRICES: dict[str, tuple[float, float]] = {"gpt-6-luna": (0.10, 0.50)}
OPENAI_API_HOST = "api.openai.com"

# The HTTP request state (carrying ``actor``) for the call being served, so ledger rows
# written deep inside services still name the signed-in person who triggered them.
_request_state: ContextVar[object | None] = ContextVar("usage_request_state", default=None)


@contextmanager
def usage_request_scope(state: object) -> Iterator[None]:
    token = _request_state.set(state)
    try:
        yield
    finally:
        _request_state.reset(token)


def _current_actor_user_id() -> UUID | None:
    actor = getattr(_request_state.get(), "actor", None)
    user_id = getattr(actor, "user_id", None)
    return user_id if isinstance(user_id, UUID) else None


class UsageLedger:
    def __init__(self, database: Database, catalog: ModelCatalogService) -> None:
        self.database = database
        self.catalog = catalog

    def record_event(
        self,
        *,
        kind: str,
        purpose: str,
        provider: str,
        model: str,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        units: float | None = None,
        unit_type: str | None = "tokens",
        estimated_usd: float | None = None,
        price_source: str | None = None,
        duration_ms: int | None = None,
        status: str = "succeeded",
        meeting_id: object = None,
        knowledge_base_id: object = None,
        prep_event_id: object = None,
        actor_user_id: object = None,
        details: dict[str, Any] | None = None,
        organization_id: UUID | None = None,
    ) -> None:
        """Append one metered call to the workspace ledger. Never raises.

        ``kind`` is one of llm, embedding, vision, transcription, search, contents.
        ``estimated_usd`` stays None when no published price is known; callers must
        not invent prices. ``details`` holds non-secret metadata only (no keys, no
        prompts containing customer data beyond short labels).
        """
        try:
            self._insert(self._row(
                kind=kind, purpose=purpose, provider=provider, model=model, input_tokens=input_tokens,
                output_tokens=output_tokens, units=units, unit_type=unit_type, estimated_usd=estimated_usd,
                price_source=price_source, duration_ms=duration_ms, status=status, meeting_id=meeting_id,
                knowledge_base_id=knowledge_base_id, prep_event_id=prep_event_id, actor_user_id=actor_user_id,
                details=details, organization_id=organization_id,
            ))
        except SQLAlchemyError:
            # A usage write must not destroy a successfully generated MOM, answer or briefing.
            logger.exception("could not persist usage event")
        except LookupError:
            logger.warning("usage event skipped: no workspace scope for %s/%s", kind, purpose)

    def record(
        self, profile: ProviderProfile, request: TextGenerationRequest, result: TextGenerationResult,
        *, duration_ms: int | None = None, details: dict[str, Any] | None = None,
    ) -> None:
        metadata = request.metadata
        price = self.catalog.cached_price(profile, result.model)
        # Current published list rate; estimates exclude provider taxes, routing,
        # discounts and cache pricing. Unknown models stay unpriced.
        if price is None and result.provider == "openai":
            price = OPENAI_TEXT_FALLBACK_PRICES.get(result.model)
        estimated = None
        if price and result.input_tokens is not None and result.output_tokens is not None:
            estimated = round((result.input_tokens * price[0] + result.output_tokens * price[1]) / 1_000_000, 8)
        self.record_event(
            kind=str(metadata.get("usage_kind") or "llm"), purpose=str(metadata.get("purpose") or "mom_generation"),
            provider=result.provider, model=result.model, input_tokens=result.input_tokens,
            output_tokens=result.output_tokens, estimated_usd=estimated,
            price_source="catalog_list_price" if estimated is not None else None, duration_ms=duration_ms,
            meeting_id=metadata.get("meeting_id"), knowledge_base_id=metadata.get("knowledge_base_id"),
            prep_event_id=metadata.get("prep_event_id"), actor_user_id=metadata.get("actor_user_id"),
            details={**_profile_details(profile), "request_type": "text_generation", **(details or {})},
        )

    def record_embedding(
        self, profile: ProviderProfile, request: EmbeddingRequest, result: EmbeddingResult,
        *, duration_ms: int | None = None,
    ) -> None:
        price = OPENAI_EMBEDDING_USD_PER_MILLION.get(result.model) if result.provider == "openai" else None
        estimated = round(result.input_tokens * price / 1_000_000, 8) if price is not None and result.input_tokens is not None else None
        self.record_event(
            kind="embedding", purpose=str(request.metadata.get("purpose") or "knowledge_embedding"),
            provider=result.provider, model=result.model, input_tokens=result.input_tokens, output_tokens=0,
            estimated_usd=estimated, price_source="published_list_price" if estimated is not None else None,
            duration_ms=duration_ms, meeting_id=request.metadata.get("meeting_id"),
            knowledge_base_id=request.metadata.get("knowledge_base_id"),
            prep_event_id=request.metadata.get("prep_event_id"), actor_user_id=request.metadata.get("actor_user_id"),
            details={**_profile_details(profile), "request_type": "embedding",
                     "inputs": len(request.inputs), "dimensions": result.dimensions},
        )

    def record_failure(
        self, profile: ProviderProfile, metadata: dict[str, Any], *, kind: str, model: str | None,
        error: BaseException, duration_ms: int | None = None,
    ) -> None:
        """A failed provider call. Failed calls can still be billed, so they stay visible (unpriced)."""
        default_purpose = "knowledge_embedding" if kind == "embedding" else "mom_generation"
        self.record_event(
            kind=str(metadata.get("usage_kind") or kind), purpose=str(metadata.get("purpose") or default_purpose),
            provider=profile.provider_type.value, model=model or "unknown", unit_type=None,
            duration_ms=duration_ms, status="failed", meeting_id=metadata.get("meeting_id"),
            knowledge_base_id=metadata.get("knowledge_base_id"), prep_event_id=metadata.get("prep_event_id"),
            actor_user_id=metadata.get("actor_user_id"),
            details={**_profile_details(profile), "request_type": kind, "error_type": type(error).__name__},
        )

    def record_transcription(
        self, *, meeting_id: UUID, capture_id: object, route: dict[str, Any] | None,
        segments: Iterable[object], joined_at: datetime | None, stopped_at: datetime | None,
        organization_id: UUID | None = None,
    ) -> bool:
        """Record one transcription event per finished capture. Idempotent; never raises.

        Audio length is estimated from the captured transcript span (or the join/stop window
        when no segments exist). Vexa streams audio to the STT route, so provider billing can
        differ from this estimate; it is labelled as such in ``details``.
        """
        try:
            seconds, measure = transcript_audio_seconds(segments, joined_at, stopped_at)
            provider = str(route.get("provider_type")) if route else "vexa"
            model = str(route.get("model")) if route else "unknown"
            host = str(route.get("endpoint_host")) if route else None
            rate = OPENAI_TRANSCRIPTION_USD_PER_MINUTE.get(model) \
                if provider == "openai" and host == OPENAI_API_HOST else None
            estimated = round(seconds / 60 * rate, 8) if rate is not None and seconds is not None else None
            window = _window_ms(joined_at, stopped_at)
            row = self._row(
                kind="transcription", purpose="meeting_transcription", provider=provider, model=model,
                units=round(seconds, 3) if seconds is not None else None, unit_type="audio_seconds",
                estimated_usd=estimated, price_source="openai_stt_list_price_x_span" if estimated is not None else None,
                duration_ms=window, meeting_id=meeting_id, organization_id=organization_id,
                details={
                    "request_type": "vexa_bot_stt", "measure": measure,
                    "route": "per_bot_profile" if route else "vexa_default",
                    "profile_id": route.get("profile_id") if route else None,
                    "profile_name": route.get("profile_name") if route else None,
                    "endpoint_host": host, "capture_id": str(capture_id),
                    "note": "estimate from captured span; provider billing may differ",
                },
            )
            row.id = str(uuid5(NAMESPACE_URL, f"meetings-ai:transcription:{meeting_id}:{capture_id}"))
            with self.database.session_factory() as session:
                if session.get(UsageEventRow, row.id) is not None:
                    return False
            self._insert(row)
            return True
        except IntegrityError:
            return False  # A concurrent finalizer already recorded this capture.
        except (SQLAlchemyError, LookupError, TypeError, ValueError):
            logger.exception("could not persist transcription usage for %s", meeting_id)
            return False

    def summary(self, organization_id: UUID, *, since: datetime | None = None,
                until: datetime | None = None) -> UsageSummary:
        return summarize(self.database, organization_id, since=since, until=until)

    def _row(self, *, kind: str, purpose: str, provider: str, model: str, organization_id: UUID | None,
             details: dict[str, Any] | None, meeting_id: object = None, knowledge_base_id: object = None,
             prep_event_id: object = None, actor_user_id: object = None, input_tokens: int | None = None,
             output_tokens: int | None = None, units: float | None = None, unit_type: str | None = "tokens",
             estimated_usd: float | None = None, price_source: str | None = None,
             duration_ms: int | None = None, status: str = "succeeded") -> UsageEventRow:
        return UsageEventRow(
            id=str(uuid4()), organization_id=str(organization_id or current_organization_id()),
            kind=kind[:30], purpose=(purpose or kind)[:60], provider=(provider or "unknown")[:40],
            model=(model or "unknown")[:200], input_tokens=input_tokens, output_tokens=output_tokens,
            units=units, unit_type=unit_type, estimated_usd=estimated_usd,
            price_source=(price_source[:60] if price_source else None), duration_ms=duration_ms,
            status=status[:20], meeting_id=_uuid_text(meeting_id),
            knowledge_base_id=_uuid_text(knowledge_base_id), prep_event_id=_uuid_text(prep_event_id),
            actor_user_id=_uuid_text(actor_user_id) or _uuid_text(_current_actor_user_id()),
            details={key: value for key, value in (details or {}).items() if value is not None},
            created_at=datetime.now(UTC),
        )

    def _insert(self, row: UsageEventRow) -> None:
        with self.database.session_factory.begin() as session:
            session.add(row)


def transcript_audio_seconds(
    segments: Iterable[object], joined_at: datetime | None, stopped_at: datetime | None,
) -> tuple[float | None, str]:
    """Captured audio length: transcript span first, then the capture window, else unknown."""
    spans = [(float(item.start_seconds), float(item.end_seconds)) for item in segments]
    if spans:
        return max(max(end for _, end in spans) - min(start for start, _ in spans), 0.0), "transcript_span"
    window = _window_ms(joined_at, stopped_at)
    if window is not None:
        return window / 1000, "capture_window"
    return None, "unknown"


def _window_ms(joined_at: datetime | None, stopped_at: datetime | None) -> int | None:
    if joined_at is None or stopped_at is None:
        return None
    start = joined_at if joined_at.tzinfo else joined_at.replace(tzinfo=UTC)
    end = stopped_at if stopped_at.tzinfo else stopped_at.replace(tzinfo=UTC)
    return max(int((end - start).total_seconds() * 1000), 0)


def _profile_details(profile: ProviderProfile) -> dict[str, Any]:
    host = None
    if profile.base_url:
        from urllib.parse import urlsplit
        host = urlsplit(profile.base_url).hostname
    elif profile.provider_type.value == "openai":
        host = OPENAI_API_HOST
    return {"profile_id": str(profile.id), "profile_name": profile.name,
            "execution_location": profile.execution_location.value, "endpoint_host": host}


def _uuid_text(value: object) -> str | None:
    try:
        return str(UUID(str(value))) if value else None
    except ValueError:
        return None
