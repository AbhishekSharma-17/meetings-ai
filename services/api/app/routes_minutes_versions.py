"""Document access is evaluated here for every role, including owners and administrators."""
import re
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, Response, Query

from .minutes_service import MinutesConflictError, MinutesGenerationError
from .background_jobs import JobPublic, JobFailure
from .job_kinds import resolve_actor, actor_payload, MINUTES_ERRORS, _minutes_failure
from .tenant import current_organization_id
from .database import MinutesVersionRow
from sqlalchemy import update
from .minutes_versions import (MinutesVersionsService, VersionCreate, VersionEdit, VersionRevision,
                              VersionSharing, VersionSummary, VersionDetail, VersionError)

_ID = r"[0-9a-f-]{36}"


def versions_route_allowed(method, path):
    return (method == "GET" and path == "/v1/me/minutes-versions"
        or method in {"GET", "POST"} and bool(re.fullmatch(rf"/v1/meetings/{_ID}/minutes-versions", path))
        or method in {"GET", "PATCH", "DELETE"} and bool(re.fullmatch(rf"/v1/minutes-versions/{_ID}", path))
        or method == "POST" and bool(re.fullmatch(rf"/v1/minutes-versions/{_ID}/(?:generate|jobs|approve|sharing)", path)))


def register_minutes_versions_routes(app: FastAPI, service: MinutesVersionsService):
    jobs = app.state.background_jobs

    async def run_personal_mom(context):
        actor = resolve_actor(service.database, context)
        await context.progress("writing", "Drafting your personal MOM")
        try:
            result = await service.generate(actor, UUID(context.payload["version_id"]), context.payload["revision"])
        except VersionError as exc:
            raise JobFailure(str(exc), exc.status) from exc
        except MINUTES_ERRORS as exc:
            raise _minutes_failure(exc) from exc
        return {"version_id": str(result.id)}  # Never put private contents in job payloads/results.

    def personal_mom_done(job):
        app.state.notifications.notify(current_organization_id(), user_ids=[job.user_id],
            kind="personal_mom.ready", severity="success", title="Your personal MOM is ready",
            body="Review your private draft in Shared with me before sharing it.",
            link_view="shared", dedupe_key=f"personal-mom:{job.id}:ready")

    def personal_mom_failed(job):
        # Startup recovery marks interrupted jobs failed; make their version retryable now.
        with service.database.session_factory.begin() as session:
            session.execute(update(MinutesVersionRow).where(
                MinutesVersionRow.id == job.subject_id,
                MinutesVersionRow.organization_id == str(current_organization_id()),
                MinutesVersionRow.creator_id == str(job.user_id),
                MinutesVersionRow.generation_started_at <= job.finished_at,
            ).values(generation_token=None, generation_started_at=None))

    jobs.register("personal_mom", run_personal_mom, on_success=personal_mom_done,
                  on_failure=personal_mom_failed)  # Personal visibility even for owners/admins.

    @app.exception_handler(VersionError)
    async def version_error(request, exc):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=exc.status, content={"detail": str(exc)})

    @app.get("/v1/meetings/{meeting_id}/minutes-versions", response_model=list[VersionSummary])
    def catalogue(meeting_id: UUID, request: Request):
        return service.catalogue(request.state.actor, meeting_id)

    @app.get("/v1/me/minutes-versions", response_model=list[VersionSummary])
    def inbox(request: Request):
        return service.inbox(request.state.actor)

    @app.post("/v1/meetings/{meeting_id}/minutes-versions", response_model=VersionDetail, status_code=201)
    def create(meeting_id: UUID, payload: VersionCreate, request: Request):
        return service.create(request.state.actor, meeting_id, payload)

    @app.get("/v1/minutes-versions/{version_id}", response_model=VersionDetail)
    def get(version_id: UUID, request: Request):
        return service.get(request.state.actor, version_id)

    @app.patch("/v1/minutes-versions/{version_id}", response_model=VersionDetail)
    def edit(version_id: UUID, payload: VersionEdit, request: Request):
        try:
            return service.edit(request.state.actor, version_id, payload)
        except (MinutesConflictError, MinutesGenerationError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/v1/minutes-versions/{version_id}/generate", response_model=VersionDetail)
    async def generate(version_id: UUID, payload: VersionRevision, request: Request):
        try:
            return await service.generate(request.state.actor, version_id, payload.revision)
        except MINUTES_ERRORS as exc:
            failure = _minutes_failure(exc)
            raise HTTPException(status_code=failure.status_code, detail=str(failure)) from exc

    @app.post("/v1/minutes-versions/{version_id}/jobs", response_model=JobPublic, status_code=202)
    async def start_job(version_id: UUID, payload: VersionRevision, request: Request):
        actor = request.state.actor
        item = service.get(actor, version_id)
        if not item.is_mine:
            raise VersionError("only this MOM's creator can generate it", 403)
        service._transcript_access(actor, item.meeting_id)
        active = jobs.active(actor.organization_id, actor.user_id, "personal_mom", str(version_id))
        if active:
            return active
        if item.revision != payload.revision:
            raise VersionError("this version changed; refresh before generating", 409)
        job, _ = jobs.submit(organization_id=actor.organization_id, user_id=actor.user_id,
            kind="personal_mom", subject_id=str(version_id),
            payload={"version_id": str(version_id), "revision": payload.revision, "actor": actor_payload(actor)})
        return job

    @app.post("/v1/minutes-versions/{version_id}/approve", response_model=VersionDetail)
    def approve(version_id: UUID, payload: VersionRevision, request: Request):
        try:
            return service.approve(request.state.actor, version_id, payload.revision)
        except (MinutesConflictError, MinutesGenerationError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/v1/minutes-versions/{version_id}/sharing", response_model=VersionDetail)
    def share(version_id: UUID, payload: VersionSharing, request: Request):
        return service.share(request.state.actor, version_id, payload)

    @app.delete("/v1/minutes-versions/{version_id}", status_code=204)
    def remove(version_id: UUID, request: Request, revision: int = Query(ge=1)):
        service.remove(request.state.actor, version_id, revision)
        return Response(status_code=204)
