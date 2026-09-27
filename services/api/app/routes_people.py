"""Per-person endpoints: default workspace preference and profile photos."""

from __future__ import annotations

from uuid import UUID

from fastapi import FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool

from .accounts import AccountError, AccountService, DefaultWorkspaceRequest, OrganizationOption
from .profile_photos import MAX_PHOTO_BYTES, ProfilePhotoError, ProfilePhotoService, encode_profile_photo
from .rate_limit import SlidingWindowLimiter

PHOTO_UPLOADS_PER_WINDOW = 10
PHOTO_UPLOAD_WINDOW_SECONDS = 10 * 60
# URLs carry a version, so a private cache may keep a photo for a day.
PHOTO_CACHE_CONTROL = "private, max-age=86400"


def register_people_routes(app: FastAPI, *, accounts: AccountService, photos: ProfilePhotoService) -> None:
    upload_limiter = SlidingWindowLimiter(
        PHOTO_UPLOADS_PER_WINDOW, PHOTO_UPLOAD_WINDOW_SECONDS,
        "too many photo uploads; try again in a few minutes",
    )

    def account_with_photo(request: Request) -> dict[str, object]:
        actor = request.state.actor
        payload = accounts.public(actor).model_dump(mode="json")
        payload["photo_url"] = photos.url_for(actor.user_id)
        return payload

    @app.put("/v1/workspaces/default", response_model=list[OrganizationOption])
    def set_default_workspace(payload: DefaultWorkspaceRequest, request: Request) -> list[OrganizationOption]:
        try:
            return accounts.set_default_organization(request.state.actor, payload.organization_id)
        except AccountError as exc:
            raise HTTPException(status_code=404, detail="workspace not found") from exc

    @app.put("/v1/auth/me/photo")
    async def upload_profile_photo(request: Request, file: UploadFile = File(...)) -> dict[str, object]:
        actor = request.state.actor
        upload_limiter.check(actor.user_id)
        data = await file.read(MAX_PHOTO_BYTES + 1)
        try:
            encoded = await run_in_threadpool(encode_profile_photo, data)
        except ProfilePhotoError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        await run_in_threadpool(photos.save, actor.user_id, encoded)
        return account_with_photo(request)

    @app.delete("/v1/auth/me/photo")
    def remove_profile_photo(request: Request) -> dict[str, object]:
        photos.remove(request.state.actor.user_id)
        return account_with_photo(request)

    @app.get("/v1/users/{user_id}/photo")
    def get_profile_photo(user_id: UUID, request: Request) -> Response:
        actor = request.state.actor
        photo = photos.get_visible(actor.user_id, actor.organization_id, user_id)
        if photo is None:
            # Same answer for "no photo" and "not in your workspace": no cross-tenant probing.
            raise HTTPException(status_code=404, detail="photo not found")
        headers = {
            "ETag": photo.etag,
            "Cache-Control": PHOTO_CACHE_CONTROL,
            "X-Content-Type-Options": "nosniff",
            "Vary": "Cookie",
        }
        if photo.etag in {tag.strip() for tag in request.headers.get("if-none-match", "").split(",")}:
            return Response(status_code=304, headers=headers)
        return Response(content=photo.data, media_type=photo.content_type, headers=headers)
