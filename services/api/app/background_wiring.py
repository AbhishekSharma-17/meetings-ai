"""Wires notifications and background jobs into the app with one call from ``create_app``."""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import FastAPI

from .background_jobs import BackgroundJobService
from .database import Database
from .job_kinds import register_job_kinds
from .notification_events import NotificationEvents
from .notifications import NotificationService
from .notification_email_worker import NotificationEmailWorker
from .routes_jobs import register_job_routes
from .routes_notifications import register_notification_routes

logger = logging.getLogger(__name__)


def install_background_services(
    app: FastAPI, *, database: Database, meeting_prep: Any, repository: Any, meeting_service: Any,
    minutes_service: Any, post_meeting_worker: Any, calendar_schedule: Any, knowledge_index: Any,
    knowledge_bases: Any, indexing_worker: Any,
) -> BackgroundJobService:
    notifications = NotificationService(database)
    knowledge_bases.notifications = notifications
    app.state.accounts.notifications = notifications
    app.state.notification_email_worker = NotificationEmailWorker(
        database, minutes_service.resend, os.getenv("WEB_ORIGIN", "http://localhost:3020"),
    )
    events = NotificationEvents(notifications, database)
    # Existing services emit through ``events`` (a no-op until set here); see notification_events.
    for emitter in (meeting_service, minutes_service, post_meeting_worker, calendar_schedule,
                    knowledge_index, indexing_worker):
        emitter.events = events
    jobs = BackgroundJobService(database)
    register_job_kinds(jobs, database=database, notifications=notifications, events=events,
                       meeting_prep=meeting_prep, repository=repository, meeting_service=meeting_service,
                       minutes_service=minutes_service, knowledge_index=knowledge_index)
    app.state.notifications = notifications
    app.state.notification_events = events
    app.state.background_jobs = jobs
    register_notification_routes(app, notifications=notifications)
    register_job_routes(app, jobs=jobs, meeting_prep=meeting_prep, minutes_service=minutes_service,
                        repository=repository, knowledge_bases=knowledge_bases)
    return jobs


async def start_background_services(app: FastAPI) -> None:
    try:
        app.state.notifications.prune()
    except Exception:
        logger.exception("could not prune old notifications")
    await app.state.background_jobs.start()


async def stop_background_services(app: FastAPI) -> None:
    await app.state.background_jobs.stop()


def leadership_callbacks(
    app: FastAPI, start_loops: Callable[[], list[asyncio.Task[None]]],
) -> tuple[Callable[[], Awaitable[None]], Callable[[], Awaitable[None]]]:
    """The work a process starts when it becomes the background leader, and stops when it isn't.

    Leading: recover background jobs, then start the periodic loops. Stepping down (another process
    took the lock, or shutdown): cancel the loops and this process's own running jobs, so the next
    leader's recovery (which treats every running job it doesn't own as interrupted) never races
    work that is still going on here.
    """
    loops: list[asyncio.Task[None]] = []

    async def lead() -> None:
        await start_background_services(app)
        loops.extend(start_loops())
        if getattr(app.state, "notification_email_worker", None) is not None:
            loops.append(asyncio.create_task(app.state.notification_email_worker.run()))

    async def step_down() -> None:
        running, loops[:] = list(loops), []
        for task in running:
            task.cancel()
        await asyncio.gather(*running, return_exceptions=True)
        await stop_background_services(app)

    return lead, step_down
