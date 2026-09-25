"""HTTP adapter for the pinned local Vexa gateway API."""

from typing import Any
from urllib.parse import quote

import httpx


class VexaAPIError(RuntimeError):
    def __init__(self, operation: str, status_code: int, detail: str) -> None:
        self.operation = operation
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"Vexa {operation} failed ({status_code}): {detail}")


class VexaCaptureAdapter:
    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_seconds: float = 15.0,
    ) -> None:
        headers = {"Accept": "application/json"}
        if api_key:
            headers["X-API-Key"] = api_key
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers=headers,
            timeout=timeout_seconds,
            transport=transport,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def join(
        self,
        *,
        meeting_url: str,
        bot_name: str,
        language: str | None,
        transcribe_enabled: bool,
        recording_enabled: bool,
        stt_override: dict[str, object] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "meeting_url": meeting_url,
            "bot_name": bot_name,
            "transcribe_enabled": transcribe_enabled,
            "recording_enabled": recording_enabled,
        }
        if language:
            payload["language"] = language
        if stt_override is not None:
            health = await self._request(
                "GET", "/health", operation="verify per-bot STT capability"
            )
            features = health.get("features")
            if not isinstance(features, dict) or features.get("signed_stt_override") is not True:
                raise VexaAPIError(
                    "verify per-bot STT capability", 503,
                    "connected Vexa does not advertise signed per-bot STT routing",
                )
            payload["stt_override"] = stt_override
        return await self._request("POST", "/bots", operation="join", json=payload)

    async def preflight(self) -> dict[str, Any]:
        """Validate gateway reachability and API-key authentication without mutation."""
        identity = await self._request(
            "GET", "/auth/me", operation="authentication preflight"
        )
        scopes = identity.get("scopes", [])
        if not isinstance(scopes, list):
            raise VexaAPIError(
                "authentication preflight", 502, "Vexa returned invalid API-key scopes"
            )
        missing = {"bot", "tx"} - {str(scope) for scope in scopes}
        if missing:
            raise VexaAPIError(
                "authentication preflight",
                403,
                f"Vexa API key is missing required scope(s): {', '.join(sorted(missing))}",
            )
        return identity

    async def list_meetings(self) -> list[dict[str, Any]]:
        body = await self._request("GET", "/meetings", operation="list meetings")
        meetings = body.get("meetings", [])
        if not isinstance(meetings, list):
            raise VexaAPIError("list meetings", 502, "invalid meetings response")
        return meetings

    async def list_running_bots(self) -> list[dict[str, Any]]:
        body = await self._request("GET", "/bots/status", operation="list bot status")
        running = body.get("running", body.get("running_bots", []))
        if not isinstance(running, list):
            raise VexaAPIError("list bot status", 502, "invalid bot status response")
        return running

    async def get_meeting(self, vexa_meeting_id: int) -> dict[str, Any]:
        return await self._request(
            "GET", f"/meetings/{vexa_meeting_id}", operation="refresh meeting"
        )

    async def stop(self, platform: str, native_meeting_id: str) -> dict[str, Any]:
        platform_path = quote(platform, safe="")
        native_path = quote(native_meeting_id, safe="")
        return await self._request(
            "DELETE",
            f"/bots/{platform_path}/{native_path}",
            operation="stop meeting",
        )

    async def get_transcript(self, vexa_meeting_id: int) -> dict[str, Any]:
        return await self._request(
            "GET",
            f"/transcripts/by-id/{vexa_meeting_id}",
            operation="retrieve transcript",
        )

    async def get_participants(self, platform: str, native_meeting_id: str) -> dict[str, Any]:
        return await self._request(
            "GET",
            f"/meetings/{quote(platform, safe='')}/{quote(native_meeting_id, safe='')}/participants",
            operation="retrieve participants",
        )

    async def _request(
        self, method: str, path: str, *, operation: str, **kwargs: Any
    ) -> dict[str, Any]:
        try:
            response = await self._client.request(method, path, **kwargs)
        except httpx.RequestError as exc:
            raise VexaAPIError(operation, 503, "Vexa is unavailable") from exc
        if response.is_error:
            try:
                body = response.json()
                detail = body.get("detail", body) if isinstance(body, dict) else body
            except ValueError:
                detail = response.text[:500]
            raise VexaAPIError(operation, response.status_code, str(detail))
        try:
            body = response.json()
        except ValueError as exc:
            raise VexaAPIError(operation, 502, "Vexa returned invalid JSON") from exc
        if not isinstance(body, dict):
            raise VexaAPIError(operation, 502, "Vexa returned a non-object response")
        return body
