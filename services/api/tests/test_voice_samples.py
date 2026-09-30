"""Opt-in voice samples: upload validation, owner-only playback, admin visibility without audio, deletion,
membership and workspace isolation, the known-speaker request shape per model, voice-match suggestions
(never applied without approval) and the v32→v33 migration. All provider HTTP is mocked."""

from __future__ import annotations

import asyncio
import json
import re
from uuid import UUID, uuid4

import httpx
import pytest
from account_links import accept_invite
from fastapi.testclient import TestClient
from in_person_helpers import FakeOpenRouterStt, FakeTextModel, configure_providers, no_vexa, start_recording, upload, wait_for
from meetings_contracts import Capability, ExecutionLocation, ProviderProfile, ProviderType
from sqlalchemy import select, text

from app.database import Database, SchemaVersionRow, VoiceSampleRow
from app.in_person_audio import Part
from app.in_person_reconcile import GlobalSegment, reconcile
from app.in_person_stt import InPersonTranscriber, KnownSpeaker, RawSegment, SttResult, parse_transcription, route_for
from app.in_person_voice import VoiceReference, merge, pick_attendees, voice_matches, voice_suggestions
from app.main import create_app
from app.voice_samples import MAX_SAMPLE_BYTES, VoiceSampleError, VoiceSampleService, sniff_audio, validate_sample

OWNER_EMAIL, OWNER_PASSWORD = "developer@genaiprotos.com", "owner-password-for-test"
WEBM = b"\x1a\x45\xdf\xa3" + b"\x42\x86\x81\x01" + b"voice" * 200
OGG = b"OggS" + b"\x00" * 300
MP4 = b"\x00\x00\x00\x20ftypM4A " + b"\x00" * 300
WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 300


# ----- validation ---------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(("data", "content_type", "expected"), [
    (WEBM, "audio/webm;codecs=opus", "audio/webm"),
    (OGG, "audio/ogg", "audio/ogg"),
    (MP4, "audio/mp4", "audio/mp4"),
    (WAV, "audio/x-wav", "audio/wav"),
])
def test_valid_samples_are_recognised_by_their_bytes(data: bytes, content_type: str, expected: str) -> None:
    assert sniff_audio(data) == expected
    assert validate_sample(data, content_type, 7_000) == expected


@pytest.mark.parametrize(("data", "content_type", "duration", "status", "message"), [
    (b"", "audio/webm", 7_000, 422, "record a voice sample"),
    (WEBM + b"\x00" * MAX_SAMPLE_BYTES, "audio/webm", 7_000, 413, "at most 1 MB"),
    (WEBM, "video/webm", 7_000, 415, "WebM, MP4, Ogg or WAV"),
    (WEBM, "text/plain", 7_000, 415, "WebM, MP4, Ogg or WAV"),
    (OGG, "audio/webm", 7_000, 415, "does not match"),
    (b"<script>alert(1)</script>", "audio/webm", 7_000, 415, "does not match"),
    (WEBM, "audio/webm", 4_999, 422, "between 5 and 10 seconds"),
    (WEBM, "audio/webm", 10_001, 422, "between 5 and 10 seconds"),
])
def test_invalid_samples_are_rejected(data: bytes, content_type: str, duration: int, status: int, message: str) -> None:
    with pytest.raises(VoiceSampleError, match=message) as caught:
        validate_sample(data, content_type, duration)
    assert caught.value.status_code == status


# ----- API ----------------------------------------------------------------------------------------------------------
def _login(client: TestClient, email: str, password: str) -> dict:
    client.post("/v1/auth/logout")
    response = client.post("/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return client.get("/v1/auth/me").json()


def _as(client: TestClient, who: str) -> dict:
    if who == "owner":
        return _login(client, OWNER_EMAIL, OWNER_PASSWORD)
    return _login(client, f"{who}@example.com", f"{who}-password-long-enough")


def _put(client: TestClient, data: bytes = WEBM, content_type: str = "audio/webm", duration_ms: int = 7_000):
    return client.put("/v1/me/voice-sample", files={"file": ("sample.webm", data, content_type)},
                      data={"duration_ms": str(duration_ms)})


@pytest.fixture()
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER_PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "voice-sample-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER_EMAIL)
    monkeypatch.setenv("IN_PERSON_CLEANUP_ENABLED", "0")
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'voice.db'}", credential_key="test-key",
                     vexa_adapter=no_vexa())
    with TestClient(app) as client:
        _as(client, "owner")
        configure_providers(app, client, FakeOpenRouterStt(), FakeTextModel())
        invites = {key: client.post("/v1/workspace/invite", json={
            "email": f"{key}@example.com", "display_name": key.title(), "role": role}).json()
            for key, role in (("ada", "admin"), ("mo", "member"), ("vic", "viewer"))}
        ids = {}
        for key, invited in invites.items():
            client.post("/v1/auth/logout")
            ids[key] = accept_invite(client, invited, f"{key}-password-long-enough")
        yield {"app": app, "client": client}


def test_owner_records_plays_replaces_and_deletes_their_own_sample(world) -> None:
    client = world["client"]
    _as(client, "mo")
    empty = client.get("/v1/me/voice-sample").json()
    assert empty["sample"] is None and (empty["min_duration_ms"], empty["max_duration_ms"]) == (5_000, 10_000)
    assert empty["matching"]["status"] == "unsupported"  # the workspace uses OpenRouter (gemini-3.5-transcribe)
    assert "doesn't use voice samples yet" in empty["matching"]["message"]
    assert client.get("/v1/me/voice-sample/audio").status_code == 404

    saved = _put(client)
    assert saved.status_code == 200, saved.text
    assert saved.json()["sample"] | {"updated_at": None} == {
        "mime_type": "audio/webm", "duration_ms": 7_000, "byte_size": len(WEBM), "updated_at": None}
    played = client.get("/v1/me/voice-sample/audio")
    assert played.status_code == 200 and played.content == WEBM
    assert played.headers["content-type"] == "audio/webm"
    assert played.headers["cache-control"] == "no-store" and played.headers["x-content-type-options"] == "nosniff"

    assert _put(client, OGG, "audio/ogg", 9_500).json()["sample"]["mime_type"] == "audio/ogg"  # re-record replaces
    assert client.get("/v1/me/voice-sample/audio").content == OGG
    assert _put(client, OGG, "audio/webm").status_code == 415
    assert _put(client, duration_ms=12_000).status_code == 422
    too_big = client.put("/v1/me/voice-sample", content=b"x" * (2 * MAX_SAMPLE_BYTES),
                         headers={"content-type": "multipart/form-data; boundary=zz"})
    assert too_big.status_code == 413  # refused on the declared length, before the body is parsed

    def chunked():  # no Content-Length: the real byte count is enforced while reading
        for _ in range(3):
            yield b"x" * MAX_SAMPLE_BYTES
    streamed = client.put("/v1/me/voice-sample", content=chunked(),
                          headers={"content-type": "multipart/form-data; boundary=zz"})
    assert streamed.status_code == 413
    no_duration = client.put("/v1/me/voice-sample", files={"file": ("sample.webm", WEBM, "audio/webm")})
    assert no_duration.status_code == 422
    assert client.put("/v1/me/voice-sample", files={"file": ("s.webm", WEBM, "audio/webm")},
                      data={"duration_ms": "seven"}).status_code == 422

    assert client.delete("/v1/me/voice-sample").status_code == 204
    assert client.get("/v1/me/voice-sample").json()["sample"] is None
    assert client.get("/v1/me/voice-sample/audio").status_code == 404
    assert client.delete("/v1/me/voice-sample").status_code == 204  # idempotent


def test_samples_are_private_admins_see_who_has_one_but_never_the_audio(world) -> None:
    client = world["client"]
    for who in ("mo", "vic"):  # every role can opt in, viewers included
        _as(client, who)
        assert _put(client).status_code == 200
    mo = _as(client, "mo")
    assert client.get("/v1/workspace/voice-samples").status_code == 403  # members can't list

    _as(client, "ada")
    assert client.get("/v1/me/voice-sample").json()["sample"] is None  # only their own sample, never another's
    assert client.get("/v1/me/voice-sample/audio").status_code == 404
    holders = client.get("/v1/workspace/voice-samples")
    assert holders.status_code == 200
    assert [item["display_name"] for item in holders.json()] == ["Mo", "Vic"]
    assert set(holders.json()[0]) == {"user_id", "display_name", "duration_ms", "updated_at"}
    assert holders.json()[0]["user_id"] == mo["user_id"]
    # No route serves someone else's audio.
    assert client.get(f"/v1/users/{mo['user_id']}/voice-sample").status_code == 404
    _as(client, "owner")
    assert [item["display_name"] for item in client.get("/v1/workspace/voice-samples").json()] == ["Mo", "Vic"]


def test_sample_holders_come_back_in_a_stable_order_for_the_four_speaker_cap(world) -> None:
    client, app = world["client"], world["app"]
    for who in ("vic", "mo", "ada"):  # saved out of name order
        _as(client, who)
        assert _put(client).status_code == 200
    owner = _as(client, "owner")
    service = VoiceSampleService(app.state.database)
    names = [name for _, name, _ in service.identities(UUID(owner["organization_id"]))]
    assert names == ["Ada", "Mo", "Vic"]


def test_removing_a_member_deletes_their_sample(world) -> None:
    client, app = world["client"], world["app"]
    mo = _as(client, "mo")
    assert _put(client).status_code == 200
    _as(client, "owner")
    assert client.delete(f"/v1/workspace/members/{mo['user_id']}").status_code == 204
    assert client.get("/v1/workspace/voice-samples").json() == []
    with app.state.database.session_factory() as session:
        assert session.execute(select(VoiceSampleRow).where(VoiceSampleRow.user_id == mo["user_id"])).first() is None


def test_samples_never_cross_workspaces(world) -> None:
    client = world["client"]
    owner = _as(client, "owner")
    assert _put(client).status_code == 200
    first_workspace = owner["organization_id"]
    second = client.post("/v1/workspaces", json={"display_name": "Elsewhere"}).json()
    assert client.post(f"/v1/workspaces/{second['organization_id']}/switch").status_code == 200
    assert client.get("/v1/me/voice-sample").json()["sample"] is None
    assert client.get("/v1/me/voice-sample/audio").status_code == 404
    assert client.get("/v1/workspace/voice-samples").json() == []
    assert client.get("/v1/me/voice-sample").json()["matching"]["status"] == "not_configured"
    assert client.delete("/v1/me/voice-sample").status_code == 204  # deletes nothing in the first workspace
    assert client.post(f"/v1/workspaces/{first_workspace}/switch").status_code == 200
    assert client.get("/v1/me/voice-sample/audio").content == WEBM


def test_voice_sample_routes_need_a_session(world) -> None:
    client = world["client"]
    client.post("/v1/auth/logout")
    assert client.get("/v1/me/voice-sample").status_code == 401
    assert _put(client).status_code == 401


# ----- provider request shapes ----------------------------------------------------------------------------------------
def _profile(provider_type: ProviderType, model: str, base_url: str | None = None) -> ProviderProfile:
    return ProviderProfile(name="STT", provider_type=provider_type, execution_location=ExecutionLocation.CLOUD,
                           base_url=base_url, models={Capability.TRANSCRIPTION: model}, api_key="sk-test-secret")


def _fields(request: httpx.Request) -> dict[str, list[str]]:
    """Multipart form fields (not files) of a captured request."""
    body = request.content.decode("latin-1")
    found: dict[str, list[str]] = {}
    for name, value in re.findall(r'name="([^"]+)"\r\n\r\n(.*?)\r\n--', body, flags=re.S):
        found.setdefault(name, []).append(value)
    return found


KNOWN = (KnownSpeaker("person_1", "audio/webm", WEBM), KnownSpeaker("person_2", "audio/ogg", OGG))


def test_openai_diarize_request_carries_known_speaker_references() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"text": "Hello. Hi.", "duration": 9.0, "segments": [
            {"start": 0.0, "end": 4.0, "text": "Hello.", "speaker": "person_2"},
            {"start": 4.2, "end": 9.0, "text": "Hi.", "speaker": "A"},
        ]})

    transcriber = InPersonTranscriber(object(), transport=httpx.MockTransport(handler))
    profile = _profile(ProviderType.OPENAI, "gpt-4o-transcribe-diarize")
    result = asyncio.run(transcriber.transcribe(
        profile, b"webm-bytes", "audio/webm", diarize=True, language=None, purpose="in_person_transcription",
        meeting_id=uuid4(), audio_ms=9_000, known_speakers=KNOWN + (KnownSpeaker("person_3", "audio/webm", WEBM),) * 3))
    fields = _fields(seen[0])
    assert fields["response_format"] == ["diarized_json"] and fields["chunking_strategy"] == ["auto"]
    assert fields["known_speaker_names[]"] == ["person_1", "person_2", "person_3", "person_3"]  # capped at 4
    references = fields["known_speaker_references[]"]
    assert len(references) == 4 and references[0].startswith("data:audio/webm;base64,")
    assert references[1].startswith("data:audio/ogg;base64,")
    assert result.known_labels == {"A": "person_2"}  # the first label seen is "A": the provider said person_2
    assert [item.speaker for item in result.segments] == ["A", "B"]
    assert result.details["voice_references"] == 4


def test_models_without_voice_references_never_receive_them() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"text": "Hello.", "segments": [{"start": 0, "end": 1, "text": "Hello.", "speaker": 0}]})

    transcriber = InPersonTranscriber(object(), transport=httpx.MockTransport(handler))
    for profile in (_profile(ProviderType.OPENAI_COMPATIBLE, "google/gemini-3.5-transcribe", "https://openrouter.ai/api/v1"),
                    _profile(ProviderType.OPENAI, "whisper-1")):
        result = asyncio.run(transcriber.transcribe(
            profile, b"audio", "audio/webm", diarize=True, language=None, purpose="p", meeting_id=uuid4(),
            audio_ms=1_000, known_speakers=KNOWN))
        assert result.known_labels == {}
    assert all(b"known_speaker" not in request.content for request in seen)
    openrouter = json.loads(seen[0].content)
    assert not any("known" in key or "reference" in key for key in openrouter)
    # A preview (no diarization) never sends references either.
    diarize_profile = _profile(ProviderType.OPENAI, "gpt-4o-transcribe-diarize")
    asyncio.run(transcriber.transcribe(diarize_profile, b"audio", "audio/webm", diarize=False, language=None,
                                       purpose="p", meeting_id=uuid4(), audio_ms=1_000, known_speakers=KNOWN))
    assert b"known_speaker" not in seen[-1].content
    assert route_for(diarize_profile).kind == "openai_diarize"


# ----- matching -------------------------------------------------------------------------------------------------------
def test_pick_attendees_prefers_the_recorder_then_invitees_then_typed_names() -> None:
    ids = [UUID(int=index) for index in range(1, 7)]
    identities = [(ids[0], "Rae Recorder", "rae@x.test"), (ids[1], "Priya Shah", "priya@x.test"),
                  (ids[2], "Marcus Lee", "marcus@x.test"), (ids[3], "Sam One", None), (ids[4], "Sam Two", None),
                  (ids[5], "Dana Wu", "dana@x.test")]
    chosen = pick_attendees(identities, recorder_id=ids[0], expected=["Marcus", "Sam One", "Dana Wu", "Nobody"],
                            invitees=[{"name": "P. Shah", "email": "PRIYA@x.test"}])
    assert chosen == [ids[0], ids[1], ids[3], ids[5]]  # a lone first name ("Marcus") never matches; capped at 4
    assert pick_attendees(identities, recorder_id=uuid4(), expected=[], invitees=[]) == []


def _ref(key: str, name: str) -> VoiceReference:
    return VoiceReference(KnownSpeaker(key, "audio/webm", WEBM), uuid4(), name)


def test_voice_matches_map_each_label_to_one_person() -> None:
    refs = [_ref("person_1", "Priya Shah"), _ref("person_2", "Marcus Lee")]
    segments = [GlobalSegment(0, 5, "a", "A", "person_1"), GlobalSegment(5, 6, "b", "B", "person_1"),
                GlobalSegment(6, 9, "c", "B", None), GlobalSegment(9, 12, "d", "C", "person_2"),
                GlobalSegment(12, 13, "e", "C", "unknown")]
    matches = voice_matches(segments, refs)
    assert {label: ref.display_name for label, ref in matches.items()} == {"A": "Priya Shah", "C": "Marcus Lee"}


def test_known_speakers_keep_one_label_across_parts() -> None:
    first = Part(index=0, seqs=(0, 1), start_ms=0, duration_ms=20_000, overlap_ms=0, stream_first_seq=0)
    second = Part(index=1, seqs=(5, 6), start_ms=60_000, duration_ms=20_000, overlap_ms=0, stream_first_seq=5)

    def result(segments, known):
        return SttResult(segments=tuple(segments), text="", audio_seconds=None, cost_usd=None, diarized=True,
                         response_format="diarized_json", known_labels=known)

    parts = [(first, result([RawSegment(0, 5, "one", "A"), RawSegment(5, 9, "two", "B")], {"B": "person_1"})),
             (second, result([RawSegment(0, 4, "three", "A"), RawSegment(4, 8, "four", "B")], {"A": "person_1"}))]
    merged = asyncio.run(reconcile(parts, providers=None, meeting_id=uuid4()))
    assert [(item.text, item.label, item.known) for item in merged] == [
        ("one", "A", None), ("two", "B", "person_1"), ("three", "B", "person_1"), ("four", "C", None)]


class _Line:
    def __init__(self, speaker: str, text_: str, start: float) -> None:
        self.raw_speaker, self.text, self.start_seconds = speaker, text_, start


def test_voice_suggestions_have_voice_evidence_and_merge_with_transcript_names() -> None:
    transcript = [_Line("Speaker A", "Morning all, let's start.", 0.0), _Line("Speaker B", "Budget first.", 4.5),
                  _Line("Speaker A", "Agreed.", 8.0)]
    voice = voice_suggestions({"A": _ref("person_1", "Priya Shah"), "Z": _ref("person_2", "Ghost")}, transcript)
    assert voice == [{"speaker": "Speaker A", "name": "Priya Shah", "confidence": "medium",
                      "reason": "Matched Priya Shah's saved voice sample",
                      "evidence": [{"quote": "Morning all, let's start.", "at_seconds": 0.0, "kind": "voice_sample"}],
                      "state": "suggested"}]
    spoken = [{"speaker": "Speaker A", "name": "Priya Shah", "confidence": "medium", "reason": "Called Priya",
               "evidence": [{"quote": "Thanks, Priya", "at_seconds": 3, "kind": "addressed"}], "state": "suggested"},
              {"speaker": "Speaker B", "name": "priya shah", "confidence": "low", "reason": "r", "evidence": [], "state": "suggested"}]
    merged = merge(spoken, voice)
    assert [item["speaker"] for item in merged] == ["Speaker A"]  # one name, one voice
    assert merged[0]["confidence"] == "high"
    assert [item["kind"] for item in merged[0]["evidence"]] == ["voice_sample", "addressed"]
    disagree = merge([{**spoken[0], "name": "Dana"}], voice)
    assert disagree[0]["name"] == "Priya Shah" and disagree[0]["confidence"] == "medium"


# ----- final pass end to end ----------------------------------------------------------------------------------------
class FakeOpenAIDiarize:
    """gpt-4o-transcribe-diarize: previews get text; the final pass labels the matched voice person_1."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        assert request.url.host == "api.openai.com"
        self.requests.append(request)
        fields = _fields(request)
        if fields["response_format"] == ["json"]:
            return httpx.Response(200, json={"text": "preview"})
        known = fields.get("known_speaker_names[]", [])
        first = known[0] if known else "A"
        return httpx.Response(200, json={"text": "…", "duration": 12.0, "segments": [
            {"start": 0.0, "end": 4.0, "text": "Morning, let's review the pilot.", "speaker": first},
            {"start": 4.2, "end": 8.0, "text": "The budget looks fine to me.", "speaker": "B"},
            {"start": 8.1, "end": 12.0, "text": "Great, we ship in October.", "speaker": first},
        ], "usage": {"type": "duration", "seconds": 12}})


def _use_openai_diarize(app, client: TestClient) -> FakeOpenAIDiarize:
    fake = FakeOpenAIDiarize()
    app.state.in_person.transcriber.transport = httpx.MockTransport(fake.handle)
    profile = client.post("/v1/provider-profiles", json={
        "name": "OpenAI diarize", "provider_type": "openai", "execution_location": "cloud", "api_key": "sk-diarize",
        "capabilities": [{"capability": "transcription", "model": "gpt-4o-transcribe-diarize"}],
    })
    assert profile.status_code == 201, profile.text
    assert client.put("/v1/provider-defaults/transcription", json={
        "policy": "cloud_only", "cloud_profile_id": profile.json()["id"]}).status_code == 200
    return fake


def _record_and_finish(client: TestClient, **overrides) -> str:
    meeting_id = start_recording(client, **overrides)["meeting_id"]
    assert upload(client, meeting_id, 0).status_code == 200
    assert client.post(f"/v1/in-person/meetings/{meeting_id}/stop", json={"final_seq": 0}).status_code == 200
    assert wait_for(client, meeting_id, {"done", "failed"})["status"] == "done"
    return meeting_id


def test_final_pass_sends_attendee_samples_and_suggests_the_matched_name(world) -> None:
    client, app = world["client"], world["app"]
    _as(client, "mo")
    assert _put(client).status_code == 200
    _as(client, "vic")
    assert _put(client, OGG, "audio/ogg").status_code == 200  # not expected at this meeting: never sent
    owner = _as(client, "owner")
    fake = _use_openai_diarize(app, client)
    assert client.get("/v1/me/voice-sample").json()["matching"]["status"] == "available"
    assert _put(client, WAV, "audio/wav", 6_000).status_code == 200

    meeting_id = _record_and_finish(client, expected_people=["Mo"])
    final = [_fields(request) for request in fake.requests if _fields(request)["response_format"] == ["diarized_json"]]
    assert len(final) == 1
    assert final[0]["known_speaker_names[]"] == ["person_1", "person_2"]  # the recorder first, then Mo
    references = final[0]["known_speaker_references[]"]
    assert references[0].startswith("data:audio/wav;base64,") and references[1].startswith("data:audio/webm;base64,")
    assert all("Mo" not in name and owner["display_name"] not in name for name in final[0]["known_speaker_names[]"])

    view = client.get(f"/v1/in-person/meetings/{meeting_id}/speaker-names").json()
    rows = {row["speaker"]: row for row in view["speakers"]}
    matched = rows["Speaker A"]
    assert matched["state"] == "suggested" and matched["current_name"] is None
    assert matched["suggestion"]["name"] == owner["display_name"]
    assert matched["suggestion"]["evidence"][0] == {"quote": "Morning, let's review the pilot.", "at_seconds": 0.0,
                                                    "kind": "voice_sample"}
    transcript = client.get(f"/v1/meetings/{meeting_id}/transcript").json()["segments"]
    assert {item["speaker"] for item in transcript} == {"Speaker A", "Speaker B"}  # nothing applied until approved
    with app.state.database.session_factory() as session:
        from app.database import UsageEventRow
        event = session.execute(select(UsageEventRow).where(UsageEventRow.purpose == "in_person_transcription")).scalar_one()
    assert event.details["voice_references"] == 2 and "person_1" not in json.dumps(event.details)

    # Refreshing the text-model suggestions keeps the voice match (the audio is gone by then).
    refreshed = client.post(f"/v1/in-person/meetings/{meeting_id}/speaker-names/refresh")
    assert refreshed.status_code == 200, refreshed.text
    again = {row["speaker"]: row for row in refreshed.json()["speakers"]}["Speaker A"]
    assert any(item["kind"] == "voice_sample" for item in again["suggestion"]["evidence"])


def test_openrouter_final_pass_sends_no_samples(world) -> None:
    client, app = world["client"], world["app"]
    _as(client, "owner")
    assert _put(client).status_code == 200
    stt = FakeOpenRouterStt()
    app.state.in_person.transcriber.transport = stt.transport()
    meeting_id = _record_and_finish(client)
    final = [body for body in stt.requests if body.get("diarize")]
    assert final and all(not any("known" in key or "reference" in key for key in body) for body in final)
    view = client.get(f"/v1/in-person/meetings/{meeting_id}/speaker-names").json()
    evidence = [item["kind"] for row in view["speakers"] if row["suggestion"] for item in row["suggestion"]["evidence"]]
    assert "voice_sample" not in evidence


# ----- migration ------------------------------------------------------------------------------------------------------
def test_v32_database_upgrades_to_v33_with_voice_samples(tmp_path) -> None:
    url = f"sqlite+pysqlite:///{tmp_path / 'upgrade.db'}"
    database = Database(url)
    database.migrate()
    with database.engine.begin() as connection:
        connection.execute(text("DROP TABLE voice_samples"))
        connection.execute(text("DELETE FROM schema_version WHERE version >= 33"))
    database.engine.dispose()
    upgraded = Database(url)
    upgraded.migrate()
    with upgraded.session_factory() as session:
        assert max(session.execute(select(SchemaVersionRow.version)).scalars().all()) == Database.SCHEMA_VERSION >= 33
    with upgraded.engine.connect() as connection:
        columns = {column["name"] for column in __import__("sqlalchemy").inspect(connection).get_columns("voice_samples")}
    assert columns == {"organization_id", "user_id", "mime_type", "bytes", "byte_size", "duration_ms", "created_at", "updated_at"}
    upgraded.engine.dispose()
