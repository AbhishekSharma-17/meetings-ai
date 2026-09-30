"""In-person speech-to-text: provider request shapes, response parsing, audio framing, long-recording parts,
speaker reconciliation across parts, speaker-name validation and the v30 migration. All HTTP is mocked."""

from __future__ import annotations

import asyncio
import json
import struct
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from in_person_helpers import (
    CLUSTER,
    WEBM_HEADER,
    FakeOpenRouterStt,
    FakeTextModel,
    configure_providers,
    no_vexa,
    start_recording,
    upload,
    wait_for,
    webm_chunk,
)
from meetings_contracts import Capability, ExecutionLocation, MeetingTranscriptSegment, ProviderProfile, ProviderType
from sqlalchemy import select, text

from app.database import Database, SchemaVersionRow
from app.in_person_audio import aligned, plan_parts, standalone, stream_header
from app.in_person_naming import validate_suggestions
from app.in_person_store import ChunkMeta
from app.in_person_stt import InPersonTranscriber, SttError, parse_transcription, route_for
from app.main import create_app


def _profile(provider_type: ProviderType, model: str, base_url: str | None = None) -> ProviderProfile:
    return ProviderProfile(name="STT", provider_type=provider_type, execution_location=ExecutionLocation.CLOUD,
                           base_url=base_url, models={Capability.TRANSCRIPTION: model}, api_key="sk-test-secret")


class _Ledger:
    def __init__(self) -> None:
        self.events: list[dict] = []

    def stt_price(self, provider, host, model):
        return (0.006, "openai_stt_list_price") if host == "api.openai.com" else None

    def record_event(self, **event) -> None:
        self.events.append(event)


class _Providers:
    def __init__(self) -> None:
        self.usage = _Ledger()
        self.failures: list = []

    def _record_failure(self, profile, metadata, kind, capability, error, started) -> None:
        self.failures.append((metadata, kind, type(error).__name__))


# ----- request shapes ---------------------------------------------------------------------------------------
def test_openai_diarize_request_is_multipart_diarized_json_with_auto_chunking() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"task": "transcribe", "duration": 27.4, "text": "Hello. Hi there.", "segments": [
            {"type": "transcript.text.segment", "id": "seg_001", "start": 0.0, "end": 4.7, "text": "Hello.", "speaker": "agent"},
            {"type": "transcript.text.segment", "id": "seg_002", "start": 4.9, "end": 7.0, "text": "Hi there.", "speaker": "B"},
        ], "usage": {"type": "duration", "seconds": 27}})

    providers = _Providers()
    transcriber = InPersonTranscriber(providers, transport=httpx.MockTransport(handler))
    profile = _profile(ProviderType.OPENAI, "gpt-4o-transcribe-diarize")
    route = route_for(profile)
    assert (route.kind, route.endpoint, route.max_part_bytes) == (
        "openai_diarize", "https://api.openai.com/v1/audio/transcriptions", 24 * 1024 * 1024)
    result = asyncio.run(transcriber.transcribe(profile, b"webm-bytes", "audio/webm", diarize=True, language="en",
                                                purpose="in_person_transcription", meeting_id=uuid4(), audio_ms=27_400))
    request = seen[0]
    assert request.headers["authorization"] == "Bearer sk-test-secret"
    assert request.headers["content-type"].startswith("multipart/form-data")
    body = request.content.decode(errors="replace")
    for name, value in (("model", "gpt-4o-transcribe-diarize"), ("response_format", "diarized_json"),
                        ("chunking_strategy", "auto"), ("language", "en")):
        assert f'name="{name}"\r\n\r\n{value}\r\n' in body
    assert 'name="file"; filename="meeting.webm"' in body and "webm-bytes" in body
    assert [(item.speaker, item.text) for item in result.segments] == [("A", "Hello."), ("B", "Hi there.")]
    assert result.diarized and result.audio_seconds == 27
    event = providers.usage.events[0]
    assert event["kind"] == "transcription" and event["purpose"] == "in_person_transcription"
    assert event["units"] == 27 and event["estimated_usd"] == round(27 / 60 * 0.006, 8)
    assert event["price_source"] == "openai_stt_list_price_x_audio"


def test_openrouter_request_shape_and_fallback_when_diarization_is_rejected() -> None:
    stt = FakeOpenRouterStt(reject_diarize=True)
    providers = _Providers()
    transcriber = InPersonTranscriber(providers, transport=stt.transport())
    profile = _profile(ProviderType.OPENAI_COMPATIBLE, "google/gemini-3.5-transcribe", "https://openrouter.ai/api/v1")
    profile.api_key = "stt-secret-key"
    result = asyncio.run(transcriber.transcribe(profile, b"\x00\x01audio", "audio/mp4", diarize=True, language=None,
                                                purpose="in_person_transcription", meeting_id=uuid4(), audio_ms=9_000))
    first, second = stt.requests
    assert first == {"model": "google/gemini-3.5-transcribe",
                     "input_audio": {"data": "AAFhdWRpbw==", "format": "m4a"}, "response_format": "verbose_json",
                     "timestamp_granularities": ["segment", "word"], "diarize": True}
    assert "diarize" not in second and second["response_format"] == "verbose_json"
    assert not result.diarized and len(result.segments) == 3


def test_provider_errors_are_safe_and_retryable_errors_are_marked() -> None:
    for status, fragment, retryable in ((401, "rejected the API key", False), (402, "out of credit", False),
                                        (429, "rate limiting", True), (503, "(503)", True)):
        transcriber = InPersonTranscriber(_Providers(), transport=httpx.MockTransport(
            lambda request, status=status: httpx.Response(status, json={"error": {"message": "sk-test-secret leaked?"}})))
        profile = _profile(ProviderType.OPENAI, "whisper-1")
        with pytest.raises(SttError) as caught:
            asyncio.run(transcriber.transcribe(profile, b"a", "audio/webm", diarize=False, language=None,
                                               purpose="in_person_live_preview", meeting_id=uuid4(), audio_ms=1000))
        assert fragment in str(caught.value) and caught.value.retryable is retryable
        if status in {401, 402, 429}:
            assert "sk-test-secret" not in str(caught.value)


def test_vexa_native_profiles_cannot_transcribe_uploaded_audio() -> None:
    with pytest.raises(SttError, match="choose an OpenAI or OpenRouter"):
        route_for(_profile(ProviderType.VEXA_NATIVE, "whisper", "http://vexa.local"))


# ----- parsing -------------------------------------------------------------------------------------------------
def test_words_with_speakers_become_segments_and_text_only_is_timed_by_sentence() -> None:
    words = parse_transcription({"text": "Hi there Ok", "segments": [{"id": 0, "start": 0, "end": 2, "text": "Hi there Ok"}],
                                 "words": [{"word": "Hi", "start": 0, "end": 0.3, "speaker_label": "speaker_0"},
                                           {"word": "there", "start": 0.3, "end": 0.6, "speaker_label": "speaker_0"},
                                           {"word": "(laughs)", "start": 0.6, "end": 0.9, "type": "audio_event"},
                                           {"word": "Ok", "start": 1.0, "end": 1.2, "speaker_label": "speaker_1"}]},
                                response_format="verbose_json", audio_ms=2000)
    assert [(item.speaker, item.text, item.start) for item in words.segments] == [("A", "Hi there", 0.0), ("B", "Ok", 1.0)]
    plain = parse_transcription({"text": "First sentence here. Second one!"}, response_format="json", audio_ms=10_000)
    assert plain.estimated_times and not plain.diarized
    # 20 of 31 characters come first, so the second sentence starts 20/31 of the way through 10 s.
    assert [(item.text, item.start) for item in plain.segments] == [("First sentence here.", 0.0), ("Second one!", 6.452)]
    assert plain.segments[-1].end == pytest.approx(10.0)


# ----- audio framing and parts ---------------------------------------------------------------------------------------
def test_webm_mp4_and_ogg_framing() -> None:
    assert stream_header("audio/webm", webm_chunk(0)) == WEBM_HEADER
    assert aligned("audio/webm", b"tail-of-cluster" + webm_chunk(3)) == webm_chunk(3)
    assert standalone("audio/webm", WEBM_HEADER, [webm_chunk(4), webm_chunk(5)], starts_stream=False) == (
        WEBM_HEADER + webm_chunk(4) + webm_chunk(5))
    assert standalone("audio/webm", None, [webm_chunk(4)], starts_stream=False) is None

    def box(kind: bytes, payload: bytes = b"") -> bytes:
        return struct.pack(">I", 8 + len(payload)) + kind + payload

    moof = box(b"moof", box(b"mfhd", b"\x00" * 8))
    first = box(b"ftyp", b"iso6") + box(b"moov", b"trak") + moof + box(b"mdat", b"aac")
    assert stream_header("audio/mp4", first) == box(b"ftyp", b"iso6") + box(b"moov", b"trak")
    later = b"xxmoofxx" + moof + box(b"mdat", b"more")  # a stray 'moof' in data is not a box
    assert aligned("audio/mp4", later) == moof + box(b"mdat", b"more")

    def page(granule: int, body: bytes) -> bytes:
        return b"OggS" + b"\x00\x02" + struct.pack("<q", granule) + b"\x00" * 12 + bytes([1, len(body)]) + body

    ogg = page(0, b"OpusHead") + page(0, b"OpusTags") + page(960, b"audio")
    assert stream_header("audio/ogg", ogg) == page(0, b"OpusHead") + page(0, b"OpusTags")


def _meta(durations: list[int], stream_starts: set[int] | None = None) -> list[ChunkMeta]:
    offset, result = 0, []
    for seq, duration in enumerate(durations):
        result.append(ChunkMeta(seq=seq, byte_size=1000, duration_ms=duration,
                                stream_start=seq == 0 or seq in (stream_starts or set()), start_ms=offset))
        offset += duration
    return result


def test_parts_respect_limits_overlap_by_one_chunk_and_restart_at_new_streams() -> None:
    parts = plan_parts(_meta([15_000] * 10), max_bytes=10**9, max_ms=60_000, header_bytes=0)
    assert [part.seqs for part in parts] == [(0, 1, 2, 3), (3, 4, 5, 6), (6, 7, 8, 9)]
    assert [(part.start_ms, part.overlap_ms) for part in parts] == [(0, 0), (45_000, 15_000), (90_000, 15_000)]
    by_bytes = plan_parts(_meta([15_000] * 4), max_bytes=2500, max_ms=10**9, header_bytes=0)
    assert [part.seqs for part in by_bytes] == [(0, 1), (1, 2), (2, 3)]
    reloaded = plan_parts(_meta([15_000] * 5, stream_starts={3}), max_bytes=10**9, max_ms=10**9, header_bytes=0)
    assert [(part.seqs, part.stream_first_seq, part.overlap_ms) for part in reloaded] == [((0, 1, 2), 0, 0), ((3, 4), 3, 0)]
    one_hour = plan_parts(_meta([15_000] * 240), max_bytes=20 * 1024 * 1024, max_ms=600_000)
    assert len(one_hour) == 7 and all(part.duration_ms <= 600_000 for part in one_hour)


# ----- split and reconcile (end to end through the API) ------------------------------------------------------------
def test_long_recording_is_split_and_speakers_are_reconciled_across_parts(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("IN_PERSON_CLEANUP_ENABLED", "0")
    monkeypatch.setenv("IN_PERSON_STT_PART_SECONDS", "60")
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'split.db'}", credential_key="k", vexa_adapter=no_vexa())
    stt = FakeOpenRouterStt()
    text_model = FakeTextModel(continuity={"mappings": [{"label": "new-B", "same_as": "Speaker B"}]})

    def diarized(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["response_format"] == "json":
            return httpx.Response(200, json={"text": ""})
        stt.requests.append(body)
        second = len([item for item in stt.requests if item.get("diarize")]) == 2
        segments = [  # part 2 starts 45 s in; its "speaker 7" is part 1's A (same words in the overlap)
            {"id": 0, "start": 0.0, "end": 13.0, "text": "and that is why the pilot matters", "speaker": 7},
            {"id": 1, "start": 14.0, "end": 30.0, "text": "I agree, Priya, let's budget for it", "speaker": 3},
        ] if second else [
            {"id": 0, "start": 0.0, "end": 20.0, "text": "Welcome, I'm Priya", "speaker": 0},
            {"id": 1, "start": 20.0, "end": 40.0, "text": "Marcus here, from finance", "speaker": 1},
            {"id": 2, "start": 40.0, "end": 58.0, "text": "and that is why the pilot matters", "speaker": 0},
        ]
        return httpx.Response(200, json={"text": "x", "segments": segments, "usage": {"seconds": 60}})

    with TestClient(app) as client:
        configure_providers(app, client, stt, text_model)
        app.state.in_person.transcriber.transport = httpx.MockTransport(diarized)
        meeting_id = start_recording(client)["meeting_id"]
        for seq in range(6):
            assert upload(client, meeting_id, seq).status_code == 200
        client.post(f"/v1/in-person/meetings/{meeting_id}/stop", json={"final_seq": 5})
        done = wait_for(client, meeting_id, {"done", "failed"})
        assert done["status"] == "done", done
        assert done["finalize"]["parts_total"] == 2 and done["finalize"]["parts_done"] == 2
        final = [item for item in stt.requests if item.get("diarize")]
        assert len(final) == 2
        import base64
        assert base64.b64decode(final[1]["input_audio"]["data"]) == WEBM_HEADER + b"".join(webm_chunk(seq) for seq in (3, 4, 5))
        segments = client.get(f"/v1/meetings/{meeting_id}/transcript").json()["segments"]
        assert [(item["raw_speaker"], item["start_seconds"], item["text"]) for item in segments] == [
            ("Speaker A", 0.0, "Welcome, I'm Priya"),
            ("Speaker B", 20.0, "Marcus here, from finance"),
            ("Speaker A", 40.0, "and that is why the pilot matters"),  # the overlap copy from part 2 is dropped
            ("Speaker B", 59.0, "I agree, Priya, let's budget for it"),  # mapped by the continuity check
        ]
        continuity = [item for item in text_model.requests if item.metadata["purpose"] == "in_person_speaker_continuity"]
        assert len(continuity) == 1 and "new-B" in continuity[0].prompt and "Speaker A" in continuity[0].prompt
    assert CLUSTER in webm_chunk(1)


# ----- naming validation ----------------------------------------------------------------------------------------------
def _segments() -> list[MeetingTranscriptSegment]:
    lines = [("Speaker A", 0, "Morning all, I'm Priya from product."), ("Speaker B", 5, "Thanks, Priya. Budget first?"),
             ("Speaker C", 9, "Sure, Dana can take notes."), ("Speaker B", 12, "Great.")]
    return [MeetingTranscriptSegment(segment_id=f"s{index}", start_seconds=start, end_seconds=start + 3, text=text_,
                                     speaker=label, raw_speaker=label) for index, (label, start, text_) in enumerate(lines)]


def test_naming_keeps_only_verified_evidence_and_one_name_per_voice() -> None:
    labels = ["Speaker A", "Speaker B", "Speaker C"]
    output = {"speakers": [
        {"speaker": "Speaker A", "name": "Priya Shah", "confidence": "high", "reason": "Introduces herself",
         "evidence": [{"quote": "I'm Priya from product", "at_seconds": 99, "kind": "self_introduction"}]},
        {"speaker": "Speaker B", "name": "Priya Shah", "confidence": "low", "reason": "Mentions Priya",
         "evidence": [{"quote": "Thanks, Priya", "at_seconds": 5, "kind": "addressed"}]},
        {"speaker": "Speaker C", "name": "Dana Lee", "confidence": "high", "reason": "Invitee",
         "evidence": [{"quote": "Dana can take notes", "at_seconds": 9, "kind": "invitee"}]},
        {"speaker": "Speaker Z", "name": "Ghost", "confidence": "high", "reason": "x",
         "evidence": [{"quote": "Great.", "at_seconds": 12, "kind": "self_introduction"}]},
        {"speaker": "Speaker B", "name": "Omar", "confidence": "high", "reason": "made up",
         "evidence": [{"quote": "Hello, I am Omar", "at_seconds": 1, "kind": "self_introduction"}]},
    ]}
    result = validate_suggestions(output, segments=_segments(), labels=labels, invitees=["Dana Lee"], expected=[])
    assert [(item["speaker"], item["name"], item["confidence"]) for item in result] == [
        ("Speaker A", "Priya Shah", "high"),   # quote verified; its time comes from the transcript (0 s, not 99)
        ("Speaker C", "Dana Lee", "low"),      # invitee match only: never more than low confidence
    ]
    assert result[0]["evidence"][0]["at_seconds"] == 0 and result[0]["state"] == "suggested"
    tie = validate_suggestions({"speakers": [
        {"speaker": "Speaker A", "name": "Sam", "confidence": "medium", "reason": "r",
         "evidence": [{"quote": "Morning all", "at_seconds": 0, "kind": "addressed"}]},
        {"speaker": "Speaker B", "name": "sam", "confidence": "medium", "reason": "r",
         "evidence": [{"quote": "Budget first", "at_seconds": 5, "kind": "addressed"}]},
    ]}, segments=_segments(), labels=labels, invitees=[], expected=[])
    assert tie == []
    assert validate_suggestions("not json", segments=_segments(), labels=labels, invitees=[], expected=[]) == []


# ----- migration ------------------------------------------------------------------------------------------------------
def test_v29_database_upgrades_to_v30_with_in_person_tables(tmp_path) -> None:
    url = f"sqlite+pysqlite:///{tmp_path / 'upgrade.db'}"
    database = Database(url)
    database.migrate()
    with database.engine.begin() as connection:
        connection.execute(text("DROP TABLE in_person_chunks"))
        connection.execute(text("DROP TABLE in_person_sessions"))
        # Back to a real v29 database: later versions' tables go too (v31: research profiles).
        for table in ("research_messages", "research_conversations", "research_profiles"):
            connection.execute(text(f"DROP TABLE {table}"))
        connection.execute(text("DELETE FROM schema_version WHERE version >= 30"))
    database.engine.dispose()
    upgraded = Database(url)
    upgraded.migrate()
    with upgraded.session_factory() as session:
        assert max(session.execute(select(SchemaVersionRow.version)).scalars().all()) == Database.SCHEMA_VERSION >= 30
    with upgraded.engine.connect() as connection:
        names = set(upgraded.engine.dialect.get_table_names(connection))
    assert {"in_person_sessions", "in_person_chunks"} <= names
    upgraded.engine.dispose()
