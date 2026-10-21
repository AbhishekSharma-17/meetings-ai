"""Automation opt-in, occurrence identity, cancellation and delivery boundaries.

All calendars, captures, generation and email are local fakes; no live integrations.
"""
import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from meetings_contracts import MeetingMinutes, MeetingMinutesDraft, MeetingStatus, MeetingTranscriptSegment, MinutesStatus
from sqlalchemy import func, select, update

from app.adapters.resend import EmailDeliveryError
from app.calendar_automation import AutomationSettings, CalendarAutomationService, occurrence_key
from app.composio_calendar import CalendarConnection, CalendarEvent, CalendarEventsResponse, _event
from app.database import (
    AutomaticMinutesDeliveryRow, CalendarAutomationOccurrenceRow, CalendarAutomationRuleRow,
    CalendarScheduleRow, MeetingAutomationRow, OrganizationMembershipRow, UserRow,
    LEGACY_ADMIN_USER_ID, LEGACY_ORGANIZATION_ID,
)
from app.main import create_app
from app.tenant import tenant_scope


def run(coro):
    return asyncio.run(coro)


class Calendar:
    configured = True

    def __init__(self):
        self.items = []
        self.active = True
        self.truncated = False
        self.calls = 0

    async def connections(self, actor):
        return [CalendarConnection(id="personal", provider="googlecalendar", label="Me", status="ACTIVE")] if self.active else []

    async def events_for_window(self, actor, connection, start, end, timezone):
        self.calls += 1
        return CalendarEventsResponse(events=list(self.items), range_start=start, range_end=end, timezone=timezone, truncated=self.truncated)


def event(identity="one", offset=0, **values):
    start = datetime.now(UTC) + timedelta(hours=2, minutes=offset)
    import hashlib
    code = "".join(chr(97 + value % 26) for value in hashlib.sha256(identity.encode()).digest()[:10])
    return CalendarEvent(connection_id="personal", provider="googlecalendar", event_id=identity,
                         title=identity, starts_at=start, ends_at=start + timedelta(hours=1),
                         meeting_url=f"https://meet.google.com/{code[:3]}-{code[3:7]}-{code[7:]}", platform="google_meet", **values)


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTO_CALENDAR_SCHEDULE_ENABLED", "1")
    monkeypatch.delenv("AUTO_MOM_ENABLED", raising=False)
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'automation.db'}", credential_key="automation-tests")
    calendar = Calendar()
    app.state.calendar_automation.calendar = calendar
    app.state.calendar_schedule.calendar = calendar
    client = TestClient(app)  # no lifespan/background loops
    settings = {"enabled": True, "connection_ids": ["personal"], "recording_disclosure_acknowledged": True}
    yield SimpleNamespace(app=app, client=client, calendar=calendar, settings=settings, automation=app.state.calendar_automation, monkeypatch=monkeypatch)
    client.close()
    app.state.database.engine.dispose()


def rows(setup, cls):
    with setup.app.state.database.session_factory() as session:
        return session.execute(select(cls)).scalars().all()


def save(setup, **changes):
    response = setup.client.put("/v1/calendar/automation", json={**setup.settings, **changes})
    assert response.status_code == 200, response.text
    return response.json()


def scan(setup):
    response = setup.client.post("/v1/calendar/automation/reconcile")
    assert response.status_code == 200, response.text
    return response.json()


def test_defaults_off_preview_has_no_writes_and_batch_scan_deduplicates_restart_and_move(setup):
    defaults = setup.client.get("/v1/calendar/automation").json()
    assert not defaults["enabled"] and defaults["knowledge_base_id"] is None
    assert defaults["availability"]["auto_mom_enabled"] is False
    setup.calendar.items = [event()]
    preview = setup.client.post("/v1/calendar/automation/preview", json=setup.settings)
    assert preview.status_code == 200 and len(preview.json()["eligible"]) == 1
    assert not rows(setup, CalendarAutomationRuleRow) and not rows(setup, CalendarAutomationOccurrenceRow)
    save(setup)
    assert scan(setup)["scheduled"] == 1
    setup.calendar.items = [setup.calendar.items[0].model_copy(update={"starts_at": datetime.now(UTC) + timedelta(days=2)})]
    assert scan(setup)["scheduled"] == 0
    assert len(rows(setup, CalendarScheduleRow)) == 1
    assert setup.calendar.calls == 3  # one read per scan, no per-event re-fetch
    original = setup.automation
    setup.automation = CalendarAutomationService(original.database, original.calendar, original.schedules, original.meetings, original.worker, original.minutes, original.knowledge_bases)
    actor = setup.automation._actor(str(LEGACY_ORGANIZATION_ID), str(LEGACY_ADMIN_USER_ID))
    assert run(setup.automation.reconcile(actor))["scheduled"] == 0


def test_newly_discovered_complete_baseline_and_truncation(setup):
    setup.calendar.items = [event("existing")]
    save(setup, enrolment_scope="newly_discovered")
    setup.calendar.truncated = True
    assert scan(setup)["scheduled"] == 0
    assert not rows(setup, CalendarAutomationOccurrenceRow)
    assert rows(setup, CalendarAutomationRuleRow)[0].baselined_connections == []
    setup.calendar.truncated = False
    assert scan(setup)["scheduled"] == 0
    assert rows(setup, CalendarAutomationRuleRow)[0].baselined_connections == ["personal"]
    setup.calendar.items.append(event("new", offset=20))
    assert scan(setup)["scheduled"] == 1
    assert scan(setup)["scheduled"] == 0


def test_recurrence_filter_and_declined_invite(setup):
    setup.calendar.items = [event("one"), event("recurring", 10, is_recurring=True), event("declined", 20, self_response_status="declined")]
    save(setup, meeting_types="recurring")
    assert scan(setup)["scheduled"] == 1
    assert rows(setup, CalendarScheduleRow)[0].event_id == "recurring"
    save(setup, meeting_types="all")
    assert scan(setup)["scheduled"] == 1  # type exclusions can be changed, prior enrolment cannot duplicate


def test_skip_pause_and_no_rejection_resurrection(setup):
    setup.calendar.items = [event()]
    save(setup)
    scan(setup)
    schedule = rows(setup, CalendarScheduleRow)[0]
    response = setup.client.patch(f"/v1/meetings/{schedule.meeting_id}/automation", json={"skip": True})
    assert response.status_code == 200 and response.json()["skip"]
    assert rows(setup, CalendarScheduleRow)[0].status == "cancelled"
    assert scan(setup)["scheduled"] == 0
    save(setup, enabled=False)
    save(setup)
    assert scan(setup)["scheduled"] == 0


@pytest.mark.parametrize("revoke", ["rule", "connection", "membership", "role"])
def test_join_guard_revocation_fails_closed(setup, revoke):
    setup.calendar.items = [event()]
    save(setup)
    scan(setup)
    schedule = rows(setup, CalendarScheduleRow)[0]
    if revoke == "rule":
        save(setup, enabled=False)
    elif revoke == "connection":
        setup.calendar.active = False
    else:
        with setup.app.state.database.session_factory.begin() as session:
            membership = session.get(OrganizationMembershipRow, (str(LEGACY_ORGANIZATION_ID), str(LEGACY_ADMIN_USER_ID)))
            if revoke == "membership":
                session.delete(membership)
            else:
                membership.role = "viewer"
    assert not run(setup.automation.allow_join(schedule.meeting_id))
    assert rows(setup, CalendarScheduleRow)[0].status == "cancelled"
    assert run(setup.automation.allow_join(str(uuid4())))  # manual records unchanged


def test_disable_never_cancels_joined_call_and_can_pause_after_authorization_revoked(setup):
    setup.calendar.items = [event()]
    save(setup)
    scan(setup)
    with setup.app.state.database.session_factory.begin() as session:
        schedule = session.get(CalendarScheduleRow, rows(setup, CalendarScheduleRow)[0].meeting_id)
        schedule.status = "joined"
    save(setup, enabled=False, mom_mode="send_automatically", knowledge_base_id=str(uuid4()), delivery={"internal_group_ids": [str(uuid4())]})
    assert rows(setup, CalendarScheduleRow)[0].status == "joined"


def test_cap_defers_without_tombstoning_extra_occurrences(setup, monkeypatch):
    monkeypatch.setattr("app.calendar_automation.MAX_SCHEDULES_PER_SCAN", 2)
    setup.calendar.items = [event("later", 40), event("first", 0), event("second", 20)]
    save(setup)
    assert scan(setup)["scheduled"] == 2
    assert {row.event_id for row in rows(setup, CalendarScheduleRow)} == {"first", "second"}
    assert len(rows(setup, CalendarAutomationOccurrenceRow)) == 2
    assert scan(setup)["scheduled"] == 1


def test_binding_precedes_schedule_and_failed_binding_leaves_no_pending_join(setup, monkeypatch):
    setup.calendar.items = [event()]
    save(setup)
    def fail_source(actor, meeting_id, source):
        assert any(row.meeting_id == str(meeting_id) for row in rows(setup, MeetingAutomationRow))
        raise RuntimeError("simulated crash after durable automation binding")
    monkeypatch.setattr(setup.app.state.calendar_schedule, "_save_source", fail_source)
    result = scan(setup)
    assert result["scheduled"] == 0 and result["errors"]
    assert not rows(setup, CalendarScheduleRow)
    assert rows(setup, CalendarAutomationOccurrenceRow)[0].status == "failed"
    assert scan(setup)["scheduled"] == 0


def test_metadata_keeps_zoom_series_semantics_distinct():
    connection = CalendarConnection(id="personal", provider="googlecalendar", label="Me", status="ACTIVE")
    parsed = _event({"id": "instance", "recurringEventId": "series", "originalStartTime": {"dateTime": "2026-11-01T10:00:00Z"},
                     "attendees": [{"self": True, "responseStatus": "declined"}], "hangoutLink": "https://meet.google.com/abc-defg-hij",
                     "start": {"dateTime": "2026-11-02T10:00:00Z"}, "end": {"dateTime": "2026-11-02T11:00:00Z"}}, connection, "UTC")
    assert parsed.is_recurring and not parsed.series
    assert parsed.series_id == "series" and parsed.self_response_status == "declined"
    assert occurrence_key(parsed) == occurrence_key(parsed.model_copy(update={"starts_at": datetime.now(UTC)}))


def test_declined_then_accepted_is_reevaluated_and_zoom_instances_have_full_identity(setup):
    setup.calendar.items = [event(self_response_status="declined")]
    save(setup)
    assert scan(setup)["scheduled"] == 0
    assert not rows(setup, CalendarAutomationOccurrenceRow)
    setup.calendar.items = [setup.calendar.items[0].model_copy(update={"self_response_status": "accepted"})]
    assert scan(setup)["scheduled"] == 1
    first = event("zoom-series", series=True, original_starts_at=datetime(2026, 11, 1, 9, tzinfo=UTC))
    second = first.model_copy(update={"original_starts_at": first.original_starts_at + timedelta(hours=3)})
    assert occurrence_key(first) != occurrence_key(second)


def prepare_delivery(setup):
    setup.monkeypatch.setenv("AUTO_MOM_ENABLED", "1")
    # Existing local owner has no email; assign a local test address and create an internal team.
    with setup.app.state.database.session_factory.begin() as session:
        session.get(UserRow, str(LEGACY_ADMIN_USER_ID)).email = "leader@example.test"
    team = setup.client.post("/v1/workspace/teams", json={"name": "Leadership", "members": [{"user_id": str(LEGACY_ADMIN_USER_ID)}]}).json()
    policy = setup.client.put("/v1/workspace/automation-policy", json={"automatic_delivery_enabled": True, "allowed_group_ids": [team["id"]]})
    assert policy.status_code == 200, policy.text
    setup.calendar.items = [event()]
    save(setup, mom_mode="send_automatically", delivery={"internal_group_ids": [team["id"]]})
    assert scan(setup)["scheduled"] == 1
    meeting_id = UUID(rows(setup, CalendarScheduleRow)[0].meeting_id)
    repository = setup.app.state.repository
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        meeting = repository.get_meeting(meeting_id)
        meeting.status, meeting.vexa_meeting_id, meeting.joined_at = MeetingStatus.COMPLETED, 123, datetime.now(UTC)
        repository.save_meeting(meeting)
        repository.replace_transcript(meeting_id, [MeetingTranscriptSegment(start_seconds=0, end_seconds=30, text="The meeting agreed to proceed with the plan.", completed=True)])
        repository.save_minutes(MeetingMinutes(meeting_id=meeting_id, title="Recap", executive_summary="Agreed to proceed."))
        repository.save_minutes_source_revision(meeting_id, repository.get_transcript_revision(meeting_id))
        setup.automation.generated(meeting_id)
    return meeting_id, team


def deliver(setup, meeting_id):
    state = next(row for row in rows(setup, MeetingAutomationRow) if row.meeting_id == str(meeting_id))
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        run(setup.automation._deliver(state))


def test_delivery_freezes_recipient_approval_and_retries_same_key(setup, monkeypatch):
    meeting_id, team = prepare_delivery(setup)
    send = AsyncMock(side_effect=[EmailDeliveryError("temporary failure"), "mail-123"])
    monkeypatch.setattr(setup.app.state.minutes_service.resend, "send", send)
    deliver(setup, meeting_id)
    first = rows(setup, AutomaticMinutesDeliveryRow)[0]
    assert first.status == "retry" and first.attempts == 1
    with setup.app.state.database.session_factory.begin() as session:
        session.get(AutomaticMinutesDeliveryRow, str(meeting_id)).next_retry_at = None
    deliver(setup, meeting_id)
    assert rows(setup, AutomaticMinutesDeliveryRow)[0].status == "sent"
    assert send.await_count == 2
    assert send.call_args_list[0].kwargs["idempotency_key"] == send.call_args_list[1].kwargs["idempotency_key"]
    assert send.call_args_list[0].kwargs["recipients"] == ["leader@example.test"]
    deliver(setup, meeting_id)
    assert send.await_count == 2


def test_completed_capture_uses_finalized_turns_despite_provisional_tail(setup, monkeypatch):
    meeting_id, _ = prepare_delivery(setup)
    repository = setup.app.state.repository
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        finalized = repository.get_transcript(meeting_id)
        repository.replace_transcript(meeting_id, [*finalized, MeetingTranscriptSegment(
            segment_id="unfinished-tail", start_seconds=31, end_seconds=32,
            text="Unfinished provisional text", completed=False,
        )])
        # The automatic draft's input is the finalized subset of this revision.
        repository.save_minutes_source_revision(meeting_id, repository.get_transcript_revision(meeting_id))
        setup.automation.generated(meeting_id)
    send = AsyncMock(return_value="finalized-mail")
    monkeypatch.setattr(setup.app.state.minutes_service.resend, "send", send)
    deliver(setup, meeting_id)
    assert rows(setup, AutomaticMinutesDeliveryRow)[0].status == "sent"
    assert send.await_count == 1


@pytest.mark.parametrize("change", ["manual_edit", "manual_draft", "policy", "team", "transcript", "hold", "no_admission"])
def test_automatic_delivery_fails_closed_when_authorization_or_content_changes(setup, monkeypatch, change):
    meeting_id, team = prepare_delivery(setup)
    send = AsyncMock(return_value="must-not-send")
    monkeypatch.setattr(setup.app.state.minutes_service.resend, "send", send)
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        if change == "manual_edit":
            minutes = setup.app.state.repository.get_minutes(meeting_id)
            minutes.executive_summary = "Human edited"
            setup.app.state.repository.save_minutes(minutes)
        elif change == "manual_draft":
            with setup.app.state.database.session_factory.begin() as session:
                session.get(MeetingAutomationRow, str(meeting_id)).generated_fingerprint = None
        elif change == "policy":
            setup.client.put("/v1/workspace/automation-policy", json={"automatic_delivery_enabled": False})
        elif change == "team":
            setup.client.delete(f"/v1/workspace/teams/{team['id']}")
        elif change == "transcript":
            setup.app.state.repository.replace_transcript(meeting_id, [MeetingTranscriptSegment(start_seconds=0, end_seconds=20, text="Different recording now.", completed=True)])
        elif change == "hold":
            setup.client.patch(f"/v1/meetings/{meeting_id}/automation", json={"hold_delivery": True})
        else:
            meeting = setup.app.state.repository.get_meeting(meeting_id)
            meeting.joined_at = None
            setup.app.state.repository.save_meeting(meeting)
    deliver(setup, meeting_id)
    send.assert_not_awaited()


def test_manual_stop_suspends_email_but_natural_stop_service_is_unchanged(setup, monkeypatch):
    meeting_id, _ = prepare_delivery(setup)
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        meeting = setup.app.state.repository.get_meeting(meeting_id)
    monkeypatch.setattr(setup.app.state.meeting_service, "stop", AsyncMock(return_value=meeting))
    send = AsyncMock()
    monkeypatch.setattr(setup.app.state.minutes_service.resend, "send", send)
    response = setup.client.post(f"/v1/meetings/{meeting_id}/stop")
    assert response.status_code == 200
    state = setup.client.get(f"/v1/meetings/{meeting_id}/automation").json()
    assert "stopped manually" in state["last_error"]
    deliver(setup, meeting_id)
    send.assert_not_awaited()


def test_approval_and_intent_roll_back_together_then_resume_after_commit(setup, monkeypatch):
    meeting_id, _ = prepare_delivery(setup)
    repository = setup.app.state.repository
    original = repository.save_minutes
    def interrupted(minutes, **kwargs):
        original_callback = kwargs["on_save"]
        def crash(session, saved):
            original_callback(session, saved)
            raise RuntimeError("crash before approval and intent commit")
        return original(minutes, **{**kwargs, "on_save": crash})
    monkeypatch.setattr(repository, "save_minutes", interrupted)
    with pytest.raises(RuntimeError, match="before approval"):
        deliver(setup, meeting_id)
    assert not rows(setup, AutomaticMinutesDeliveryRow)
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        assert repository.get_minutes(meeting_id).status == MinutesStatus.DRAFT
    monkeypatch.setattr(repository, "save_minutes", original)
    original_update = setup.automation._delivery_update
    def crash_after_commit(*args, **kwargs):
        if kwargs.get("status") == "sending":
            raise RuntimeError("crash after approval and intent commit")
        return original_update(*args, **kwargs)
    monkeypatch.setattr(setup.automation, "_delivery_update", crash_after_commit)
    with pytest.raises(RuntimeError, match="after approval"):
        deliver(setup, meeting_id)
    pending = rows(setup, AutomaticMinutesDeliveryRow)[0]
    assert pending.status == "pending"
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        assert repository.get_minutes(meeting_id).approved_at.isoformat() == pending.frozen["approved_at"]
    send = AsyncMock(return_value="recovered-mail")
    monkeypatch.setattr(setup.app.state.minutes_service.resend, "send", send)
    monkeypatch.setattr(setup.automation, "_delivery_update", original_update)
    deliver(setup, meeting_id)
    assert rows(setup, AutomaticMinutesDeliveryRow)[0].status == "sent"
    assert send.await_count == 1


def test_automatic_draft_source_and_provenance_commit_atomically(setup, monkeypatch):
    meeting_id, _ = prepare_delivery(setup)
    repository = setup.app.state.repository
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        repository.delete_minutes(meeting_id)
        revision = repository.get_transcript_revision(meeting_id)
    with setup.app.state.database.session_factory.begin() as session:
        state = session.get(MeetingAutomationRow, str(meeting_id))
        state.generated_fingerprint, state.source_revision = None, None
    draft = MeetingMinutesDraft(title="Automatic draft", executive_summary="Captured the plan.")
    monkeypatch.setattr(setup.app.state.minutes_service, "generate_draft", AsyncMock(return_value=(draft, SimpleNamespace(id=None), SimpleNamespace(provider="fake", model="fake"), revision)))
    persist = setup.automation.persist_generated
    def crash(session, minutes, source_revision):
        persist(session, minutes, source_revision)
        raise RuntimeError("crash before generated MOM transaction commits")
    monkeypatch.setattr(setup.automation, "persist_generated", crash)
    with tenant_scope(LEGACY_ORGANIZATION_ID), pytest.raises(RuntimeError, match="generated MOM"):
        run(setup.app.state.minutes_service.generate(meeting_id, automated=True))
    from app.repository import MinutesNotFoundError
    with tenant_scope(LEGACY_ORGANIZATION_ID), pytest.raises(MinutesNotFoundError):
        repository.get_minutes(meeting_id)
    assert rows(setup, MeetingAutomationRow)[0].generated_fingerprint is None
    monkeypatch.setattr(setup.automation, "persist_generated", persist)
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        run(setup.app.state.minutes_service.generate(meeting_id, automated=True))
        assert repository.get_minutes_source_revision(meeting_id) == revision
    assert rows(setup, MeetingAutomationRow)[0].generated_fingerprint


def test_guard_rereads_rule_after_calendar_await(setup, monkeypatch):
    setup.calendar.items = [event()]
    save(setup)
    scan(setup)
    schedule = rows(setup, CalendarScheduleRow)[0]
    original = setup.calendar.connections
    async def revoke_during_lookup(actor):
        with setup.app.state.database.session_factory.begin() as session:
            row = session.get(CalendarAutomationRuleRow, (str(LEGACY_ORGANIZATION_ID), str(LEGACY_ADMIN_USER_ID)))
            row.settings = {**row.settings, "enabled": False}
        return await original(actor)
    monkeypatch.setattr(setup.calendar, "connections", revoke_during_lookup)
    assert not run(setup.automation.allow_join(schedule.meeting_id))
    assert rows(setup, CalendarScheduleRow)[0].status == "cancelled"


def test_separate_service_scan_lease_prevents_concurrent_duplicate_enrolment(setup, monkeypatch):
    setup.calendar.items = [event()]
    save(setup)
    original = setup.automation
    second = CalendarAutomationService(original.database, original.calendar, original.schedules, original.meetings, original.worker, original.minutes, original.knowledge_bases)
    actor = original._actor(str(LEGACY_ORGANIZATION_ID), str(LEGACY_ADMIN_USER_ID))
    async def concurrent():
        started, release = asyncio.Event(), asyncio.Event()
        real_scans = original._scans
        async def slow_scans(*args):
            started.set()
            await release.wait()
            return await real_scans(*args)
        monkeypatch.setattr(original, "_scans", slow_scans)
        first_task = asyncio.create_task(original.reconcile(actor))
        await started.wait()
        other = await second.reconcile(actor)
        assert other["scheduled"] == 0 and "in progress" in other["errors"][0]
        release.set()
        assert (await first_task)["scheduled"] == 1
    run(concurrent())
    assert len(rows(setup, CalendarScheduleRow)) == 1


def test_policy_revocation_at_email_adapter_boundary_holds_delivery(setup, monkeypatch):
    meeting_id, _ = prepare_delivery(setup)
    send = AsyncMock(return_value="must-not-send")
    monkeypatch.setattr(setup.app.state.minutes_service.resend, "send", send)
    original = setup.automation._before_email
    def revoke_at_boundary(state, frozen):
        from app.database import WorkspaceAutomationPolicyRow
        with setup.app.state.database.session_factory.begin() as session:
            policy = session.get(WorkspaceAutomationPolicyRow, str(LEGACY_ORGANIZATION_ID))
            policy.settings = {**policy.settings, "automatic_delivery_enabled": False}
        original(state, frozen)
    monkeypatch.setattr(setup.automation, "_before_email", revoke_at_boundary)
    deliver(setup, meeting_id)
    send.assert_not_awaited()
    assert rows(setup, AutomaticMinutesDeliveryRow)[0].status == "held"


def test_external_teams_are_rejected_and_disabled_policy_is_always_saveable(setup):
    team = setup.client.post("/v1/workspace/teams", json={"name": "External group", "members": [{"email": "outside@example.test"}]}).json()
    assert setup.client.put("/v1/workspace/automation-policy", json={"automatic_delivery_enabled": True, "allowed_group_ids": [team["id"]]}).status_code == 422
    assert setup.client.put("/v1/workspace/automation-policy", json={"automatic_delivery_enabled": False, "allowed_group_ids": [str(uuid4())]}).status_code == 200


def test_database_call_claim_prevents_race_even_when_coverage_snapshot_is_stale(setup, monkeypatch):
    first = event("source-a")
    second = event("source-b").model_copy(update={"starts_at": first.starts_at, "ends_at": first.ends_at,
                    "meeting_url": first.meeting_url.upper().replace("HTTPS", "https") + "?authuser=1"})
    setup.calendar.items = [first, second]
    save(setup)
    # Simulate both requests seeing the same old coordination/source snapshot.
    monkeypatch.setattr(setup.app.state.calendar_schedule, "_assert_not_imported", lambda *args, **kwargs: None)
    monkeypatch.setattr(setup.app.state.call_coordination, "check", lambda *args: SimpleNamespace(assistants=[], your_assistants=[]))
    assert scan(setup)["scheduled"] == 1
    assert len(rows(setup, CalendarScheduleRow)) == 1
    assert len(rows(setup, CalendarAutomationOccurrenceRow)) == 1


def test_deleted_or_inaccessible_base_is_not_a_server_error(setup):
    payload = {**setup.settings, "knowledge_enabled": True, "knowledge_base_id": str(uuid4())}
    assert setup.client.put("/v1/calendar/automation", json=payload).status_code == 404
    assert setup.client.post("/v1/calendar/automation/preview", json=payload).status_code == 404
    payload["enabled"] = False
    assert setup.client.put("/v1/calendar/automation", json=payload).status_code == 200


def test_manual_regeneration_holds_delivery_before_awaiting_final_capture(setup, monkeypatch):
    meeting_id, _ = prepare_delivery(setup)
    with tenant_scope(LEGACY_ORGANIZATION_ID):
        draft = setup.app.state.repository.get_minutes(meeting_id)
    async def capture(_meeting_id):
        assert "regeneration requested manually" in rows(setup, MeetingAutomationRow)[0].suspended_reason
        return []
    monkeypatch.setattr(setup.app.state.meeting_service, "transcript", capture)
    monkeypatch.setattr(setup.app.state.minutes_service, "generate", AsyncMock(return_value=draft))
    send = AsyncMock()
    monkeypatch.setattr(setup.app.state.minutes_service.resend, "send", send)
    response = setup.client.post(f"/v1/meetings/{meeting_id}/minutes/generate")
    assert response.status_code == 200, response.text
    deliver(setup, meeting_id)
    send.assert_not_awaited()
