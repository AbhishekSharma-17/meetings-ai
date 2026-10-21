"""Saved meeting evidence can enter a knowledge base later without another capture or MOM."""

from datetime import UTC, datetime
from copy import deepcopy
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
from meetings_contracts import ActionItem, MeetingMinutes, MeetingStatus, MeetingTranscriptSegment, MinutesStatus

from app.database import KnowledgeIndexJobRow
from app.main import create_app
from document_fixtures import FakeProvider, configure_providers


def test_sent_meeting_can_be_added_later_and_moved_without_recapture(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTO_MOM_ENABLED", "0")
    monkeypatch.setenv("AUTO_CALENDAR_SCHEDULE_ENABLED", "0")
    monkeypatch.setenv("AUTO_KNOWLEDGE_INDEX_ENABLED", "0")
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'late-kb.db'}", credential_key="test-key")
    with TestClient(app) as client:
        fake = FakeProvider()
        configure_providers(client, app, fake, vision=False)
        base_id = client.post("/v1/knowledge-bases", json={"name": "Leadership archive"}).json()["id"]
        other_id = client.post("/v1/knowledge-bases", json={"name": "Client archive"}).json()["id"]
        response = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij", "title": "Saved roadmap review",
        })
        assert response.status_code == 201
        assert response.json()["knowledge_enabled"] is False
        assert response.json()["knowledge_base_id"] is None
        meeting_id = response.json()["id"]
        repository = app.state.repository
        meeting = repository.get_meeting(meeting_id)
        meeting.status = MeetingStatus.COMPLETED
        repository.save_meeting(meeting)
        repository.replace_transcript(meeting.id, [
            MeetingTranscriptSegment(segment_id="saved-1", speaker="Alice", start_seconds=12, end_seconds=18,
                                     text="Alice will deliver the roadmap on Friday.", completed=True),
            MeetingTranscriptSegment(segment_id="unfinished", speaker="Bob", start_seconds=20, end_seconds=22,
                                     text="A provisional private roadmap thought.", completed=False),
        ])
        revision = repository.get_transcript_revision(meeting.id)
        now = datetime.now(UTC)
        repository.save_minutes(MeetingMinutes(
            meeting_id=meeting.id, title="Saved roadmap review", executive_summary="Roadmap delivery is agreed.",
            action_items=[ActionItem(description="Deliver the roadmap", owner="Alice", evidence_segment_ids=["saved-1"])],
            status=MinutesStatus.SENT, approved_at=now, sent_at=now,
        ))
        repository.save_minutes_source_revision(meeting.id, revision)
        original = deepcopy(repository.get_minutes(meeting.id))
        app.state.meeting_service.transcript = AsyncMock(side_effect=AssertionError("must use the saved transcript"))
        app.state.minutes_service.generate = AsyncMock(side_effect=AssertionError("must not regenerate a sent MOM"))
        query = {"query": "roadmap", "knowledge_base_id": base_id}
        assert client.post("/v1/knowledge/search", json=query).json()["count"] == 0

        added = client.patch(f"/v1/meetings/{meeting_id}/knowledge", json={
            "tags": ["roadmap"], "knowledge_enabled": True, "knowledge_base_id": base_id,
        })
        assert added.status_code == 200, added.text
        with app.state.database.session_factory() as session:
            job = session.get(KnowledgeIndexJobRow, base_id)
            assert job is not None and job.status == "pending"
        indexed = client.post(f"/v1/knowledge-bases/{base_id}/reindex")
        assert indexed.status_code == 200, indexed.text
        assert indexed.json()["indexed_sources"] > 0
        sources = client.post("/v1/knowledge/search", json=query).json()["sources"]
        assert any(source["kind"] == "transcript" and "saved-1" in source["evidence_segment_ids"] for source in sources)
        assert any(source["kind"] == "action" for source in sources)
        assert all("provisional" not in source["text"] for source in sources)
        assert client.get(f"/v1/knowledge-bases/{base_id}/overview").json()["meetings"][0]["id"] == meeting_id

        moved = client.patch(f"/v1/meetings/{meeting_id}/knowledge", json={
            "tags": ["roadmap"], "knowledge_enabled": True, "knowledge_base_id": other_id,
        })
        assert moved.status_code == 200, moved.text
        assert client.post("/v1/knowledge/search", json=query).json()["count"] == 0
        assert client.post("/v1/knowledge/search", json={**query, "knowledge_base_id": other_id}).json()["count"] > 0
        assert client.patch(f"/v1/meetings/{meeting_id}/knowledge", json={
            "tags": [], "knowledge_enabled": False, "knowledge_base_id": other_id,
        }).status_code == 200
        assert client.post("/v1/knowledge/search", json={**query, "knowledge_base_id": other_id}).json()["count"] == 0
        assert repository.get_minutes(meeting.id) == original
        assert repository.get_transcript_revision(meeting.id) == revision
        assert len(repository.get_transcript(meeting.id)) == 2
        app.state.meeting_service.transcript.assert_not_called()
        app.state.minutes_service.generate.assert_not_called()
