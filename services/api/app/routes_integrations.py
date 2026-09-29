"""Workspace research integrations (owners and admins only): the Apollo connection.

``GET/PUT/DELETE /v1/workspace/integrations/apollo`` and ``POST /v1/workspace/integrations/apollo/test``.
These paths are not in the member allowlist of the ``require_admin`` middleware; the service checks the
role again so they stay safe if that list changes. The API key only ever appears in the PUT body and is
never echoed back, logged or audited (the audit log records the route template only).
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request, Response

from .apollo_composio import ApolloError
from .apollo_integration import ApolloIntegrationService, ApolloIntegrationView, ApolloKeyRequest, IntegrationError
from .rate_limit import SlidingWindowLimiter

CHANGES_PER_WINDOW = 10
CHECKS_PER_WINDOW = 10
WINDOW_SECONDS = 600


def _actor(request: Request):
    actor = getattr(request.state, "actor", None)
    if actor is None:
        raise HTTPException(status_code=401, detail="sign in required")
    return actor


def _http(exc: IntegrationError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


def register_integration_routes(app: FastAPI, *, apollo: ApolloIntegrationService) -> None:
    change_limit = SlidingWindowLimiter(CHANGES_PER_WINDOW, WINDOW_SECONDS,
                                        "too many Apollo connection changes; try again in a few minutes")
    check_limit = SlidingWindowLimiter(CHECKS_PER_WINDOW, WINDOW_SECONDS,
                                       "Apollo was checked recently; try again in a few minutes")

    @app.get("/v1/workspace/integrations/apollo", response_model=ApolloIntegrationView)
    def apollo_status(request: Request) -> ApolloIntegrationView:
        try:
            return apollo.status(_actor(request))
        except IntegrationError as exc:
            raise _http(exc) from None

    @app.put("/v1/workspace/integrations/apollo", response_model=ApolloIntegrationView)
    async def connect_apollo(payload: ApolloKeyRequest, request: Request) -> ApolloIntegrationView:
        actor = _actor(request)
        try:
            apollo.status(actor)  # role check before spending a rate-limit slot
            change_limit.check(actor.organization_id)
            return await apollo.connect(actor, payload)
        except IntegrationError as exc:
            raise _http(exc) from None

    @app.post("/v1/workspace/integrations/apollo/test", response_model=ApolloIntegrationView)
    async def test_apollo(request: Request) -> ApolloIntegrationView:
        actor = _actor(request)
        try:
            apollo.status(actor)
            check_limit.check(actor.organization_id)
            return await apollo.test(actor)
        except IntegrationError as exc:
            raise _http(exc) from None

    @app.delete("/v1/workspace/integrations/apollo", status_code=204)
    async def disconnect_apollo(request: Request) -> Response:
        actor = _actor(request)
        try:
            apollo.status(actor)
            change_limit.check(actor.organization_id)
            await apollo.disconnect(actor)
        except IntegrationError as exc:
            raise _http(exc) from None
        except ApolloError:
            raise HTTPException(status_code=502, detail="Apollo could not be disconnected; try again shortly.") from None
        return Response(status_code=204)
