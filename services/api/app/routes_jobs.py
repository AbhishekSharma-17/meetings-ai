"""Background-job HTTP routes: start briefing/minutes/re-index jobs, read status, cancel.

Roles: every signed-in user can list/read/cancel their own jobs; owners/admins also see
workspace-level jobs (minutes drafts, knowledge re-index). Creating a briefing job follows
the prep rules (viewers cannot); minutes jobs live under /v1/meetings (owners/admins only,
enforced by the middleware); re-index follows the knowledge-base creator/admin rule.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import FastAPI, HTTPException, Query, Request

from .background_jobs import BackgroundJobService, JobNotFoundError, JobPublic
from .composio_calendar import CalendarError
from .job_kinds import KNOWLEDGE_REINDEX, MINUTES_DRAFT, PREP_BRIEFING, actor_payload
from .knowledge_bases import KnowledgeBaseNotFoundError
from .meeting_prep import MeetingPrepService, PrepRequest
from .minutes_service import MinutesConflictError
from .rate_limit import prep_generation_limiter
from .repository import MeetingNotFoundError


def register_job_routes(app: FastAPI, *, jobs: BackgroundJobService, meeting_prep: MeetingPrepService,
                        minutes_service: Any, repository: Any, knowledge_bases: Any) -> None:
    def prep_limiter():
        # Shared with the synchronous/streaming prep endpoints so every path counts toward one limit.
        limiter = getattr(app.state, "prep_limiter", None)
        if limiter is None:
            limiter = app.state.prep_limiter = prep_generation_limiter()
        return limiter

    @app.get("/v1/background-jobs", response_model=list[JobPublic])
    def list_jobs(request: Request, kind: str | None = Query(default=None, max_length=60),
                  subject_id: str | None = Query(default=None, max_length=120),
                  active: bool | None = None, limit: int = Query(default=20, ge=1, le=50)) -> list[JobPublic]:
        return jobs.list(request.state.actor, kind=kind, subject_id=subject_id, active=active, limit=limit)

    @app.get("/v1/background-jobs/{job_id}", response_model=JobPublic)
    def get_job(job_id: UUID, request: Request) -> JobPublic:
        try:
            return jobs.get(request.state.actor, job_id)
        except JobNotFoundError as exc:
            raise HTTPException(status_code=404, detail="job not found") from exc

    @app.post("/v1/background-jobs/{job_id}/cancel", response_model=JobPublic)
    async def cancel_job(job_id: UUID, request: Request) -> JobPublic:
        try:
            return await jobs.cancel(request.state.actor, job_id)
        except JobNotFoundError as exc:
            raise HTTPException(status_code=404, detail="job not found") from exc

    @app.post("/v1/calendar/events/{event_id}/prep/jobs", response_model=JobPublic, status_code=202)
    async def start_prep_job(event_id: UUID, payload: PrepRequest, request: Request) -> JobPublic:
        """Start a briefing in the background, or return the one already running for this event."""
        actor = request.state.actor
        try:
            event = meeting_prep.cache.get_event(actor, event_id)
        except CalendarError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if actor.role == "viewer":
            raise HTTPException(status_code=403, detail="viewers cannot prepare meeting briefings")
        active = jobs.active(actor.organization_id, actor.user_id, PREP_BRIEFING, str(event_id))
        if active is not None:
            return active
        prep_limiter().check(actor.user_id)
        job, _ = jobs.submit(
            organization_id=actor.organization_id, user_id=actor.user_id, kind=PREP_BRIEFING,
            subject_id=str(event_id), payload={
                "event_id": str(event_id), "title": event.title, "request": payload.model_dump(mode="json"),
                "actor": actor_payload(actor),
            },
        )
        return job

    @app.post("/v1/meetings/{meeting_id}/minutes/jobs", response_model=JobPublic, status_code=202)
    async def start_minutes_job(meeting_id: UUID, request: Request) -> JobPublic:
        """Generate (or regenerate) the MOM draft in the background; one active job per meeting."""
        actor = request.state.actor
        try:
            repository.get_meeting(meeting_id)
            minutes_service.require_not_sent(meeting_id)
        except MeetingNotFoundError as exc:
            raise HTTPException(status_code=404, detail="meeting not found") from exc
        except MinutesConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        job, _ = jobs.submit(organization_id=actor.organization_id, user_id=actor.user_id, kind=MINUTES_DRAFT,
                             subject_id=str(meeting_id), payload={"meeting_id": str(meeting_id),
                                                                  "actor": actor_payload(actor)})
        return job

    @app.post("/v1/knowledge-bases/{base_id}/reindex/jobs", response_model=JobPublic, status_code=202)
    async def start_reindex_job(base_id: UUID, request: Request) -> JobPublic:
        actor = request.state.actor
        try:
            base = knowledge_bases.get(base_id, actor)
        except KnowledgeBaseNotFoundError as exc:
            raise HTTPException(status_code=404, detail="knowledge base not found") from exc
        if not actor.is_admin and base.created_by != actor.user_id:
            raise HTTPException(status_code=409, detail="only the creator or an admin can index this knowledge base")
        job, _ = jobs.submit(organization_id=actor.organization_id, user_id=actor.user_id, kind=KNOWLEDGE_REINDEX,
                             subject_id=str(base_id), payload={"knowledge_base_id": str(base_id),
                                                               "actor": actor_payload(actor)})
        return job
