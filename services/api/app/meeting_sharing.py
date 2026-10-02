"""Share a meeting's transcript and approved minutes with workspace members, and keep a history.

A share grants one member read access to the meeting's status, transcript and approved (or sent)
minutes; never edits, deletes or delivery changes. Owners and admins share and revoke; revoking
keeps the row so the history shows who had access and when. Recap emails, the first send and any
resend, are attributed to whoever sent them (``email_delivery_senders``), and the meeting's
history lists both.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID, uuid4

from meetings_contracts import MeetingMinutesPublic, MinutesStatus
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, select, update
from .database import NotificationEmailRow
from sqlalchemy.exc import IntegrityError

from .accounts import Actor
from .database import (
    Database,
    EmailDeliveryRow,
    EmailDeliverySenderRow,
    MeetingRow,
    MeetingShareRow,
    MeetingTenantRow,
    OrganizationMembershipRow,
    UserRow,
)

MAX_SHARE_RECIPIENTS = 25
DeliveryKind = Literal["recap", "resend"]


class SharingError(ValueError):
    """A share that can't be made (unknown person, not a member, self)."""


class ShareNotFoundError(LookupError):
    pass


class MeetingShareCreate(BaseModel):
    user_ids: list[UUID] = Field(min_length=1, max_length=MAX_SHARE_RECIPIENTS)
    note: str | None = Field(default=None, max_length=500)

    @field_validator("note")
    @classmethod
    def clean_note(cls, value: str | None) -> str | None:
        return value.strip() or None if value else None


class PersonRef(BaseModel):
    user_id: UUID
    display_name: str
    email: str | None = None


class MeetingSharePublic(BaseModel):
    id: UUID
    person: PersonRef
    shared_by: PersonRef | None
    note: str | None
    created_at: datetime
    revoked_at: datetime | None
    revoked_by: PersonRef | None


class RecapDeliveryPublic(BaseModel):
    id: UUID
    kind: DeliveryKind
    recipients: list[str]
    status: str
    error: str | None
    sent_by: PersonRef | None
    include_transcript: bool | None
    created_at: datetime


class MeetingSharingPublic(BaseModel):
    shares: list[MeetingSharePublic]
    deliveries: list[RecapDeliveryPublic]


class SharedMeetingView(BaseModel):
    """What a member the meeting was shared with sees besides the meeting and transcript."""

    shared_by: PersonRef | None
    shared_at: datetime
    note: str | None
    minutes: MeetingMinutesPublic | None


class SharedWithMeItem(BaseModel):
    meeting_id: UUID
    title: str
    platform: str
    status: str
    meeting_at: datetime
    shared_by: PersonRef | None
    shared_at: datetime
    note: str | None


def _live_shares(organization_id: str, user_id: str):
    """Unrevoked shares with a person, made during their current membership: a share from before
    they left (and were invited again) never grants access."""
    return select(MeetingShareRow).join(OrganizationMembershipRow, and_(
        OrganizationMembershipRow.organization_id == MeetingShareRow.organization_id,
        OrganizationMembershipRow.user_id == MeetingShareRow.user_id,
    )).where(
        MeetingShareRow.organization_id == organization_id, MeetingShareRow.user_id == user_id,
        MeetingShareRow.revoked_at.is_(None), MeetingShareRow.created_at >= OrganizationMembershipRow.created_at,
    )


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


class MeetingSharingService:
    def __init__(self, database: Database, minutes: Any, notifications: Any = None) -> None:
        self.database = database
        self.minutes = minutes
        self.notifications = notifications

    # ----- access -----------------------------------------------------------------------------
    def can_read(self, actor: Actor, meeting_id: UUID | str) -> bool:
        return self._active(actor, str(meeting_id)) is not None

    def _active(self, actor: Actor, meeting_id: str) -> MeetingShareRow | None:
        with self.database.session_factory() as session:
            return session.execute(_live_shares(str(actor.organization_id), str(actor.user_id)).where(
                MeetingShareRow.meeting_id == meeting_id,
            ).order_by(MeetingShareRow.created_at.desc()).limit(1)).scalar_one_or_none()

    # ----- sharing ----------------------------------------------------------------------------
    def share(self, actor: Actor, meeting_id: UUID, payload: MeetingShareCreate) -> MeetingSharingPublic:
        now = datetime.now(UTC)
        requested = list(dict.fromkeys(str(item) for item in payload.user_ids))
        if str(actor.user_id) in requested:
            raise SharingError("you already have access to this meeting")
        try:
            created, title = self._create(actor, meeting_id, requested, payload.note, now)
        except IntegrityError:
            # A simultaneous share for the same person won the race; theirs stands.
            created, title = self._create(actor, meeting_id, requested, payload.note, now)
        for share_id, user_id in created:
            self._announce(actor, meeting_id, title, payload.note, share_id, user_id)
        return self.history(actor, meeting_id)

    def _create(self, actor: Actor, meeting_id: UUID, requested: list[str], note: str | None,
                now: datetime) -> tuple[list[tuple[str, str]], str]:
        organization_id = str(actor.organization_id)
        created: list[tuple[str, str]] = []
        with self.database.session_factory.begin() as session:
            title = self._meeting_title(session, organization_id, str(meeting_id))
            members = set(session.execute(select(OrganizationMembershipRow.user_id).join(
                UserRow, UserRow.id == OrganizationMembershipRow.user_id,
            ).where(
                OrganizationMembershipRow.organization_id == organization_id,
                OrganizationMembershipRow.user_id.in_(requested), UserRow.status == "active",
            )).scalars())
            if missing := [item for item in requested if item not in members]:
                raise SharingError(f"{len(missing)} selected {'person is' if len(missing) == 1 else 'people are'} "
                                   "not an active member of this workspace")
            active = set(session.execute(select(MeetingShareRow.user_id).where(
                MeetingShareRow.organization_id == organization_id, MeetingShareRow.meeting_id == str(meeting_id),
                MeetingShareRow.revoked_at.is_(None),
            )).scalars())
            for user_id in requested:
                if user_id in active:
                    continue  # already shared: sharing again changes nothing
                row = MeetingShareRow(id=str(uuid4()), organization_id=organization_id, meeting_id=str(meeting_id),
                                      user_id=user_id, shared_by=str(actor.user_id), note=note, created_at=now)
                session.add(row)
                created.append((row.id, user_id))
        return created, title

    def revoke(self, actor: Actor, meeting_id: UUID, share_id: UUID) -> MeetingSharingPublic:
        with self.database.session_factory.begin() as session:
            row = session.get(MeetingShareRow, str(share_id))
            if row is None or row.organization_id != str(actor.organization_id) or row.meeting_id != str(meeting_id):
                raise ShareNotFoundError("share not found")
            if row.revoked_at is None:
                row.revoked_at = datetime.now(UTC)
                row.revoked_by = str(actor.user_id)
                if self.notifications is not None:
                    session.execute(update(NotificationEmailRow).where(
                        NotificationEmailRow.organization_id == row.organization_id,
                        NotificationEmailRow.user_id == row.user_id,
                        NotificationEmailRow.link_id == row.meeting_id,
                        NotificationEmailRow.status == "pending",
                    ).values(status="cancelled", last_error="Sharing was revoked before delivery."))
                    self.notifications.access_notice(
                        session, row.organization_id, user_ids=[row.user_id], kind="meeting.access_removed",
                        title="Meeting sharing was removed", body=f"{actor.display_name} removed a meeting shared with you.",
                    )
        return self.history(actor, meeting_id)

    def _announce(self, actor: Actor, meeting_id: UUID, title: str, note: str | None, share_id: str, user_id: str) -> None:
        if self.notifications is None:
            return
        self.notifications.notify(
            actor.organization_id, user_ids=[user_id], kind="meeting.shared", severity="info",
            title=f"{actor.display_name or 'A teammate'} shared “{title}” with you",
            body=note or "You can read its transcript and approved minutes.",
            link_view="meeting", link_id=meeting_id, meeting_id=meeting_id, dedupe_key=f"meeting-share:{share_id}")

    @staticmethod
    def _meeting_title(session, organization_id: str, meeting_id: str) -> str:
        tenant = session.get(MeetingTenantRow, meeting_id)
        meeting = session.get(MeetingRow, meeting_id)
        if tenant is None or meeting is None or tenant.organization_id != organization_id:
            raise ShareNotFoundError("meeting not found")
        return meeting.title or "Untitled meeting"

    # ----- recap senders ------------------------------------------------------------------------
    def record_sender(self, actor: Actor, meeting_id: UUID, delivery_id: UUID, kind: DeliveryKind,
                      include_transcript: bool) -> None:
        """Called just before sending, so a failed send is attributed as well."""
        with self.database.session_factory.begin() as session:
            session.add(EmailDeliverySenderRow(
                delivery_id=str(delivery_id), organization_id=str(actor.organization_id), meeting_id=str(meeting_id),
                sent_by=str(actor.user_id), kind=kind, include_transcript=include_transcript,
                created_at=datetime.now(UTC)))

    # ----- reading ----------------------------------------------------------------------------
    def history(self, actor: Actor, meeting_id: UUID) -> MeetingSharingPublic:
        organization_id = str(actor.organization_id)
        with self.database.session_factory() as session:
            self._meeting_title(session, organization_id, str(meeting_id))
            shares = session.execute(select(MeetingShareRow).where(
                MeetingShareRow.organization_id == organization_id, MeetingShareRow.meeting_id == str(meeting_id),
            ).order_by(MeetingShareRow.created_at.desc())).scalars().all()
            deliveries = session.execute(select(EmailDeliveryRow).where(
                EmailDeliveryRow.meeting_id == str(meeting_id),
            ).order_by(EmailDeliveryRow.created_at.desc()).limit(100)).scalars().all()
            senders = {row.delivery_id: row for row in session.execute(select(EmailDeliverySenderRow).where(
                EmailDeliverySenderRow.organization_id == organization_id,
                EmailDeliverySenderRow.meeting_id == str(meeting_id),
            )).scalars()}
            people = self._people(session, organization_id, {
                *(row.user_id for row in shares), *(row.shared_by for row in shares), *(row.revoked_by for row in shares),
                *(row.sent_by for row in senders.values()),
            })
            first_sent = min((row.created_at for row in deliveries if row.status == "sent"), default=None)
            return MeetingSharingPublic(
                shares=[MeetingSharePublic(
                    id=UUID(row.id), person=people.get(row.user_id) or PersonRef(user_id=UUID(row.user_id), display_name="Former member"),
                    shared_by=people.get(row.shared_by or ""), note=row.note, created_at=_utc(row.created_at),
                    revoked_at=_utc(row.revoked_at) if row.revoked_at else None, revoked_by=people.get(row.revoked_by or ""),
                ) for row in shares],
                deliveries=[self._delivery(row, senders.get(row.id), people, first_sent) for row in deliveries],
            )

    @staticmethod
    def _delivery(row: EmailDeliveryRow, sender: EmailDeliverySenderRow | None, people: dict[str, PersonRef],
                  first_sent: datetime | None) -> RecapDeliveryPublic:
        # Deliveries from before senders were recorded: anything after the first successful send is a resend.
        kind: DeliveryKind = sender.kind if sender else (  # type: ignore[assignment]
            "resend" if first_sent is not None and row.created_at > first_sent else "recap")
        return RecapDeliveryPublic(
            id=UUID(row.id), kind=kind, recipients=list(row.recipients or []), status=row.status, error=row.error,
            sent_by=people.get(sender.sent_by or "") if sender else None,
            include_transcript=sender.include_transcript if sender else None, created_at=_utc(row.created_at))

    @staticmethod
    def _people(session, organization_id: str, user_ids: set[str | None]) -> dict[str, PersonRef]:
        ids = [item for item in user_ids if item]
        if not ids:
            return {}
        rows = session.execute(select(UserRow).where(UserRow.id.in_(ids))).scalars().all()
        return {row.id: PersonRef(user_id=UUID(row.id), display_name=row.display_name, email=row.email) for row in rows}

    def shared_view(self, actor: Actor, meeting_id: UUID) -> SharedMeetingView:
        row = self._active(actor, str(meeting_id))
        if row is None:
            raise ShareNotFoundError("this meeting isn't shared with you")
        with self.database.session_factory() as session:
            people = self._people(session, str(actor.organization_id), {row.shared_by})
        minutes = None
        try:
            current = self.minutes.get(meeting_id)
            if current.status in {MinutesStatus.APPROVED, MinutesStatus.SENT}:
                minutes = self.minutes.to_public(current)
        except LookupError:
            minutes = None
        return SharedMeetingView(shared_by=people.get(row.shared_by or ""), shared_at=_utc(row.created_at),
                                 note=row.note, minutes=minutes)

    def shared_with_me(self, actor: Actor) -> list[SharedWithMeItem]:
        organization_id = str(actor.organization_id)
        with self.database.session_factory() as session:
            rows = session.execute(_live_shares(organization_id, str(actor.user_id)).add_columns(MeetingRow).join(
                MeetingRow, MeetingRow.id == MeetingShareRow.meeting_id,
            ).order_by(MeetingShareRow.created_at.desc()).limit(200)).all()
            people = self._people(session, organization_id, {share.shared_by for share, _ in rows})
        seen: set[str] = set()
        items = []
        for share, meeting in rows:
            if meeting.id in seen:
                continue
            seen.add(meeting.id)
            items.append(SharedWithMeItem(
                meeting_id=UUID(meeting.id), title=meeting.title or "Untitled meeting", platform=meeting.platform,
                status=meeting.status, meeting_at=_utc(meeting.joined_at or meeting.created_at),
                shared_by=people.get(share.shared_by or ""), shared_at=_utc(share.created_at), note=share.note))
        return items
