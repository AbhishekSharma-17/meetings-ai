"""Selectable items per storage category (id, label, created_at, bytes) for targeted deletion."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import func, select, union
from sqlalchemy.orm import Session

from .storage import (
    CATEGORY_BY_KEY,
    StorageItem,
    T,
    TableSpec,
    any_of,
    grouped_bytes,
    ilike,
    measure_table,
    merge_sizes,
    org_bases,
    org_meetings,
)


def _sizes(session: Session, org: str, category: str, keys: list[str]) -> dict[str, tuple[int, int]]:
    return merge_sizes(*(grouped_bytes(session, spec, org, keys) for spec in CATEGORY_BY_KEY[category].tables
                         if spec.item_key))


def _item(key: str, label: str, created_at: datetime | None, sizes: dict[str, tuple[int, int]],
          detail: str | None = None) -> StorageItem:
    rows, size = sizes.get(key, (0, 0))
    return StorageItem(id=key, label=label, created_at=created_at, bytes=size, rows=rows, detail=detail)


def _where(*conditions: Any) -> list[Any]:
    return [item for item in conditions if item is not None]


def _meetings(session: Session, org: str, q: str | None, limit: int) -> list[StorageItem]:
    meetings, sources = T["meetings"], T["meeting_sources"]
    rows = session.execute(select(meetings.c.id, meetings.c.title, sources.c.title, meetings.c.platform,
                                  meetings.c.status, meetings.c.created_at)
                           .outerjoin(sources, sources.c.meeting_id == meetings.c.id)
                           .where(*_where(meetings.c.id.in_(org_meetings(org)),
                                          any_of(ilike(meetings.c.title, q), ilike(sources.c.title, q))))
                           .order_by(meetings.c.created_at.desc()).limit(limit)).all()
    sizes = _sizes(session, org, "meetings", [row[0] for row in rows])
    return [_item(row[0], row[1] or row[2] or f"{row[3]} meeting", row[5], sizes, f"{row[4]} · {row[3]}")
            for row in rows]


def _event_titles(session: Session, org: str, event_ids: list[str]) -> dict[str, tuple[str, datetime | None]]:
    events = T["calendar_event_cache"]
    rows = session.execute(select(events.c.id, events.c.payload, events.c.starts_at).where(
        events.c.organization_id == org, events.c.id.in_(event_ids))).all()
    return {row[0]: (str((row[1] or {}).get("title") or "Untitled event"), row[2]) for row in rows}


def _meeting_preps(session: Session, org: str, q: str | None, limit: int) -> list[StorageItem]:
    preps, inputs, documents = T["meeting_preps"], T["meeting_prep_inputs"], T["knowledge_documents"]
    touched = union(
        select(preps.c.calendar_event_id.label("event_id"), preps.c.created_at.label("at"))
        .where(preps.c.organization_id == org),
        select(inputs.c.calendar_event_id, inputs.c.updated_at).where(inputs.c.organization_id == org),
        select(documents.c.scope_id, documents.c.created_at)
        .where(documents.c.organization_id == org, documents.c.scope == "prep", documents.c.scope_id.is_not(None)),
    ).subquery()
    rows = session.execute(select(touched.c.event_id, func.max(touched.c.at)).group_by(touched.c.event_id)
                           .order_by(func.max(touched.c.at).desc())).all()
    titles = _event_titles(session, org, [row[0] for row in rows])
    if q:
        rows = [row for row in rows if q in titles.get(row[0], ("Deleted calendar event", None))[0].lower()]
    rows = rows[:limit]
    keys = [row[0] for row in rows]
    chunks = TableSpec("knowledge_chunks", lambda o: (T["knowledge_chunks"].c.organization_id == o)
                       & (T["knowledge_chunks"].c.scope == "prep"), "scope_id")
    sizes = merge_sizes(_sizes(session, org, "meeting_preps", keys), grouped_bytes(session, chunks, org, keys))
    return [_item(key, titles.get(key, ("Deleted calendar event", None))[0], at, sizes,
                  "includes prep documents and their search index") for key, at in rows]


def _documents(session: Session, org: str, q: str | None, limit: int) -> list[StorageItem]:
    documents, briefs = T["knowledge_documents"], T["organization_brief_documents"]
    rows = session.execute(select(documents.c.id, documents.c.filename, documents.c.created_at, documents.c.scope,
                                  documents.c.status)
                           .where(*_where(documents.c.organization_id == org, documents.c.scope != "prep",
                                          ilike(documents.c.filename, q)))
                           .order_by(documents.c.created_at.desc()).limit(limit)).all()
    legacy = session.execute(select(briefs.c.id, briefs.c.filename, briefs.c.uploaded_at)
                             .where(*_where(briefs.c.organization_id == org, ilike(briefs.c.filename, q),
                                            briefs.c.id.not_in(select(documents.c.id))))
                             .order_by(briefs.c.uploaded_at.desc()).limit(limit)).all()
    keys = [row[0] for row in rows] + [row[0] for row in legacy]
    chunks = TableSpec("knowledge_chunks", lambda o: T["knowledge_chunks"].c.organization_id == o, "document_id")
    sizes = merge_sizes(_sizes(session, org, "documents", keys), grouped_bytes(session, chunks, org, keys))
    items = [_item(row[0], row[1], row[2], sizes, f"{row[3].replace('_', ' ')} · {row[4]}") for row in rows]
    items += [_item(row[0], row[1], row[2], sizes, "organization profile document") for row in legacy]
    return sorted(items, key=lambda item: item.created_at.timestamp() if item.created_at else 0.0, reverse=True)[:limit]


def _base_related(session: Session, org: str, keys: list[str]) -> dict[str, tuple[int, int]]:
    chunks = TableSpec("knowledge_chunks", lambda o: (T["knowledge_chunks"].c.organization_id == o)
                       & (T["knowledge_chunks"].c.scope == "knowledge_base"), "scope_id")
    embeddings = CATEGORY_BY_KEY["search_index"].tables[1]
    documents = TableSpec("knowledge_documents", lambda o: (T["knowledge_documents"].c.organization_id == o)
                          & (T["knowledge_documents"].c.scope == "knowledge_base"), "scope_id")
    conversations = CATEGORY_BY_KEY["ai_chats"].tables[0]
    return merge_sizes(grouped_bytes(session, chunks, org, keys), grouped_bytes(session, embeddings, org, keys),
                       grouped_bytes(session, documents, org, keys),
                       grouped_bytes(session, conversations, org, keys, key_column="knowledge_base_id"))


def _knowledge_bases(session: Session, org: str, q: str | None, limit: int, *, index_only: bool) -> list[StorageItem]:
    bases = T["knowledge_bases"]
    rows = session.execute(select(bases.c.id, bases.c.name, bases.c.created_at, bases.c.visibility)
                           .where(*_where(bases.c.organization_id == org, ilike(bases.c.name, q)))
                           .order_by(bases.c.created_at.desc()).limit(limit)).all()
    keys = [row[0] for row in rows]
    if index_only:
        chunks = TableSpec("knowledge_chunks", lambda o: (T["knowledge_chunks"].c.organization_id == o)
                           & (T["knowledge_chunks"].c.scope == "knowledge_base"), "scope_id")
        sizes = merge_sizes(grouped_bytes(session, chunks, org, keys),
                            grouped_bytes(session, CATEGORY_BY_KEY["search_index"].tables[1], org, keys))
        items = [_item(row[0], f"Index: {row[1]}", row[2], sizes) for row in rows]
        return items + _scope_index_items(session, org, q)
    sizes = merge_sizes(_sizes(session, org, "knowledge_bases", keys), _base_related(session, org, keys))
    return [_item(row[0], row[1], row[2], sizes, f"{row[3]} · includes index, documents and chats") for row in rows]


def _scope_index_items(session: Session, org: str, q: str | None) -> list[StorageItem]:
    chunks = T["knowledge_chunks"]
    items = []
    for scope, label in (("organization", "Index: organization documents"), ("prep", "Index: meeting prep documents")):
        if q and q not in label.lower():
            continue
        spec = TableSpec("knowledge_chunks", lambda o, s=scope: (chunks.c.organization_id == o) & (chunks.c.scope == s))
        rows, size = measure_table(session, spec, org)
        if rows:
            items.append(StorageItem(id=scope, label=label, created_at=None, bytes=size, rows=rows))
    return items


def _chats(session: Session, org: str, q: str | None, limit: int) -> list[StorageItem]:
    conversations, bases, users = T["knowledge_conversations"], T["knowledge_bases"], T["users"]
    rows = session.execute(select(conversations.c.id, conversations.c.title, conversations.c.updated_at,
                                  bases.c.name, users.c.display_name)
                           .join(bases, bases.c.id == conversations.c.knowledge_base_id)
                           .outerjoin(users, users.c.id == conversations.c.user_id)
                           .where(*_where(conversations.c.knowledge_base_id.in_(org_bases(org)),
                                          ilike(conversations.c.title, q)))
                           .order_by(conversations.c.updated_at.desc()).limit(limit)).all()
    sizes = _sizes(session, org, "ai_chats", [row[0] for row in rows])
    return [_item(row[0], row[1], row[2], sizes, f"{row[3]} · {row[4] or 'former member'}") for row in rows]


def _calendar(session: Session, org: str, q: str | None, limit: int) -> list[StorageItem]:
    events = T["calendar_event_cache"]
    rows = session.execute(select(events.c.connection_id, func.max(events.c.provider), func.count(),
                                  func.max(events.c.synced_at))
                           .where(events.c.organization_id == org).group_by(events.c.connection_id)
                           .order_by(func.max(events.c.synced_at).desc())).all()
    if q:
        rows = [row for row in rows if q in f"{row[1]} {row[0]}".lower()]
    rows = rows[:limit]
    sizes = _sizes(session, org, "calendar_cache", [row[0] for row in rows])
    return [_item(row[0], f"{row[1]} calendar", row[3], sizes, f"{row[2]} cached events") for row in rows]


def _logs(session: Session, org: str, q: str | None) -> list[StorageItem]:
    items = []
    for key, label, names, stamp in (("usage", "Usage & cost ledger", ("usage_events", "model_usage"), "created_at"),
                                     ("audit", "Audit trail", ("audit_events",), "created_at")):
        if q and q not in label.lower():
            continue
        specs = [spec for spec in CATEGORY_BY_KEY["logs"].tables if spec.name in names]
        measured = [measure_table(session, spec, org) for spec in specs]
        oldest = session.execute(select(func.min(T[names[0]].c[stamp])).where(
            T[names[0]].c.organization_id == org)).scalar_one_or_none()
        items.append(StorageItem(id=key, label=label, created_at=oldest, rows=sum(item[0] for item in measured),
                                 bytes=sum(item[1] for item in measured), detail="created_at is the oldest entry"))
    return items


def list_items(session: Session, org: str, category: str, *, q: str | None, limit: int) -> list[StorageItem]:
    if category == "meetings":
        return _meetings(session, org, q, limit)
    if category == "meeting_preps":
        return _meeting_preps(session, org, q, limit)
    if category == "documents":
        return _documents(session, org, q, limit)
    if category == "knowledge_bases":
        return _knowledge_bases(session, org, q, limit, index_only=False)
    if category == "search_index":
        return _knowledge_bases(session, org, q, limit, index_only=True)
    if category == "ai_chats":
        return _chats(session, org, q, limit)
    if category == "calendar_cache":
        return _calendar(session, org, q, limit)
    if category == "logs":
        return _logs(session, org, q)
    raise ValueError(f"unknown storage category: {category}")
