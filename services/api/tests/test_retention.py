import asyncio
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database import KnowledgeConversationRow
from app.main import create_app


def test_retention_defaults_off_and_deletes_only_after_explicit_enable(tmp_path) -> None:
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'retention.db'}",
        credential_key="test-credential-key",
    )
    with TestClient(app) as client:
        meeting_id = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
        }).json()["id"]
        meeting = app.state.repository.get_meeting(meeting_id)
        meeting.created_at = datetime.now(UTC) - timedelta(days=120)
        app.state.repository.save_meeting(meeting)
        base_id = client.post("/v1/knowledge-bases", json={"name": "Archive wiki"}).json()["id"]
        conversation_id = app.state.knowledge_bases.save_exchange(
            base_id, None, "Old question", "Old answer", [], None, None,
        )
        with app.state.database.session_factory.begin() as session:
            session.get(KnowledgeConversationRow, str(conversation_id)).updated_at = \
                datetime.now(UTC) - timedelta(days=120)
        assert client.get("/v1/workspace/retention").json() == {
            "enabled": False, "meeting_days": None, "chat_days": None, "audit_days": None,
        }
        asyncio.run(app.state.retention.tick())
        assert client.get(f"/v1/meetings/{meeting_id}").status_code == 200
        assert client.get(f"/v1/knowledge-bases/{base_id}/conversations/{conversation_id}").status_code == 200
        assert client.put("/v1/workspace/retention", json={
            "enabled": True, "meeting_days": None, "chat_days": None, "audit_days": None,
        }).status_code == 422
        assert client.put("/v1/workspace/retention", json={
            "enabled": True, "meeting_days": 90, "chat_days": 90, "audit_days": None,
        }).status_code == 200
        asyncio.run(app.state.retention.tick())
        assert client.get(f"/v1/meetings/{meeting_id}").status_code == 404
        assert client.get(f"/v1/knowledge-bases/{base_id}/conversations/{conversation_id}").status_code == 404
        with app.state.database.session_factory() as session:
            assert session.execute(select(KnowledgeConversationRow.id)).scalars().all() == []
