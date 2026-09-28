"""Speaker contact suggestions and bulk approval.

Suggestions never link anything by themselves; approving one saves a normal
speaker identity. Both routes sit under /v1/meetings/{id}, which the auth
middleware already restricts to workspace admins/owners and resolves inside the
caller's tenant (another workspace's meeting is a 404).
"""

from __future__ import annotations

import logging
from typing import Annotated
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request
from meetings_contracts import SpeakerIdentityPublic, SpeakerIdentityRequest
from pydantic import BaseModel, ConfigDict, Field

from .calendar_schedule import CalendarScheduleService
from .meeting_service import MeetingService
from .repository import MeetingNotFoundError
from .speaker_suggestions import Candidate, SpeakerSuggestion, email_address, suggest_speaker_emails
from .sqlalchemy_repository import SQLAlchemyRepository, SpeakerIdentityConflictError
from .workspace_service import WorkspaceService

MAX_BULK_IDENTITIES = 50
_DIRECTORY_STATUSES = frozenset({"active", "invited"})
logger = logging.getLogger(__name__)


class BulkSpeakerIdentityRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    identities: Annotated[list[SpeakerIdentityRequest], Field(min_length=1, max_length=MAX_BULK_IDENTITIES)]


def register_speaker_routes(
    app: FastAPI, *, repository: SQLAlchemyRepository, meeting_service: MeetingService,
    calendar_schedule: CalendarScheduleService, workspace_service: WorkspaceService,
) -> None:
    async def upstream_invitees(meeting_id: UUID) -> list[Candidate]:
        """Invitees the capture service knows about; optional evidence, so failures only log."""
        try:
            response = await meeting_service.participants(meeting_id)
        except MeetingNotFoundError:
            raise
        except Exception:  # noqa: BLE001 - the calendar source and directory still give suggestions.
            logger.warning("speaker suggestions: capture roster unavailable for %s", meeting_id, exc_info=True)
            return []
        return [Candidate(person.email, person.name, "invite")
                for person in response.participants if person.source == "invite" and person.email]

    def meeting_candidates(request: Request, meeting_id: UUID) -> list[Candidate]:
        source = calendar_schedule.source(request.state.actor, meeting_id)
        if source is None:
            return []
        people = [Candidate(person.email, person.name, "invite") for person in source.invitees if person.email]
        organizer = email_address(source.organizer)
        if organizer:
            named = next((person.name for person in source.invitees if person.email == organizer), organizer)
            people.append(Candidate(organizer, named, "organizer"))
        return people

    def directory_candidates() -> list[Candidate]:
        return [Candidate(member.email, member.display_name, "workspace_member")
                for member in workspace_service.list_members()
                if member.email and member.status in _DIRECTORY_STATUSES]

    @app.get("/v1/meetings/{meeting_id}/speaker-suggestions", response_model=list[SpeakerSuggestion])
    async def speaker_suggestions(meeting_id: UUID, request: Request) -> list[SpeakerSuggestion]:
        try:
            meeting = repository.get_meeting(meeting_id)
            speakers = [segment.speaker for segment in repository.get_transcript(meeting_id) if segment.speaker]
            confirmed = {item.speaker: item.email for item in repository.list_speaker_identities(meeting_id)}
            candidates = [
                *meeting_candidates(request, meeting_id),
                *(await upstream_invitees(meeting_id) if meeting.vexa_meeting_id is not None else []),
                *directory_candidates(),
            ]
        except MeetingNotFoundError as exc:
            raise HTTPException(status_code=404, detail="meeting not found") from exc
        return suggest_speaker_emails(speakers, candidates, confirmed=confirmed, bot_name=meeting.bot_name)

    @app.post("/v1/meetings/{meeting_id}/speaker-identities/bulk", response_model=list[SpeakerIdentityPublic])
    def save_speaker_identities(meeting_id: UUID, payload: BulkSpeakerIdentityRequest) -> list[SpeakerIdentityPublic]:
        """Approve several suggestions at once; every speaker is checked before anything is saved."""
        if any(item.email is None for item in payload.identities):
            raise HTTPException(status_code=422, detail="each approval needs an email address")
        speakers = [item.speaker for item in payload.identities]
        if len(set(speakers)) != len(speakers):
            raise HTTPException(status_code=422, detail="each speaker can be approved only once per request")
        try:
            named = {segment.speaker for segment in repository.get_transcript(meeting_id) if segment.speaker}
            missing = [speaker for speaker in speakers if speaker not in named]
            if missing:
                raise HTTPException(status_code=409, detail="speaker must first be named in this meeting transcript")
            saved: list[SpeakerIdentityPublic] = []
            for item in payload.identities:
                saved = repository.save_speaker_identity(meeting_id, item.speaker, item.email)
            return saved
        except MeetingNotFoundError as exc:
            raise HTTPException(status_code=404, detail="meeting not found") from exc
        except SpeakerIdentityConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
