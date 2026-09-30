"""Per-workspace cache of Apollo results so repeat briefings and lookups do not spend Apollo credits again.

Enrichment results live 30 days; Research searches (``org_search`` / ``people_search``) live one day;
"Save to Apollo" stage/owner lists an hour and its duplicate checks 15 minutes.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID, uuid4

from sqlalchemy import delete, select
from sqlalchemy.exc import SQLAlchemyError

from .database import ApolloCacheRow, Database

logger = logging.getLogger(__name__)

CACHE_DAYS = 30
SEARCH_CACHE_HOURS = 24
CRM_LIST_MINUTES = 60
CRM_MATCH_MINUTES = 15
CacheKind = Literal["org", "person", "news", "jobs", "account", "contact", "org_search", "people_search",
                    "contact_stages", "account_stages", "users", "crm_match"]
# Stage and owner lists for "Save to Apollo" live an hour; a duplicate check only 15 minutes, so a
# "create anyway" or "link to existing" decision is always made against a recent look at Apollo.
_TTL: dict[str, timedelta] = {"org_search": timedelta(hours=SEARCH_CACHE_HOURS),
                              "people_search": timedelta(hours=SEARCH_CACHE_HOURS),
                              "contact_stages": timedelta(minutes=CRM_LIST_MINUTES),
                              "account_stages": timedelta(minutes=CRM_LIST_MINUTES),
                              "users": timedelta(minutes=CRM_LIST_MINUTES),
                              "crm_match": timedelta(minutes=CRM_MATCH_MINUTES)}


def ttl_for(kind: str) -> timedelta:
    return _TTL.get(kind, timedelta(days=CACHE_DAYS))


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


class ApolloCache:
    def __init__(self, database: Database, *, now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self.database = database
        self._now = now

    def get(self, organization_id: UUID | str, kind: CacheKind, key: str) -> dict[str, Any] | None:
        try:
            with self.database.session_factory() as session:
                row = session.execute(select(ApolloCacheRow).where(
                    ApolloCacheRow.organization_id == str(organization_id), ApolloCacheRow.kind == kind,
                    ApolloCacheRow.cache_key == key[:400],
                )).scalar_one_or_none()
        except SQLAlchemyError:
            logger.exception("could not read the Apollo cache")
            return None
        if row is None or _aware(row.expires_at) <= self._now():
            return None
        return row.payload if isinstance(row.payload, dict) else None

    def put(self, organization_id: UUID | str, kind: CacheKind, key: str, payload: dict[str, Any]) -> None:
        now = self._now()
        expires = now + ttl_for(kind)
        try:
            with self.database.session_factory.begin() as session:
                row = session.execute(select(ApolloCacheRow).where(
                    ApolloCacheRow.organization_id == str(organization_id), ApolloCacheRow.kind == kind,
                    ApolloCacheRow.cache_key == key[:400],
                )).scalar_one_or_none()
                if row is None:
                    session.add(ApolloCacheRow(id=str(uuid4()), organization_id=str(organization_id), kind=kind,
                                               cache_key=key[:400], payload=payload, fetched_at=now,
                                               expires_at=expires))
                else:
                    row.payload, row.fetched_at, row.expires_at = payload, now, expires
        except SQLAlchemyError:
            # A cache write must never fail a briefing; the next one simply asks Apollo again.
            logger.exception("could not write the Apollo cache")

    def clear(self, organization_id: UUID | str) -> None:
        with self.database.session_factory.begin() as session:
            session.execute(delete(ApolloCacheRow).where(ApolloCacheRow.organization_id == str(organization_id)))
