"""Which meetings a person may already see, so Research never shows more than the rest of the app.

Mirrors the ``require_admin`` middleware and meeting routes: owners and admins read every meeting in the
workspace; anyone else reads a meeting only when its assistant covers them (owner or sharing notes), or
when it is completed, opted into knowledge and filed in a knowledge base they can read.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from .accounts import Actor
from .database import (
    KnowledgeBaseAccessRow, KnowledgeBaseRow, MeetingCoverageRow, MeetingKnowledgeBaseRow, MeetingKnowledgeSettingsRow,
    MeetingRow, MeetingTenantRow,
)


def tenant_meeting_ids(session: Session, actor: Actor, candidates: Iterable[str]) -> set[str]:
    ids = list(dict.fromkeys(candidates))
    if not ids:
        return set()
    return set(session.execute(select(MeetingTenantRow.meeting_id).where(
        MeetingTenantRow.organization_id == str(actor.organization_id), MeetingTenantRow.meeting_id.in_(ids),
    )).scalars())


def readable_base_ids(session: Session, actor: Actor) -> set[str]:
    rows = session.execute(select(KnowledgeBaseRow.id, KnowledgeBaseRow.created_by, KnowledgeBaseRow.visibility).where(
        KnowledgeBaseRow.organization_id == str(actor.organization_id))).all()
    if actor.is_admin:
        return {row.id for row in rows}
    shared = set(session.execute(select(KnowledgeBaseAccessRow.knowledge_base_id).where(
        KnowledgeBaseAccessRow.user_id == str(actor.user_id))).scalars())
    return {row.id for row in rows if row.created_by == str(actor.user_id) or row.visibility == "organization"
            or row.id in shared}


def readable_meeting_ids(session: Session, actor: Actor, candidates: Iterable[str]) -> set[str]:
    """The subset of ``candidates`` (meeting ids) this person may open."""
    ids = tenant_meeting_ids(session, actor, candidates)
    if not ids or actor.is_admin:
        return ids
    covered = set(session.execute(select(MeetingCoverageRow.meeting_id).where(
        MeetingCoverageRow.organization_id == str(actor.organization_id), MeetingCoverageRow.user_id == str(actor.user_id),
        MeetingCoverageRow.meeting_id.in_(list(ids)))).scalars())
    remaining = list(ids - covered)
    if not remaining:
        return covered
    bases = readable_base_ids(session, actor)
    shared = set(session.execute(select(MeetingRow.id).join(
        MeetingKnowledgeSettingsRow, MeetingKnowledgeSettingsRow.meeting_id == MeetingRow.id,
    ).join(MeetingKnowledgeBaseRow, MeetingKnowledgeBaseRow.meeting_id == MeetingRow.id).where(
        MeetingRow.id.in_(remaining), MeetingRow.status == "completed",
        MeetingKnowledgeSettingsRow.knowledge_enabled.is_(True),
        MeetingKnowledgeBaseRow.knowledge_base_id.in_(list(bases) or [""]),
    )).scalars())
    return covered | shared
