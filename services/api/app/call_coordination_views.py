"""Read side of call coordination: checks, the meeting panel, calendar and library chips.

Every method takes the signed-in actor and reads only the actor's workspace.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from .call_coverage import AssistantRecord, calendar_holders, coverage_row, load_record, load_records, names, same_call_records
from .call_keys import Window, call_key_for_url, windows_overlap
from .coordination_models import (
    CalendarCoordination,
    CallCheck,
    CallCheckRequest,
    CoordinationPerson,
    CoverageSummary,
    MeetingCoordination,
    TeammateAssistant,
)
from .database import CalendarEventCacheRow, Database

ACTIVE_STATES = frozenset({"scheduled", "joining", "in_call"})
DEFAULT_CALL_LENGTH = timedelta(hours=1)
MAX_CALENDAR_RANGE = timedelta(days=92)


class CoordinationError(ValueError):
    def __init__(self, message: str, status_code: int = 409) -> None:
        super().__init__(message)
        self.status_code = status_code


def _utc(value: datetime) -> datetime:
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC)


class CoordinationViews:
    def __init__(self, database: Database) -> None:
        self.database = database

    # ----- shared helpers -------------------------------------------------------------------
    @staticmethod
    def _org(actor) -> str:
        return str(actor.organization_id)

    @staticmethod
    def _person(user_id: str | None, known: dict[str, str], actor) -> CoordinationPerson | None:
        if not user_id:
            return None
        return CoordinationPerson(user_id=UUID(user_id), display_name=known.get(user_id, "A former teammate"),
                                  is_you=user_id == str(actor.user_id))

    def _assistant(self, record: AssistantRecord, known: dict[str, str], actor) -> TeammateAssistant:
        me = str(actor.user_id)
        return TeammateAssistant(
            meeting_id=UUID(record.meeting_id), owner=self._person(record.owner_id, known, actor),
            starts_at=record.starts_at, state=record.state,  # type: ignore[arg-type]
            covering=[person for person in (self._person(user, known, actor) for user in record.sharers) if person],
            kept_own=record.decision == "own",
            can_open=actor.is_admin or me == record.owner_id or me in record.sharers,
        )

    @staticmethod
    def _people_of(records: list[AssistantRecord]) -> set[str]:
        people: set[str] = set()
        for record in records:
            people.update(record.sharers)
            if record.owner_id:
                people.add(record.owner_id)
        return people

    def _on_calendar(self, session: Session, actor, record: AssistantRecord) -> bool:
        return str(actor.user_id) in calendar_holders(session, self._org(actor), record.key, record.window)

    def _require_record(self, session: Session, actor, meeting_id: UUID) -> AssistantRecord:
        record = load_record(session, self._org(actor), str(meeting_id))
        if record is None:
            raise CoordinationError("meeting not found", 404)
        return record

    def _visible(self, session: Session, actor, record: AssistantRecord) -> bool:
        """Admins see every record; others only records that cover them."""
        return actor.is_admin or coverage_row(session, self._org(actor), record.meeting_id, str(actor.user_id)) is not None

    # ----- before creating an assistant ------------------------------------------------------
    def check(self, actor, request: CallCheckRequest) -> CallCheck:
        key = call_key_for_url(request.meeting_url)
        if key is None:
            return CallCheck(supported=False)
        start = _utc(request.starts_at) if request.starts_at else datetime.now(UTC)
        end = _utc(request.ends_at) if request.ends_at and _utc(request.ends_at) > start else start + DEFAULT_CALL_LENGTH
        me = str(actor.user_id)
        with self.database.session_factory() as session:
            records = [item for item in same_call_records(session, self._org(actor), key, (start, end))
                       if item.state in ACTIVE_STATES]
            holders = set(calendar_holders(session, self._org(actor), key, (start, end)))
            known = names(session, self._people_of(records))
        theirs = [item for item in records if item.owner_id != me]
        mine = [item for item in records if item.owner_id == me]
        return CallCheck(
            supported=True, platform=key.split(":", 1)[0],
            assistants=[self._assistant(item, known, actor) for item in theirs],
            your_assistants=[self._assistant(item, known, actor) for item in mine],
            teammates_on_calendar=len(holders - {me} - self._people_of(records)),
        )

    # ----- the meeting's coordination panel ---------------------------------------------------
    def view(self, actor, meeting_id: UUID) -> MeetingCoordination:
        me = str(actor.user_id)
        with self.database.session_factory() as session:
            record = self._require_record(session, actor, meeting_id)
            if not self._visible(session, actor, record):
                raise CoordinationError("meeting not found", 404)
            others = [item for item in same_call_records(session, self._org(actor), record.key, record.window,
                                                         exclude=record.meeting_id) if item.state in ACTIVE_STATES]
            handed = load_record(session, self._org(actor), record.handed_to) if record.handed_to else None
            everyone = [record, *others, *([handed] if handed else [])]
            holders = set(calendar_holders(session, self._org(actor), record.key, record.window))
            known = names(session, self._people_of(everyone))
            mine = coverage_row(session, self._org(actor), record.meeting_id, me)
            on_calendar = me in holders
        role = "owner" if record.owner_id == me else ("sharing" if me in record.sharers else None)
        shareable = record.state in ACTIVE_STATES | {"ended"} and record.decision != "handed_over"
        return MeetingCoordination(
            meeting_id=UUID(record.meeting_id), state=record.state, starts_at=record.starts_at,  # type: ignore[arg-type]
            owner=self._person(record.owner_id, known, actor),
            covering=[person for person in (self._person(user, known, actor) for user in record.sharers) if person],
            your_role=role, receive_recap=bool(mine and mine.role == "sharing" and mine.receive_recap),
            kept_own=record.decision == "own",
            handed_to=self._assistant(handed, known, actor) if handed else None,
            other_assistants=[self._assistant(item, known, actor) for item in others],
            teammates_on_calendar=len(holders - {me} - self._people_of(everyone)),
            can_share=role is None and shareable and (actor.is_admin or on_calendar),
            can_stop_sharing=role == "sharing", can_manage=actor.is_admin,
        )

    # ----- the viewer's own calendar ---------------------------------------------------------
    def calendar(self, actor, start: datetime, end: datetime) -> list[CalendarCoordination]:
        start, end = _utc(start), _utc(end)
        if end <= start or end - start > MAX_CALENDAR_RANGE:
            raise CoordinationError("choose a range of up to 92 days", 400)
        me, org = str(actor.user_id), self._org(actor)
        with self.database.session_factory() as session:
            rows = session.execute(select(CalendarEventCacheRow).where(
                CalendarEventCacheRow.organization_id == org, CalendarEventCacheRow.starts_at < end,
                CalendarEventCacheRow.ends_at > start,
            )).scalars().all()
            records = [item for item in load_records(session, org) if item.state != "idle"]
            known = names(session, self._people_of(records))
        own_rows = [row for row in rows if row.user_id == me]
        return [item for item in (self._calendar_item(row, rows, records, known, actor) for row in own_rows) if item]

    def _calendar_item(self, row: CalendarEventCacheRow, rows: list[CalendarEventCacheRow],
                       records: list[AssistantRecord], known: dict[str, str], actor) -> CalendarCoordination | None:
        me = str(actor.user_id)
        key = call_key_for_url(row.payload.get("meeting_url") if isinstance(row.payload, dict) else None)
        if key is None:
            return None
        window: Window = (row.starts_at, row.ends_at)
        matching = [item for item in records if item.same_call(key, window)]
        owned = next((item for item in matching if item.owner_id == me and item.state != "idle"), None)
        shared = next((item for item in matching if me in item.sharers), None)
        theirs = [item for item in matching if item.owner_id != me and (item.state in ACTIVE_STATES or me in item.sharers
                                                                          or item.state == "ended")]
        holders = {other.user_id for other in rows if other.user_id != me and call_key_for_url(
            other.payload.get("meeting_url") if isinstance(other.payload, dict) else None) == key
            and windows_overlap((other.starts_at, other.ends_at), window)}
        count = len(holders - self._people_of(matching))
        if not theirs and not owned and not shared and not count:
            return None
        mine = owned or shared
        return CalendarCoordination(
            event_id=UUID(row.id), assistants=[self._assistant(item, known, actor) for item in theirs],
            your_role="owner" if owned else ("sharing" if shared else None),
            your_meeting_id=UUID(mine.meeting_id) if mine else None,
            shared_from=self._person(shared.owner_id, known, actor) if shared and not owned else None,
            teammates_on_calendar=count,
        )

    # ----- library chips ---------------------------------------------------------------------
    def summaries(self, actor) -> list[CoverageSummary]:
        me = str(actor.user_id)
        with self.database.session_factory() as session:
            records = load_records(session, self._org(actor))
            handed = {item.meeting_id: item for item in records}
            known = names(session, self._people_of(records))
        results: list[CoverageSummary] = []
        for record in records:
            if not actor.is_admin and me not in record.sharers and record.owner_id != me:
                continue
            others = sum(1 for other in records if other.meeting_id != record.meeting_id and other.state in ACTIVE_STATES
                         and record.state in ACTIVE_STATES and other.same_call(record.key, record.window))
            target = handed.get(record.handed_to or "")
            summary = CoverageSummary(
                meeting_id=UUID(record.meeting_id), owner=self._person(record.owner_id, known, actor),
                covering=[person for person in (self._person(user, known, actor) for user in record.sharers) if person],
                your_role="owner" if record.owner_id == me else ("sharing" if me in record.sharers else None),
                kept_own=record.decision == "own" and others > 0,
                handed_to_owner=self._person(target.owner_id, known, actor) if target else None,
                other_assistants=others,
            )
            if summary.covering or summary.handed_to_owner or others or summary.your_role == "sharing":
                results.append(summary)
        return results

    # ----- access -----------------------------------------------------------------------------
    def can_read(self, actor, meeting_id: UUID | str) -> bool:
        """True when this meeting's assistant covers the actor (owner or sharing)."""
        with self.database.session_factory() as session:
            return coverage_row(session, self._org(actor), str(meeting_id), str(actor.user_id)) is not None
