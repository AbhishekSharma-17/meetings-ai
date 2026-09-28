"""Notification-center HTTP routes. Every signed-in role reads and manages only its own notifications."""

from __future__ import annotations

from uuid import UUID

from fastapi import FastAPI, HTTPException, Query, Request, Response

from .notifications import (
    NotificationNotFoundError,
    NotificationPage,
    NotificationPublic,
    NotificationService,
    UnreadCount,
)


def register_notification_routes(app: FastAPI, *, notifications: NotificationService) -> None:
    @app.get("/v1/notifications", response_model=NotificationPage)
    def list_notifications(request: Request, unread: bool = False, limit: int = Query(default=30, ge=1, le=100),
                           cursor: str | None = Query(default=None, max_length=200)) -> NotificationPage:
        return notifications.list(request.state.actor, unread_only=unread, limit=limit, cursor=cursor)

    @app.get("/v1/notifications/unread-count", response_model=UnreadCount)
    def unread_notifications(request: Request) -> UnreadCount:
        return UnreadCount(unread_count=notifications.unread_count(request.state.actor))

    @app.post("/v1/notifications/read-all", response_model=UnreadCount)
    def read_all_notifications(request: Request) -> UnreadCount:
        notifications.mark_all_read(request.state.actor)
        return UnreadCount(unread_count=notifications.unread_count(request.state.actor))

    @app.post("/v1/notifications/{notification_id}/read", response_model=NotificationPublic)
    def read_notification(notification_id: UUID, request: Request) -> NotificationPublic:
        try:
            return notifications.mark_read(request.state.actor, notification_id)
        except NotificationNotFoundError as exc:
            raise HTTPException(status_code=404, detail="notification not found") from exc

    @app.delete("/v1/notifications/{notification_id}", status_code=204)
    def delete_notification(notification_id: UUID, request: Request) -> Response:
        try:
            notifications.delete(request.state.actor, notification_id)
        except NotificationNotFoundError as exc:
            raise HTTPException(status_code=404, detail="notification not found") from exc
        return Response(status_code=204)
