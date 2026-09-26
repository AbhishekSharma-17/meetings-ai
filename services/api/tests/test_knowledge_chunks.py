"""Knowledge-base indexing on knowledge_chunks keeps search/chat citation shapes and access rules."""

import asyncio
from uuid import uuid4

from fastapi.testclient import TestClient
from meetings_contracts import (
    ActionItem, MeetingMinutes, MeetingStatus, MeetingTranscriptSegment, MinutesStatus, TextGenerationResult,
)
from sqlalchemy import func, select

from app.database import LEGACY_ORGANIZATION_ID, KnowledgeChunkRow, KnowledgeDocumentRow
from app.knowledge_service import KnowledgeSource
from app.main import create_app
from document_fixtures import FakeProvider, configure_providers
from test_retrieval import _member

SOURCE_KEYS = set(KnowledgeSource.model_fields)


def _meeting(client, app, base_id):
    meeting_id = client.post("/v1/meetings", json={
        "meeting_url": "https://meet.google.com/abc-defg-hij", "title": "Contract review",
        "knowledge_enabled": True, "knowledge_base_id": base_id,
    }).json()["id"]
    repository = app.state.repository
    meeting = repository.get_meeting(meeting_id)
    meeting.status = MeetingStatus.COMPLETED
    repository.save_meeting(meeting)
    repository.replace_transcript(meeting.id, [
        MeetingTranscriptSegment(segment_id="seg-1", start_seconds=1, end_seconds=4, speaker="Alice",
                                 text="The contract renewal is due in March.", completed=True),
        MeetingTranscriptSegment(segment_id="seg-2", start_seconds=4, end_seconds=8, speaker="Alice",
                                 text="Legal must review the contract terms first.", completed=True),
        MeetingTranscriptSegment(segment_id="seg-3", start_seconds=8, end_seconds=10, speaker="Bob",
                                 text="Agreed, budget is approved.", completed=True),
    ])
    repository.save_minutes(MeetingMinutes(
        meeting_id=meeting_id, title="Contract review", executive_summary="Renewal planned.",
        action_items=[ActionItem(description="Legal reviews the contract", owner="Alice",
                                 evidence_segment_ids=["seg-2"])],
        status=MinutesStatus.APPROVED,
    ))
    return meeting_id


def test_turn_chunks_map_back_to_identical_citation_shapes(tmp_path) -> None:
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'kb.db'}", credential_key="test-credential-key")
    fake = FakeProvider()
    with TestClient(app) as client:
        configure_providers(client, app, fake, vision=False)
        base_id = client.post("/v1/knowledge-bases", json={"name": "Contracts"}).json()["id"]
        meeting_id = _meeting(client, app, base_id)
        indexed = client.post(f"/v1/knowledge-bases/{base_id}/reindex")
        assert indexed.status_code == 200, indexed.text
        assert indexed.json()["indexed_sources"] == 3  # two speaker turns + one approved action item
        with app.state.database.session_factory() as session:
            rows = session.execute(select(KnowledgeChunkRow).order_by(KnowledgeChunkRow.position)).scalars().all()
        assert [row.source_type for row in rows] == ["transcript", "transcript", "mom"]
        assert rows[0].details["segment_ids"] == ["seg-1", "seg-2"] and rows[0].meeting_id == meeting_id
        assert rows[0].scope == "knowledge_base" and rows[0].scope_id == base_id
        assert rows[0].content.startswith("Alice: The contract renewal")
        assert rows[2].details["evidence_segment_ids"] == ["seg-2"]
        assert all(row.context.startswith("LLM note") for row in rows)

        result = client.post("/v1/knowledge/search", json={"query": "contract renewal", "knowledge_base_id": base_id}).json()
        assert result["retrieval_mode"] == "hybrid"
        assert all(set(source) == SOURCE_KEYS for source in result["sources"])
        turn = next(source for source in result["sources"] if source["evidence_segment_ids"] == ["seg-1", "seg-2"])
        assert turn["segment_id"] == "seg-1" and turn["kind"] == "transcript" and turn["speaker"] == "Alice"
        assert turn["start_seconds"] == 1 and turn["end_seconds"] == 8 and "Legal must review" in turn["text"]
        # The lexical per-segment hit on seg-1 is folded into the turn, never cited twice.
        transcript_segments = [source["segment_id"] for source in result["sources"] if source["kind"] == "transcript"]
        assert transcript_segments.count("seg-1") == 1

        async def generated(_request, **_kwargs):
            return object(), TextGenerationResult(
                text='{"answer":"Renewal is due in March [K1].","citation_ids":["K1"]}',
                provider="test", model="economy-test")

        app.state.profile_service.generate_text = generated
        chat = client.post("/v1/knowledge/chat", json={"query": "when is the contract renewal", "knowledge_base_id": base_id})
        assert chat.status_code == 200, chat.text
        assert chat.json()["citations"] and all(set(item) == SOURCE_KEYS for item in chat.json()["citations"])


def test_access_invalidation_and_deletion_purge_chunks(tmp_path) -> None:
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'kb-purge.db'}", credential_key="test-credential-key")
    fake = FakeProvider()
    with TestClient(app) as client:
        profile = configure_providers(client, app, fake, vision=False)
        base_id = client.post("/v1/knowledge-bases", json={"name": "Contracts"}).json()["id"]
        meeting_id = _meeting(client, app, base_id)
        assert client.post(f"/v1/knowledge-bases/{base_id}/reindex").json()["indexed_sources"] == 3
        retriever = app.state.chunk_retriever
        found = asyncio.run(retriever.search(LEGACY_ORGANIZATION_ID, "contract renewal",
                                             scopes=[("knowledge_base", base_id)]))
        assert found and {item.meeting_id for item in found} == {meeting_id}
        stranger = _member(uuid4())
        assert asyncio.run(retriever.search(LEGACY_ORGANIZATION_ID, "contract renewal",
                                            scopes=[("knowledge_base", base_id)], actor=stranger)) == []

        # Profile deletion keeps chunk text but drops unusable vectors.
        assert client.delete(f"/v1/provider-profiles/{profile['id']}").status_code == 204
        assert client.get(f"/v1/knowledge-bases/{base_id}/index").json()["indexed_sources"] == 0
        with app.state.database.session_factory() as session:
            assert session.execute(select(func.count()).select_from(KnowledgeChunkRow)).scalar_one() == 3

        # Opting the meeting out removes its text copies immediately.
        assert client.patch(f"/v1/meetings/{meeting_id}/knowledge", json={
            "knowledge_enabled": False, "tags": []}).status_code == 200
        with app.state.database.session_factory() as session:
            assert session.execute(select(func.count()).select_from(KnowledgeChunkRow)).scalar_one() == 0

        document = client.post("/v1/documents", data={"scope": "knowledge_base", "scope_id": base_id},
                               files={"file": ("terms.md", b"# Terms\n\nPayment within 30 days.", "text/markdown")})
        assert document.status_code == 201
        assert client.delete(f"/v1/knowledge-bases/{base_id}").status_code == 204
        with app.state.database.session_factory() as session:
            assert session.execute(select(func.count()).select_from(KnowledgeDocumentRow)).scalar_one() == 0
            assert session.execute(select(func.count()).select_from(KnowledgeChunkRow)).scalar_one() == 0
