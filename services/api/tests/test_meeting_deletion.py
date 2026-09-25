"""Deleting a meeting must erase both capture and all product-side copies."""

import httpx
from fastapi.testclient import TestClient
from meetings_contracts import MeetingMinutes, MeetingStatus, MeetingTranscriptSegment, MinutesStatus
from sqlalchemy import func, select

from app.adapters.vexa import VexaCaptureAdapter
from app.database import (
    KnowledgeConversationRow, KnowledgeEmbeddingRow, KnowledgeMessageRow,
    MeetingMinutesRow, MeetingRow, TranscriptSegmentRow,
)
from app.main import create_app


def test_delete_terminal_meeting_removes_capture_and_knowledge_copies(tmp_path) -> None:
    upstream_status = {"code": 503}
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        if request.method == "DELETE" and request.url.path == "/meetings/42":
            return httpx.Response(upstream_status["code"], json={"detail": "storage unavailable"}) \
                if upstream_status["code"] != 204 else httpx.Response(204)
        raise AssertionError(f"unexpected Vexa request: {request.method} {request.url.path}")

    adapter = VexaCaptureAdapter("http://vexa.test", "test-key", transport=httpx.MockTransport(handler))
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'delete.db'}",
        credential_key="test-credential-key", vexa_adapter=adapter,
    )
    with TestClient(app) as client:
        base_id = client.post("/v1/knowledge-bases", json={"name": "Client wiki"}).json()["id"]
        created = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij", "title": "Client review",
            "knowledge_enabled": True, "knowledge_base_id": base_id,
        }).json()
        meeting_id = created["id"]
        meeting = app.state.repository.get_meeting(meeting_id)
        meeting.status = MeetingStatus.COMPLETED
        meeting.vexa_meeting_id = 42
        app.state.repository.save_meeting(meeting)
        app.state.repository.replace_transcript(meeting.id, [MeetingTranscriptSegment(
            segment_id="turn-1", start_seconds=1, end_seconds=2,
            speaker="Alice", text="Approve the client plan.", completed=True,
        )])
        app.state.knowledge_bases.save_exchange(
            meeting.knowledge_base_id, None, "What was approved?", "The plan.",
            [{"meeting_id": meeting_id, "text": "Approve the client plan."}],
            "fake", "fake",
        )
        assert client.delete(f"/v1/meetings/{meeting_id}").status_code == 503
        assert client.get(f"/v1/meetings/{meeting_id}").status_code == 200
        upstream_status["code"] = 204
        assert client.delete(f"/v1/meetings/{meeting_id}").status_code == 204
        assert calls == [("DELETE", "/meetings/42"), ("DELETE", "/meetings/42")]
        assert client.get(f"/v1/meetings/{meeting_id}").status_code == 404
        assert client.get(f"/v1/knowledge-bases/{base_id}/overview").json()["meetings"] == []
        with app.state.database.session_factory() as session:
            for table in (
                MeetingRow, TranscriptSegmentRow, MeetingMinutesRow,
                KnowledgeEmbeddingRow, KnowledgeConversationRow, KnowledgeMessageRow,
            ):
                assert session.execute(select(func.count()).select_from(table)).scalar_one() == 0


def test_active_meeting_cannot_be_deleted(tmp_path) -> None:
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'active.db'}",
        credential_key="test-credential-key",
    )
    with TestClient(app) as client:
        meeting_id = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
        }).json()["id"]
        meeting = app.state.repository.get_meeting(meeting_id)
        meeting.status = MeetingStatus.ACTIVE
        app.state.repository.save_meeting(meeting)
        assert client.delete(f"/v1/meetings/{meeting_id}").status_code == 409
        assert client.get(f"/v1/meetings/{meeting_id}").status_code == 200


def test_unsent_mom_can_be_deleted_without_deleting_transcript(tmp_path) -> None:
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'minutes-delete.db'}",
        credential_key="test-credential-key",
    )
    with TestClient(app) as client:
        meeting_id = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
        }).json()["id"]
        meeting = app.state.repository.get_meeting(meeting_id)
        meeting.status = MeetingStatus.COMPLETED
        app.state.repository.save_meeting(meeting)
        app.state.repository.replace_transcript(meeting.id, [MeetingTranscriptSegment(
            segment_id="turn-1", start_seconds=1, end_seconds=2,
            text="We agreed to proceed.", completed=True,
        )])
        app.state.repository.save_minutes(MeetingMinutes(
            meeting_id=meeting.id, title="Draft MOM", executive_summary="We agreed to proceed.",
            status=MinutesStatus.DRAFT,
        ))
        assert client.delete(f"/v1/meetings/{meeting_id}/minutes").status_code == 204
        assert client.get(f"/v1/meetings/{meeting_id}/minutes").status_code == 404
        assert client.get(f"/v1/meetings/{meeting_id}/transcript").json()["segment_count"] == 1
        assert app.state.repository.get_post_meeting_job(meeting.id).completed_at is not None
        app.state.repository.save_minutes(MeetingMinutes(
            meeting_id=meeting.id, title="Sent MOM", executive_summary="Already emailed.",
            status=MinutesStatus.SENT,
        ))
        assert client.delete(f"/v1/meetings/{meeting_id}/minutes").status_code == 409
