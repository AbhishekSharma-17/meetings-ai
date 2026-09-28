"""Product events that become notifications. Services call these through a small, failure-safe surface.

Services hold ``events`` (defaults to ``NO_EVENTS``, a no-op) and call e.g.
``self.events.meeting_status(meeting)``. Every public method here swallows and logs its own
errors, so a notification problem never breaks capture, drafting, delivery or indexing.
Polling loops call these repeatedly; dedupe keys keep each fact to one notification per user.
"""

from __future__ import annotations

import functools
import logging
from collections import OrderedDict
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any, TypeVar
from uuid import UUID

from meetings_contracts import MeetingStatus
from sqlalchemy import select

from .database import (
    CalendarScheduleRow,
    Database,
    KnowledgeBaseRow,
    MeetingRow,
    MeetingTenantRow,
)
from .notifications import NotificationService
from .tenant import current_organization_id
from .time_display import TimePreferences, format_datetime, format_time

logger = logging.getLogger(__name__)
REMINDER_LEAD = timedelta(minutes=10)
ANNOUNCED_CACHE_SIZE = 2000
ERROR_PREVIEW = 300

F = TypeVar("F", bound=Callable[..., Any])


def _safe(method: F) -> F:
    @functools.wraps(method)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return method(*args, **kwargs)
        except Exception:
            logger.exception("notification event %s failed", method.__name__)
            return None
    return wrapper  # type: ignore[return-value]


class _NoEvents:
    """Default for services constructed without notifications (tests, scripts)."""

    def __getattr__(self, _name: str) -> Callable[..., None]:
        return lambda *args, **kwargs: None


NO_EVENTS: Any = _NoEvents()


def _title(value: str | None) -> str:
    text = " ".join((value or "").split())
    return f"“{text[:120]}”" if text else "your meeting"


def _preview(value: str | None) -> str | None:
    text = " ".join((value or "").split())
    return text[:ERROR_PREVIEW] if text else None


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _joins_on(starts_at: datetime) -> Callable[[TimePreferences], str]:
    """Rendered per reader: their zone and 12/24-hour clock, with the zone named."""
    return lambda reader: f"It joins automatically on {format_datetime(starts_at, reader)}."


def _joins_at(starts_at: datetime) -> Callable[[TimePreferences], str]:
    return lambda reader: f"The assistant joins automatically at {format_time(starts_at, reader)}."


class NotificationEvents:
    def __init__(self, notifications: NotificationService, database: Database) -> None:
        self.notifications = notifications
        self.database = database
        # Meeting statuses announced by this process; skips the DB dedupe check on every poll.
        self._announced: OrderedDict[str, None] = OrderedDict()

    # ----- meeting capture -----------------------------------------------------------------
    @_safe
    def meeting_status(self, meeting: Any) -> None:
        status = meeting.status
        attempt = str(meeting.vexa_meeting_id) if meeting.vexa_meeting_id is not None \
            else f"local-{_utc(meeting.updated_at).timestamp():.0f}"
        key = f"meeting:{meeting.id}:{attempt}:status:{status.value}"
        if key in self._announced:
            return
        message = self._status_message(meeting)
        if message is None:
            return
        kind, severity, title, body = message
        self.notifications.notify_meeting(current_organization_id(), meeting.id, kind=kind, severity=severity,
                                          title=title, body=body, dedupe_key=key)
        self._announced[key] = None
        while len(self._announced) > ANNOUNCED_CACHE_SIZE:
            self._announced.popitem(last=False)

    @staticmethod
    def _status_message(meeting: Any) -> tuple[str, str, str, str | None] | None:
        name = _title(meeting.title)
        status = meeting.status
        if status is MeetingStatus.AWAITING_ADMISSION:
            return ("assistant.lobby", "warning", "Assistant is waiting in the lobby",
                    f"Admit Meetings AI to {name} so it can start capturing.")
        if status is MeetingStatus.ACTIVE:
            return ("assistant.joined", "success", f"Assistant joined {name}",
                    "Recording and transcription are running.")
        if status is MeetingStatus.NEEDS_HUMAN_HELP:
            return ("assistant.attention", "warning", "Assistant needs attention",
                    _preview(meeting.last_error) or f"Someone in {name} needs to help the assistant.")
        if status is MeetingStatus.FAILED:
            if meeting.joined_at is None:
                return ("assistant.join_failed", "danger", f"Assistant could not join {name}",
                        _preview(meeting.last_error) or "Check the meeting link and try again.")
            return ("assistant.capture_failed", "danger", f"Capture stopped with an error in {name}",
                    _preview(meeting.last_error))
        if status is MeetingStatus.COMPLETED:
            return ("assistant.capture_finished", "success", f"Capture finished for {name}",
                    "The transcript is saved and ready for review.")
        return None

    # ----- calendar scheduler --------------------------------------------------------------
    @_safe
    def schedule_created(self, organization_id: UUID | str, meeting_id: UUID | str, title: str | None,
                         starts_at: datetime) -> None:
        self.notifications.notify_meeting(
            organization_id, meeting_id, kind="assistant.scheduled", severity="info",
            title=f"Assistant scheduled for {_title(title)}", body=_joins_on(starts_at),
            dedupe_key=f"schedule:{meeting_id}:created",
        )

    @_safe
    def schedule_missed(self, organization_id: UUID | str, meeting_id: UUID | str) -> None:
        self.notifications.notify_meeting(
            organization_id, meeting_id, kind="assistant.schedule_missed", severity="warning",
            title=f"Scheduled join missed for {self._meeting_title(meeting_id, organization_id)}",
            body="The start time passed before the assistant could join. Send it manually with a fresh link.",
            dedupe_key=f"schedule:{meeting_id}:missed",
        )

    @_safe
    def schedule_failed(self, organization_id: UUID | str, meeting_id: UUID | str, error: str, attempt: int) -> None:
        self.notifications.notify_meeting(
            organization_id, meeting_id, kind="assistant.join_failed", severity="danger",
            title=f"Scheduled join failed for {self._meeting_title(meeting_id, organization_id)}", body=_preview(error),
            dedupe_key=f"schedule:{meeting_id}:failed:{attempt}",
        )

    @_safe
    def schedule_reminders(self, now: datetime | None = None) -> int:
        """~10 minutes before each pending scheduled join, remind the meeting audience once."""
        now = now or datetime.now(UTC)
        with self.database.session_factory() as session:
            rows = session.execute(select(
                CalendarScheduleRow.organization_id, CalendarScheduleRow.meeting_id, CalendarScheduleRow.starts_at,
                MeetingRow.title,
            ).join(MeetingRow, MeetingRow.id == CalendarScheduleRow.meeting_id).where(
                CalendarScheduleRow.status == "pending",
                CalendarScheduleRow.starts_at > now,
                CalendarScheduleRow.starts_at <= now + REMINDER_LEAD,
            )).all()
        sent = 0
        for organization_id, meeting_id, starts_at, title in rows:
            minutes = max(1, round((_utc(starts_at) - now).total_seconds() / 60))
            sent += self.notifications.notify_meeting(
                organization_id, meeting_id, kind="meeting.reminder", severity="info",
                title=f"{_title(title) if title else 'Your meeting'} starts in {minutes} min",
                body=_joins_at(starts_at),
                dedupe_key=f"schedule:{meeting_id}:{_utc(starts_at).isoformat()}:reminder",
            )
        return sent

    # ----- minutes and delivery ------------------------------------------------------------
    @_safe
    def minutes_ready(self, meeting_id: UUID | str, *, reference: str) -> None:
        self.notifications.notify_meeting(
            current_organization_id(), meeting_id, kind="minutes.ready", severity="success",
            title=f"Draft minutes ready for {self._meeting_title(meeting_id)}",
            body="Review every field before approving and sending the recap.",
            dedupe_key=f"meeting:{meeting_id}:minutes-ready:{reference}",
        )

    @_safe
    def minutes_failed(self, meeting_id: UUID | str, error: str | None, *, reference: str) -> None:
        self.notifications.notify_meeting(
            current_organization_id(), meeting_id, kind="minutes.failed", severity="danger",
            title=f"Draft minutes failed for {self._meeting_title(meeting_id)}",
            body=_preview(error) or "Open the meeting to retry drafting.",
            dedupe_key=f"meeting:{meeting_id}:minutes-failed:{reference}",
        )

    @_safe
    def recap_sent(self, meeting_id: UUID | str, delivery_id: UUID | str, recipient_count: int) -> None:
        people = "1 recipient" if recipient_count == 1 else f"{recipient_count} recipients"
        self.notifications.notify_meeting(
            current_organization_id(), meeting_id, kind="recap.sent", severity="success",
            title=f"Recap sent for {self._meeting_title(meeting_id)}", body=f"Delivered to {people}.",
            dedupe_key=f"delivery:{delivery_id}:sent",
        )

    @_safe
    def recap_failed(self, meeting_id: UUID | str, delivery_id: UUID | str, error: str | None) -> None:
        self.notifications.notify_meeting(
            current_organization_id(), meeting_id, kind="recap.failed", severity="danger",
            title=f"Recap delivery failed for {self._meeting_title(meeting_id)}",
            body=_preview(error) or "Open the meeting to review recipients and resend.",
            dedupe_key=f"delivery:{delivery_id}:failed",
        )

    # ----- documents and knowledge ---------------------------------------------------------
    @_safe
    def document_indexed(self, document: dict[str, Any]) -> None:
        self._document(document, ok=True)

    @_safe
    def document_failed(self, document: dict[str, Any], error: str | None) -> None:
        self._document(document, ok=False, error=error)

    def _document(self, document: dict[str, Any], *, ok: bool, error: str | None = None) -> None:
        owner = document.get("created_by")
        if not owner:
            return
        scope, scope_id = document.get("scope"), document.get("scope_id")
        view = {"prep": "prep", "knowledge_base": "knowledge", "organization": "workspace"}.get(scope)
        name = document.get("filename") or "document"
        self.notifications.notify(
            document["organization_id"], user_ids=[owner],
            kind="document.processed" if ok else "document.failed", severity="success" if ok else "danger",
            title=f"{name} is ready" if ok else f"Could not process {name}",
            body="Its text is indexed for briefings and AI answers." if ok else _preview(error),
            link_view=view, link_id=scope_id if view != "workspace" else None,
            dedupe_key=f"document:{document['id']}:{'indexed' if ok else 'failed'}:{document.get('attempt_key', '')}",
        )

    @_safe
    def knowledge_indexed(self, organization_id: UUID | str, base_id: UUID | str, *, reference: str,
                          user_id: UUID | str | None = None) -> None:
        name, creator = self._base(base_id, organization_id)
        self.notifications.notify(
            organization_id, user_ids=[user_id or creator], kind="knowledge.indexed", severity="success",
            title=f"{name} is indexed", body="New meetings in this knowledge base are searchable in AI chat.",
            link_view="knowledge", link_id=base_id, dedupe_key=f"knowledge:{base_id}:indexed:{reference}",
        )

    @_safe
    def knowledge_index_failed(self, organization_id: UUID | str, base_id: UUID | str, error: str | None, *,
                               reference: str, user_id: UUID | str | None = None) -> None:
        name, creator = self._base(base_id, organization_id)
        self.notifications.notify(
            organization_id, user_ids=[user_id or creator], kind="knowledge.index_failed", severity="danger",
            title=f"Indexing failed for {name}", body=_preview(error), link_view="knowledge", link_id=base_id,
            dedupe_key=f"knowledge:{base_id}:failed:{reference}",
        )

    # ----- helpers -------------------------------------------------------------------------
    def _meeting_title(self, meeting_id: UUID | str, organization_id: UUID | str | None = None) -> str:
        # Only ever read a title from the workspace the notification is for.
        workspace = str(organization_id or current_organization_id())
        with self.database.session_factory() as session:
            title = session.execute(select(MeetingRow.title).join(
                MeetingTenantRow, MeetingTenantRow.meeting_id == MeetingRow.id,
            ).where(MeetingRow.id == str(meeting_id), MeetingTenantRow.organization_id == workspace)).scalar_one_or_none()
        return _title(title)

    def _base(self, base_id: UUID | str, organization_id: UUID | str) -> tuple[str, str | None]:
        with self.database.session_factory() as session:
            row = session.get(KnowledgeBaseRow, str(base_id))
            if row is not None and row.organization_id != str(organization_id):
                row = None
            return (f"“{row.name}”" if row else "Knowledge base", row.created_by if row else None)
