"""The concrete background jobs: meeting-prep briefings, minutes drafts and knowledge re-indexing.

Each runner does exactly what the matching synchronous endpoint does (the result is saved in
the same place, so existing GET endpoints return it), reports its stage, and maps expected
errors to ``JobFailure`` with the status code the synchronous endpoint would have returned.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import select

from .accounts import Actor
from .adapters.base import ProviderExecutionError
from .adapters.vexa import VexaAPIError
from .background_jobs import BackgroundJobService, JobContext, JobFailure, JobPublic
from .composio_calendar import CalendarError
from .database import BackgroundJobRow, Database, OrganizationMembershipRow, UserRow
from .knowledge_bases import KnowledgeBaseNotFoundError
from .knowledge_index import KnowledgeIndexError
from .meeting_prep import MeetingPrepService, PrepRequest
from .meeting_service import MeetingConflictError
from .minutes_service import MinutesConflictError, MinutesGenerationError
from .notification_events import NotificationEvents
from .notifications import NotificationService
from .prep_research import (
    PrepBusyError,
    PrepConfigError,
    PrepError,
    PrepPermissionError,
)
from .repository import MeetingNotFoundError, MinutesNotFoundError, ProfileNotFoundError
from .service import ProviderSelectionError
from .tenant import current_organization_id

PREP_BRIEFING = "prep_briefing"
MINUTES_DRAFT = "minutes_draft"
KNOWLEDGE_REINDEX = "knowledge_reindex"


def actor_payload(actor: Actor) -> dict[str, Any]:
    return {"email": actor.email, "display_name": actor.display_name}


def resolve_actor(database: Database, context: JobContext) -> Actor:
    """Rebuild the requesting actor with their *current* role; removed members cannot run jobs."""
    if context.user_id is None:
        raise JobFailure("This job has no requesting user.", 403)
    with database.session_factory() as session:
        membership = session.get(OrganizationMembershipRow, (str(context.organization_id), str(context.user_id)))
        user = session.get(UserRow, str(context.user_id))
        if membership is None or user is None:
            raise JobFailure("You are no longer a member of this workspace.", 403)
        return Actor(user_id=context.user_id, organization_id=context.organization_id, email=user.email,
                     display_name=user.display_name, role=membership.role, must_change_password=False,
                     session_version=0)


def _prep_failure(exc: Exception) -> JobFailure:
    if isinstance(exc, CalendarError):
        return JobFailure(str(exc), 404)
    if isinstance(exc, PrepPermissionError):
        return JobFailure(str(exc), 403)
    if isinstance(exc, (PrepConfigError, PrepBusyError)):
        return JobFailure(str(exc), 409)
    return JobFailure(str(exc), 502)


def _minutes_failure(exc: Exception) -> JobFailure:
    if isinstance(exc, MeetingNotFoundError):
        return JobFailure("meeting not found", 404)
    if isinstance(exc, MinutesNotFoundError):
        return JobFailure("MOM has not been generated", 404)
    if isinstance(exc, (MinutesConflictError, MeetingConflictError, ProviderSelectionError, ProfileNotFoundError)):
        return JobFailure(str(exc), 409)
    return JobFailure(str(exc), 502)


MINUTES_ERRORS = (MeetingNotFoundError, MinutesNotFoundError, MinutesConflictError, MinutesGenerationError,
                  MeetingConflictError, ProviderSelectionError, ProviderExecutionError, ProfileNotFoundError,
                  VexaAPIError)


def register_job_kinds(jobs: BackgroundJobService, *, database: Database, notifications: NotificationService,
                       events: NotificationEvents, meeting_prep: MeetingPrepService, repository: Any,
                       meeting_service: Any, minutes_service: Any, knowledge_index: Any) -> None:
    # ----- meeting-prep briefing (personal) ------------------------------------------------
    async def run_prep(context: JobContext) -> dict[str, Any]:
        actor = resolve_actor(database, context)
        event_id = UUID(context.payload["event_id"])
        request = PrepRequest.model_validate(context.payload.get("request") or {})
        try:
            report = await meeting_prep.generate(actor, event_id, request, context.progress)
        except (CalendarError, PrepError) as exc:
            raise _prep_failure(exc) from exc
        return {"report_id": str(report.id), "calendar_event_id": str(event_id),
                "target_company": report.target_company}

    def prep_title(job: JobPublic) -> str:
        with database.session_factory() as session:
            payload = session.execute(select(BackgroundJobRow.payload).where(
                BackgroundJobRow.id == str(job.id))).scalar_one_or_none() or {}
        title = " ".join(str(payload.get("title") or "").split())[:120]
        return f"“{title}”" if title else "your meeting"

    def prep_done(job: JobPublic) -> None:
        notifications.notify(
            current_organization_id(), user_ids=[job.user_id], kind="prep.ready", severity="success",
            title=f"Briefing ready for {prep_title(job)}",
            body=f"Researched briefing on {job.result.get('target_company')}." if job.result and job.result.get("target_company")
            else "Your meeting briefing is saved.",
            link_view="prep", link_id=job.subject_id, dedupe_key=f"job:{job.id}:done",
        )

    def prep_failed(job: JobPublic) -> None:
        notifications.notify(
            current_organization_id(), user_ids=[job.user_id], kind="prep.failed", severity="danger",
            title=f"Briefing failed for {prep_title(job)}", body=job.error, link_view="prep",
            link_id=job.subject_id, dedupe_key=f"job:{job.id}:failed",
        )

    jobs.register(PREP_BRIEFING, run_prep, on_success=prep_done, on_failure=prep_failed)

    # ----- minutes draft (workspace-level, per meeting) ------------------------------------
    async def run_minutes(context: JobContext) -> dict[str, Any]:
        # Same rule as the synchronous endpoint: only a current owner/admin may draft minutes.
        if not resolve_actor(database, context).is_admin:
            raise JobFailure("Only workspace owners and admins can draft minutes.", 403)
        meeting_id = UUID(context.payload["meeting_id"])
        try:
            minutes_service.require_not_sent(meeting_id)
            meeting = repository.get_meeting(meeting_id)
            if meeting.vexa_meeting_id is not None:
                await context.progress("reading", "Fetching the final transcript")
                # Pull the final upstream snapshot before freezing the MOM input.
                await meeting_service.transcript(meeting_id)
            await context.progress("writing", "Drafting the minutes")
            minutes = await minutes_service.generate(meeting_id)
        except MINUTES_ERRORS as exc:
            raise _minutes_failure(exc) from exc
        return {"meeting_id": str(meeting_id), "minutes_status": minutes.status.value}

    def minutes_done(job: JobPublic) -> None:
        events.minutes_ready(job.subject_id, reference=f"job-{job.id}")

    def minutes_failed(job: JobPublic) -> None:
        events.minutes_failed(job.subject_id, job.error, reference=f"job-{job.id}")

    jobs.register(MINUTES_DRAFT, run_minutes, on_success=minutes_done, on_failure=minutes_failed,
                  workspace_level=True)

    # ----- knowledge-base re-index (workspace-level, per base) -----------------------------
    async def run_reindex(context: JobContext) -> dict[str, Any]:
        actor = resolve_actor(database, context)
        base_id = UUID(context.payload["knowledge_base_id"])
        await context.progress("indexing", "Chunking and embedding meeting sources")
        try:
            status = await knowledge_index.reindex(base_id, actor)
        except KnowledgeBaseNotFoundError as exc:
            raise JobFailure("knowledge base not found", 404) from exc
        except KnowledgeIndexError as exc:
            raise JobFailure(str(exc), 409) from exc
        return {"knowledge_base_id": str(base_id), "indexed_sources": status.indexed_sources}

    def reindex_done(job: JobPublic) -> None:
        events.knowledge_indexed(current_organization_id(), job.subject_id,
                                 reference=f"job-{job.id}", user_id=job.user_id)

    def reindex_failed(job: JobPublic) -> None:
        events.knowledge_index_failed(current_organization_id(), job.subject_id, job.error,
                                      reference=f"job-{job.id}", user_id=job.user_id)

    jobs.register(KNOWLEDGE_REINDEX, run_reindex, on_success=reindex_done, on_failure=reindex_failed,
                  workspace_level=True)
