import json
import asyncio

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
        assert transcript.json()["segments"][0] == {
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
