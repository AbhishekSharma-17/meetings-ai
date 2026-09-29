"""Speech-to-text for uploaded in-person audio through the workspace's configured transcription profile.

Request shapes (verified 2026-09-29 against the provider docs):

- OpenRouter (``https://openrouter.ai/api/v1``) — ``POST /audio/transcriptions`` with a JSON body
  ``{"model", "input_audio": {"data": <base64>, "format": "webm"|"m4a"|"ogg"}, "response_format",
  "timestamp_granularities": ["segment", "word"], "diarize": true, "language"?}``. ``diarize`` needs
  ``response_format="verbose_json"``; speakers come back on ``segments[].speaker`` (int) /
  ``speaker_label`` and on ``words[]``; ``usage`` carries ``seconds`` and ``cost`` (USD).
  https://openrouter.ai/docs/guides/overview/multimodal/stt.md ,
  https://openrouter.ai/docs/api/api-reference/stt/create-transcription.md
  google/gemini-3.5-transcribe: up to 8 speakers; 30 minutes of audio per request with diarization
  (https://openrouter.ai/google/gemini-3.5-transcribe). OpenRouter's upstream timeout is 60 s per
  request, so long recordings are sent in parts (see ``route_for``).
- OpenAI ``gpt-4o-transcribe-diarize`` — multipart ``POST /v1/audio/transcriptions`` with
  ``response_format=diarized_json`` and ``chunking_strategy=auto``; segments carry ``speaker`` "A",
  "B", …; 25 MB per file and 2,000 output tokens per request.
  https://developers.openai.com/api/docs/guides/speech-to-text.md ,
  https://developers.openai.com/api/docs/models/gpt-4o-transcribe-diarize.md
- Other OpenAI / OpenAI-compatible routes — multipart with ``verbose_json`` (Whisper-style segments)
  or ``json`` (text only; timestamps are then estimated per sentence).

Audio and transcript text are never logged. Every call is recorded in the usage ledger.
"""

from __future__ import annotations

import base64
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Literal
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from meetings_contracts import Capability, ProviderProfile, ProviderType

from .stt_route import STTRouteError, transcription_endpoint

OPENROUTER_HOST = "openrouter.ai"
OPENAI_HOST = "api.openai.com"
REQUEST_TIMEOUT_SECONDS = 180.0
_FORMAT = {"audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg"}
_EXTENSION = {"audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg"}
_SENTENCE = re.compile(r"(?<=[.!?])\s+")
_MAX_WORDS_PER_SEGMENT = 60

RouteKind = Literal["openrouter", "openai_diarize", "openai", "compatible"]


class SttError(RuntimeError):
    """A safe, user-facing transcription failure (never includes credentials or audio)."""

    def __init__(self, message: str, *, retryable: bool = False, status_code: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status_code = status_code


@dataclass(frozen=True)
class SttRoute:
    kind: RouteKind
    endpoint: str
    model: str
    host: str
    max_part_ms: int
    max_part_bytes: int


@dataclass(frozen=True)
class RawSegment:
    start: float
    end: float
    text: str
    speaker: str | None = None  # part-local label ("A", "B", …) or None


@dataclass(frozen=True)
class SttResult:
    segments: tuple[RawSegment, ...]
    text: str
    audio_seconds: float | None
    cost_usd: float | None
    diarized: bool                  # the provider returned speaker labels
    response_format: str
    estimated_times: bool = False   # timestamps estimated from sentence lengths
    details: dict[str, Any] = field(default_factory=dict)


def _env_seconds(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, "") or default)
    except ValueError:
        value = default
    return max(60, min(value, 3600)) * 1000


def route_for(profile: ProviderProfile) -> SttRoute:
    """How to call this profile, and the largest part one request may carry."""
    if profile.provider_type is ProviderType.VEXA_NATIVE:
        raise SttError("the Speech to text profile is a Vexa route, which cannot transcribe uploaded audio; "
                       "choose an OpenAI or OpenRouter speech-to-text profile in AI providers")
    try:
        endpoint = transcription_endpoint(profile)
    except STTRouteError as exc:
        raise SttError(str(exc)) from exc
    model = profile.models[Capability.TRANSCRIPTION]
    host = (urlsplit(endpoint).hostname or "").lower()
    if host == OPENROUTER_HOST:
        # Gemini allows 30 min with diarization, but OpenRouter's upstream timeout is 60 s per request.
        return SttRoute("openrouter", endpoint, model, host, _env_seconds("IN_PERSON_STT_PART_SECONDS", 600),
                        20 * 1024 * 1024)
    openai = profile.provider_type is ProviderType.OPENAI or host == OPENAI_HOST
    if openai and "diarize" in model:
        # 2,000 output tokens per request is roughly 7–8 minutes of dense speech.
        return SttRoute("openai_diarize", endpoint, model, host, _env_seconds("IN_PERSON_STT_DIARIZE_PART_SECONDS", 420),
                        24 * 1024 * 1024)
    kind: RouteKind = "openai" if openai else "compatible"
    return SttRoute(kind, endpoint, model, host, _env_seconds("IN_PERSON_STT_PART_SECONDS", 600), 24 * 1024 * 1024)


class InPersonTranscriber:
    """Transcribes one audio file with the workspace's Speech to text profile and meters the call."""

    def __init__(self, providers: Any, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.providers = providers
        self.transport = transport

    def profile(self) -> ProviderProfile:
        """The configured Speech to text profile; SttError explains what to set up when there is none."""
        try:
            profile = self.providers.resolve_transcription_profile()
        except Exception as exc:  # ProviderSelectionError: the default exists but is unusable
            raise SttError(f"the Speech to text default in AI providers cannot be used: {exc}") from exc
        if profile is None:
            raise SttError("set a Speech to text default in AI providers before recording in person")
        route_for(profile)  # rejects profiles that cannot take uploaded audio
        return profile

    async def transcribe(self, profile: ProviderProfile, audio: bytes, mime_type: str, *, diarize: bool,
                         language: str | None, purpose: str, meeting_id: UUID, audio_ms: int,
                         part: int | None = None) -> SttResult:
        route = route_for(profile)
        started = time.monotonic()
        metadata = {"purpose": purpose, "meeting_id": str(meeting_id), "usage_kind": "transcription"}
        try:
            result = await self._call(route, profile, audio, mime_type, diarize=diarize, language=language,
                                      audio_ms=audio_ms)
        except SttError as exc:
            self._record_failure(profile, metadata, exc, started)
            raise
        self._record_success(profile, route, result, purpose=purpose, meeting_id=meeting_id,
                             audio_ms=audio_ms, started=started, part=part)
        return result

    # ----- provider calls ------------------------------------------------------------------------
    async def _call(self, route: SttRoute, profile: ProviderProfile, audio: bytes, mime_type: str, *,
                    diarize: bool, language: str | None, audio_ms: int) -> SttResult:
        if route.kind == "openrouter":
            attempts = ["diarize", "verbose", "json"] if diarize else ["json"]
            return await self._with_fallback(attempts, lambda mode: self._openrouter(
                route, profile, audio, mime_type, mode=mode, language=language, audio_ms=audio_ms))
        if route.kind == "openai_diarize":
            mode = "diarized_json" if diarize else "json"
            return await self._multipart(route, profile, audio, mime_type, response_format=mode, language=language,
                                         extra={"chunking_strategy": "auto"}, audio_ms=audio_ms)
        verbose = diarize and (route.kind == "compatible" or route.model.startswith("whisper"))
        attempts = ["verbose_json", "json"] if verbose else ["json"]
        return await self._with_fallback(attempts, lambda mode: self._multipart(
            route, profile, audio, mime_type, response_format=mode, language=language,
            extra={"timestamp_granularities[]": "segment"} if mode == "verbose_json" else {}, audio_ms=audio_ms))

    @staticmethod
    async def _with_fallback(modes: list[str], call) -> SttResult:
        """A 400 for an optional feature (diarization, timestamps) retries with the next simpler request."""
        for index, mode in enumerate(modes):
            try:
                return await call(mode)
            except SttError as exc:
                if exc.status_code != 400 or index == len(modes) - 1:
                    raise
        raise SttError("speech-to-text request failed")  # unreachable; keeps type checkers content

    async def _openrouter(self, route: SttRoute, profile: ProviderProfile, audio: bytes, mime_type: str, *,
                          mode: str, language: str | None, audio_ms: int) -> SttResult:
        body: dict[str, Any] = {
            "model": route.model,
            "input_audio": {"data": base64.b64encode(audio).decode("ascii"), "format": _FORMAT.get(mime_type, "webm")},
            "response_format": "json" if mode == "json" else "verbose_json",
        }
        if mode != "json":
            body["timestamp_granularities"] = ["segment", "word"]
        if mode == "diarize":
            body["diarize"] = True
        if language:
            body["language"] = language
        payload = await self._post(route, profile, json_body=body)
        return parse_transcription(payload, response_format=body["response_format"], audio_ms=audio_ms,
                                   details={"diarize_requested": mode == "diarize"})

    async def _multipart(self, route: SttRoute, profile: ProviderProfile, audio: bytes, mime_type: str, *,
                         response_format: str, language: str | None, extra: dict[str, str], audio_ms: int) -> SttResult:
        data = {"model": route.model, "response_format": response_format, **extra}
        if language:
            data["language"] = language
        files = {"file": (f"meeting.{_EXTENSION.get(mime_type, 'webm')}", audio, mime_type)}
        payload = await self._post(route, profile, data=data, files=files)
        return parse_transcription(payload, response_format=response_format, audio_ms=audio_ms,
                                   details={"diarize_requested": response_format == "diarized_json"})

    async def _post(self, route: SttRoute, profile: ProviderProfile, *, json_body: dict | None = None,
                    data: dict | None = None, files: dict | None = None) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {profile.api_key}"} if profile.api_key else {}
        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS, transport=self.transport) as client:
                response = await client.post(route.endpoint, headers=headers, json=json_body, data=data, files=files)
        except httpx.TimeoutException as exc:
            raise SttError("the speech-to-text provider timed out", retryable=True) from exc
        except httpx.RequestError as exc:
            raise SttError("the speech-to-text provider is unavailable", retryable=True) from exc
        if response.is_error:
            raise SttError(_provider_error(response), retryable=response.status_code in {408, 429, 500, 502, 503, 504},
                           status_code=response.status_code)
        try:
            payload = response.json()
        except ValueError as exc:
            raise SttError("the speech-to-text provider returned an unreadable response") from exc
        if not isinstance(payload, dict):
            raise SttError("the speech-to-text provider returned an unexpected response")
        return payload

    # ----- usage ledger --------------------------------------------------------------------------
    def _record_success(self, profile: ProviderProfile, route: SttRoute, result: SttResult, *, purpose: str,
                        meeting_id: UUID, audio_ms: int, started: float, part: int | None) -> None:
        ledger = getattr(self.providers, "usage", None)
        seconds = result.audio_seconds if result.audio_seconds is not None else audio_ms / 1000
        if ledger is not None:
            estimated, source = result.cost_usd, "provider_reported_cost" if result.cost_usd is not None else None
            if estimated is None:
                rate = ledger.stt_price(profile.provider_type.value, route.host, route.model)
                if rate is not None:
                    estimated, source = round(seconds / 60 * rate[0], 8), f"{rate[1]}_x_audio"
            ledger.record_event(
                kind="transcription", purpose=purpose, provider=profile.provider_type.value, model=route.model,
                units=round(seconds, 3), unit_type="audio_seconds", estimated_usd=estimated, price_source=source,
                duration_ms=int((time.monotonic() - started) * 1000), meeting_id=meeting_id,
                details={"profile_id": str(profile.id), "profile_name": profile.name, "endpoint_host": route.host,
                         "execution_location": profile.execution_location.value, "request_type": "in_person_stt",
                         "response_format": result.response_format, "diarized": result.diarized,
                         "part": part, **result.details},
            )
        record_key_use = getattr(self.providers, "_record_key_use", None)
        if record_key_use is not None:
            record_key_use(profile)

    def _record_failure(self, profile: ProviderProfile, metadata: dict[str, Any], error: Exception, started: float) -> None:
        record = getattr(self.providers, "_record_failure", None)
        if record is not None:
            record(profile, metadata, "transcription", Capability.TRANSCRIPTION, error, started)


def _provider_error(response: httpx.Response) -> str:
    status = response.status_code
    if status in {401, 403}:
        return "the speech-to-text provider rejected the API key; check the Speech to text profile in AI providers"
    if status == 402:
        return "the speech-to-text provider account is out of credit"
    if status == 413:
        return "the audio part was too large for the speech-to-text provider"
    if status == 429:
        return "the speech-to-text provider is rate limiting requests; it will be retried"
    try:
        raw = response.json()
        detail = raw.get("error", raw) if isinstance(raw, dict) else raw
        if isinstance(detail, dict):
            detail = detail.get("message") or detail
    except ValueError:
        detail = ""
    return f"speech-to-text request failed ({status}){': ' + str(detail)[:300] if detail else ''}"


# ----- response parsing ------------------------------------------------------------------------------
def parse_transcription(payload: dict[str, Any], *, response_format: str, audio_ms: int,
                        details: dict[str, Any] | None = None) -> SttResult:
    """Normalize OpenRouter verbose_json, OpenAI diarized_json / verbose_json / json into segments."""
    text = str(payload.get("text") or "").strip()
    labels: dict[str, str] = {}
    segments = _segments(payload.get("segments"), labels)
    if segments and all(item.speaker is None for item in segments):
        from_words = _segments_from_words(payload.get("words"), labels)
        if from_words:
            segments = from_words
    elif not segments:
        segments = _segments_from_words(payload.get("words"), labels)
    estimated = False
    if not segments and text:
        segments, estimated = _estimated_segments(text, audio_ms), True
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    seconds = _number(usage.get("seconds")) or _number(payload.get("duration"))
    return SttResult(
        segments=tuple(segments), text=text or " ".join(item.text for item in segments),
        audio_seconds=seconds, cost_usd=_number(usage.get("cost")),
        diarized=any(item.speaker is not None for item in segments), response_format=response_format,
        estimated_times=estimated, details=dict(details or {}),
    )


def _label(raw: object, labels: dict[str, str]) -> str | None:
    """Stable part-local letters (A, B, …) for the provider's speaker ids, in order of appearance."""
    if raw is None or raw == "":
        return None
    key = str(raw).strip()
    if key not in labels:
        labels[key] = _letters(len(labels))
    return labels[key]


def _letters(index: int) -> str:
    name = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


def _segments(raw: object, labels: dict[str, str]) -> list[RawSegment]:
    result: list[RawSegment] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        start = max(_number(item.get("start")) or 0.0, 0.0)
        end = max(_number(item.get("end")) or start, start)
        speaker = item.get("speaker_label") if item.get("speaker") is None else item.get("speaker")
        result.append(RawSegment(start, end, text, _label(speaker, labels)))
    return result


def _segments_from_words(raw: object, labels: dict[str, str]) -> list[RawSegment]:
    """Consecutive words by the same speaker become one segment (bounded length)."""
    result: list[RawSegment] = []
    words: list[str] = []
    speaker: str | None = None
    start = end = 0.0
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict) or item.get("type") == "audio_event":
            continue
        word = str(item.get("word") or "").strip()
        if not word:
            continue
        label = _label(item.get("speaker_label") if item.get("speaker") is None else item.get("speaker"), labels)
        if words and (label != speaker or len(words) >= _MAX_WORDS_PER_SEGMENT):
            result.append(RawSegment(start, end, " ".join(words), speaker))
            words = []
        if not words:
            start, speaker = max(_number(item.get("start")) or 0.0, 0.0), label
        words.append(word)
        end = max(_number(item.get("end")) or start, start)
    if words:
        result.append(RawSegment(start, end, " ".join(words), speaker))
    return result


def _estimated_segments(text: str, audio_ms: int) -> list[RawSegment]:
    """Text-only responses: one segment per sentence, timed in proportion to its length."""
    sentences = [item.strip() for item in _SENTENCE.split(text) if item.strip()] or [text]
    total = sum(len(item) for item in sentences) or 1
    seconds, cursor, result = max(audio_ms / 1000, 1.0), 0.0, []
    for sentence in sentences:
        length = seconds * len(sentence) / total
        result.append(RawSegment(round(cursor, 3), round(cursor + length, 3), sentence, None))
        cursor += length
    return result


def _number(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None
