from fastapi.testclient import TestClient

from app.main import create_app


def _app(tmp_path, monkeypatch):
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "owner-password-for-test")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", "developer@genaiprotos.com")
    return create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'operations.db'}",
        credential_key="test-credential-key",
    )


def test_login_throttle_is_persistent_and_returns_retry_after(tmp_path, monkeypatch) -> None:
    app = _app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        for _ in range(8):
            response = client.post("/v1/auth/login", json={
                "email": "developer@genaiprotos.com", "password": "wrong-password",
            })
            assert response.status_code == 401
        blocked = client.post("/v1/auth/login", json={
            "email": "developer@genaiprotos.com", "password": "owner-password-for-test",
        })
        assert blocked.status_code == 429
        assert int(blocked.headers["Retry-After"]) > 0
    app.state.database.engine.dispose()

    restarted = _app(tmp_path, monkeypatch)
    with TestClient(restarted) as client:
        assert client.post("/v1/auth/login", json={
            "email": "developer@genaiprotos.com", "password": "owner-password-for-test",
        }).status_code == 429


def test_audit_is_scoped_and_never_stores_request_credentials(tmp_path, monkeypatch) -> None:
    app = _app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        assert client.get("/v1/workspace/audit").status_code == 401
        assert client.post("/v1/auth/login", json={
            "email": "developer@genaiprotos.com", "password": "owner-password-for-test",
        }).status_code == 200
        assert client.patch("/v1/workspace", json={"display_name": "Audited workspace"}).status_code == 200
        result = client.get("/v1/workspace/audit")
        assert result.status_code == 200
        events = result.json()
        assert [item["action"] for item in events] == ["PATCH /v1/workspace", "auth.login.succeeded"]
        assert all(item["resource_path"] in {"/v1/workspace", "/v1/auth/login"} for item in events)
        assert "owner-password-for-test" not in str(events)
