"""Two real sessions must not enumerate or mutate each other's product data."""

import asyncio
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.accounts import _hash_password
from app.database import (
    OrganizationMembershipRow, OrganizationRow, UserCredentialRow, UserRow,
)
from app.main import create_app
from app.repository import MeetingNotFoundError, ProfileNotFoundError
from app.tenant import current_organization_id, tenant_scope
from app.post_meeting_worker import PostMeetingWorker


def _profile(name: str) -> dict:
    return {
        "name": name, "provider_type": "openai", "execution_location": "cloud",
        "api_key": "test-provider-credential", "capabilities": [
            {"capability": "text_generation", "model": "test-model"},
        ],
    }


def test_two_organizations_cannot_read_or_change_each_others_data(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "owner-password-for-test")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", "owner@example.test")
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'tenants.db'}",
        credential_key="test-credential-key",
    )
    other_org, other_user = uuid4(), uuid4()
    now = datetime.now(UTC)
    with app.state.database.session_factory.begin() as session:
        session.add(OrganizationRow(
            id=str(other_org), slug="other-workspace", display_name="Other Company",
            contact_email="other@example.test", status="active",
            created_at=now, updated_at=now,
        ))
        session.add(UserRow(
            id=str(other_user), email="other@example.test", display_name="Other Owner",
            auth_subject=f"local:{other_user}", status="active",
            created_at=now, updated_at=now,
        ))
        session.add(OrganizationMembershipRow(
            organization_id=str(other_org), user_id=str(other_user),
            role="owner", created_at=now,
        ))
        session.add(UserCredentialRow(
            user_id=str(other_user), password_hash=_hash_password("other-password-for-test"),
            must_change_password=False, session_version=1,
            created_at=now, updated_at=now,
        ))

    with TestClient(app) as owner, TestClient(app) as other:
        assert owner.post("/v1/auth/login", json={
            "email": "owner@example.test", "password": "owner-password-for-test",
        }).status_code == 200
        assert other.post("/v1/auth/login", json={
            "email": "other@example.test", "password": "other-password-for-test",
        }).status_code == 200
        assert other.get("/v1/workspace").json()["display_name"] == "Other Company"
        assert other.get("/v1/workspace/members").json()[0]["user_id"] == str(other_user)

        owner_profile = owner.post("/v1/provider-profiles", json=_profile("Owner provider")).json()
        other_profile = other.post("/v1/provider-profiles", json=_profile("Other provider")).json()
        assert [item["id"] for item in owner.get("/v1/provider-profiles").json()] == [owner_profile["id"]]
        assert [item["id"] for item in other.get("/v1/provider-profiles").json()] == [other_profile["id"]]
        assert owner.put("/v1/provider-defaults/text_generation", json={
            "policy": "cloud_only", "cloud_profile_id": owner_profile["id"],
        }).status_code == 200
        assert other.get("/v1/provider-defaults").json() == []
        assert other.put("/v1/provider-defaults/text_generation", json={
            "policy": "cloud_only", "cloud_profile_id": other_profile["id"],
        }).status_code == 200
        assert owner.get("/v1/provider-defaults").json()[0]["ordered_profile_ids"] == [owner_profile["id"]]
        assert other.patch(f"/v1/provider-profiles/{owner_profile['id']}", json={
            "name": "stolen",
        }).status_code == 404
        assert other.delete(f"/v1/provider-profiles/{owner_profile['id']}").status_code == 404

        owner_base = owner.post("/v1/knowledge-bases", json={"name": "Client notes"}).json()
        other_base = other.post("/v1/knowledge-bases", json={"name": "Client notes"}).json()
        assert owner_base["organization_id"] != other_base["organization_id"]
        assert other.get(f"/v1/knowledge-bases/{owner_base['id']}").status_code == 404
        assert other.post("/v1/knowledge/search", json={
            "query": "roadmap", "knowledge_base_id": owner_base["id"],
        }).status_code == 404

        owner_meeting = owner.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
            "knowledge_enabled": True, "knowledge_base_id": owner_base["id"],
        }).json()
        other_meeting = other.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/xyz-abcd-efg",
            "knowledge_enabled": True, "knowledge_base_id": other_base["id"],
        }).json()
        assert [item["id"] for item in owner.get("/v1/meetings").json()["items"]] == [owner_meeting["id"]]
        assert [item["id"] for item in other.get("/v1/meetings").json()["items"]] == [other_meeting["id"]]
        for path in (
            "", "/transcript", "/minutes", "/delivery-settings", "/post-meeting-job",
        ):
            assert other.get(f"/v1/meetings/{owner_meeting['id']}{path}").status_code == 404
        assert other.post(f"/v1/meetings/{owner_meeting['id']}/minutes/send", json={
            "recipients": ["other@example.test"],
        }).status_code == 404
        assert other.patch(f"/v1/meetings/{owner_meeting['id']}/knowledge", json={
            "tags": ["stolen"], "knowledge_enabled": True,
        }).status_code == 404

        with tenant_scope(other_org):
            with pytest.raises(MeetingNotFoundError):
                app.state.repository.get_transcript(UUID(owner_meeting["id"]))
            with pytest.raises(ProfileNotFoundError):
                app.state.repository.get_profile(UUID(owner_profile["id"]))
        worker_scopes = set(app.state.repository.list_worker_scopes())
        assert (UUID(owner_base["organization_id"]), UUID(owner_meeting["id"])) in worker_scopes
        assert (other_org, UUID(other_meeting["id"])) in worker_scopes


def test_worker_switches_tenant_scope_for_each_job() -> None:
    first_org, second_org = uuid4(), uuid4()
    first_meeting, second_meeting = uuid4(), uuid4()

    class Repository:
        def list_worker_scopes(self):
            return [(first_org, first_meeting), (second_org, second_meeting)]

    worker = PostMeetingWorker(Repository(), object(), object())
    seen = []

    async def observe(meeting_id):
        seen.append((current_organization_id(), meeting_id))

    worker.process_meeting = observe
    asyncio.run(worker.tick())
    assert seen == [(first_org, first_meeting), (second_org, second_meeting)]


def test_owner_can_create_and_switch_workspace_without_data_leaking(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "owner-password-for-test")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", "owner@example.test")
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'switch.db'}",
        credential_key="test-credential-key",
    )
    with TestClient(app) as client:
        assert client.post("/v1/auth/login", json={
            "email": "owner@example.test", "password": "owner-password-for-test",
        }).status_code == 200
        original = client.get("/v1/workspace").json()["id"]
        teammate = client.post("/v1/workspace/invite", json={
            "email": "teammate@example.test", "display_name": "Team Mate", "role": "member",
        })
        assert teammate.status_code == 201
        assert teammate.json()["temporary_password"]
        profile = client.post("/v1/provider-profiles", json=_profile("First organization provider")).json()
        base = client.post("/v1/knowledge-bases", json={"name": "First organization wiki"}).json()

        created = client.post("/v1/workspaces", json={"display_name": "Second Organization"})
        assert created.status_code == 201
        second = created.json()["organization_id"]
        assert second != original
        assert created.json()["role"] == "owner"
        assert client.get("/v1/workspace").json()["id"] == second
        signed_cookie = client.cookies.get("meetings_ai_session")
        assert signed_cookie is not None
        parts = signed_cookie.split(".")
        assert len(parts) == 6 and parts[2] == second
        tampered = ".".join([*parts[:2], original, *parts[3:]])
        assert client.get("/v1/workspace", headers={"cookie": f"meetings_ai_session={tampered}"}).status_code == 401
        assert client.get("/v1/provider-profiles").json() == []
        assert client.get("/v1/knowledge-bases").json() == []
        assert client.get("/v1/meetings").json()["items"] == []
        assert client.patch(f"/v1/provider-profiles/{profile['id']}", json={"name": "No access"}).status_code == 404
        assert client.get(f"/v1/knowledge-bases/{base['id']}").status_code == 404
        assert len(client.get("/v1/workspaces").json()) == 2
        added = client.post("/v1/workspace/invite", json={
            "email": "teammate@example.test", "display_name": "Team Mate", "role": "viewer",
        })
        assert added.status_code == 201
        assert added.json()["temporary_password"] is None
        assert added.json()["account"]["user_id"] == teammate.json()["account"]["user_id"]
        assert client.post("/v1/workspace/invite", json={
            "email": "teammate@example.test", "display_name": "Team Mate", "role": "viewer",
        }).status_code == 409

        switched = client.post(f"/v1/workspaces/{original}/switch")
        assert switched.status_code == 200
        assert switched.json()["organization_id"] == original
        assert client.get("/v1/provider-profiles").json()[0]["id"] == profile["id"]
        assert client.get("/v1/knowledge-bases").json()[0]["id"] == base["id"]
        assert client.post(f"/v1/workspaces/{uuid4()}/switch").status_code == 404
        with TestClient(app) as member:
            assert member.post("/v1/auth/login", json={
                "email": "teammate@example.test", "password": teammate.json()["temporary_password"],
            }).status_code == 200
            assert member.post("/v1/auth/change-password", json={
                "current_password": teammate.json()["temporary_password"],
                "new_password": "replacement-password-for-test",
            }).status_code == 200
            options = member.get("/v1/workspaces").json()
            assert {item["id"] for item in options} == {original, second}
            assert member.post(f"/v1/workspaces/{second}/switch").json()["role"] == "viewer"
            assert member.get("/v1/workspace").json()["id"] == second
