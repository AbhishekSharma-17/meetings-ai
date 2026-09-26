"""Workspace storage accounting and category purge endpoints (workspace owners and admins only)."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException, Query, Request

from .routes_usage import require_workspace_admin
from .storage import StorageItemsResponse, StorageService, StorageSummary
from .storage_purge import (
    StoragePurgeError,
    StoragePurgeRequest,
    StoragePurgeResult,
    StoragePurgeService,
)

ItemCategory = Literal["meetings", "meeting_preps", "documents", "search_index", "knowledge_bases",
                       "ai_chats", "calendar_cache", "logs"]


def register_storage_routes(app: FastAPI, *, storage: StorageService, purger: StoragePurgeService) -> None:
    @app.get("/v1/workspace/storage", response_model=StorageSummary)
    async def get_workspace_storage(request: Request, include_capture: bool = False) -> StorageSummary:
        actor = require_workspace_admin(request)
        return await storage.summary(actor.organization_id, include_capture=include_capture)

    @app.get("/v1/workspace/storage/items", response_model=StorageItemsResponse)
    def get_workspace_storage_items(
        request: Request, category: ItemCategory,
        q: Annotated[str | None, Query(max_length=200)] = None,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
    ) -> StorageItemsResponse:
        actor = require_workspace_admin(request)
        return storage.items(actor.organization_id, category, q=q, limit=limit)

    @app.post("/v1/workspace/storage/purge", response_model=StoragePurgeResult)
    async def purge_workspace_storage(payload: StoragePurgeRequest, request: Request) -> StoragePurgeResult:
        actor = require_workspace_admin(request)
        try:
            return await purger.purge(actor, payload)
        except StoragePurgeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
