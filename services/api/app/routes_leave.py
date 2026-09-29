"""When the assistant leaves a call: the workspace policy and each meeting's leave status.

- ``GET /v1/workspace/leave-policy`` every member; ``PUT`` owners and admins.
- ``GET /v1/meetings/{id}/leave`` the planned automatic leave (in a call) or why it ended.
- ``POST /v1/meetings/{id}/keep`` owners and admins: keep the assistant in the call 30 minutes more.

Non-admin writes are also rejected by the ``require_admin`` middleware; the services check again.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import FastAPI, HTTPException, Request

from .leave_service import LeaveConflictError, LeaveService, MeetingLeaveView
from .leave_store import LeavePermissionError, LeavePolicyInput, LeavePolicyService, LeavePolicyView
from .repository import MeetingNotFoundError


def register_leave_routes(app: FastAPI, *, policies: LeavePolicyService, leave: LeaveService) -> None:
    @app.get("/v1/workspace/leave-policy", response_model=LeavePolicyView)
    def get_leave_policy(request: Request) -> LeavePolicyView:
        return policies.view(request.state.actor)

    @app.put("/v1/workspace/leave-policy", response_model=LeavePolicyView)
    def save_leave_policy(payload: LeavePolicyInput, request: Request) -> LeavePolicyView:
        try:
            return policies.save(request.state.actor, payload)
        except LeavePermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc

    @app.get("/v1/meetings/{meeting_id}/leave", response_model=MeetingLeaveView)
    def get_meeting_leave(meeting_id: UUID, request: Request) -> MeetingLeaveView:
        try:
            return leave.view(request.state.actor, meeting_id)
        except MeetingNotFoundError as exc:
            raise HTTPException(status_code=404, detail="meeting not found") from exc

    @app.post("/v1/meetings/{meeting_id}/keep", response_model=MeetingLeaveView)
    def keep_in_call(meeting_id: UUID, request: Request) -> MeetingLeaveView:
        try:
            return leave.keep(request.state.actor, meeting_id)
        except MeetingNotFoundError as exc:
            raise HTTPException(status_code=404, detail="meeting not found") from exc
        except LeavePermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except LeaveConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
