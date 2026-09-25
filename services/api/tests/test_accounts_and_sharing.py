from fastapi.testclient import TestClient

from app.main import create_app
from meetings_contracts import MeetingStatus, MeetingTranscriptSegment


def test_invite_requires_password_change_and_sharing_limits_member_access(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "owner-password-for-test")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", "developer@genaiprotos.com")
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'accounts.db'}",
        credential_key="test-credential-key",
    )
    with TestClient(app) as client:
        assert client.post("/v1/auth/login", json={
            "email": "developer@genaiprotos.com", "password": "owner-password-for-test",
        }).status_code == 200
        owner = client.get("/v1/auth/me").json()
        assert owner["role"] == "owner"
        private_base = client.post("/v1/knowledge-bases", json={"name": "Client account"}).json()
        created = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
            "title": "Client review", "knowledge_enabled": True,
            "knowledge_base_id": private_base["id"],
        })
        assert created.status_code == 201
        meeting_id = created.json()["id"]
        meeting = app.state.repository.get_meeting(meeting_id)
        meeting.status = MeetingStatus.COMPLETED
        app.state.repository.save_meeting(meeting)
        app.state.repository.replace_transcript(meeting.id, [MeetingTranscriptSegment(
            segment_id="s1", start_seconds=2, end_seconds=5,
            text="Roadmap confirmed", speaker="Alice", completed=True,
        )])
        invited = client.post("/v1/workspace/invite", json={
            "email": "teammate@example.com", "display_name": "Team Member", "role": "member",
        })
        assert invited.status_code == 201
        member_id = invited.json()["account"]["user_id"]
        temporary = invited.json()["temporary_password"]
        assert len(temporary) >= 20
        client.post("/v1/auth/logout")

        assert client.post("/v1/auth/login", json={
            "email": "teammate@example.com", "password": temporary,
        }).status_code == 200
        assert client.get("/v1/auth/me").json()["must_change_password"] is True
        assert client.get("/v1/knowledge-bases").status_code == 403
        changed = client.post("/v1/auth/change-password", json={
            "current_password": temporary, "new_password": "a-very-long-new-password",
        })
        assert changed.status_code == 200
        assert client.get("/v1/auth/me").json()["must_change_password"] is False
        assert client.get("/v1/knowledge-bases").json() == []
        assert client.get(f"/v1/knowledge-bases/{private_base['id']}/map").status_code == 404
        assert client.get(f"/v1/meetings/{meeting_id}").status_code == 404
        assert client.get("/v1/provider-profiles").status_code == 403
        assert client.patch("/v1/workspace", json={"display_name": "Taken over"}).status_code == 403
        assert client.post("/v1/knowledge/search", json={"query": "roadmap"}).status_code == 403
        client.post("/v1/auth/logout")

        client.post("/v1/auth/login", json={
            "email": "developer@genaiprotos.com", "password": "owner-password-for-test",
        })
        shared = client.put(f"/v1/knowledge-bases/{private_base['id']}/sharing", json={
            "visibility": "specific", "user_ids": [member_id],
        })
        assert shared.status_code == 200
        assert shared.json()["shared_user_ids"] == [member_id]
        owner_chat = client.post("/v1/knowledge/chat", json={
            "query": "unmentioned topic", "knowledge_base_id": private_base["id"],
        })
        assert owner_chat.status_code == 200
        owner_conversation_id = owner_chat.json()["conversation_id"]
        client.post("/v1/auth/logout")

        client.post("/v1/auth/login", json={
            "email": "teammate@example.com", "password": "a-very-long-new-password",
        })
        assert [item["id"] for item in client.get("/v1/knowledge-bases").json()] == [private_base["id"]]
        assert client.get(f"/v1/knowledge-bases/{private_base['id']}/map").status_code == 200
        assert client.get(f"/v1/knowledge-bases/{private_base['id']}/conversations/{owner_conversation_id}").status_code == 404
        assert client.delete(f"/v1/knowledge-bases/{private_base['id']}/conversations/{owner_conversation_id}").status_code == 404
        assert client.get(f"/v1/knowledge-bases/{private_base['id']}/conversations").json() == []
        member_chat = client.post("/v1/knowledge/chat", json={
            "query": "unmentioned topic", "knowledge_base_id": private_base["id"],
        })
        assert member_chat.status_code == 200
        member_conversation_id = member_chat.json()["conversation_id"]
        assert client.delete(f"/v1/knowledge-bases/{private_base['id']}/conversations/{member_conversation_id}").status_code == 204
        assert client.get(f"/v1/knowledge-bases/{private_base['id']}/conversations").json() == []
        assert client.delete(f"/v1/knowledge-bases/{private_base['id']}").status_code == 409
        result = client.post("/v1/knowledge/search", json={
            "query": "roadmap", "knowledge_base_id": private_base["id"],
        })
        assert result.status_code == 200
        assert result.json()["sources"][0]["segment_id"] == "s1"
        assert client.get(f"/v1/meetings/{meeting_id}/transcript").status_code == 200
        assert client.get(f"/v1/meetings/{meeting_id}").status_code == 200
        client.post("/v1/auth/logout")
        client.post("/v1/auth/login", json={
            "email": "developer@genaiprotos.com", "password": "owner-password-for-test",
        })
        reset = client.post(f"/v1/workspace/members/{member_id}/temporary-password")
        assert reset.status_code == 200
        second_temporary = reset.json()["temporary_password"]
        assert second_temporary != temporary
        client.post("/v1/auth/logout")
        assert client.post("/v1/auth/login", json={
            "email": "teammate@example.com", "password": "a-very-long-new-password",
        }).status_code == 401
        assert client.post("/v1/auth/login", json={
            "email": "teammate@example.com", "password": second_temporary,
        }).status_code == 200
        assert client.get("/v1/auth/me").json()["must_change_password"] is True
