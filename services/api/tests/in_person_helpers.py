"""Shared fakes for in-person recording tests: OpenRouter STT over a mock transport, a scripted text model."""

from __future__ import annotations

import base64
import json
import re
import time
from dataclasses import dataclass, field

import httpx
from fastapi.testclient import TestClient
from meetings_contracts import ProviderType, TextGenerationResult

from app.adapters.vexa import VexaCaptureAdapter

WEBM_HEADER = b"\x1a\x45\xdf\xa3" + b"\x42\x86\x81\x01" + b"webm-header-tracks" * 4
CLUSTER = b"\x1f\x43\xb6\x75"


def webm_chunk(seq: int, size: int = 400) -> bytes:
    body = CLUSTER + bytes([seq % 251]) * size
    return WEBM_HEADER + body if seq == 0 else body


def no_vexa() -> VexaCaptureAdapter:
    """Any Vexa call fails the test: in-person meetings must never reach it."""
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"Vexa must not be called for in-person meetings: {request.method} {request.url.path}")
    return VexaCaptureAdapter("http://vexa.test", transport=httpx.MockTransport(handler))


@dataclass
class FakeOpenRouterStt:
    """Records requests; preview (json) gets text, diarized (verbose_json) gets speaker-labelled segments."""

    requests: list[dict] = field(default_factory=list)
    diarized_segments: list[dict] | None = None
    reject_diarize: bool = False
    fail_status: int | None = None
    usage_cost: float | None = 0.0021

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/audio/transcriptions"
        assert request.headers["authorization"] == "Bearer stt-secret-key"
        body = json.loads(request.content)
        self.requests.append(body)
        if self.fail_status:
            return httpx.Response(self.fail_status, json={"error": {"message": "upstream said no"}})
        if body.get("diarize") and self.reject_diarize:
            return httpx.Response(400, json={"error": {"message": "model cannot diarize"}})
        if body["response_format"] == "json":
            return httpx.Response(200, json={"text": "we should ship the pilot", "usage": {"seconds": 15, "cost": 0.0001}})
        segments = self.diarized_segments if self.diarized_segments is not None else [
            {"id": 0, "start": 0.0, "end": 3.0, "text": "Hi everyone, I'm Priya from product.", "speaker": 0},
            {"id": 1, "start": 3.2, "end": 6.0, "text": "Thanks, Priya. Marcus here, finance.", "speaker": 1},
            {"id": 2, "start": 6.1, "end": 9.5, "text": "Let's ship the pilot in October.", "speaker": 0},
        ]
        if not body.get("diarize"):
            segments = [{key: value for key, value in item.items() if key != "speaker"} for item in segments]
        return httpx.Response(200, json={
            "text": " ".join(item["text"] for item in segments), "duration": 30.0, "segments": segments,
            "usage": {"seconds": 30.0, **({"cost": self.usage_cost} if self.usage_cost is not None else {})},
        })

    def audio(self, index: int) -> bytes:
        return base64.b64decode(self.requests[index]["input_audio"]["data"])


class FakeTextModel:
    """Answers the naming, continuity and minutes prompts by purpose."""

    def __init__(self, naming: dict | None = None, continuity: dict | None = None) -> None:
        self.requests: list = []
        self.naming = naming
        self.continuity = continuity

    async def generate_text(self, profile, request):
        self.requests.append(request)
        purpose = request.metadata.get("purpose")
        if purpose == "in_person_speaker_naming":
            payload = self.naming if self.naming is not None else {"speakers": [
                {"speaker": "Speaker A", "name": "Priya Shah", "confidence": "high", "reason": "Introduces herself",
                 "evidence": [{"quote": "I'm Priya from product", "at_seconds": 0, "kind": "self_introduction"}]},
                {"speaker": "Speaker B", "name": "Marcus", "confidence": "medium", "reason": "Says his name",
                 "evidence": [{"quote": "Marcus here", "at_seconds": 3, "kind": "self_introduction"}]},
            ]}
        elif purpose == "in_person_speaker_continuity":
            payload = self.continuity or {"mappings": []}
        else:
            speakers: dict[str, list[str]] = {}
            for segment_id, speaker in re.findall(r"ID=([^\n]+)\n(?:TIME=[^\n]*\n)?SPEAKER=([^\n]+)", request.prompt):
                speakers.setdefault(speaker, []).append(segment_id)
            assert speakers  # the minutes prompt carries the saved transcript lines
            payload = {"title": "Pilot planning", "executive_summary": "The pilot ships in October.",
                       "discussion_points": ["Pilot timing"], "decisions": ["Ship in October"], "action_items": [],
                       "open_questions": [], "questions_asked": [],
                       "speaker_contributions": [{"speaker": name, "summary": "Discussed the pilot.",
                                                  "evidence_segment_ids": ids[:3]} for name, ids in speakers.items()]}
        return TextGenerationResult(text=json.dumps(payload), structured_output=payload, provider="fake",
                                    model="fake-text", input_tokens=100, output_tokens=50)


def configure_providers(app, client: TestClient, stt: FakeOpenRouterStt, text: FakeTextModel) -> None:
    app.state.profile_service.adapters[ProviderType.OPENAI] = text
    app.state.in_person.transcriber.transport = stt.transport()
    app.state.in_person_finalizer.retry_delays = (0.0,)
    stt_profile = client.post("/v1/provider-profiles", json={
        "name": "OpenRouter STT", "provider_type": "openai_compatible", "execution_location": "cloud",
        "base_url": "https://openrouter.ai/api/v1", "api_key": "stt-secret-key",
        "capabilities": [{"capability": "transcription", "model": "google/gemini-3.5-transcribe"}],
    })
    assert stt_profile.status_code == 201, stt_profile.text
    assert client.put("/v1/provider-defaults/transcription", json={
        "policy": "cloud_only", "cloud_profile_id": stt_profile.json()["id"]}).status_code == 200
    text_profile = client.post("/v1/provider-profiles", json={
        "name": "Text", "provider_type": "openai", "execution_location": "cloud", "api_key": "text-key",
        "capabilities": [{"capability": "text_generation", "model": "gpt-6-luna"}],
    }).json()
    assert client.put("/v1/provider-defaults/text_generation", json={
        "policy": "cloud_only", "cloud_profile_id": text_profile["id"]}).status_code == 200


def start_recording(client: TestClient, **overrides) -> dict:
    body = {"title": "Pilot planning", "device": "phone", "mime_type": "audio/webm;codecs=opus",
            "consent": {"everyone_agreed": True, "notice_shown": True}, **overrides}
    response = client.post("/v1/in-person/meetings", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def upload(client: TestClient, meeting_id: str, seq: int, data: bytes | None = None, *, duration_ms: int = 15_000,
           content_type: str = "audio/webm;codecs=opus", stream_start: int = 0):
    return client.post(f"/v1/in-person/meetings/{meeting_id}/chunks",
                       params={"seq": seq, "duration_ms": duration_ms, "stream_start": stream_start},
                       content=data if data is not None else webm_chunk(seq), headers={"content-type": content_type})


def wait_for(client: TestClient, meeting_id: str, statuses: set[str], timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        session = client.get(f"/v1/in-person/meetings/{meeting_id}").json()
        if session["status"] in statuses:
            return session
        time.sleep(0.05)
    raise AssertionError(f"session never reached {statuses}: {session}")
