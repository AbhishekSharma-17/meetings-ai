import json
import asyncio
import hmac
import hashlib

import httpx
from fastapi.testclient import TestClient

from app.adapters.vexa import VexaCaptureAdapter
from app.main import create_app


def test_meeting_vertical_slice_with_mocked_vexa() -> None:
    requests: list[httpx.Request] = []
    transcript_available = {"value": True}

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["x-api-key"] == "test-vexa-token"
        if request.method == "POST" and request.url.path == "/bots":
            body = json.loads(request.content)
            assert body == {
                "meeting_url": "https://meet.google.com/abc-defg-hij",
                "bot_name": "Meetings AI",
                "transcribe_enabled": True,
                "recording_enabled": False,
                "language": "en",
            }
            return httpx.Response(
                201,
                json={
                    "id": 42,
                    "platform": "google_meet",
                    "native_meeting_id": "abc-defg-hij",
                    "status": "joining",
                },
            )
        if request.method == "GET" and request.url.path == "/meetings/42":
            return httpx.Response(200, json={"id": 42, "status": "active"})
        if request.method == "GET" and request.url.path == "/transcripts/by-id/42":
            if not transcript_available["value"]:
                return httpx.Response(503, json={"detail": "temporary outage"})
            return httpx.Response(
                200,
                json={
                    "id": 42,
                    "status": "active",
                    "segments": [
                        {
                            "start": 1.0,
                            "end": 2.5,
                            "text": "This is Anna.",
                            "speaker": "spk-Anna",
                            "language": "en",
                            "completed": True,
                        }
                    ],
                },
            )
        if request.method == "DELETE" and request.url.path == "/bots/google_meet/abc-defg-hij":
            return httpx.Response(200, json={"status": "stopping"})
        raise AssertionError(f"unexpected Vexa request: {request.method} {request.url.path}")

    adapter = VexaCaptureAdapter(
        "http://vexa.test:8056",
        "test-vexa-token",
        transport=httpx.MockTransport(handler),
    )
    app = create_app(
        database_url="sqlite+pysqlite:///:memory:",
        credential_key="test-encryption-key",
        vexa_adapter=adapter,
    )

    with TestClient(app) as client:
        created = client.post(
            "/v1/meetings",
            json={
                "meeting_url": "https://meet.google.com/abc-defg-hij",
                "language": "en",
            },
        )
        assert created.status_code == 201
        assert created.json()["status"] == "created"
        assert created.json()["platform"] == "google_meet"
        meeting_id = created.json()["id"]

        listed = client.get("/v1/meetings")
        assert listed.json()["count"] == 1
        assert listed.json()["items"][0]["id"] == meeting_id

        joined = client.post(f"/v1/meetings/{meeting_id}/join")
        assert joined.status_code == 200
        assert joined.json()["status"] == "joining"
        assert joined.json()["vexa_meeting_id"] == 42

        detail = client.get(f"/v1/meetings/{meeting_id}")
        assert detail.json()["vexa_meeting_id"] == 42

        refreshed = client.post(f"/v1/meetings/{meeting_id}/refresh")
        assert refreshed.status_code == 200
        assert refreshed.json()["status"] == "active"
        assert refreshed.json()["last_refreshed_at"] is not None

        transcript = client.get(f"/v1/meetings/{meeting_id}/transcript")
        assert transcript.status_code == 200
        assert transcript.json()["segment_count"] == 1
        assert {key: transcript.json()["segments"][0][key] for key in (
            "start_seconds", "end_seconds", "text", "speaker", "language", "completed"
        )} == {
            "start_seconds": 1.0,
            "end_seconds": 2.5,
            "text": "This is Anna.",
            "speaker": "spk-Anna",
            "language": "en",
            "completed": True,
        }
        transcript_available["value"] = False
        cached_transcript = client.get(f"/v1/meetings/{meeting_id}/transcript")
        assert cached_transcript.status_code == 200
        assert cached_transcript.json()["segments"] == transcript.json()["segments"]

        stopped = client.post(f"/v1/meetings/{meeting_id}/stop")
        assert stopped.status_code == 200
        assert stopped.json()["status"] == "stopping"
        # Product-level stop is idempotent even though Vexa returns 404 on redelivery.
        stopped_again = client.post(f"/v1/meetings/{meeting_id}/stop")
        assert stopped_again.status_code == 200
        assert stopped_again.json()["status"] == "stopping"

    delete_calls = [request for request in requests if request.method == "DELETE"]
    assert len(delete_calls) == 1


def test_default_stt_profile_switches_new_bot_invocation_without_browser_secret(monkeypatch) -> None:
    monkeypatch.setenv("VEXA_STT_OVERRIDE_SECRET", "local-test-signing-secret")
    spawns = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200, json={
                "status": "ok", "features": {"signed_stt_override": True},
            })
        if request.method == "GET" and request.url.path.startswith("/meetings/"):
            return httpx.Response(200, json={"status": "joining"})
        if request.url.path != "/bots":
            raise AssertionError(request.url.path)
        spawns.append(json.loads(request.content))
        return httpx.Response(201, json={
            "id": 40 + len(spawns), "platform": "google_meet",
            "native_meeting_id": "abc-defg-hij", "status": "joining",
            "data": {"stt_override_profile_id": spawns[-1]["stt_override"]["profile_id"]},
        })

    app = create_app(
        database_url="sqlite+pysqlite:///:memory:", credential_key="test-key",
        vexa_adapter=VexaCaptureAdapter(
            "http://vexa.test", transport=httpx.MockTransport(handler)
        ),
    )
    with TestClient(app) as client:
        openai = client.post("/v1/provider-profiles", json={
            "name": "OpenAI STT", "provider_type": "openai", "execution_location": "cloud",
            "capabilities": [{"capability": "transcription", "model": "gpt-4o-mini-transcribe"}],
            "api_key": "openai-secret-test",
        }).json()
        router = client.post("/v1/provider-profiles", json={
            "name": "OpenRouter STT", "provider_type": "openai_compatible",
            "execution_location": "cloud", "base_url": "https://openrouter.ai/api/v1",
            "capabilities": [{"capability": "transcription", "model": "economy-stt-test"}],
            "api_key": "router-secret-test",
        }).json()
        assert "openai-secret-test" not in json.dumps(openai)
        assert "router-secret-test" not in json.dumps(router)
        for profile, code in ((openai, "abc-defg-hij"), (router, "abc-defg-hik")):
            client.put("/v1/provider-defaults/transcription", json={
                "policy": "cloud_only", "cloud_profile_id": profile["id"],
            })
            meeting = client.post("/v1/meetings", json={
                "meeting_url": f"https://meet.google.com/{code}",
            }).json()
            assert client.get(f"/v1/meetings/{meeting['id']}/transcription-route").json()["mode"] == "pending"
            assert client.post(f"/v1/meetings/{meeting['id']}/join").status_code == 200
            assert "secret-test" not in json.dumps(client.get(f"/v1/meetings/{meeting['id']}").json())
            route = client.get(f"/v1/meetings/{meeting['id']}/transcription-route").json()
            assert route["mode"] == "profile"
            assert route["profile_id"] == profile["id"]
            assert route["model"] in {"gpt-4o-mini-transcribe", "economy-stt-test"}
            assert "secret-test" not in json.dumps(route)

    assert len(spawns) == 2
    first, second = (spawn["stt_override"] for spawn in spawns)
    assert first["url"] == "https://api.openai.com/v1/audio/transcriptions"
    assert first["model"] == "gpt-4o-mini-transcribe"
    assert first["token"] == "openai-secret-test"
    assert second["url"] == "https://openrouter.ai/api/v1/audio/transcriptions"
    assert second["model"] == "economy-stt-test"
    assert second["token"] == "router-secret-test"
    assert first["profile_id"] != second["profile_id"]
    for spawn in spawns:
        signed = spawn["stt_override"]
        claims = {key: value for key, value in signed.items() if key != "signature"}
        canonical = json.dumps(claims, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        assert signed["signature"] == hmac.new(
            b"local-test-signing-secret", canonical, hashlib.sha256
        ).hexdigest()


def test_selected_stt_profile_fails_closed_without_vexa_signing_secret(monkeypatch) -> None:
    monkeypatch.delenv("VEXA_STT_OVERRIDE_SECRET", raising=False)
    app = create_app(database_url="sqlite+pysqlite:///:memory:", credential_key="test-key")
    with TestClient(app) as client:
        profile = client.post("/v1/provider-profiles", json={
            "name": "STT", "provider_type": "openai", "execution_location": "cloud",
            "capabilities": [{"capability": "transcription", "model": "gpt-4o-mini-transcribe"}],
            "api_key": "test-only",
        }).json()
        client.put("/v1/provider-defaults/transcription", json={
            "policy": "cloud_only", "cloud_profile_id": profile["id"],
        })
        meeting = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
        }).json()
        response = client.post(f"/v1/meetings/{meeting['id']}/join")
        assert response.status_code == 409
        assert "signing secret" in response.json()["detail"]
        assert client.get(f"/v1/meetings/{meeting['id']}").json()["status"] == "created"


def test_old_vexa_cannot_silently_ignore_selected_stt_profile(monkeypatch) -> None:
    monkeypatch.setenv("VEXA_STT_OVERRIDE_SECRET", "test-signing-key")
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, json={"status": "ok", "service": "gateway"})

    app = create_app(
        database_url="sqlite+pysqlite:///:memory:", credential_key="test-key",
        vexa_adapter=VexaCaptureAdapter("http://old-vexa.test", transport=httpx.MockTransport(handler)),
    )
    with TestClient(app) as client:
        profile = client.post("/v1/provider-profiles", json={
            "name": "STT", "provider_type": "openai", "execution_location": "cloud",
            "capabilities": [{"capability": "transcription", "model": "gpt-4o-mini-transcribe"}],
            "api_key": "test-only",
        }).json()
        client.put("/v1/provider-defaults/transcription", json={
            "policy": "cloud_only", "cloud_profile_id": profile["id"],
        })
        meeting = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
        }).json()
        response = client.post(f"/v1/meetings/{meeting['id']}/join")
        assert response.status_code == 503
        assert "does not advertise" in response.json()["detail"]
        assert calls == ["/health"]  # No bot was started with the wrong STT route.


def test_vexa_missing_stt_attestation_requests_bot_stop(monkeypatch) -> None:
    monkeypatch.setenv("VEXA_STT_OVERRIDE_SECRET", "test-signing-key")
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        if request.url.path == "/health":
            return httpx.Response(200, json={
                "status": "ok", "features": {"signed_stt_override": True},
            })
        if request.method == "POST" and request.url.path == "/bots":
            return httpx.Response(201, json={
                "id": 67, "platform": "google_meet",
                "native_meeting_id": "abc-defg-hij", "status": "joining",
            })
        if request.method == "DELETE" and request.url.path == "/bots/google_meet/abc-defg-hij":
            return httpx.Response(200, json={"status": "stopping"})
        raise AssertionError(f"unexpected Vexa request: {request.method} {request.url.path}")

    app = create_app(
        database_url="sqlite+pysqlite:///:memory:", credential_key="test-key",
        vexa_adapter=VexaCaptureAdapter("http://vexa.test", transport=httpx.MockTransport(handler)),
    )
    with TestClient(app) as client:
        profile = client.post("/v1/provider-profiles", json={
            "name": "STT", "provider_type": "openai", "execution_location": "cloud",
            "capabilities": [{"capability": "transcription", "model": "gpt-4o-mini-transcribe"}],
            "api_key": "test-only",
        }).json()
        client.put("/v1/provider-defaults/transcription", json={
            "policy": "cloud_only", "cloud_profile_id": profile["id"],
        })
        meeting = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
        }).json()
        response = client.post(f"/v1/meetings/{meeting['id']}/join")
        assert response.status_code == 502
        assert "did not attest" in response.json()["detail"]
        assert client.get(f"/v1/meetings/{meeting['id']}").json()["status"] == "failed"
        assert client.get(f"/v1/meetings/{meeting['id']}/transcription-route").json()["mode"] == "pending"
        assert calls == [
            ("GET", "/health"), ("POST", "/bots"),
            ("DELETE", "/bots/google_meet/abc-defg-hij"),
        ]


def test_join_failure_is_persisted_as_failed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"detail": "transcription is not configured"})

    adapter = VexaCaptureAdapter(
        "http://vexa.test", transport=httpx.MockTransport(handler)
    )
    app = create_app(vexa_adapter=adapter, credential_key="test-key")
    with TestClient(app) as client:
        created = client.post(
            "/v1/meetings",
            json={"meeting_url": "https://meet.google.com/abc-defg-hij"},
        ).json()
        response = client.post(f"/v1/meetings/{created['id']}/join")
        assert response.status_code == 503
        detail = client.get(f"/v1/meetings/{created['id']}").json()
        assert detail["status"] == "failed"
        assert "transcription is not configured" in detail["last_error"]


def test_asynchronous_vexa_failure_reason_is_persisted() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/bots":
            return httpx.Response(
                201,
                json={
                    "id": 51,
                    "platform": "google_meet",
                    "native_meeting_id": "abc-defg-hij",
                    "status": "joining",
                },
            )
        if request.method == "GET" and request.url.path == "/meetings/51":
            return httpx.Response(
                200,
                json={
                    "id": 51,
                    "status": "failed",
                    "failure_stage": "joining",
                    "data": {
                        "reason": "browser launch failed\nMissing X server or $DISPLAY"
                    },
                },
            )
        raise AssertionError(f"unexpected Vexa request: {request.method} {request.url.path}")

    adapter = VexaCaptureAdapter(
        "http://vexa.test", transport=httpx.MockTransport(handler)
    )
    app = create_app(vexa_adapter=adapter, credential_key="test-key")
    with TestClient(app) as client:
        created = client.post(
            "/v1/meetings",
            json={"meeting_url": "https://meet.google.com/abc-defg-hij"},
        ).json()
        joined = client.post(f"/v1/meetings/{created['id']}/join")
        assert joined.status_code == 200

        refreshed = client.post(f"/v1/meetings/{created['id']}/refresh")
        assert refreshed.status_code == 200
        assert refreshed.json()["status"] == "failed"
        assert refreshed.json()["last_error"] == (
            "Vexa browser could not start because its local display server was unavailable."
        )


def test_unjoined_meeting_actions_are_conflicts() -> None:
    adapter = VexaCaptureAdapter(
        "http://vexa.test",
        transport=httpx.MockTransport(lambda request: httpx.Response(500)),
    )
    app = create_app(vexa_adapter=adapter, credential_key="test-key")
    with TestClient(app) as client:
        meeting = client.post(
            "/v1/meetings",
            json={"meeting_url": "https://meet.google.com/abc-defg-hij"},
        ).json()
        assert client.post(f"/v1/meetings/{meeting['id']}/stop").status_code == 409
        assert client.post(f"/v1/meetings/{meeting['id']}/refresh").status_code == 409
        assert client.get(f"/v1/meetings/{meeting['id']}/transcript").status_code == 409


def test_rejects_unrecognized_meeting_url() -> None:
    app = create_app(credential_key="test-key")
    with TestClient(app) as client:
        response = client.post(
            "/v1/meetings", json={"meeting_url": "https://example.com/not-a-meeting"}
        )
    assert response.status_code == 422
    assert "supported Google Meet" in response.json()["detail"]


def test_vexa_adapter_lists_meetings_and_running_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/me":
            assert request.headers["x-api-key"] == "preflight-key"
            return httpx.Response(
                200,
                json={
                    "id": 3,
                    "email": "internal@example.test",
                    "scopes": ["bot", "tx"],
                    "max_concurrent": 3,
                },
            )
        if request.url.path == "/meetings":
            return httpx.Response(200, json={"meetings": [{"id": 7, "status": "active"}]})
        if request.url.path == "/bots/status":
            # Verify compatibility with Vexa's sealed v0.10 field.
            return httpx.Response(
                200, json={"running_bots": [{"native_meeting_id": "abc-defg-hij"}]}
            )
        raise AssertionError(request.url.path)

    async def scenario() -> None:
        adapter = VexaCaptureAdapter(
            "http://vexa.test", "preflight-key", transport=httpx.MockTransport(handler)
        )
        assert (await adapter.preflight())["id"] == 3
        assert (await adapter.list_meetings())[0]["id"] == 7
        assert (await adapter.list_running_bots())[0]["native_meeting_id"] == "abc-defg-hij"
        await adapter.close()

    asyncio.run(scenario())


def test_vexa_health_is_non_mutating_and_requires_bot_and_tx_scopes() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={"user_id": 7, "scopes": ["bot", "tx", "browser"], "max_concurrent": 3},
        )

    adapter = VexaCaptureAdapter(
        "http://vexa.test", "ready-key", transport=httpx.MockTransport(handler)
    )
    app = create_app(vexa_adapter=adapter, credential_key="test-key")
    with TestClient(app) as client:
        response = client.get("/v1/integrations/vexa/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ready",
        "integration": "vexa",
        "scopes": ["bot", "tx", "browser"],
        "max_concurrent": 3,
    }
    assert [(request.method, request.url.path) for request in requests] == [
        ("GET", "/auth/me")
    ]


def test_vexa_health_preserves_missing_scope_as_403() -> None:
    adapter = VexaCaptureAdapter(
        "http://vexa.test",
        "limited-key",
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"scopes": ["bot"]})
        ),
    )
    app = create_app(vexa_adapter=adapter, credential_key="test-key")
    with TestClient(app) as client:
        response = client.get("/v1/integrations/vexa/health")

    assert response.status_code == 403
    assert "missing required scope(s): tx" in response.json()["detail"]


def test_vexa_needs_help_alias_is_persisted_as_needs_human_help() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/bots":
            return httpx.Response(
                201,
                json={
                    "id": 91,
                    "platform": "google_meet",
                    "native_meeting_id": "abc-defg-hij",
                    "status": "needs_help",
                },
            )
        raise AssertionError(request.url.path)

    adapter = VexaCaptureAdapter(
        "http://vexa.test", transport=httpx.MockTransport(handler)
    )
    app = create_app(vexa_adapter=adapter, credential_key="test-key")
    with TestClient(app) as client:
        created = client.post(
            "/v1/meetings",
            json={"meeting_url": "https://meet.google.com/abc-defg-hij"},
        ).json()
        response = client.post(f"/v1/meetings/{created['id']}/join")

    assert response.status_code == 200
    assert response.json()["status"] == "needs_human_help"
    assert response.json()["joined_at"] is None
