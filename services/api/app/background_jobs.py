"""Durable in-process background jobs (briefings, minutes drafts, knowledge re-indexing).

State lives in ``background_jobs`` so a browser can leave the page and come back to a job's
live stage, result or error. Jobs run as asyncio tasks in the API process with bounded
concurrency. The API runs as a single replica (docs/deployment/railway.md); on startup,
jobs a previous process left ``running`` are marked failed with a retryable message and
jobs still ``queued`` are started again. A multi-replica deployment needs a shared queue.
"""

from __future__ import annotations

import asyncio
import threading
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel
from sqlalchemy import select, update

from .accounts import Actor
from .database import BackgroundJobRow, Database
from .tenant import tenant_scope

logger = logging.getLogger(__name__)

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
ACTIVE_STATUSES = ("queued", "running")
DEFAULT_CONCURRENCY = 3
MAX_LIST = 50
CANCEL_WAIT_SECONDS = 5.0
INTERRUPTED_MESSAGE = "The server restarted while this was running. Start it again."
GENERIC_FAILURE = "The job could not be completed. Please try again."


class JobPublic(BaseModel):
    id: UUID
    kind: str
    subject_id: str | None = None
    status: JobStatus
    stage: str | None = None
    message: str | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    attempts: int
    user_id: UUID | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    updated_at: datetime


class JobFailure(Exception):
    """An expected failure whose message is safe to show; ``status_code`` mirrors the sync endpoint."""

    def __init__(self, message: str, status_code: int = 409) -> None:
        super().__init__(message)
        self.status_code = status_code


class JobNotFoundError(LookupError):
    pass


@dataclass
class JobContext:
    job_id: UUID
    organization_id: UUID
    user_id: UUID | None
    payload: dict[str, Any]
    service: BackgroundJobService

    async def progress(self, stage: str, message: str = "") -> None:
        self.service.record_progress(self.job_id, stage, message)


Runner = Callable[[JobContext], Awaitable[dict[str, Any] | None]]
Hook = Callable[[JobPublic], None]


@dataclass(frozen=True)
class JobKind:
    runner: Runner
    on_success: Hook | None = None
    on_failure: Hook | None = None
    # Workspace-level jobs (e.g. a meeting's minutes) are shared: one active job per subject,
    # visible to owners/admins. Personal jobs (briefings) are one per user and private.
    workspace_level: bool = False


def _utc(value: datetime | None) -> datetime | None:
    return value.replace(tzinfo=value.tzinfo or UTC) if value else None


def _public(row: BackgroundJobRow) -> JobPublic:
    return JobPublic(
        id=UUID(row.id), kind=row.kind, subject_id=row.subject_id, status=row.status, stage=row.stage,
        message=row.message, result=row.result, error=row.error, attempts=row.attempts,
        user_id=UUID(row.user_id) if row.user_id else None, created_at=_utc(row.created_at),
        started_at=_utc(row.started_at), finished_at=_utc(row.finished_at), updated_at=_utc(row.updated_at),
    )


class BackgroundJobService:
    def __init__(self, database: Database, *, concurrency: int = DEFAULT_CONCURRENCY) -> None:
        self.database = database
        self.concurrency = concurrency
        self.kinds: dict[str, JobKind] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._semaphore: asyncio.Semaphore | None = None
        self._submit_lock = threading.Lock()

    def register(self, kind: str, runner: Runner, *, on_success: Hook | None = None,
                 on_failure: Hook | None = None, workspace_level: bool = False) -> None:
        self.kinds[kind] = JobKind(runner, on_success, on_failure, workspace_level)

    # ----- lifecycle -----------------------------------------------------------------------
    async def start(self) -> None:
        """Recover jobs from a previous process. Call once from the app lifespan."""
        self._semaphore = asyncio.Semaphore(self.concurrency)
        try:
            self.recover()
        except Exception:
            logger.exception("could not recover background jobs")

    async def stop(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def recover(self) -> tuple[int, int]:
        """Mark interrupted ``running`` jobs failed (retryable); start ``queued`` ones again.

        Runs only in the process that leads background work (see ``leader``), once the previous
        leader has gone, so every other ``running`` job was really interrupted. Jobs this process is
        already running (submitted to it while it waited to lead) are left alone.
        """
        now = datetime.now(UTC)
        mine = set(self._tasks)
        with self.database.session_factory.begin() as session:
            interrupted = [row for row in session.execute(select(BackgroundJobRow).where(
                BackgroundJobRow.status == "running",
            )).scalars().all() if row.id not in mine]
            for row in interrupted:
                row.status, row.error, row.finished_at, row.updated_at = "failed", INTERRUPTED_MESSAGE, now, now
                row.result = {"error_status": 503, "retryable": True}
            failed = [(_public(row), UUID(row.organization_id)) for row in interrupted]
            queued = [job_id for job_id in session.execute(select(BackgroundJobRow.id).where(
                BackgroundJobRow.status == "queued",
            )).scalars().all() if job_id not in mine]
        for job, organization_id in failed:
            self._hook(job, organization_id)
        for job_id in queued:
            self._schedule(job_id)
        return len(failed), len(queued)

    # ----- submitting ----------------------------------------------------------------------
    def active(self, organization_id: UUID, user_id: UUID | None, kind: str, subject_id: str | None) -> JobPublic | None:
        spec = self.kinds.get(kind)
        conditions = [BackgroundJobRow.organization_id == str(organization_id), BackgroundJobRow.kind == kind,
                      BackgroundJobRow.status.in_(ACTIVE_STATUSES)]
        conditions.append(BackgroundJobRow.subject_id == subject_id if subject_id is not None
                          else BackgroundJobRow.subject_id.is_(None))
        if not (spec and spec.workspace_level):
            conditions.append(BackgroundJobRow.user_id == (str(user_id) if user_id else None))
        with self.database.session_factory() as session:
            row = session.execute(select(BackgroundJobRow).where(*conditions)
                                  .order_by(BackgroundJobRow.created_at.desc()).limit(1)).scalar_one_or_none()
            return _public(row) if row else None

    def submit(self, *, organization_id: UUID, user_id: UUID | None, kind: str, subject_id: str | None,
               payload: dict[str, Any] | None = None) -> tuple[JobPublic, bool]:
        """Create and start a job, or return the active one for the same subject. Must run in the event loop."""
        if kind not in self.kinds:
            raise ValueError(f"unknown background job kind: {kind}")
        # Check-then-insert under one lock so double clicks or two tabs can never start
        # the same paid job twice (single API replica; see docs/deployment/railway.md).
        with self._submit_lock:
            existing = self.active(organization_id, user_id, kind, subject_id)
            if existing is not None:
                return existing, False
            return self._insert_and_schedule(organization_id, user_id, kind, subject_id, payload)

    def _insert_and_schedule(self, organization_id: UUID, user_id: UUID | None, kind: str, subject_id: str | None,
                             payload: dict[str, Any] | None) -> tuple[JobPublic, bool]:
        now = datetime.now(UTC)
        row = BackgroundJobRow(
            id=str(uuid4()), organization_id=str(organization_id), user_id=str(user_id) if user_id else None,
            kind=kind, subject_id=subject_id, status="queued", stage="queued", message="Waiting to start",
            payload=payload or {}, result=None, error=None, attempts=0, created_at=now, started_at=None,
            finished_at=None, updated_at=now,
        )
        with self.database.session_factory.begin() as session:
            session.add(row)
            job = _public(row)
        self._schedule(row.id)
        return job, True

    def _schedule(self, job_id: str) -> None:
        if job_id in self._tasks:
            return
        task = asyncio.get_running_loop().create_task(self._run(job_id), name=f"background-job-{job_id}")
        self._tasks[job_id] = task
        task.add_done_callback(lambda _: self._tasks.pop(job_id, None))

    # ----- running -------------------------------------------------------------------------
    async def _run(self, job_id: str) -> None:
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(self.concurrency)
        # Cancellation propagates: a user cancel is recorded by cancel(); on process shutdown the
        # row stays "running" so the next start reports it as interrupted and notifies the user.
        async with self._semaphore:
            await self._execute(job_id)

    def _claim(self, job_id: str) -> tuple[JobContext, str] | None:
        """Atomically move a queued job to running. Exactly one process can win; None if another did."""
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            claimed = session.execute(update(BackgroundJobRow).where(
                BackgroundJobRow.id == job_id, BackgroundJobRow.status == "queued",
            ).values(status="running", started_at=now, updated_at=now, attempts=BackgroundJobRow.attempts + 1,
                     stage="starting", message="Starting")).rowcount
            if not claimed:
                return None
            row = session.get(BackgroundJobRow, job_id)
            context = JobContext(UUID(row.id), UUID(row.organization_id),
                                 UUID(row.user_id) if row.user_id else None, dict(row.payload or {}), self)
            return context, row.kind

    async def _execute(self, job_id: str) -> None:
        claim = self._claim(job_id)
        if claim is None:
            return
        context, kind = claim
        spec = self.kinds.get(kind)
        if spec is None:
            self._finish(job_id, "failed", error="This kind of job is no longer supported.", message=None)
            return
        try:
            with tenant_scope(context.organization_id):
                result = await spec.runner(context)
        except JobFailure as exc:
            self._finish(job_id, "failed", error=str(exc), message=None, result={"error_status": exc.status_code})
        except Exception:  # CancelledError is a BaseException and propagates
            logger.exception("background job %s (%s) failed", job_id, kind)
            self._finish(job_id, "failed", error=GENERIC_FAILURE, message=None, result={"error_status": 500})
        else:
            self._finish(job_id, "succeeded", error=None, message="Done", result=result or {})

    def record_progress(self, job_id: UUID | str, stage: str, message: str = "") -> None:
        try:
            with self.database.session_factory.begin() as session:
                session.execute(update(BackgroundJobRow).where(
                    BackgroundJobRow.id == str(job_id), BackgroundJobRow.status == "running",
                ).values(stage=stage[:40], message=message[:500] or None, updated_at=datetime.now(UTC)))
        except Exception:
            logger.exception("could not record background job progress")

    def _finish(self, job_id: str, status: str, *, error: str | None, message: str | None,
                result: dict[str, Any] | None = None) -> None:
        now = datetime.now(UTC)
        try:
            with self.database.session_factory.begin() as session:
                row = session.get(BackgroundJobRow, job_id)
                if row is None or row.status not in ACTIVE_STATUSES:
                    return
                row.status, row.error, row.finished_at, row.updated_at = status, error, now, now
                row.stage = "done" if status == "succeeded" else status
                row.message = message
                row.result = result
                job, organization_id = _public(row), UUID(row.organization_id)
        except Exception:
            logger.exception("could not record background job outcome")
            return
        self._hook(job, organization_id)

    def _hook(self, job: JobPublic, organization_id: UUID) -> None:
        spec = self.kinds.get(job.kind)
        hook = (spec.on_success if job.status == "succeeded" else spec.on_failure) if spec else None
        if hook is None or job.status == "cancelled":
            return
        try:
            with tenant_scope(organization_id):
                hook(job)
        except Exception:
            logger.exception("background job hook failed for %s", job.kind)

    # ----- reading and cancelling ----------------------------------------------------------
    def _visible(self, actor: Actor, row: BackgroundJobRow | None) -> bool:
        if row is None or row.organization_id != str(actor.organization_id):
            return False
        if row.user_id == str(actor.user_id):
            return True
        spec = self.kinds.get(row.kind)
        return bool(spec and spec.workspace_level and actor.is_admin)

    def get(self, actor: Actor, job_id: UUID) -> JobPublic:
        with self.database.session_factory() as session:
            row = session.get(BackgroundJobRow, str(job_id))
            if not self._visible(actor, row):
                raise JobNotFoundError("job not found")
            return _public(row)

    def list(self, actor: Actor, *, kind: str | None = None, subject_id: str | None = None,
             active: bool | None = None, limit: int = 20) -> list[JobPublic]:
        conditions = [BackgroundJobRow.organization_id == str(actor.organization_id)]
        if kind:
            conditions.append(BackgroundJobRow.kind == kind)
        if subject_id:
            conditions.append(BackgroundJobRow.subject_id == subject_id)
        if active is True:
            conditions.append(BackgroundJobRow.status.in_(ACTIVE_STATUSES))
        elif active is False:
            conditions.append(BackgroundJobRow.status.not_in(ACTIVE_STATUSES))
        with self.database.session_factory() as session:
            rows = session.execute(select(BackgroundJobRow).where(*conditions).order_by(
                BackgroundJobRow.created_at.desc(),
            ).limit(max(1, min(limit, MAX_LIST)) * 4)).scalars().all()
            return [_public(row) for row in rows if self._visible(actor, row)][:max(1, min(limit, MAX_LIST))]

    async def cancel(self, actor: Actor, job_id: UUID) -> JobPublic:
        with self.database.session_factory() as session:
            row = session.get(BackgroundJobRow, str(job_id))
            if not self._visible(actor, row):
                raise JobNotFoundError("job not found")
            if row.user_id != str(actor.user_id) and not actor.is_admin:
                raise JobNotFoundError("job not found")
            status = row.status
        if status in ACTIVE_STATUSES:
            task = self._tasks.get(str(job_id))
            if task is not None and not task.done():
                task.cancel()
                # Bounded: a provider call that ignores cancellation must not hang the Cancel request.
                # The row is marked cancelled below either way, and _finish never overwrites it later.
                done, _ = await asyncio.wait({task}, timeout=CANCEL_WAIT_SECONDS)
                if not done:
                    logger.warning("background job %s did not stop within %ss of cancel", job_id, CANCEL_WAIT_SECONDS)
            self._finish(str(job_id), "cancelled", error=None, message="Cancelled")
        return self.get(actor, job_id)

    async def wait(self, job_id: UUID | str, timeout: float = 10.0) -> None:
        """Test/diagnostic helper: wait until the job's task (if any) finishes."""
        task = self._tasks.get(str(job_id))
        if task is not None:
            await asyncio.wait_for(asyncio.shield(task), timeout)
