"""Calendar automation settings, read-only preview and occurrence controls."""
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request

from .calendar_automation import AutomationPolicy, AutomationSettings, MeetingAutomationPatch
from .composio_calendar import CalendarError
from .repository import MeetingNotFoundError
from .knowledge_bases import KnowledgeBaseNotFoundError


def automation_route_allowed(method, path):
    import re
    return ((path in {"/v1/calendar/automation", "/v1/calendar/automation/preview", "/v1/calendar/automation/reconcile"} and method in {"GET", "PUT", "POST"})
            or (path == "/v1/workspace/automation-policy" and method == "GET")
            or (re.fullmatch(r"/v1/meetings/[0-9a-f-]{36}/automation", path) and method in {"GET", "PATCH"}))


def register_calendar_automation_routes(app: FastAPI, automation):
    def error(exc):
        code = 404 if isinstance(exc, (MeetingNotFoundError, KnowledgeBaseNotFoundError)) else 403 if isinstance(exc, PermissionError) else 422
        return HTTPException(status_code=code, detail=str(exc))

    errors = (ValueError, PermissionError, CalendarError, MeetingNotFoundError, KnowledgeBaseNotFoundError)

    @app.get("/v1/calendar/automation")
    def settings(request: Request):
        return automation.get(request.state.actor)

    @app.put("/v1/calendar/automation")
    async def save(payload: AutomationSettings, request: Request):
        try:
            return await automation.save(request.state.actor, payload)
        except errors as exc:
            raise error(exc) from exc

    @app.post("/v1/calendar/automation/preview")
    async def preview(payload: AutomationSettings, request: Request):
        try:
            return await automation.preview(request.state.actor, payload)
        except errors as exc:
            raise error(exc) from exc

    @app.post("/v1/calendar/automation/reconcile")
    async def reconcile(request: Request):
        try:
            return await automation.reconcile(request.state.actor)
        except errors as exc:
            raise error(exc) from exc

    @app.get("/v1/workspace/automation-policy")
    def policy(request: Request):
        return automation.policy(request.state.actor)

    @app.put("/v1/workspace/automation-policy")
    def save_policy(payload: AutomationPolicy, request: Request):
        try:
            return automation.save_policy(request.state.actor, payload)
        except errors as exc:
            raise error(exc) from exc

    @app.get("/v1/meetings/{meeting_id}/automation")
    def meeting(meeting_id: UUID, request: Request):
        try:
            return automation.meeting(request.state.actor, meeting_id)
        except errors as exc:
            raise error(exc) from exc

    @app.patch("/v1/meetings/{meeting_id}/automation")
    def patch(meeting_id: UUID, payload: MeetingAutomationPatch, request: Request):
        try:
            return automation.patch_meeting(request.state.actor, meeting_id, payload)
        except errors as exc:
            raise error(exc) from exc
