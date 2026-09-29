"""Wires in-person recording into the app with one call from ``create_app``."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from .database import Database
from .in_person_finalize import InPersonFinalizer
from .in_person_names import SpeakerNamingService
from .in_person_service import InPersonService
from .in_person_store import InPersonStore
from .in_person_stt import InPersonTranscriber
from .routes_in_person import register_in_person_routes


def install_in_person(
    app: FastAPI, *, database: Database, repository: Any, meeting_service: Any, providers: Any,
    calendar_schedule: Any, call_coordination: Any, jobs: Any, transport: Any = None,
) -> InPersonFinalizer:
    """Routes, the final-pass job kind, and the cleanup loop (returned; the leader process runs it)."""
    service = InPersonService(
        store=InPersonStore(database), repository=repository, meetings=meeting_service,
        transcriber=InPersonTranscriber(providers, transport=transport), calendar_schedule=calendar_schedule,
        coordination=call_coordination, jobs=jobs,
    )
    finalizer = InPersonFinalizer(service, providers)
    finalizer.register(jobs)
    register_in_person_routes(app, service=service, naming=SpeakerNamingService(service, finalizer))
    app.state.in_person = service
    app.state.in_person_finalizer = finalizer
    return finalizer
