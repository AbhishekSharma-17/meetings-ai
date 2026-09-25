"""Semantic retrieval uses indexed vectors only while canonical evidence agrees."""

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from meetings_contracts import (
    EmbeddingResult, MeetingStatus, MeetingTranscriptSegment, ProviderType,
)

from app.adapters.base import ProviderExecutionError
from app.database import KnowledgeConversationRow, KnowledgeEmbeddingRow, KnowledgeMessageRow
from app.main import create_app


class FakeEmbeddingAdapter:
    calls = 0

    async def embed(self, profile, request):
        self.calls += 1
        if getattr(self, "fail", False):
            raise ProviderExecutionError("temporary provider failure")
        vectors = [[1.0, 0.0] if "portal" in value.lower() or "launch" in value.lower()
                   else [0.0, 1.0] for value in request.inputs]
        return EmbeddingResult(vectors=vectors, provider="fake", model="fake-embed", dimensions=2)


def _meeting(client: TestClient, app, base_id: str, text: str) -> str:
    created = client.post("/v1/meetings", json={
        "meeting_url": "https://meet.google.com/abc-defg-hij", "title": "Client discussion",
        "knowledge_enabled": True, "knowledge_base_id": base_id,
    })
    assert created.status_code == 201
    meeting_id = created.json()["id"]
    meeting = app.state.repository.get_meeting(meeting_id)
    meeting.status = MeetingStatus.COMPLETED
    app.state.repository.save_meeting(meeting)
    app.state.repository.replace_transcript(meeting.id, [MeetingTranscriptSegment(
        segment_id="turn-1", start_seconds=7, end_seconds=11,
        speaker="Alice", text=text, completed=True,
    )])
    return meeting_id


def test_reindex_enables_semantic_match_and_opt_out_excludes_stale_vectors(tmp_path) -> None:
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'index.db'}",
        credential_key="test-credential-key",
    )
    fake = FakeEmbeddingAdapter()
    app.state.profile_service.adapters[ProviderType.OPENAI] = fake
    with TestClient(app) as client:
        profile = client.post("/v1/provider-profiles", json={
            "name": "Semantic model", "provider_type": "openai",
            "execution_location": "cloud", "api_key": "test-key",
            "capabilities": [{"capability": "embeddings", "model": "fake-embed"}],
        }).json()
        assert client.put("/v1/provider-defaults/embeddings", json={
            "policy": "cloud_only", "cloud_profile_id": profile["id"],
        }).status_code == 200
        base_id = client.post("/v1/knowledge-bases", json={"name": "Client wiki"}).json()["id"]
        meeting_id = _meeting(client, app, base_id, "Ship the new client portal.")
        query = {"query": "launch", "knowledge_base_id": base_id}
        assert client.post("/v1/knowledge/search", json=query).json()["count"] == 0
        indexed = client.post(f"/v1/knowledge-bases/{base_id}/reindex")
        assert indexed.status_code == 200
        assert indexed.json()["indexed_sources"] == 1
        assert indexed.json()["profile_id"] == profile["id"]
        assert indexed.json()["model"] == "fake-embed"
        result = client.post("/v1/knowledge/search", json=query).json()
        assert result["retrieval_mode"] == "hybrid"
        assert result["sources"][0]["meeting_id"] == meeting_id
        assert result["sources"][0]["segment_id"] == "turn-1"

        fake.fail = True
        assert client.post(f"/v1/knowledge-bases/{base_id}/reindex").status_code == 409
        assert client.get(f"/v1/knowledge-bases/{base_id}/index").json()["indexed_sources"] == 1
        fake.fail = False

        assert client.patch(f"/v1/meetings/{meeting_id}/knowledge", json={
            "knowledge_enabled": False, "tags": [],
        }).status_code == 200
        excluded = client.post("/v1/knowledge/search", json=query).json()
        assert excluded["count"] == 0
        assert excluded["retrieval_mode"] == "lexical"
        assert client.get(f"/v1/knowledge-bases/{base_id}/index").json()["indexed_sources"] == 0
        cleared = client.post(f"/v1/knowledge-bases/{base_id}/reindex")
        assert cleared.status_code == 200
        assert cleared.json()["indexed_sources"] == 0


def test_index_fingerprint_rejects_edited_transcript_and_missing_provider(tmp_path) -> None:
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'edits.db'}",
        credential_key="test-credential-key",
    )
    app.state.profile_service.adapters[ProviderType.OPENAI] = FakeEmbeddingAdapter()
    with TestClient(app) as client:
        base_id = client.post("/v1/knowledge-bases", json={"name": "Edited wiki"}).json()["id"]
        meeting_id = _meeting(client, app, base_id, "Ship the new client portal.")
        assert client.post(f"/v1/knowledge-bases/{base_id}/reindex").status_code == 409
        profile = client.post("/v1/provider-profiles", json={
            "name": "Semantic model", "provider_type": "openai",
            "execution_location": "cloud", "api_key": "test-key",
            "capabilities": [{"capability": "embeddings", "model": "fake-embed"}],
        }).json()
        assert client.put("/v1/provider-defaults/embeddings", json={
            "policy": "cloud_only", "cloud_profile_id": profile["id"],
        }).status_code == 200
        assert client.post(f"/v1/knowledge-bases/{base_id}/reindex").status_code == 200
        app.state.repository.replace_transcript(meeting_id, [MeetingTranscriptSegment(
            segment_id="turn-1", start_seconds=7, end_seconds=11,
            speaker="Alice", text="Budget review is complete.", completed=True,
        )])
        assert client.get(f"/v1/knowledge-bases/{base_id}/index").json()["indexed_sources"] == 0
        stale = client.post("/v1/knowledge/search", json={
            "query": "launch", "knowledge_base_id": base_id,
        }).json()
        assert stale["count"] == 0
        assert stale["retrieval_mode"] == "lexical"
        assert client.post(f"/v1/knowledge-bases/{base_id}/reindex").status_code == 200
        assert client.get(f"/v1/knowledge-bases/{base_id}/index").json()["indexed_sources"] == 1
        assert client.delete(f"/v1/provider-profiles/{profile['id']}").status_code == 204
        assert client.get(f"/v1/knowledge-bases/{base_id}/index").json()["indexed_sources"] == 0


def test_delete_base_purges_knowledge_copies_and_preserves_meeting(tmp_path) -> None:
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'delete-base.db'}",
        credential_key="test-credential-key",
    )
    app.state.profile_service.adapters[ProviderType.OPENAI] = FakeEmbeddingAdapter()
    with TestClient(app) as client:
        profile = client.post("/v1/provider-profiles", json={
            "name": "Semantic model", "provider_type": "openai",
            "execution_location": "cloud", "api_key": "test-key",
            "capabilities": [{"capability": "embeddings", "model": "fake-embed"}],
        }).json()
        assert client.put("/v1/provider-defaults/embeddings", json={
            "policy": "cloud_only", "cloud_profile_id": profile["id"],
        }).status_code == 200
        base_id = client.post("/v1/knowledge-bases", json={"name": "To remove"}).json()["id"]
        meeting_id = _meeting(client, app, base_id, "Ship the new client portal.")
        assert client.post(f"/v1/knowledge-bases/{base_id}/reindex").json()["indexed_sources"] == 1
        saved = client.post("/v1/knowledge/chat", json={
            "query": "unmentioned topic", "knowledge_base_id": base_id,
        })
        assert saved.status_code == 200
        conversation_id = saved.json()["conversation_id"]
        assert client.delete(f"/v1/knowledge-bases/{base_id}").status_code == 204
        assert client.get(f"/v1/knowledge-bases/{base_id}").status_code == 404
        assert client.get(f"/v1/knowledge-bases/{base_id}/conversations/{conversation_id}").status_code == 404
        meeting = client.get(f"/v1/meetings/{meeting_id}")
        assert meeting.status_code == 200
        assert meeting.json()["knowledge_enabled"] is False
        assert meeting.json()["knowledge_base_id"] is None
        assert client.get(f"/v1/meetings/{meeting_id}/transcript").status_code == 200
        with app.state.database.session_factory() as session:
            for table in (KnowledgeEmbeddingRow, KnowledgeConversationRow, KnowledgeMessageRow):
                assert session.execute(select(func.count()).select_from(table)).scalar_one() == 0
