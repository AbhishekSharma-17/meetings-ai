"""Public shapes for call coordination (who brings the assistant to a shared call).

Privacy boundary: a teammate's NAME and the fact that their assistant is set for the same
meeting link (with its planned time and state) are shared inside the workspace. Other
people's calendars are only ever summarised as a count; titles, agendas and invitees of a
teammate's private calendar event are never returned.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

AssistantState = Literal["scheduled", "joining", "in_call", "ended", "idle"]
CoverageRole = Literal["owner", "sharing"]


class CoordinationPerson(BaseModel):
    user_id: UUID
    display_name: str
    is_you: bool = False


class TeammateAssistant(BaseModel):
    """Another assistant record set for the same call (same link, overlapping time)."""

    meeting_id: UUID
    owner: CoordinationPerson | None = None
    starts_at: datetime
    state: AssistantState
    covering: list[CoordinationPerson] = Field(default_factory=list)
    # The owner explicitly kept their own assistant although a teammate brings one too.
    kept_own: bool = False
    # Whether the viewer may open this meeting record (admins, or people it covers).
    can_open: bool = False


class CallCheckRequest(BaseModel):
    meeting_url: str = Field(min_length=1, max_length=2000)
    starts_at: datetime | None = None
    ends_at: datetime | None = None


class CallCheck(BaseModel):
    supported: bool
    platform: str | None = None
    # Teammates' assistants already set for this call.
    assistants: list[TeammateAssistant] = Field(default_factory=list)
    # Your own other assistants for this call (a duplicate record would never join twice).
    your_assistants: list[TeammateAssistant] = Field(default_factory=list)
    # Other people who have this call on their own synced calendar (count only).
    teammates_on_calendar: int = 0


class ShareRequest(BaseModel):
    # Add your address to the recap's internal recipients (before it is sent).
    receive_recap: bool = True


class MeetingCoordination(BaseModel):
    meeting_id: UUID
    state: AssistantState
    starts_at: datetime
    owner: CoordinationPerson | None = None
    covering: list[CoordinationPerson] = Field(default_factory=list)
    your_role: CoverageRole | None = None
    receive_recap: bool = False
    kept_own: bool = False
    # This record stood down in favour of another teammate's assistant.
    handed_to: TeammateAssistant | None = None
    other_assistants: list[TeammateAssistant] = Field(default_factory=list)
    teammates_on_calendar: int = 0
    can_share: bool = False
    can_stop_sharing: bool = False
    can_manage: bool = False


class CalendarCoordination(BaseModel):
    """Coordination facts for one of the viewer's own synced calendar events."""

    event_id: UUID
    assistants: list[TeammateAssistant] = Field(default_factory=list)
    your_role: CoverageRole | None = None
    your_meeting_id: UUID | None = None
    shared_from: CoordinationPerson | None = None
    teammates_on_calendar: int = 0


class CoverageSummary(BaseModel):
    """Library chip data for one meeting."""

    meeting_id: UUID
    owner: CoordinationPerson | None = None
    covering: list[CoordinationPerson] = Field(default_factory=list)
    your_role: CoverageRole | None = None
    kept_own: bool = False
    handed_to_owner: CoordinationPerson | None = None
    other_assistants: int = 0
