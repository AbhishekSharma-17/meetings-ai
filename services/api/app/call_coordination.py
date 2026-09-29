"""Call coordination: several teammates set an assistant for the same call.

Decisions (recorded in ``meeting_coverage``):
- ``share``: rely on a teammate's assistant. No second bot; your own pending schedule for the
  call is cancelled (handed over) and you may read that meeting's status, transcript and
  approved minutes, and optionally receive its recap. Editing stays with the owner and admins.
- ``own``: keep your own assistant too. The capture service allows one bot per call link at a
  time, so whichever joins first records it; the other stands down automatically and its owner
  becomes a sharer of the one in the call (``join_refused``).
The scheduler never joins a record that was handed over, nor a second record of the same
person for the same call (``join_guard``).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import select

from .call_coverage import AssistantRecord, calendar_holders, coverage_row, emails, load_record, load_records, names, same_call_records
from .call_coordination_views import ACTIVE_STATES, CoordinationError, CoordinationViews
from .call_keys import call_key_for_url
from .coordination_models import MeetingCoordination
from .database import (
    CalendarEventCacheRow, CalendarScheduleRow, Database, MeetingCoverageRow, MeetingMinutesRow, MeetingTenantRow,
)
from .notification_events import NO_EVENTS
from .tenant import current_organization_id

logger = logging.getLogger(__name__)
HEADS_UP_HORIZON = timedelta(days=14)
MAX_RECIPIENTS = 50


def _now() -> datetime:
    return datetime.now(UTC)


class CallCoordinationService(CoordinationViews):
    def __init__(self, database: Database, notices: Any = NO_EVENTS, repository: Any = None) -> None:
        super().__init__(database)
        self.notices = notices
        self.repository = repository

    # ----- owners ---------------------------------------------------------------------------
    def record_owner(self, organization_id: UUID | str, meeting_id: UUID | str, user_id: UUID | str,
                     decision: str | None = None) -> None:
        """The person who scheduled or sent an assistant owns it (first writer wins). Never raises."""
        try:
            self._record_owner(str(organization_id), str(meeting_id), str(user_id), decision)
        except Exception:
            logger.exception("could not record the owner of meeting %s", meeting_id)

    def _record_owner(self, org: str, meeting: str, user: str, decision: str | None) -> None:
        with self.database.session_factory.begin() as session:
            # Coverage rows are only ever written for a meeting of the caller's own workspace.
            tenant = session.execute(select(MeetingTenantRow.organization_id).where(
                MeetingTenantRow.meeting_id == meeting)).scalar_one_or_none()
            if tenant != org:
                return
            existing = session.execute(select(MeetingCoverageRow).where(
                MeetingCoverageRow.meeting_id == meeting, MeetingCoverageRow.role == "owner",
                MeetingCoverageRow.organization_id == org)).scalar_one_or_none()
            if existing is not None:
                if decision and existing.user_id == user and existing.decision != "handed_over":
                    existing.decision, existing.decided_at, existing.decided_by = decision, _now(), user
                return
            session.execute(MeetingCoverageRow.__table__.delete().where(
                MeetingCoverageRow.meeting_id == meeting, MeetingCoverageRow.user_id == user))
            session.add(MeetingCoverageRow(
                meeting_id=meeting, user_id=user, organization_id=org, role="owner", decision=decision,
                handed_to_meeting_id=None, receive_recap=False, decided_at=_now(), decided_by=user))

    @staticmethod
    def owned_by(session, meeting_id: str, user_id: UUID | str, organization_id: UUID | str) -> bool:
        """Whether ``user_id`` owns this meeting's assistant (coverage owner, else who scheduled it)."""
        owner = session.execute(select(MeetingCoverageRow.user_id).where(
            MeetingCoverageRow.meeting_id == meeting_id, MeetingCoverageRow.role == "owner",
            MeetingCoverageRow.organization_id == str(organization_id),
        ).order_by(MeetingCoverageRow.decided_at).limit(1)).scalar_one_or_none()
        if owner is None:
            schedule = session.get(CalendarScheduleRow, meeting_id)
            owner = schedule.user_id if schedule is not None else None
        return owner is None or owner == str(user_id)

    def announce(self, actor, meeting_id: UUID | str, decision: str | None = None) -> None:
        """After an assistant is scheduled or sent: record its owner and tell the teammates concerned."""
        try:
            self.record_owner(actor.organization_id, meeting_id, actor.user_id, "own" if decision == "own" else None)
            self._announce(actor, str(meeting_id), decision)
        except Exception:  # coordination must never break scheduling or joining
            logger.exception("could not announce call coordination for meeting %s", meeting_id)

    def _announce(self, actor, meeting_id: str, decision: str | None) -> None:
        me, org = str(actor.user_id), self._org(actor)
        with self.database.session_factory() as session:
            record = load_record(session, org, meeting_id)
            if record is None or record.state not in ACTIVE_STATES:
                return
            others = [item for item in same_call_records(session, org, record.key, record.window, exclude=meeting_id)
                      if item.state in ACTIVE_STATES and item.owner_id and item.owner_id != me]
            holders = calendar_holders(session, org, record.key, record.window)
        name = actor.display_name or "A teammate"
        for other in others:
            if decision == "own":
                self.notices.two_assistants(org, recipient=other.owner_id, recipient_meeting=other.meeting_id,
                                            title=other.title, actor_name=name, new_meeting=meeting_id)
            else:
                self.notices.teammate_also_scheduled(org, recipient=other.owner_id, recipient_meeting=other.meeting_id,
                                                     title=other.title, actor_name=name, new_meeting=meeting_id,
                                                     starts_at=record.starts_at)
        told = {me, *self._people_of(others)}
        for user_id, row in holders.items():
            if user_id in told:
                continue
            self.notices.calendar_heads_up(org, recipient=user_id, meeting_id=meeting_id,
                                           event_title=(row.payload or {}).get("title"), owner_name=name,
                                           starts_at=record.starts_at, in_call=record.state == "in_call")

    # ----- share / stop sharing --------------------------------------------------------------
    def share(self, actor, meeting_id: UUID, receive_recap: bool = True) -> MeetingCoordination:
        me, org = str(actor.user_id), self._org(actor)
        with self.database.session_factory() as session:
            record = self._require_record(session, actor, meeting_id)
            allowed = actor.is_admin or self._on_calendar(session, actor, record) or \
                coverage_row(session, org, record.meeting_id, me) is not None
            if not allowed:
                raise CoordinationError("meeting not found", 404)
            if record.owner_id == me:
                raise CoordinationError("this is your own assistant")
            if record.decision == "handed_over" or record.state not in ACTIVE_STATES | {"ended"}:
                raise CoordinationError("this assistant is not set to join the call; share the one that is")
            mine = [item for item in same_call_records(session, org, record.key, record.window, exclude=record.meeting_id)
                    if item.owner_id == me and item.state == "scheduled"]
            owner_name = names(session, {record.owner_id} if record.owner_id else set()).get(record.owner_id or "")
        recap = self._add_recap(actor, record, receive_recap)
        self._save_sharing(org, record.meeting_id, me, recap, decided_by=me)
        for own in mine:
            self._hand_over(org, own, record.meeting_id, me, owner_name)
        if record.owner_id:
            self.notices.now_sharing(org, owner=record.owner_id, meeting_id=record.meeting_id, title=record.title,
                                     sharer=me, sharer_name=actor.display_name or "A teammate", receive_recap=recap)
        return self.view(actor, meeting_id)

    def stop_sharing(self, actor, meeting_id: UUID) -> MeetingCoordination:
        me, org = str(actor.user_id), self._org(actor)
        with self.database.session_factory.begin() as session:
            row = coverage_row(session, org, str(meeting_id), me)
            if row is None or row.role != "sharing":
                raise CoordinationError("you are not sharing this assistant", 404)
            had_recap = row.receive_recap
            session.delete(row)
        if had_recap:
            self._remove_recap(actor, str(meeting_id))
        if actor.is_admin:
            return self.view(actor, meeting_id)
        return MeetingCoordination(meeting_id=meeting_id, state="idle", starts_at=_now())

    def _save_sharing(self, org: str, meeting_id: str, user_id: str, receive_recap: bool, *, decided_by: str | None) -> None:
        with self.database.session_factory.begin() as session:
            row = coverage_row(session, org, meeting_id, user_id)
            if row is None:
                session.add(MeetingCoverageRow(
                    meeting_id=meeting_id, user_id=user_id, organization_id=org, role="sharing", decision="share",
                    handed_to_meeting_id=None, receive_recap=receive_recap, decided_at=_now(), decided_by=decided_by))
            elif row.role == "sharing":
                row.receive_recap, row.decided_at, row.decided_by = receive_recap, _now(), decided_by

    def _hand_over(self, org: str, own: AssistantRecord, target: str, user_id: str, owner_name: str | None) -> None:
        """Cancel this person's own pending join for the call; it now relies on ``target``."""
        who = f"{owner_name}'s assistant" if owner_name else "a teammate's assistant"
        with self.database.session_factory.begin() as session:
            schedule = session.get(CalendarScheduleRow, own.meeting_id)
            if schedule is not None and schedule.organization_id == org and schedule.status == "pending":
                schedule.status = "cancelled"
                schedule.last_error = f"Handed over: {who} covers this call."
                schedule.updated_at = _now()
            row = coverage_row(session, org, own.meeting_id, user_id)
            if row is not None and row.role == "owner":
                row.decision, row.handed_to_meeting_id, row.decided_at, row.decided_by = "handed_over", target, _now(), user_id

    # ----- recap recipients -------------------------------------------------------------------
    def _recap_open(self, meeting_id: str) -> bool:
        with self.database.session_factory() as session:
            minutes = session.get(MeetingMinutesRow, meeting_id)
            return minutes is None or minutes.sent_at is None

    def _add_recap(self, actor, record: AssistantRecord, wanted: bool) -> bool:
        address = (actor.email or "").strip()
        if not wanted or not address or self.repository is None or not self._recap_open(record.meeting_id):
            return False
        settings = self.repository.get_delivery_settings(UUID(record.meeting_id))
        current = list(settings.internal_recipients)
        if address.lower() in {item.lower() for item in current}:
            return True
        if len(current) >= MAX_RECIPIENTS:
            return False
        self.repository.save_delivery_settings(UUID(record.meeting_id), settings.model_copy(
            update={"internal_recipients": [*current, address]}))
        return True

    def _remove_recap(self, actor, meeting_id: str) -> None:
        address = (actor.email or "").strip().lower()
        if not address or self.repository is None or not self._recap_open(meeting_id):
            return
        settings = self.repository.get_delivery_settings(UUID(meeting_id))
        kept = [item for item in settings.internal_recipients if item.lower() != address]
        if len(kept) != len(settings.internal_recipients):
            self.repository.save_delivery_settings(UUID(meeting_id), settings.model_copy(update={"internal_recipients": kept}))

    # ----- join time -------------------------------------------------------------------------
    def join_guard(self, meeting_id: str) -> str | None:
        """Why a due scheduled join must not run, or None. Never raises."""
        try:
            return self._join_guard(meeting_id)
        except Exception:
            logger.exception("call coordination guard failed for meeting %s", meeting_id)
            return None

    def _join_guard(self, meeting_id: str) -> str | None:
        with self.database.session_factory() as session:
            schedule = session.get(CalendarScheduleRow, meeting_id)
            if schedule is None:
                return None
            record = load_record(session, schedule.organization_id, meeting_id)
            if record is None:
                return None
            if record.decision == "handed_over":
                return "Handed over: a teammate's assistant covers this call."
            if not record.owner_id:
                return None
            twins = [item for item in same_call_records(session, schedule.organization_id, record.key, record.window,
                                                        exclude=meeting_id) if item.owner_id == record.owner_id]
        order = (record.starts_at, record.created_at, record.meeting_id)
        if any(item.state in {"joining", "in_call"} for item in twins):
            return "Skipped: your other assistant for this call is already joining it."
        if any(item.state == "scheduled" and (item.starts_at, item.created_at, item.meeting_id) < order for item in twins):
            return "Skipped: your other assistant for this call joins instead."
        return None

    def join_refused(self, meeting: Any, error: Any) -> str | None:
        """The capture service refused a second bot for this call: stand down in favour of the one in it."""
        if getattr(error, "status_code", None) != 409:
            return None
        try:
            return self._stand_down(str(current_organization_id()), str(meeting.id))
        except Exception:
            logger.exception("could not stand down meeting %s after a duplicate join", meeting.id)
            return None

    def _stand_down(self, org: str, meeting_id: str) -> str | None:
        with self.database.session_factory() as session:
            record = load_record(session, org, meeting_id)
            if record is None:
                return None
            live = [item for item in same_call_records(session, org, record.key, record.window, exclude=meeting_id)
                    if item.state in {"joining", "in_call"}]
            target = live[0] if live else None
            owner_name = names(session, {target.owner_id}).get(target.owner_id) if target and target.owner_id else None
        if target is None:
            return None
        if record.owner_id and target.owner_id == record.owner_id:
            return "Your other assistant is already in this call, so this one stood down."
        if record.owner_id:
            self._save_sharing(org, target.meeting_id, record.owner_id, False, decided_by=None)
            self._hand_over(org, record, target.meeting_id, record.owner_id, owner_name)
            self.notices.stood_down(org, recipient=record.owner_id, meeting_id=meeting_id, live_meeting=target.meeting_id,
                                    title=record.title, owner_name=owner_name)
        who = f"{owner_name}'s assistant" if owner_name else "A teammate's assistant"
        return (f"{who} was already in this call. Only one assistant can be in a call at a time, so this one "
                "stood down and its notes come from theirs.")

    # ----- calendar sync ---------------------------------------------------------------------
    def after_sync(self, actor) -> int:
        """Tell the person whose calendar was synced about teammates' assistants for their calls."""
        try:
            return self._after_sync(actor)
        except Exception:
            logger.exception("could not check synced events for teammates' assistants")
            return 0

    def _after_sync(self, actor) -> int:
        me, org, now = str(actor.user_id), self._org(actor), _now()
        with self.database.session_factory() as session:
            rows = session.execute(select(CalendarEventCacheRow).where(
                CalendarEventCacheRow.organization_id == org, CalendarEventCacheRow.user_id == me,
                CalendarEventCacheRow.ends_at > now, CalendarEventCacheRow.starts_at < now + HEADS_UP_HORIZON,
            )).scalars().all()
            records = [item for item in load_records(session, org) if item.state in ACTIVE_STATES]
            known = names(session, {item.owner_id for item in records if item.owner_id})
        sent = 0
        for row in rows:
            key = call_key_for_url((row.payload or {}).get("meeting_url"))
            matches = [item for item in records if key and item.same_call(key, (row.starts_at, row.ends_at))]
            if not matches or any(item.owner_id == me or me in item.sharers for item in matches):
                continue
            first = next((item for item in matches if item.owner_id), None)
            if first is None:
                continue
            sent += self.notices.calendar_heads_up(
                org, recipient=me, meeting_id=first.meeting_id, event_title=(row.payload or {}).get("title"),
                owner_name=known.get(first.owner_id, "A teammate"), starts_at=first.starts_at,
                in_call=first.state == "in_call") or 0
        return sent
