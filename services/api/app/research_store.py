"""Persistence for saved research profiles (workspace-shared) and each person's research chats (private).

Every query is scoped to the actor's workspace; chats are additionally scoped to their owner.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from .accounts import Actor
from .apollo_models import ApolloCompany, ApolloHiring, ApolloNewsItem, ApolloPerson
from .database import Database, ResearchConversationRow, ResearchMessageRow, ResearchProfileRow, UserRow
from .apollo_parsing import job_theme
from .research_models import ApolloCrmLink, JobGroup, PersonRef, ProfileKind, ResearchProfilePublic, apollo_record_url

MAX_PROFILES = 500
CRM_KEY = "apollo_crm"  # {record_type, record_id, record_name, action, by, at} once saved to / linked in Apollo
_KEPT_ON_REFRESH = (CRM_KEY,)
MAX_CONVERSATIONS = 50
HISTORY_TURNS = 6


class ProfileNotFoundError(LookupError):
    pass


class ResearchPermissionError(PermissionError):
    pass


class ResearchMessagePublic(BaseModel):
    id: UUID
    role: str
    content: str
    citations: list[dict[str, Any]] = Field(default_factory=list)
    provider: str | None = None
    model: str | None = None
    created_at: datetime


class ResearchConversationSummary(BaseModel):
    id: UUID
    profile_id: UUID
    title: str
    created_at: datetime
    updated_at: datetime


class ResearchConversationPublic(ResearchConversationSummary):
    messages: list[ResearchMessagePublic] = Field(default_factory=list)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def job_groups(hiring: ApolloHiring | None) -> list[JobGroup]:
    if hiring is None:
        return []
    groups = {theme.theme: JobGroup(theme=theme.theme, count=theme.count) for theme in hiring.themes}
    for job in hiring.examples:
        theme = job_theme(job.title)
        group = groups.setdefault(theme, JobGroup(theme=theme, count=0))
        group.jobs.append(job)
        group.count = max(group.count, len(group.jobs))
    return sorted(groups.values(), key=lambda group: group.count, reverse=True)


def crm_link(data: dict[str, Any], names: dict[str, str]) -> ApolloCrmLink | None:
    raw = data.get(CRM_KEY)
    if not isinstance(raw, dict) or raw.get("record_type") not in {"contact", "account"} or not raw.get("record_id"):
        return None
    by = raw.get("by") if isinstance(raw.get("by"), str) else None
    try:
        return ApolloCrmLink(
            record_type=raw["record_type"], record_id=str(raw["record_id"]), record_name=raw.get("record_name"),
            action="linked" if raw.get("action") == "linked" else "created",
            url=apollo_record_url(raw["record_type"], str(raw["record_id"])),
            by=PersonRef(id=UUID(by), name=names.get(by) or "A former teammate") if by else None,
            at=_aware(datetime.fromisoformat(str(raw.get("at")))))
    except ValueError:
        return None


def crm_user(row: ResearchProfileRow) -> str | None:
    raw = (row.data or {}).get(CRM_KEY)
    return raw.get("by") if isinstance(raw, dict) and isinstance(raw.get("by"), str) else None


def to_public(row: ResearchProfileRow, creator: str | None, actor: Actor,
              names: dict[str, str] | None = None) -> ResearchProfilePublic:
    data = row.data or {}
    company = ApolloCompany.model_validate(data["company"]) if isinstance(data.get("company"), dict) else None
    person = ApolloPerson.model_validate(data["person"]) if isinstance(data.get("person"), dict) else None
    hiring = ApolloHiring.model_validate(data["hiring"]) if isinstance(data.get("hiring"), dict) else None
    news = [ApolloNewsItem.model_validate(item) for item in data.get("news") or [] if isinstance(item, dict)]
    return ResearchProfilePublic(
        id=UUID(row.id), kind=row.kind, apollo_id=row.apollo_id, domain=row.domain, name=row.name, title=row.title,
        company=row.company, logo_url=data.get("logo_url") if isinstance(data.get("logo_url"), str) else None,
        company_facts=company, person=person, news=news, hiring=hiring, job_groups=job_groups(hiring),
        created_by=PersonRef(id=UUID(row.created_by), name=creator or "A former teammate") if row.created_by else None,
        created_at=_aware(row.created_at), updated_at=_aware(row.updated_at), fetched_at=_aware(row.fetched_at),
        apollo_calls=row.apollo_calls, can_delete=actor.is_admin or row.created_by == str(actor.user_id),
        apollo_crm=crm_link(data, names or {}),
    )


class ResearchStore:
    def __init__(self, database: Database) -> None:
        self.database = database

    # ----- profiles ----------------------------------------------------------------------------
    def get_row(self, actor: Actor, profile_id: UUID) -> ResearchProfileRow:
        with self.database.session_factory() as session:
            row = session.get(ResearchProfileRow, str(profile_id))
            if row is None or row.organization_id != str(actor.organization_id):
                raise ProfileNotFoundError("research profile not found")
            return row

    def public(self, actor: Actor, row: ResearchProfileRow) -> ResearchProfilePublic:
        names = self._names({value for value in (row.created_by, crm_user(row)) if value})
        return to_public(row, names.get(row.created_by or ""), actor, names)

    def find(self, actor: Actor, kind: ProfileKind, *, apollo_id: str | None, domain: str | None) -> ResearchProfileRow | None:
        with self.database.session_factory() as session:
            query = select(ResearchProfileRow).where(ResearchProfileRow.organization_id == str(actor.organization_id),
                                                     ResearchProfileRow.kind == kind)
            if apollo_id:
                return session.execute(query.where(ResearchProfileRow.apollo_id == apollo_id)).scalars().first()
            if kind == "company" and domain:
                return session.execute(query.where(ResearchProfileRow.domain == domain)).scalars().first()
            return None

    def list(self, actor: Actor, kind: ProfileKind | None = None) -> list[ResearchProfilePublic]:
        with self.database.session_factory() as session:
            query = select(ResearchProfileRow).where(ResearchProfileRow.organization_id == str(actor.organization_id))
            if kind:
                query = query.where(ResearchProfileRow.kind == kind)
            rows = session.execute(query.order_by(ResearchProfileRow.updated_at.desc()).limit(MAX_PROFILES)).scalars().all()
        names = self._names({value for row in rows for value in (row.created_by, crm_user(row)) if value})
        return [to_public(row, names.get(row.created_by or ""), actor, names) for row in rows]

    def saved_ids(self, actor: Actor, kind: ProfileKind, apollo_ids: list[str]) -> dict[str, UUID]:
        ids = [value for value in apollo_ids if value]
        if not ids:
            return {}
        with self.database.session_factory() as session:
            rows = session.execute(select(ResearchProfileRow.apollo_id, ResearchProfileRow.id).where(
                ResearchProfileRow.organization_id == str(actor.organization_id), ResearchProfileRow.kind == kind,
                ResearchProfileRow.apollo_id.in_(ids))).all()
        return {apollo_id: UUID(profile_id) for apollo_id, profile_id in rows}

    def people_at(self, actor: Actor, domain: str | None) -> list[ResearchProfilePublic]:
        if not domain:
            return []
        with self.database.session_factory() as session:
            rows = session.execute(select(ResearchProfileRow).where(
                ResearchProfileRow.organization_id == str(actor.organization_id), ResearchProfileRow.kind == "person",
                ResearchProfileRow.domain == domain).order_by(ResearchProfileRow.name).limit(100)).scalars().all()
        names = self._names({value for row in rows for value in (row.created_by, crm_user(row)) if value})
        return [to_public(row, names.get(row.created_by or ""), actor, names) for row in rows]

    def create(self, actor: Actor, *, kind: ProfileKind, apollo_id: str | None, domain: str | None, name: str,
               title: str | None, company: str | None, data: dict[str, Any], calls: int) -> ResearchProfileRow:
        now = datetime.now(UTC)
        row = ResearchProfileRow(
            id=str(uuid4()), organization_id=str(actor.organization_id), kind=kind, apollo_id=apollo_id,
            domain=domain, name=name[:200], title=(title or None) and title[:200], company=(company or None) and company[:200],
            data=data, created_by=str(actor.user_id), created_at=now, updated_at=now, fetched_at=now, apollo_calls=calls,
        )
        with self.database.session_factory.begin() as session:
            session.add(row)
        return row

    def refresh(self, actor: Actor, profile_id: UUID, *, name: str, title: str | None, company: str | None,
                domain: str | None, data: dict[str, Any], calls: int) -> ResearchProfileRow:
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            row = session.get(ResearchProfileRow, str(profile_id))
            if row is None or row.organization_id != str(actor.organization_id):
                raise ProfileNotFoundError("research profile not found")
            row.name, row.title, row.company = name[:200], (title or None) and title[:200], (company or None) and company[:200]
            row.domain = domain or row.domain
            kept = {key: (row.data or {})[key] for key in _KEPT_ON_REFRESH if key in (row.data or {})}
            row.data, row.updated_at, row.fetched_at = {**data, **kept}, now, now
            row.apollo_calls = (row.apollo_calls or 0) + calls
        return self.get_row(actor, profile_id)

    def set_crm(self, actor: Actor, profile_id: UUID, link: dict[str, Any]) -> ResearchProfileRow:
        """Remember where this profile now lives in Apollo (kept across refreshes)."""
        with self.database.session_factory.begin() as session:
            row = session.get(ResearchProfileRow, str(profile_id))
            if row is None or row.organization_id != str(actor.organization_id):
                raise ProfileNotFoundError("research profile not found")
            row.data = {**(row.data or {}), CRM_KEY: link}
        return self.get_row(actor, profile_id)

    def company_account(self, actor: Actor, domain: str | None) -> tuple[str, str] | None:
        """(Apollo account id, name) of the saved company at ``domain`` when it is already in Apollo."""
        if not domain:
            return None
        with self.database.session_factory() as session:
            rows = session.execute(select(ResearchProfileRow).where(
                ResearchProfileRow.organization_id == str(actor.organization_id), ResearchProfileRow.kind == "company",
                ResearchProfileRow.domain == domain).limit(5)).scalars().all()
        for row in rows:
            raw = (row.data or {}).get(CRM_KEY)
            if isinstance(raw, dict) and raw.get("record_type") == "account" and raw.get("record_id"):
                return str(raw["record_id"]), str(raw.get("record_name") or row.name)
        return None

    def delete(self, actor: Actor, profile_id: UUID) -> None:
        """Owners, admins and whoever saved it; everyone's chats about the profile go with it."""
        with self.database.session_factory.begin() as session:
            row = session.get(ResearchProfileRow, str(profile_id))
            if row is None or row.organization_id != str(actor.organization_id):
                raise ProfileNotFoundError("research profile not found")
            if not actor.is_admin and row.created_by != str(actor.user_id):
                raise ResearchPermissionError("Only the person who saved this profile or an admin can delete it.")
            conversations = select(ResearchConversationRow.id).where(ResearchConversationRow.profile_id == row.id)
            session.execute(delete(ResearchMessageRow).where(ResearchMessageRow.conversation_id.in_(conversations)))
            session.execute(delete(ResearchConversationRow).where(ResearchConversationRow.profile_id == row.id))
            session.delete(row)

    # ----- chats -------------------------------------------------------------------------------
    def conversations(self, actor: Actor, profile_id: UUID) -> list[ResearchConversationSummary]:
        self.get_row(actor, profile_id)
        with self.database.session_factory() as session:
            rows = session.execute(select(ResearchConversationRow).where(
                ResearchConversationRow.organization_id == str(actor.organization_id),
                ResearchConversationRow.profile_id == str(profile_id),
                ResearchConversationRow.user_id == str(actor.user_id),
            ).order_by(ResearchConversationRow.updated_at.desc()).limit(MAX_CONVERSATIONS)).scalars().all()
        return [self._summary(row) for row in rows]

    def conversation(self, actor: Actor, profile_id: UUID, conversation_id: UUID) -> ResearchConversationPublic:
        with self.database.session_factory() as session:
            row = self._own_conversation(session, actor, profile_id, conversation_id)
            messages = session.execute(select(ResearchMessageRow).where(
                ResearchMessageRow.conversation_id == row.id).order_by(ResearchMessageRow.position)).scalars().all()
            return ResearchConversationPublic(**self._summary(row).model_dump(), messages=[ResearchMessagePublic(
                id=UUID(item.id), role=item.role, content=item.content, citations=list(item.citations or []),
                provider=item.provider, model=item.model, created_at=_aware(item.created_at)) for item in messages])

    def history(self, actor: Actor, profile_id: UUID, conversation_id: UUID | None) -> list[ResearchMessagePublic]:
        if conversation_id is None:
            return []
        return self.conversation(actor, profile_id, conversation_id).messages[-HISTORY_TURNS:]

    def save_exchange(self, actor: Actor, profile_id: UUID, conversation_id: UUID | None, question: str, answer: str,
                      citations: list[dict[str, Any]], provider: str | None, model: str | None) -> UUID:
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            if conversation_id is None:
                row = ResearchConversationRow(id=str(uuid4()), organization_id=str(actor.organization_id),
                                              profile_id=str(profile_id), user_id=str(actor.user_id),
                                              title=question[:200], created_at=now, updated_at=now)
                session.add(row)
                session.flush()
            else:
                row = self._own_conversation(session, actor, profile_id, conversation_id)
                row.updated_at = now
            position = session.execute(select(func.coalesce(func.max(ResearchMessageRow.position), -1)).where(
                ResearchMessageRow.conversation_id == row.id)).scalar_one() + 1
            session.add(ResearchMessageRow(id=str(uuid4()), conversation_id=row.id, position=position, role="user",
                                           content=question, citations=[], provider=None, model=None, created_at=now))
            session.add(ResearchMessageRow(id=str(uuid4()), conversation_id=row.id, position=position + 1,
                                           role="assistant", content=answer, citations=citations, provider=provider,
                                           model=model, created_at=now))
            return UUID(row.id)

    def delete_conversation(self, actor: Actor, profile_id: UUID, conversation_id: UUID) -> None:
        with self.database.session_factory.begin() as session:
            row = self._own_conversation(session, actor, profile_id, conversation_id)
            session.execute(delete(ResearchMessageRow).where(ResearchMessageRow.conversation_id == row.id))
            session.delete(row)

    # ----- internals ---------------------------------------------------------------------------
    @staticmethod
    def _own_conversation(session, actor: Actor, profile_id: UUID, conversation_id: UUID) -> ResearchConversationRow:
        row = session.get(ResearchConversationRow, str(conversation_id))
        if row is None or row.organization_id != str(actor.organization_id) or row.profile_id != str(profile_id) \
                or row.user_id != str(actor.user_id):
            raise ProfileNotFoundError("conversation not found")
        return row

    @staticmethod
    def _summary(row: ResearchConversationRow) -> ResearchConversationSummary:
        return ResearchConversationSummary(id=UUID(row.id), profile_id=UUID(row.profile_id), title=row.title,
                                           created_at=_aware(row.created_at), updated_at=_aware(row.updated_at))

    def _names(self, user_ids: set[str]) -> dict[str, str]:
        if not user_ids:
            return {}
        with self.database.session_factory() as session:
            rows = session.execute(select(UserRow.id, UserRow.display_name, UserRow.email).where(UserRow.id.in_(user_ids))).all()
        return {user_id: display or (email or "A teammate").split("@")[0] for user_id, display, email in rows}
