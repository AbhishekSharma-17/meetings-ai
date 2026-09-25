from fastapi.testclient import TestClient

from app.main import create_app


def test_legacy_workspace_is_private_editable_and_persistent(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "local-workspace-test-password")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "local-workspace-test-session-secret")
    database_url = f"sqlite+pysqlite:///{tmp_path / 'workspace.db'}"

    app = create_app(database_url=database_url, credential_key="test-credential-key")
    with TestClient(app) as client:
        assert client.get("/v1/workspace").status_code == 401
        assert client.get("/v1/workspace/members").status_code == 401
        assert client.post("/v1/auth/login", json={
            "password": "local-workspace-test-password",
        }).status_code == 200

        workspace = client.get("/v1/workspace").json()
        assert workspace["display_name"] == "GenAI Protos"
        assert workspace["tenant_isolation_enabled"] is True
        assert workspace["slug"] == "legacy-workspace"

        changed = client.patch("/v1/workspace", json={
            "display_name": "  Research Team  ",
            "contact_email": "  Team@Example.com  ",
        })
        assert changed.status_code == 200
        assert changed.json()["display_name"] == "Research Team"
        assert changed.json()["contact_email"] == "team@example.com"
        assert changed.json()["id"] == workspace["id"]
        assert client.get("/v1/workspace/members").json() == [{
            "user_id": "00000000-0000-4000-8000-000000000002",
            "display_name": "Workspace owner", "email": "developer@genaiprotos.com",
            "role": "owner", "status": "active",
        }]
        assert client.patch("/v1/workspace", json={
            "display_name": " ",
        }).status_code == 422
        assert client.patch("/v1/workspace", json={
            "contact_email": "not-an-email",
        }).status_code == 422
        assert client.post("/v1/workspace", json={"display_name": "Another"}).status_code == 405

    restarted = create_app(database_url=database_url, credential_key="test-credential-key")
    with TestClient(restarted) as client:
        client.post("/v1/auth/login", json={"password": "local-workspace-test-password"})
        assert client.get("/v1/workspace").json()["display_name"] == "Research Team"
        cleared = client.patch("/v1/workspace", json={"contact_email": None})
        assert cleared.json()["contact_email"] is None
