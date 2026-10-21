"""Manual recap review remains available only to a member owning that meeting."""
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock
from uuid import UUID

from meetings_contracts import MeetingMinutes, MeetingStatus, MeetingTranscriptSegment

from app.tenant import tenant_scope
from test_call_coordination import world, _as, _schedule, LINK


def test_member_owned_minutes_controls_do_not_grant_teammates_or_viewers_access(world, monkeypatch):
    client = _as(world, "cara")
    meeting_id = _schedule(client, LINK, datetime.now(UTC) + timedelta(hours=2))
    app, repository = world["app"], world["app"].state.repository
    with tenant_scope(UUID(world["org"])):
        meeting = repository.get_meeting(UUID(meeting_id))
        meeting.status = MeetingStatus.COMPLETED
        repository.save_meeting(meeting)
        repository.replace_transcript(meeting.id, [MeetingTranscriptSegment(segment_id="s1", start_seconds=0, end_seconds=10, text="We agreed to proceed.", completed=True)])
        repository.save_minutes(MeetingMinutes(meeting_id=meeting.id, title="Owner recap", executive_summary="We agreed to proceed."))
        repository.save_minutes_source_revision(meeting.id, repository.get_transcript_revision(meeting.id))
    for suffix in ("minutes", "mom-guidance", "delivery-settings", "post-meeting-job"):
        assert client.get(f"/v1/meetings/{meeting_id}/{suffix}").status_code == 200
    assert client.get("/v1/integrations/resend/status").status_code == 200
    assert client.put(f"/v1/meetings/{meeting_id}/minutes", json={"title": "Reviewed recap", "executive_summary": "A member owner reviewed this."}).status_code == 200
    assert client.post(f"/v1/meetings/{meeting_id}/minutes/approve").status_code == 200
    monkeypatch.setattr(app.state.minutes_service.resend, "send", AsyncMock(return_value="owner-mail"))
    assert client.post(f"/v1/meetings/{meeting_id}/minutes/send", json={"recipients": ["explicit@example.test"]}).status_code == 200

    other = _as(world, "dan")
    for method, suffix in (("GET", "minutes"), ("PUT", "minutes"), ("DELETE", "minutes"),
                           ("POST", "minutes/generate"), ("POST", "minutes/approve"),
                           ("POST", "minutes/send"), ("POST", "minutes/send-configured"),
                           ("POST", "minutes/jobs"), ("POST", "post-meeting-job/retry")):
        assert other.request(method, f"/v1/meetings/{meeting_id}/{suffix}", json={}).status_code == 403
    # Workspace viewers cannot use an owner's controls even if the saved owner id is theirs.
    owner = _as(world, "asha")
    assert owner.patch(f"/v1/workspace/members/{world['cara']}/role", json={"role": "viewer"}).status_code == 200
    viewer = _as(world, "cara")
    assert viewer.get(f"/v1/meetings/{meeting_id}/minutes").status_code == 403
    assert viewer.post(f"/v1/meetings/{meeting_id}/minutes/jobs").status_code == 403
    # A newly created workspace cannot resolve the old workspace's meeting.
    outsider = _as(world, "dan")
    created = outsider.post("/v1/workspaces", json={"display_name": "Other workspace"})
    assert created.status_code == 201, created.text
    assert outsider.get(f"/v1/meetings/{meeting_id}/minutes").status_code == 404


def test_member_personal_automation_is_separate_from_admin_delivery_authorization(world, monkeypatch):
    monkeypatch.setenv("AUTO_CALENDAR_SCHEDULE_ENABLED", "1")
    world["calendar"].configured = True
    from test_call_coordination import _event
    world["calendar"].events[world["cara"]] = [_event("Member call", datetime.now(UTC) + timedelta(hours=2))]
    member = _as(world, "cara")
    payload = {"enabled": True, "connection_ids": ["google"], "recording_disclosure_acknowledged": True}
    response = member.put("/v1/calendar/automation", json=payload)
    assert response.status_code == 200, response.text
    assert not response.json()["can_manage_policy"]
    assert member.put("/v1/workspace/automation-policy", json={"automatic_delivery_enabled": True}).status_code == 403
    assert member.post("/v1/calendar/automation/reconcile").json()["scheduled"] == 1
    teammate = _as(world, "dan")
    assert teammate.get("/v1/calendar/automation").json()["enabled"] is False
    from app.database import MeetingAutomationRow
    with world["app"].state.database.session_factory() as session:
        state = session.query(MeetingAutomationRow).one()
        meeting_id = state.meeting_id
    assert teammate.get(f"/v1/meetings/{meeting_id}/automation").status_code == 404
    assert teammate.patch(f"/v1/meetings/{meeting_id}/automation", json={"skip": True}).status_code == 404
    owner = _as(world, "asha")
    group = owner.post("/v1/workspace/teams", json={"name": "Internal leadership", "members": [{"user_id": world["asha"]}]}).json()
    policy = owner.put("/v1/workspace/automation-policy", json={"automatic_delivery_enabled": True, "allowed_group_ids": [group["id"]]})
    assert policy.status_code == 200, policy.text
    member = _as(world, "cara")
    response = member.put("/v1/calendar/automation", json={**payload, "mom_mode": "send_automatically", "delivery": {"internal_group_ids": [group["id"]]}})
    assert response.status_code == 200 and response.json()["can_auto_send"]
    owner = _as(world, "asha")
    assert owner.patch(f"/v1/workspace/members/{world['cara']}/role", json={"role": "viewer"}).status_code == 200
    viewer = _as(world, "cara")
    assert viewer.put("/v1/calendar/automation", json=payload).status_code == 403
