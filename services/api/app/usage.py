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
from sqlalchemy import or_, select
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
# OpenAI GPT-6 standard short-context list prices, USD per 1M tokens (input, output),
# checked 2026-09-27 at https://developers.openai.com/api/docs/pricing. Used only when the
# live catalog has no price; long-context, cached and regional rates are not modelled.
OPENAI_TEXT_FALLBACK_PRICES: dict[str, tuple[float, float]] = {
    "gpt-6-luna": (0.10, 0.50),
    "gpt-6-sol": (2.00, 10.00),
    "gpt-6-astra": (10.00, 50.00),
}
OPENAI_API_HOST = "api.openai.com"
OPENROUTER_API_HOST = "openrouter.ai"
# Rows the ledger can price after the fact from their token counts or audio seconds
# (web research is priced per request when recorded).
REPRICEABLE_KINDS = ("llm", "vision", "embedding", "transcription")
REPRICE_BATCH = 500

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
        # Current published list rate; estimates exclude provider taxes, routing,
        # discounts and cache pricing. Unknown models stay unpriced.
        catalog_price = self.catalog.cached_price(profile, result.model)
        priced = (catalog_price, "catalog_list_price") if catalog_price else self.text_price(
            result.provider, _profile_details(profile)["endpoint_host"], result.model)
        estimated, source = None, None
        if priced and result.input_tokens is not None and result.output_tokens is not None:
            estimated, source = _text_cost(priced[0], result.input_tokens, result.output_tokens), priced[1]
        self.record_event(
            kind=str(metadata.get("usage_kind") or "llm"), purpose=str(metadata.get("purpose") or "mom_generation"),
            provider=result.provider, model=result.model, input_tokens=result.input_tokens,
            output_tokens=result.output_tokens, estimated_usd=estimated,
            price_source=source, duration_ms=duration_ms,
            meeting_id=metadata.get("meeting_id"), knowledge_base_id=metadata.get("knowledge_base_id"),
            prep_event_id=metadata.get("prep_event_id"), actor_user_id=metadata.get("actor_user_id"),
            details={**_profile_details(profile), "request_type": "text_generation",
                     **({"minutes_version_id": str(metadata["version_id"])} if metadata.get("version_id") else {}),
                     **(details or {})},
        )

    def record_embedding(
        self, profile: ProviderProfile, request: EmbeddingRequest, result: EmbeddingResult,
        *, duration_ms: int | None = None,
    ) -> None:
        priced = self.embedding_price(result.provider, _profile_details(profile)["endpoint_host"], result.model)
        estimated, source = None, None
        if priced is not None and result.input_tokens is not None:
            estimated, source = _embedding_cost(priced[0], result.input_tokens), priced[1]
        self.record_event(
            kind="embedding", purpose=str(request.metadata.get("purpose") or "knowledge_embedding"),
            provider=result.provider, model=result.model, input_tokens=result.input_tokens, output_tokens=0,
            estimated_usd=estimated, price_source=source,
            duration_ms=duration_ms, meeting_id=request.metadata.get("meeting_id"),
            knowledge_base_id=request.metadata.get("knowledge_base_id"),
            prep_event_id=request.metadata.get("prep_event_id"), actor_user_id=request.metadata.get("actor_user_id"),
            details={**_profile_details(profile), "request_type": "embedding",
                     "inputs": len(request.inputs), "dimensions": result.dimensions},
        )

    def text_price(self, provider: str, endpoint_host: str | None,
                   model: str) -> tuple[tuple[float, float], str] | None:
        """(USD per 1M input, output tokens) and its source, or None when no list price is known."""
        if endpoint_host == OPENROUTER_API_HOST:
            cached = self.catalog.cached_openrouter_text_price(model)
            if cached:
                return cached, "catalog_list_price"
        key = openai_list_model(provider, endpoint_host, model)
        fallback = OPENAI_TEXT_FALLBACK_PRICES.get(key) if key else None
        return (fallback, "published_list_price") if fallback else None

    def embedding_price(self, provider: str, endpoint_host: str | None, model: str) -> tuple[float, str] | None:
        """USD per 1M input tokens and its source, or None when no list price is known."""
        if endpoint_host == OPENROUTER_API_HOST:
            cached = self.catalog.cached_openrouter_embedding_price(model)
            if cached is not None:
                return cached, "catalog_list_price"
        key = openai_list_model(provider, endpoint_host, model)
        fallback = OPENAI_EMBEDDING_USD_PER_MILLION.get(key) if key else None
        return (fallback, "published_list_price") if fallback is not None else None

    def stt_price(self, provider: str, endpoint_host: str | None, model: str) -> tuple[float, str] | None:
        """USD per audio minute and its source, or None when no list price is known."""
        if endpoint_host == OPENROUTER_API_HOST:
            cached = self.catalog.cached_openrouter_stt_price(model)
            if cached is not None:
                return cached, "catalog_stt_list_price"
        key = openai_list_model(provider, endpoint_host, model)
        rate = OPENAI_TRANSCRIPTION_USD_PER_MINUTE.get(key) if key else None
        return (rate, "openai_stt_list_price") if rate is not None else None

    def reprice_unpriced(self, organization_id: UUID) -> int:
        """Price successful token-metered rows recorded while no list price was cached.

        Rows keep their token counts, so a price that becomes known later (the OpenRouter
        catalog loads lazily and is lost on restart) can still be applied. Returns rows priced.
        """
        priced = 0
        try:
            with self.database.session_factory.begin() as session:
                rows = session.execute(select(UsageEventRow).where(
                    UsageEventRow.organization_id == str(organization_id),
                    UsageEventRow.estimated_usd.is_(None), UsageEventRow.status == "succeeded",
                    UsageEventRow.kind.in_(REPRICEABLE_KINDS),
                    or_(UsageEventRow.input_tokens.is_not(None), UsageEventRow.units.is_not(None)),
                ).limit(REPRICE_BATCH)).scalars().all()
                for row in rows:
                    cost = self._backfill_cost(row)
                    if cost is not None:
                        row.estimated_usd, row.price_source = cost
                        priced += 1
        except SQLAlchemyError:
            logger.exception("could not reprice usage events")
            return 0
        return priced

    def _backfill_cost(self, row: UsageEventRow) -> tuple[float, str] | None:
        host = (row.details or {}).get("endpoint_host")
        if row.kind == "transcription":
            rate = self.stt_price(row.provider, host, row.model)
            if rate is None or row.units is None or row.unit_type != "audio_seconds":
                return None
            return round(row.units / 60 * rate[0], 8), f"{rate[1]}_x_span"
        if row.input_tokens is None:
            return None
        if row.kind == "embedding":
            price = self.embedding_price(row.provider, host, row.model)
            return (_embedding_cost(price[0], row.input_tokens), price[1]) if price else None
        text = self.text_price(row.provider, host, row.model)
        if text is None or row.output_tokens is None:
            return None
        return _text_cost(text[0], row.input_tokens, row.output_tokens), text[1]

    def has_unpriced_openrouter_rows(self, organization_id: UUID) -> bool:
        with self.database.session_factory() as session:
            rows = session.execute(select(UsageEventRow.details).where(
                UsageEventRow.organization_id == str(organization_id),
                UsageEventRow.estimated_usd.is_(None), UsageEventRow.status == "succeeded",
                UsageEventRow.kind.in_(REPRICEABLE_KINDS),
            ).limit(REPRICE_BATCH)).scalars().all()
        return any((details or {}).get("endpoint_host") == OPENROUTER_API_HOST for details in rows)

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
            rate = self.stt_price(provider, host, model)
            estimated = round(seconds / 60 * rate[0], 8) if rate is not None and seconds is not None else None
            window = _window_ms(joined_at, stopped_at)
            row = self._row(
                kind="transcription", purpose="meeting_transcription", provider=provider, model=model,
                units=round(seconds, 3) if seconds is not None else None, unit_type="audio_seconds",
                estimated_usd=estimated, price_source=f"{rate[1]}_x_span" if estimated is not None else None,
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


def openai_list_model(provider: str, endpoint_host: str | None, model: str) -> str | None:
    """The OpenAI model id whose published list price applies, for direct or OpenRouter calls.

    OpenRouter passes OpenAI models through at OpenAI's list price under an ``openai/`` prefix.
    """
    if provider == "openai" or endpoint_host == OPENAI_API_HOST:
        return model
    if endpoint_host == OPENROUTER_API_HOST and model.startswith("openai/"):
        return model.removeprefix("openai/")
    return None


def _text_cost(price: tuple[float, float], input_tokens: int, output_tokens: int) -> float:
    return round((input_tokens * price[0] + output_tokens * price[1]) / 1_000_000, 8)


def _embedding_cost(price_per_million: float, input_tokens: int) -> float:
    return round(input_tokens * price_per_million / 1_000_000, 8)


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
