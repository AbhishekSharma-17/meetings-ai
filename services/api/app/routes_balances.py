"""HTTP routes for provider credit balances (owners and admins only).

The ``require_admin`` middleware already rejects members and viewers for these paths (they are not
in the non-admin allowlist); the routes check again so they stay safe if the allowlist changes.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import FastAPI, HTTPException, Request

from .provider_balances import BalanceOverview, ProviderBalanceService
from .rate_limit import SlidingWindowLimiter

REFRESHES_PER_WINDOW = 6
REFRESH_WINDOW_SECONDS = 600


def _admin(request: Request) -> object:
    actor = getattr(request.state, "actor", None)
    if actor is None:
        raise HTTPException(status_code=401, detail="sign in required")
    if not getattr(actor, "is_admin", False):
        raise HTTPException(status_code=403, detail="workspace role does not permit this action")
    return actor


def register_balance_routes(app: FastAPI, *, balances: ProviderBalanceService) -> None:
    refresh_limit = SlidingWindowLimiter(REFRESHES_PER_WINDOW, REFRESH_WINDOW_SECONDS,
                                         "balances were refreshed recently; try again in a few minutes")

    @app.get("/v1/provider-balances", response_model=BalanceOverview)
    async def provider_balances(request: Request) -> BalanceOverview:
        actor = _admin(request)
        return await balances.overview(actor.organization_id)

    @app.post("/v1/provider-balances/refresh", response_model=BalanceOverview)
    async def refresh_provider_balances(request: Request, credential_id: UUID | None = None) -> BalanceOverview:
        actor = _admin(request)
        refresh_limit.check(actor.organization_id)  # per workspace: every refresh calls the providers
        return await balances.overview(actor.organization_id, force=True, credential_id=credential_id)
