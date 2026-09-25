from datetime import datetime, timezone

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.database import KnowledgeMessageRow
from app.main import create_app
from meetings_contracts import (
    ActionItem, MeetingMinutes, MeetingStatus, MeetingTranscriptSegment,
    MinutesStatus, TextGenerationResult,
)


def _create_completed_meeting(client, repository, *, opted_in: bool, title: str, base_id: str | None = None) -> str:
    created = client.post("/v1/meetings", json={
        "meeting_url": "https://meet.google.com/abc-defg-hij",
        "title": title,
        "tags": [" Roadmap ", "Customer Research", "roadmap"],
        "knowledge_enabled": opted_in,
        "knowledge_base_id": base_id,
    })
    assert created.status_code == 201
    meeting_id = created.json()["id"]
    assert created.json()["tags"] == ["roadmap", "customer research"]
    meeting = repository.get_meeting(meeting_id)
    meeting.status = MeetingStatus.COMPLETED
    meeting.joined_at = datetime(2026, 9, 20, 9, 30, tzinfo=timezone.utc)
    repository.save_meeting(meeting)
    repository.replace_transcript(meeting.id, [
        MeetingTranscriptSegment(
            segment_id="segment-1", start_seconds=13.2, end_seconds=18.4,
            text="Alice will submit the roadmap on Friday.",
            speaker="Alice", completed=True,
        ),
        MeetingTranscriptSegment(
            segment_id="segment-2", start_seconds=19.0, end_seconds=21.0,
            text="This sentence is still provisional.", speaker="Bob", completed=False,
        ),
    ])
    return meeting_id


def test_opt_in_search_has_speaker_time_tag_and_meeting_citation(tmp_path) -> None:
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'knowledge.db'}",
        credential_key="test-credential-key",
    )
    with TestClient(app) as client:
        repository = app.state.repository
        included = _create_completed_meeting(client, repository, opted_in=True, title="Launch planning")
        _create_completed_meeting(client, repository, opted_in=False, title="Private planning")
        response = client.post("/v1/knowledge/search", json={
            "query": "roadmap", "tags": ["ROADMAP"],
        })
        assert response.status_code == 200
        payload = response.json()
        assert payload["retrieval_mode"] == "lexical"
        assert payload["count"] == 1
        source = payload["sources"][0]
        assert source["meeting_id"] == included
        assert source["meeting_created_at"]
        assert source["meeting_joined_at"] == "2026-09-20T09:30:00Z"
        assert source["segment_id"] == "segment-1"
        assert source["start_seconds"] == 13.2
        assert source["speaker"] == "Alice"
        assert source["tags"] == ["roadmap", "customer research"]
        assert "provisional" not in str(payload)
        assert client.post("/v1/knowledge/search", json={
            "query": "roadmap", "tags": ["not-a-tag"],
        }).json()["count"] == 0

        changed = client.patch(f"/v1/meetings/{included}/knowledge", json={
            "tags": ["Roadmap"], "knowledge_enabled": False,
        })
        assert changed.status_code == 200
        assert changed.json()["knowledge_enabled"] is False
        assert client.post("/v1/knowledge/search", json={"query": "roadmap"}).json()["count"] == 0
        no_answer = client.post("/v1/knowledge/chat", json={"query": "roadmap"})
        assert no_answer.status_code == 200
        assert no_answer.json()["citations"] == []
        assert "couldn't find matching evidence" in no_answer.json()["answer"]


def test_approved_mom_fact_is_linked_and_chat_rejects_invalid_citations(tmp_path) -> None:
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'chat.db'}",
        credential_key="test-credential-key",
    )
    with TestClient(app) as client:
        repository = app.state.repository
        meeting_id = _create_completed_meeting(client, repository, opted_in=True, title="Launch planning")
        repository.save_minutes(MeetingMinutes(
            meeting_id=meeting_id, title="Launch planning",
            executive_summary="Alice committed to the roadmap.",
            action_items=[ActionItem(
                description="Submit the roadmap on Friday", owner="Alice",
                evidence_segment_ids=["segment-1"],
            )],
            status=MinutesStatus.APPROVED,
        ))
        search = client.post("/v1/knowledge/search", json={"query": "submit"}).json()
        assert {item["kind"] for item in search["sources"]} == {"transcript", "action"}
        action = next(item for item in search["sources"] if item["kind"] == "action")
        assert action["evidence_segment_ids"] == ["segment-1"]

        async def generated(_request):
            return object(), TextGenerationResult(
                text='{"answer":"Alice committed to submit the roadmap [K1].","citation_ids":["K1"]}',
                provider="test-provider", model="economy-test",
            )

        app.state.profile_service.generate_text = generated
        response = client.post("/v1/knowledge/chat", json={"query": "who will submit roadmap?"})
        assert response.status_code == 200
        assert response.json()["provider"] == "test-provider"
        assert response.json()["citations"][0]["segment_id"] == "segment-1"

        async def invalid(_request):
            return object(), TextGenerationResult(
                text='{"answer":"Unsupported claim.","citation_ids":["K99"]}',
                provider="test-provider", model="economy-test",
            )

        app.state.profile_service.generate_text = invalid
        refused = client.post("/v1/knowledge/chat", json={"query": "who will submit roadmap?"})
        assert refused.status_code == 502
        assert "outside the retrieved sources" in refused.json()["detail"]


def test_named_knowledge_bases_scope_search_and_save_chat(tmp_path) -> None:
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'bases.db'}",
        credential_key="test-credential-key",
    )
    with TestClient(app) as client:
        created = client.post("/v1/knowledge-bases", json={"name": "Acme client"})
        assert created.status_code == 201
        base_id = created.json()["id"]
        assert created.json()["visibility"] == "private"
        assert client.post("/v1/knowledge-bases", json={"name": "ACME CLIENT"}).status_code == 409
        other = client.post("/v1/knowledge-bases", json={"name": "Other client"}).json()["id"]
        meeting_id = _create_completed_meeting(
            client, app.state.repository, opted_in=True, title="Acme planning", base_id=base_id,
        )
        overview = client.get(f"/v1/knowledge-bases/{base_id}/overview")
        assert overview.status_code == 200
        assert [item["id"] for item in overview.json()["meetings"]] == [meeting_id]
        assert overview.json()["meetings"][0]["tags"] == ["roadmap", "customer research"]
        assert overview.json()["meetings"][0]["summary"] is None
        assert client.get(f"/v1/knowledge-bases/{other}/overview").json()["meetings"] == []
        app.state.repository.save_minutes(MeetingMinutes(
            meeting_id=meeting_id, title="Acme planning",
            executive_summary="Alice owns the roadmap.", decisions=["Launch on Friday"],
            status=MinutesStatus.APPROVED,
        ))
        approved_overview = client.get(f"/v1/knowledge-bases/{base_id}/overview").json()
        assert approved_overview["meetings"][0]["summary"] == "Alice owns the roadmap."
        assert approved_overview["meetings"][0]["decisions"] == ["Launch on Friday"]
        assert client.get(f"/v1/meetings/{meeting_id}").json()["knowledge_base_id"] == base_id
        assert client.get("/v1/knowledge-bases").json()[0]["meeting_count"] == 1
        assert client.post("/v1/knowledge/search", json={
            "query": "roadmap", "knowledge_base_id": base_id,
        }).json()["count"] == 1
        assert client.post("/v1/knowledge/search", json={
            "query": "roadmap", "knowledge_base_id": other,
        }).json()["count"] == 0

        async def generated(_request):
            return object(), TextGenerationResult(
                text='{"answer":"Alice owns the roadmap [K1].","citation_ids":["K1"]}',
                provider="test-provider", model="economy-test",
            )

        app.state.profile_service.generate_text = generated
        answer = client.post("/v1/knowledge/chat", json={
            "query": "who owns roadmap?", "knowledge_base_id": base_id,
        })
        assert answer.status_code == 200
        conversation_id = answer.json()["conversation_id"]
        saved = client.get(f"/v1/knowledge-bases/{base_id}/conversations/{conversation_id}")
        assert [item["role"] for item in saved.json()["messages"]] == ["user", "assistant"]
        assert saved.json()["messages"][1]["citations"][0]["segment_id"] == "segment-1"
        follow_up = client.post("/v1/knowledge/chat", json={
            "query": "when is it due?", "knowledge_base_id": base_id,
            "conversation_id": conversation_id,
        })
        assert follow_up.status_code == 200
        assert follow_up.json()["conversation_id"] == conversation_id
        assert len(client.get(f"/v1/knowledge-bases/{base_id}/conversations/{conversation_id}").json()["messages"]) == 4
        assert client.get(f"/v1/knowledge-bases/{other}/conversations/{conversation_id}").status_code == 404
        assert client.delete(f"/v1/knowledge-bases/{other}/conversations/{conversation_id}").status_code == 404
        assert client.delete(f"/v1/knowledge-bases/{base_id}/conversations/{conversation_id}").status_code == 204
        assert client.get(f"/v1/knowledge-bases/{base_id}/conversations/{conversation_id}").status_code == 404
        assert client.get(f"/v1/knowledge-bases/{base_id}/conversations").json() == []
        with app.state.database.session_factory() as session:
            remaining = session.execute(select(func.count()).select_from(KnowledgeMessageRow).where(
                KnowledgeMessageRow.conversation_id == conversation_id,
            )).scalar_one()
        assert remaining == 0
