"""The workspace's Apollo connection: connect (test first), replace, disconnect, status and failure alerts.

Owners and admins manage it; members' briefings use it without ever seeing the key. The API key goes
to Composio once and is never stored, logged, returned or put in a notification: we keep only the
Composio connected-account id, a masked hint (last 4) and who connected it when.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, SecretStr
from sqlalchemy import select

from .accounts import Actor
from .apollo_cache import ApolloCache
from .apollo_composio import ApolloComposio, ApolloError, mask_key
from .apollo_models import CreditLine
from .apollo_parsing import parse_credit_stats
from .apollo_research import ApolloContext, ApolloResearch, max_calls_from_env
from .database import Database, UserRow, WorkspaceIntegrationRow

logger = logging.getLogger(__name__)

PROVIDER = "apollo"
OUT_OF_CREDIT_RECHECK_HOURS = 6
ADMIN_ROLES = ("owner", "admin")
IntegrationStatus = Literal["active", "invalid", "out_of_credit"]
_STATUS_BY_ERROR: dict[str, IntegrationStatus] = {"invalid_key": "invalid", "out_of_credit": "out_of_credit"}


class IntegrationError(ValueError):
    """A user-fixable problem; the message is safe to show (never contains the key)."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


class ApolloKeyRequest(BaseModel):
    # Checked in the service (not by field constraints) so a rejected key is never echoed in a 422 body.
    api_key: SecretStr


def _clean_key(request: ApolloKeyRequest) -> str:
    secret = request.api_key.get_secret_value().strip()
    if not 8 <= len(secret) <= 200 or any(character.isspace() for character in secret):
        raise IntegrationError("Paste the Apollo API key exactly as shown in Apollo (8–200 characters, no spaces).")
    return secret


class ApolloIntegrationView(BaseModel):
    provider: Literal["apollo"] = "apollo"
    available: bool
    connected: bool
    status: IntegrationStatus | None = None
    hint: str | None = None
    connected_by: str | None = None
    connected_at: datetime | None = None
    updated_at: datetime | None = None
    last_checked_at: datetime | None = None
    last_error: str | None = None
    credits: list[CreditLine] = Field(default_factory=list)


class ApolloIntegrationService:
    def __init__(self, database: Database, client: ApolloComposio | None = None, *, notifications: Any | None = None,
                 usage: Any | None = None, cache: ApolloCache | None = None,
                 now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self.database = database
        self.client = client or ApolloComposio()
        self.notifications = notifications
        self.usage = usage
        self.cache = cache or ApolloCache(database)
        self._now = now

    # ----- reading -----------------------------------------------------------------------------
    def row(self, organization_id: UUID | str) -> WorkspaceIntegrationRow | None:
        with self.database.session_factory() as session:
            return session.execute(select(WorkspaceIntegrationRow).where(
                WorkspaceIntegrationRow.organization_id == str(organization_id),
                WorkspaceIntegrationRow.provider == PROVIDER,
            )).scalar_one_or_none()

    def status(self, actor: Actor, credits: list[CreditLine] | None = None) -> ApolloIntegrationView:
        _require_admin(actor)
        row = self.row(actor.organization_id)
        if row is None:
            return ApolloIntegrationView(available=self.client.configured, connected=False)
        return ApolloIntegrationView(
            available=self.client.configured, connected=True, status=row.status, hint=row.hint,
            connected_by=self._name(row.created_by), connected_at=row.created_at, updated_at=row.updated_at,
            last_checked_at=row.last_checked_at, last_error=row.last_error, credits=credits or [],
        )

    # ----- managing ----------------------------------------------------------------------------
    async def connect(self, actor: Actor, request: ApolloKeyRequest) -> ApolloIntegrationView:
        """Register the key with Composio, test it (free credit-usage call), then store only the reference."""
        _require_admin(actor)
        if not self.client.configured:
            raise IntegrationError("Apollo can't be connected yet: Composio is not configured on the server.", 409)
        secret = _clean_key(request)
        org = actor.organization_id
        try:
            account_id = await self.client.connect(org, secret)
        except ApolloError as exc:
            raise IntegrationError(_connect_message(exc), 502 if exc.kind in {"error", "timeout"} else 400) from None
        try:
            credits = await self._test(org, account_id, purpose="apollo_connection_test", actor=actor)
        except ApolloError as exc:
            await self._forget_account(org, account_id)
            raise IntegrationError(_connect_message(exc), 502 if exc.kind in {"error", "timeout"} else 400) from None
        previous = self._save(actor, account_id, mask_key(secret), "out_of_credit" if _exhausted(credits) else "active")
        if previous and previous != account_id:
            await self._forget_account(org, previous)
        return self.status(actor, credits)

    async def test(self, actor: Actor) -> ApolloIntegrationView:
        _require_admin(actor)
        row = self._require_row(actor.organization_id)
        try:
            credits = await self._test(actor.organization_id, row.connected_account_id,
                                       purpose="apollo_connection_test", actor=actor)
        except ApolloError as exc:
            self.record_failure(actor.organization_id, exc, notify=False)
            raise IntegrationError(f"Apollo check failed: {exc}.", 502 if exc.kind in {"error", "timeout"} else 400) from None
        return self.status(actor, credits)

    async def disconnect(self, actor: Actor) -> None:
        _require_admin(actor)
        row = self._require_row(actor.organization_id)
        try:
            await self.client.disconnect(actor.organization_id, row.connected_account_id)
        except ApolloError as exc:
            if exc.kind != "not_configured":
                raise IntegrationError("Apollo could not be disconnected in Composio; try again shortly.", 502) from None
        with self.database.session_factory.begin() as session:
            stored = session.get(WorkspaceIntegrationRow, row.id)
            if stored is not None and stored.organization_id == str(actor.organization_id):
                session.delete(stored)
        self.cache.clear(actor.organization_id)

    # ----- used by briefings and provider credits ----------------------------------------------
    def research_for(self, actor: Actor, event_id: UUID, *, refresh: bool = False) -> ApolloResearch | None:
        """An Apollo stage for one briefing, or None when Apollo is not connected (or known invalid)."""
        row = self.row(actor.organization_id)
        if row is None or row.status == "invalid" or not self.client.configured or self._credits_known_out(row):
            return None
        context = ApolloContext(organization_id=actor.organization_id, connected_account_id=row.connected_account_id,
                                prep_event_id=event_id, actor_user_id=actor.user_id, refresh=refresh,
                                max_calls=max_calls_from_env())
        return ApolloResearch(self.client, self.cache, self.usage, context,
                              on_failure=lambda error: self.record_failure(actor.organization_id, error))

    async def credit_lines(self, organization_id: UUID) -> list[CreditLine]:
        """Current credit balances (raises ApolloError); used by the provider-credits card."""
        row = self._require_row(organization_id)
        return await self._test(organization_id, row.connected_account_id, purpose="apollo_credit_check")

    def record_failure(self, organization_id: UUID | str, error: ApolloError, *, notify: bool = True) -> None:
        """401 marks the connection invalid, 402 out of credit; owners/admins hear about it once a day."""
        status = _STATUS_BY_ERROR.get(error.kind)
        try:
            with self.database.session_factory.begin() as session:
                row = session.execute(select(WorkspaceIntegrationRow).where(
                    WorkspaceIntegrationRow.organization_id == str(organization_id),
                    WorkspaceIntegrationRow.provider == PROVIDER)).scalar_one_or_none()
                if row is not None:
                    row.last_error = str(error)
                    row.last_checked_at = self._now()
                    if status:
                        row.status = status
        except Exception:  # noqa: BLE001 - bookkeeping must never break the briefing that failed
            logger.exception("could not record an Apollo failure")
        if notify and status:
            self._alert(organization_id, status)

    # ----- internals ---------------------------------------------------------------------------
    def _credits_known_out(self, row: WorkspaceIntegrationRow) -> bool:
        """Out of credits and checked recently: skip Apollo instead of spending a call on another 402."""
        if row.status != "out_of_credit" or row.last_checked_at is None:
            return False
        checked = row.last_checked_at if row.last_checked_at.tzinfo else row.last_checked_at.replace(tzinfo=UTC)
        return self._now() - checked < timedelta(hours=OUT_OF_CREDIT_RECHECK_HOURS)

    async def _test(self, organization_id: UUID | str, account_id: str, *, purpose: str,
                    actor: Actor | None = None) -> list[CreditLine]:
        started = time.monotonic()
        try:
            data = await self.client.credit_stats(organization_id, account_id)
        except ApolloError as exc:
            self._record(organization_id, purpose, 0, started, "failed", actor, {"error_kind": exc.kind})
            raise
        lines = parse_credit_stats(data)
        self._record(organization_id, purpose, len(lines), started, "succeeded", actor, {})
        with self.database.session_factory.begin() as session:
            row = session.execute(select(WorkspaceIntegrationRow).where(
                WorkspaceIntegrationRow.organization_id == str(organization_id),
                WorkspaceIntegrationRow.provider == PROVIDER)).scalar_one_or_none()
            if row is not None and row.connected_account_id == account_id:
                row.last_checked_at, row.last_error = self._now(), None
                row.status = "out_of_credit" if _exhausted(lines) else "active"
        return lines

    def _record(self, organization_id: UUID | str, purpose: str, records: int, started: float, status: str,
                actor: Actor | None, details: dict[str, Any]) -> None:
        if self.usage is None:
            return
        self.usage.record_event(
            kind="apollo", purpose=purpose, provider="apollo", model="apollo_view_credit_usage_stats", units=records,
            unit_type="records", estimated_usd=None, duration_ms=int((time.monotonic() - started) * 1000),
            status=status, actor_user_id=actor.user_id if actor else None,
            organization_id=UUID(str(organization_id)), details={"tool": "APOLLO_VIEW_CREDIT_USAGE_STATS", **details},
        )

    def _save(self, actor: Actor, account_id: str, hint: str, status: IntegrationStatus) -> str | None:
        now = self._now()
        with self.database.session_factory.begin() as session:
            row = session.execute(select(WorkspaceIntegrationRow).where(
                WorkspaceIntegrationRow.organization_id == str(actor.organization_id),
                WorkspaceIntegrationRow.provider == PROVIDER)).scalar_one_or_none()
            previous = row.connected_account_id if row else None
            if row is None:
                row = WorkspaceIntegrationRow(id=str(uuid4()), organization_id=str(actor.organization_id),
                                              provider=PROVIDER, created_at=now)
                session.add(row)
            row.connected_account_id, row.hint, row.status = account_id, hint, status
            row.created_by, row.created_at, row.updated_at = str(actor.user_id), now, now
            row.last_checked_at, row.last_error = now, None
        return previous

    async def _forget_account(self, organization_id: UUID | str, account_id: str) -> None:
        try:
            await self.client.disconnect(organization_id, account_id)
        except ApolloError:
            logger.warning("could not delete a replaced or rejected Apollo connection in Composio")

    def _require_row(self, organization_id: UUID | str) -> WorkspaceIntegrationRow:
        row = self.row(organization_id)
        if row is None:
            raise IntegrationError("Apollo is not connected for this workspace.", 404)
        return row

    def _name(self, user_id: str | None) -> str | None:
        if not user_id:
            return None
        with self.database.session_factory() as session:
            user = session.get(UserRow, user_id)
            return (user.display_name or user.email) if user else None

    def _alert(self, organization_id: UUID | str, status: IntegrationStatus) -> None:
        if self.notifications is None:
            return
        if status == "invalid":
            title, body = "Apollo rejected the workspace key", ("Briefings continue with web research only. Paste a "
                                                                "new Apollo API key under AI providers → Research sources.")
        else:
            title, body = "Apollo is out of credits", ("Briefings skip Apollo until credits renew or you top up in "
                                                       "Apollo. Web research still runs.")
        day = self._now().astimezone(UTC).date().isoformat()
        self.notifications.notify(str(organization_id), roles=ADMIN_ROLES, kind="provider_credit",
                                  severity="danger" if status == "invalid" else "warning", title=title, body=body,
                                  link_view="providers", dedupe_key=f"apollo:{status}:{day}")


def _require_admin(actor: Actor) -> None:
    if not actor.is_admin:
        raise IntegrationError("Only workspace owners and admins can manage Apollo.", 403)


def _exhausted(lines: list[CreditLine]) -> bool:
    limited = [line for line in lines if line.limit and line.limit > 0 and line.unit == "credits"]
    return bool(limited) and all((line.remaining or 0) <= 0 for line in limited)


def _connect_message(error: ApolloError) -> str:
    if error.kind == "invalid_key":
        return "Apollo rejected this API key. Check it in Apollo → Settings → Integrations → API and try again."
    if error.kind == "plan":
        return ("This Apollo key can't read credit usage. Use a master key (Apollo → Settings → API keys → "
                "Set as master key) and try again.")
    if error.kind == "out_of_credit":
        return "Apollo accepted the key but reports no credits left. Top up in Apollo, then connect again."
    if error.kind == "rate_limited":
        return "Apollo is rate limiting requests right now. Try again in a minute."
    if error.kind == "not_configured":
        return "Apollo can't be connected yet: Composio is not configured on the server."
    return "Apollo could not be reached through Composio. Try again shortly."
