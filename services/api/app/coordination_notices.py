"""Notifications for call coordination. Failure-safe and deduped per recipient.

Every time is rendered per reader (their zone and clock). Only names and the fact that a
teammate's assistant is set for the same call are shared; calendar details of other people
never appear here.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from .notification_events import _safe, _title
from .time_display import TimePreferences, format_day_time

logger = logging.getLogger(__name__)

ONE_AT_A_TIME = ("Only one assistant can be in a call at a time: the first to join records it and the other "
                 "person automatically gets its notes.")


def _possessive(name: str) -> str:
    return f"{name}'" if name.endswith("s") else f"{name}'s"


class CoordinationNotices:
    def __init__(self, notifications: Any) -> None:
        self.notifications = notifications

    @_safe
    def teammate_also_scheduled(self, organization_id: str, *, recipient: str, recipient_meeting: str,
                                title: str | None, actor_name: str, new_meeting: str, starts_at: datetime) -> int:
        def body(reader: TimePreferences) -> str:
            return (f"Both are set for {format_day_time(starts_at, reader)}. Decide who brings it: share one "
                    "assistant's notes, or keep both.")
        return self.notifications.notify(
            organization_id, user_ids=[recipient], kind="coordination.same_call", severity="warning",
            title=f"{actor_name} also scheduled an assistant for {_title(title)} (same call) — decide who brings it",
            body=body, link_view="meeting", link_id=recipient_meeting, meeting_id=recipient_meeting,
            dedupe_key=f"coordination:{recipient_meeting}:{new_meeting}:same-call")

    @_safe
    def two_assistants(self, organization_id: str, *, recipient: str, recipient_meeting: str,
                       title: str | None, actor_name: str, new_meeting: str) -> int:
        return self.notifications.notify(
            organization_id, user_ids=[recipient], kind="coordination.two_assistants", severity="info",
            title=f"Two assistants are set for {_title(title)} (yours and {_possessive(actor_name)})",
            body=ONE_AT_A_TIME, link_view="meeting", link_id=recipient_meeting, meeting_id=recipient_meeting,
            dedupe_key=f"coordination:{recipient_meeting}:{new_meeting}:two")

    @_safe
    def now_sharing(self, organization_id: str, *, owner: str, meeting_id: str, title: str | None,
                    sharer: str, sharer_name: str, receive_recap: bool) -> int:
        gets = "the transcript, approved minutes and the recap" if receive_recap else "the transcript and approved minutes"
        return self.notifications.notify(
            organization_id, user_ids=[owner], kind="coordination.sharing", severity="info",
            title=f"{sharer_name} is now sharing your assistant's notes for {_title(title)}",
            body=f"{sharer_name} gets {gets}. Only you and admins can change the meeting or its delivery.",
            link_view="meeting", link_id=meeting_id, meeting_id=meeting_id,
            dedupe_key=f"coordination:{meeting_id}:{sharer}:sharing")

    @_safe
    def calendar_heads_up(self, organization_id: str, *, recipient: str, meeting_id: str, event_title: str | None,
                          owner_name: str, starts_at: datetime, in_call: bool) -> int:
        def headline(reader: TimePreferences) -> str:
            when = "is in" if in_call else f"joins at {format_day_time(starts_at, reader)} for"
            return f"{_possessive(owner_name)} assistant {when} {_title(event_title)}"
        return self.notifications.notify(
            organization_id, user_ids=[recipient], kind="coordination.teammate_assistant", severity="info",
            title=headline, body="It's the same call as the one on your calendar. Share its notes instead of bringing another assistant.",
            link_view="calendar", dedupe_key=f"coordination:{meeting_id}:{recipient}:calendar")

    @_safe
    def stood_down(self, organization_id: str, *, recipient: str, meeting_id: str, live_meeting: str,
                   title: str | None, owner_name: str | None) -> int:
        who = f"{_possessive(owner_name)} assistant" if owner_name else "A teammate's assistant"
        return self.notifications.notify(
            organization_id, user_ids=[recipient], kind="coordination.stood_down", severity="info",
            title=f"{who} was already in {_title(title)}",
            body="Only one assistant can be in a call at a time, so yours stood down. You now get the notes from theirs.",
            link_view="meeting", link_id=live_meeting, meeting_id=live_meeting,
            dedupe_key=f"coordination:{meeting_id}:stood-down")
