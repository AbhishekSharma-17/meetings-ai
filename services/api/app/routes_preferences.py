"""Personal display preferences under /v1/me/preferences (every role, every workspace).

``POST /v1/me/preferences/detected`` is called by the web app on load with the browser's zone;
it is idempotent and is not recorded in the workspace audit log.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request

from .user_preferences import (
    DetectedTimezone,
    InvalidTimezoneError,
    PreferencesPublic,
    PreferencesUpdate,
    UserPreferenceService,
)


def register_preference_routes(app: FastAPI, *, preferences: UserPreferenceService) -> None:
    @app.get("/v1/me/preferences", response_model=PreferencesPublic)
    def get_preferences(request: Request) -> PreferencesPublic:
        return preferences.get(request.state.actor.user_id)

    @app.put("/v1/me/preferences", response_model=PreferencesPublic)
    def update_preferences(payload: PreferencesUpdate, request: Request) -> PreferencesPublic:
        try:
            return preferences.update(request.state.actor.user_id, payload)
        except InvalidTimezoneError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/v1/me/preferences/detected", response_model=PreferencesPublic)
    def record_detected_timezone(payload: DetectedTimezone, request: Request) -> PreferencesPublic:
        try:
            return preferences.record_detected(request.state.actor.user_id, payload.timezone)
        except InvalidTimezoneError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
