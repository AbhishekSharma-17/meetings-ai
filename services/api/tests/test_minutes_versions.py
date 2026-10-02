"""Personal notes privacy and a single shared capture, without live providers or email."""
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from sqlalchemy import select, update
from meetings_contracts import MeetingMinutesDraft, MeetingTranscriptSegment

from app.database import (MeetingCoverageRow, MeetingRow, MinutesVersionRow, MinutesVersionAccessRow, NotificationEmailRow, NotificationRow)
from app.tenant import tenant_scope
from app.minutes_service import MinutesGenerationError
from test_call_coordination import world, _as, LINK


@pytest.fixture
def source(world):
    client = _as(world, "asha")
    meeting = client.post("/v1/meetings", json={"meeting_url": LINK, "title": "Engineering and commercial review"}).json()["id"]
    with world["app"].state.database.session_factory.begin() as session:
        session.execute(update(MeetingRow).where(MeetingRow.id == meeting).values(status="completed"))
        session.add(MeetingCoverageRow(meeting_id=meeting, user_id=world["cara"], organization_id=world["org"],
            role="sharing", decision="share", receive_recap=False, decided_at=datetime.now(UTC), decided_by=world["cara"]))
    with tenant_scope(UUID(world["org"])):
        repo = world["app"].state.repository
        repo.replace_transcript(UUID(meeting), [MeetingTranscriptSegment(segment_id="turn-1", speaker="Asha",
            start_seconds=0, end_seconds=5, text="We need to review the technical plan and commercial options.")])
    return meeting


def create(world, source, who="cara", label="Technical notes"):
    response = _as(world, who).post(f"/v1/meetings/{source}/minutes-versions", json={"label": label, "perspective": "technical",
        "guidance": {"template": "custom", "instructions": "Explain the technical details thoroughly.", "focus_fields": ["Architecture", "Risks"]}})
    assert response.status_code == 201, response.text
    return response.json()


def generate(world, item):
    service = world["app"].state.minutes_service
    content = MeetingMinutesDraft(title="Technical review", executive_summary="The technical plan and commercial options were reviewed.",
        speaker_contributions=[{"speaker": "Asha", "summary": "Requested a review.", "evidence_segment_ids": ["turn-1"]}])
    with tenant_scope(UUID(world["org"])):
        source = service.repository.get_transcript_revision(UUID(item["meeting_id"]))
    service.generate_draft = AsyncMock(return_value=(content, SimpleNamespace(id=UUID(world["asha"])),
        SimpleNamespace(provider="fake", model="economy"), source))
    response = _as(world, "cara").post(f"/v1/minutes-versions/{item['id']}/generate", json={"revision": item["revision"]})
    assert response.status_code == 200, response.text
    return response.json()


def approve(world, item):
    response = _as(world, "cara").post(f"/v1/minutes-versions/{item['id']}/approve", json={"revision": item["revision"]})
    assert response.status_code == 200, response.text
    return response.json()


def share(world, item, visibility, ids=None):
    response = _as(world, "cara").post(f"/v1/minutes-versions/{item['id']}/sharing", json={"revision": item["revision"],
        "visibility": visibility, "user_ids": ids or []})
    assert response.status_code == 200, response.text
    return response.json()


def test_admin_sees_metadata_not_private_content_or_guidance(world, source):
    item = generate(world, create(world, source))
    for who in ("asha", "ben"):
        client = _as(world, who)
        response = client.get(f"/v1/meetings/{source}/minutes-versions")
        assert response.status_code == 200
        assert response.json()[0]["creator_name"] == "Cara Lee"
        assert response.json()[0]["template"] == "technical"
        assert response.json()[0]["can_read"] is False
        assert "executive_summary" not in response.text and "instructions" not in response.text
        assert client.get(f"/v1/minutes-versions/{item['id']}").status_code == 403
        assert client.get("/v1/me/minutes-versions").json() == []
        for action in ("approve", "generate", "sharing"):
            assert client.post(f"/v1/minutes-versions/{item['id']}/{action}", json={"revision": item["revision"]}).status_code == 403
        assert client.delete(f"/v1/minutes-versions/{item['id']}?revision={item['revision']}").status_code == 403


def test_selected_sharing_requires_approval_and_grants_no_transcript(world, source):
    item = share(world, generate(world, create(world, source)), "specific", [world["dan"]])
    assert _as(world, "dan").get(f"/v1/minutes-versions/{item['id']}").status_code == 403
    item = approve(world, item)
    client = _as(world, "dan")
    response = client.get(f"/v1/minutes-versions/{item['id']}")
    assert response.status_code == 200
    assert response.json()["content"]["executive_summary"]
    assert response.json()["guidance"] is None
    assert client.get(f"/v1/meetings/{source}/transcript").status_code == 404
    assert client.get(f"/v1/meetings/{source}/minutes-versions").status_code == 404
    assert client.get("/v1/me/minutes-versions").json()[0]["id"] == item["id"]
    assert _as(world, "ben").get(f"/v1/minutes-versions/{item['id']}").status_code == 403
    share(world, item, "private")
    assert _as(world, "dan").get(f"/v1/minutes-versions/{item['id']}").status_code == 403


def test_workspace_sharing_and_edit_invalidates_review(world, source):
    item = share(world, approve(world, generate(world, create(world, source))), "workspace")
    with world["app"].state.database.session_factory() as session:
        notices = session.execute(select(NotificationRow).where(NotificationRow.link_id == item["id"])).scalars().all()
        jobs = session.execute(select(NotificationEmailRow).where(NotificationEmailRow.link_id == item["id"])).scalars().all()
        assert notices and all(notice.kind == "workspace.minutes.access_changed" for notice in notices)
        assert {job.user_id for job in jobs} == {world[who] for who in ("asha", "ben", "cara", "dan")}
    for who in ("asha", "ben", "dan"):
        assert _as(world, who).get(f"/v1/minutes-versions/{item['id']}").status_code == 200
    response = _as(world, "cara").patch(f"/v1/minutes-versions/{item['id']}", json={"revision": item["revision"],
        "label": "Technical, expanded", "guidance": {"template": "custom", "instructions": "More technical detail"},
        "content": item["content"]})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "draft"
    assert _as(world, "dan").get(f"/v1/minutes-versions/{item['id']}").status_code == 403
    assert _as(world, "dan").get("/v1/me/minutes-versions").json() == []


def test_version_uses_personal_guidance_never_overwrites_organizer_or_joins_bot(world, source):
    first = create(world, source, who="asha", label="Commercial summary")
    item = generate(world, create(world, source))
    request = world["app"].state.minutes_service.generate_draft.call_args
    assert request.kwargs["guidance"].focus_fields == ["Architecture", "Risks"]
    assert request.kwargs["metadata"]["actor_user_id"] == world["cara"]
    assert request.kwargs["metadata"]["purpose"] == "personal_mom"
    assert world["vexa"].spawned == []
    owner = _as(world, "asha")
    assert owner.get(f"/v1/minutes-versions/{first['id']}").json()["content"] is None
    assert owner.get(f"/v1/meetings/{source}/minutes").status_code == 404
    assert len(owner.get(f"/v1/meetings/{source}/minutes-versions").json()) == 2


def test_stale_revision_and_transcript_revoke_shared_reads(world, source):
    item = share(world, approve(world, generate(world, create(world, source))), "workspace")
    response = _as(world, "cara").post(f"/v1/minutes-versions/{item['id']}/sharing", json={"revision": 1})
    assert response.status_code == 409
    with tenant_scope(UUID(world["org"])):
        world["app"].state.repository.replace_transcript(UUID(source), [MeetingTranscriptSegment(segment_id="turn-2", speaker="Ben",
            start_seconds=0, end_seconds=5, text="Corrected transcript.")])
    assert _as(world, "dan").get(f"/v1/minutes-versions/{item['id']}").status_code == 403
    client = _as(world, "cara")
    assert client.get(f"/v1/minutes-versions/{item['id']}").json()["source_is_current"] is False
    assert client.post(f"/v1/minutes-versions/{item['id']}/approve", json={"revision": item["revision"]}).status_code == 409


def test_no_cross_workspace_or_unshared_creation_and_deletion_cascades(world, source):
    assert _as(world, "dan").post(f"/v1/meetings/{source}/minutes-versions", json={"label": "Unauthorized"}).status_code == 404
    item = share(world, approve(world, generate(world, create(world, source))), "specific", [world["dan"]])
    client = _as(world, "ben")
    assert client.post("/v1/workspaces", json={"display_name": "Other organization"}).status_code == 201
    assert client.get(f"/v1/minutes-versions/{item['id']}").status_code == 404
    client = _as(world, "asha")
    assert client.delete(f"/v1/meetings/{source}").status_code == 204
    with world["app"].state.database.session_factory() as session:
        assert session.execute(select(MinutesVersionRow)).scalars().all() == []
        assert session.execute(select(MinutesVersionAccessRow)).scalars().all() == []


def test_personal_background_job_is_private_and_saves_no_content_in_result(world, source):
    item = generate(world, create(world, source))
    client = _as(world, "cara")
    response = client.post(f"/v1/minutes-versions/{item['id']}/jobs", json={"revision": item["revision"]})
    assert response.status_code == 202, response.text
    job_id = response.json()["id"]
    client.portal.call(world["app"].state.background_jobs.wait, UUID(job_id))
    result = client.get(f"/v1/background-jobs/{job_id}")
    assert result.status_code == 200
    assert result.json()["status"] == "succeeded", result.text
    assert result.json()["result"] == {"version_id": item["id"]}
    assert "executive_summary" not in result.text
    assert client.get(f"/v1/minutes-versions/{item['id']}").json()["content"]
    notifications = client.get("/v1/notifications").json()["items"]
    assert any(note["kind"] == "personal_mom.ready" for note in notifications)
    for who in ("asha", "ben", "dan"):
        other = _as(world, who)
        assert other.get(f"/v1/background-jobs/{job_id}").status_code == 404
        assert not any(job["id"] == job_id for job in other.get("/v1/background-jobs").json())


def test_failed_generation_does_not_publish_or_lock_version_and_retry_succeeds(world, source):
    item = create(world, source)
    world["app"].state.minutes_service.generate_draft = AsyncMock(side_effect=MinutesGenerationError("Fake provider failed"))
    client = _as(world, "cara")
    response = client.post(f"/v1/minutes-versions/{item['id']}/generate", json={"revision": item["revision"]})
    assert response.status_code == 502
    latest = client.get(f"/v1/minutes-versions/{item['id']}").json()
    assert latest["content"] is None and latest["status"] == "empty"
    assert generate(world, latest)["status"] == "draft"


def test_selecting_nonmember_cannot_widen_sharing(world, source):
    item = create(world, source)
    from uuid import uuid4
    client = _as(world, "cara")
    response = client.post(f"/v1/minutes-versions/{item['id']}/sharing", json={"revision": item["revision"],
        "visibility": "specific", "user_ids": [str(uuid4())]})
    assert response.status_code == 422
    assert client.get(f"/v1/minutes-versions/{item['id']}").json()["visibility"] == "private"
