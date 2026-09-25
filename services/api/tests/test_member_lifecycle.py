"""Workspace membership changes take effect on existing signed sessions."""

from fastapi.testclient import TestClient

from app.database import KnowledgeBaseAccessRow
from app.main import create_app


def _login(client: TestClient, email: str, password: str) -> None:
    assert client.post("/v1/auth/login", json={"email": email, "password": password}).status_code == 200


def test_role_changes_and_removal_apply_to_active_sessions(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "owner-password-for-test")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", "owner@example.test")
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'members.db'}",
        credential_key="test-credential-key",
    )
    with TestClient(app) as owner, TestClient(app) as teammate:
        _login(owner, "owner@example.test", "owner-password-for-test")
        invited = owner.post("/v1/workspace/invite", json={
            "email": "teammate@example.test", "display_name": "Team Mate", "role": "member",
        })
        assert invited.status_code == 201
        member_id = invited.json()["account"]["user_id"]
        temporary = invited.json()["temporary_password"]
        base = owner.post("/v1/knowledge-bases", json={"name": "Restricted wiki"}).json()
        assert owner.put(f"/v1/knowledge-bases/{base['id']}/sharing", json={
            "visibility": "specific", "user_ids": [member_id],
        }).status_code == 200

        _login(teammate, "teammate@example.test", temporary)
        assert teammate.post("/v1/auth/change-password", json={
            "current_password": temporary, "new_password": "teammate-new-password-for-test",
        }).status_code == 200
        assert teammate.get("/v1/auth/me").json()["role"] == "member"
        assert teammate.patch("/v1/auth/me", json={"display_name": "Updated Teammate"}).json()["display_name"] == "Updated Teammate"
        assert teammate.get("/v1/auth/me").json()["display_name"] == "Updated Teammate"
        assert any(item["display_name"] == "Updated Teammate" for item in owner.get("/v1/workspace/members").json())
        assert teammate.get("/v1/provider-profiles").status_code == 403

        assert owner.patch(f"/v1/workspace/members/{member_id}/role", json={"role": "admin"}).status_code == 200
        assert teammate.get("/v1/auth/me").json()["role"] == "admin"
        assert teammate.get("/v1/provider-profiles").status_code == 200
        assert owner.patch(f"/v1/workspace/members/{member_id}/role", json={"role": "viewer"}).status_code == 200
        assert teammate.get("/v1/auth/me").json()["role"] == "viewer"
        assert teammate.get("/v1/provider-profiles").status_code == 403
        assert teammate.patch(f"/v1/workspace/members/{member_id}/role", json={"role": "owner"}).status_code == 403

        assert owner.delete(f"/v1/workspace/members/{member_id}").status_code == 204
        assert teammate.get("/v1/auth/session").json() == {"authenticated": False}
        assert teammate.get("/v1/knowledge-bases").status_code == 401
        assert owner.get("/v1/workspace/members").json()[0]["role"] == "owner"
        with app.state.database.session_factory() as session:
            assert session.query(KnowledgeBaseAccessRow).filter_by(user_id=member_id).count() == 0


def test_admin_cannot_escalate_and_last_owner_is_protected(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "owner-password-for-test")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", "owner@example.test")
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'roles.db'}",
        credential_key="test-credential-key",
    )
    with TestClient(app) as owner, TestClient(app) as admin:
        _login(owner, "owner@example.test", "owner-password-for-test")
        owner_id = owner.get("/v1/auth/me").json()["user_id"]
        assert owner.delete(f"/v1/workspace/members/{owner_id}").status_code == 409
        assert owner.patch(f"/v1/workspace/members/{owner_id}/role", json={"role": "viewer"}).status_code == 409
        admin_invite = owner.post("/v1/workspace/invite", json={
            "email": "admin@example.test", "display_name": "Admin User", "role": "admin",
        }).json()
        admin_id = admin_invite["account"]["user_id"]
        member_id = owner.post("/v1/workspace/invite", json={
            "email": "member@example.test", "display_name": "Member User", "role": "member",
        }).json()["account"]["user_id"]
        _login(admin, "admin@example.test", admin_invite["temporary_password"])
        assert admin.post("/v1/auth/change-password", json={
            "current_password": admin_invite["temporary_password"],
            "new_password": "admin-new-password-for-test",
        }).status_code == 200
        assert admin.patch(f"/v1/workspace/members/{member_id}/role", json={"role": "owner"}).status_code == 409
        assert admin.patch(f"/v1/workspace/members/{member_id}/role", json={"role": "admin"}).status_code == 409
        assert admin.post("/v1/workspace/invite", json={
            "email": "peer@example.test", "display_name": "Peer Admin", "role": "admin",
        }).status_code == 409
        assert admin.patch(f"/v1/workspace/members/{member_id}/role", json={"role": "viewer"}).status_code == 200
        assert admin.patch(f"/v1/workspace/members/{owner_id}/role", json={"role": "viewer"}).status_code == 409
        assert admin.post(f"/v1/workspace/members/{owner_id}/temporary-password").status_code == 409
        assert admin.delete(f"/v1/workspace/members/{admin_id}").status_code == 409
        assert owner.patch(f"/v1/workspace/members/{member_id}/role", json={"role": "owner"}).status_code == 200
        assert owner.patch(f"/v1/workspace/members/{member_id}/role", json={"role": "viewer"}).status_code == 200
        assert owner.get("/v1/workspace/members").status_code == 200
