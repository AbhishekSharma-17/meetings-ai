"""Build a short-lived, per-bot Vexa STT route from one product profile.

The profile URL, model and decrypted credential travel together to one bot
invocation. The browser receives neither the credential nor this signed claim.
"""

import hashlib
import hmac
import json
import time
from urllib.parse import urlsplit

from meetings_contracts import Capability, ExecutionLocation, ProviderProfile, ProviderType


class STTRouteError(ValueError):
    pass


def transcription_endpoint(profile: ProviderProfile) -> str:
    if not profile.supports(Capability.TRANSCRIPTION):
        raise STTRouteError("selected profile does not support transcription")
    base = profile.base_url or (
        "https://api.openai.com/v1" if profile.provider_type is ProviderType.OPENAI else ""
    )
    parsed = urlsplit(base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise STTRouteError("selected transcription profile needs a valid HTTP(S) endpoint")
    if profile.execution_location is ExecutionLocation.CLOUD and parsed.scheme != "https":
        raise STTRouteError("cloud transcription endpoints must use HTTPS")
    if parsed.query or parsed.fragment:
        raise STTRouteError("transcription endpoint cannot contain a query or fragment")
    endpoint = base.rstrip("/")
    if endpoint.endswith("/v1/audio/transcriptions"):
        return endpoint
    if endpoint.endswith("/v1"):
        return endpoint + "/audio/transcriptions"
    return endpoint + "/v1/audio/transcriptions"


def signed_stt_override(
    profile: ProviderProfile, meeting_url: str, signing_key: str,
    *, expires_at: int | None = None,
) -> dict[str, object]:
    if not signing_key:
        raise STTRouteError("Vexa per-bot STT signing secret is not configured")
    if not profile.api_key and profile.execution_location is ExecutionLocation.CLOUD:
        raise STTRouteError("selected cloud transcription profile has no API credential")
    claims: dict[str, object] = {
        "meeting_url": meeting_url,
        "url": transcription_endpoint(profile),
        "model": profile.models[Capability.TRANSCRIPTION],
        "token": profile.api_key,
        "profile_id": str(profile.id),
        "expires_at": expires_at if expires_at is not None else int(time.time()) + 300,
    }
    canonical = json.dumps(
        claims, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    ).encode()
    claims["signature"] = hmac.new(signing_key.encode(), canonical, hashlib.sha256).hexdigest()
    return claims
