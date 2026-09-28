"""Our company identity: GET for every member, PUT for owners and admins.

Non-admin writes are also rejected by the ``require_admin`` middleware (only GET is allowlisted);
the service checks again so the rule holds for any future caller.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request

from .organization_identity import (
    IdentityPermissionError, OrganizationIdentityInput, OrganizationIdentityService, OrganizationIdentityView,
)


def register_identity_routes(app: FastAPI, *, identities: OrganizationIdentityService) -> None:
    @app.get("/v1/workspace/identity", response_model=OrganizationIdentityView)
    def get_identity(request: Request) -> OrganizationIdentityView:
        return identities.get(request.state.actor)

    @app.put("/v1/workspace/identity", response_model=OrganizationIdentityView)
    def save_identity(payload: OrganizationIdentityInput, request: Request) -> OrganizationIdentityView:
        try:
            return identities.save(request.state.actor, payload)
        except IdentityPermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
