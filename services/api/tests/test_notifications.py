"""Notification center: emit, dedupe, tenant isolation, read state, and hooks in existing flows."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
from account_links import accept_invite
from app.adapters.vexa import VexaCaptureAdapter
from app.database import (
    LEGACY_ADMIN_USER_ID,
    LEGACY_ORGANIZATION_ID,
    CalendarScheduleRow,
    Database,
    NotificationRow,
    OrganizationMembershipRow,
    OrganizationRow,
    UserRow,
)
from app.main import create_app
from app.notification_events import NotificationEvents
from app.notifications import NotificationService
from fastapi.testclient import TestClient
from meetings_contracts import (
    MeetingStatus,
    MeetingTranscriptSegment,
    ProviderType,
    TextGenerationResult,
)


def _database() -> Database:
    database = Database("sqlite+pysqlite:///:memory:")
    database.migrate()
    return database


def _add_user(database: Database, organization_id: str, role: str, *, new_org: bool = False) -> str:
    now = datetime.now(UTC)
    user_id = str(uuid4())
    with database.session_factory.begin() as session:
        if new_org:
            session.add(OrganizationRow(id=organization_id, slug=f"org-{organization_id[:8]}", display_name="Other",
                                        contact_email=None, status="active", created_at=now, updated_at=now))
            session.flush()
        session.add(UserRow(id=user_id, email=f"{user_id[:8]}@example.test", display_name="Person",
                            auth_subject=f"local:{user_id}", status="active", created_at=now, updated_at=now))
        session.flush()
        session.add(OrganizationMembershipRow(organization_id=organization_id, user_id=user_id, role=role, created_at=now))
    return user_id


class _Actor:
    def __init__(self, organization_id, user_id):
        self.organization_id, self.user_id = UUID(str(organization_id)), UUID(str(user_id))


def test_notify_dedupes_resolves_roles_and_never_crosses_workspaces() -> None:
    database = _database()
    service = NotificationService(database)
    legacy = str(LEGACY_ORGANIZATION_ID)
    member = _add_user(database, legacy, "member")
    other_org = str(uuid4())
    outsider = _add_user(database, other_org, "owner", new_org=True)

    created = service.notify(legacy, roles=("owner", "admin"), user_ids=[member, outsider], kind="assistant.joined",
                             severity="success", title="Assistant joined", dedupe_key="meeting:1:status:active")
    assert created == 2  # the legacy owner and the member; the outsider is not in this workspace
    assert service.notify(legacy, roles=("owner", "admin"), user_ids=[member], kind="assistant.joined",
                          severity="success", title="Assistant joined", dedupe_key="meeting:1:status:active") == 0
    assert service.notify(legacy, user_ids=[], kind="x", title="Nobody") == 0
    assert service.notify(legacy, user_ids=[member], kind="x", severity="nonsense", title="Coerced") == 1

    owner = _Actor(legacy, LEGACY_ADMIN_USER_ID)
    stranger = _Actor(other_org, outsider)
    assert service.unread_count(owner) == 1
    assert service.unread_count(_Actor(legacy, member)) == 2
    assert service.unread_count(stranger) == 0
    note = service.list(owner).items[0]
    try:
        service.mark_read(stranger, note.id)
    except LookupError:
        pass
    else:
        raise AssertionError("another workspace must not read this notification")
    coerced = service.list(_Actor(legacy, member)).items[0]
    assert coerced.severity == "info"


def test_notify_failure_never_raises() -> None:
    service = NotificationService(_database())
    service.database = None  # any storage failure
    assert service.notify(LEGACY_ORGANIZATION_ID, roles=("owner",), kind="x", title="Safe") == 0


def test_notification_api_read_unread_read_all_delete_and_cursor() -> None:
    app = create_app(database_url="sqlite+pysqlite:///:memory:", credential_key="test-key")
    notifications = app.state.notifications
    with TestClient(app) as client:
        for index in range(5):
            notifications.notify(LEGACY_ORGANIZATION_ID, user_ids=[LEGACY_ADMIN_USER_ID], kind="test",
                                 severity="info", title=f"Note {index}", dedupe_key=f"note-{index}")
        assert client.get("/v1/notifications/unread-count").json() == {"unread_count": 5}
        first = client.get("/v1/notifications", params={"limit": 2}).json()
        assert [item["title"] for item in first["items"]] == ["Note 4", "Note 3"]
        assert first["next_cursor"]
        second = client.get("/v1/notifications", params={"limit": 2, "cursor": first["next_cursor"]}).json()
        seen = {item["id"] for item in first["items"]} | {item["id"] for item in second["items"]}
        assert len(seen) == 4
        target = first["items"][0]["id"]
        read = client.post(f"/v1/notifications/{target}/read")
        assert read.status_code == 200 and read.json()["read_at"]
        assert client.get("/v1/notifications/unread-count").json()["unread_count"] == 4
        unread = client.get("/v1/notifications", params={"unread": True}).json()
        assert target not in {item["id"] for item in unread["items"]}
        assert client.delete(f"/v1/notifications/{target}").status_code == 204
        assert client.delete(f"/v1/notifications/{target}").status_code == 404
        assert client.post("/v1/notifications/read-all").json() == {"unread_count": 0}
        assert client.post(f"/v1/notifications/{uuid4()}/read").status_code == 404
        # Reading notifications is not recorded as workspace activity.
        assert not [event for event in client.get("/v1/workspace/audit").json() if "notifications" in event["action"]]


def test_members_and_viewers_reach_their_own_notifications(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "owner-password-for-test")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", "developer@genaiprotos.com")
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'notes.db'}", credential_key="test-key")
    with TestClient(app) as client:
        client.post("/v1/auth/login", json={"email": "developer@genaiprotos.com", "password": "owner-password-for-test"})
        owner = client.get("/v1/auth/me").json()
        invited = client.post("/v1/workspace/invite", json={
            "email": "viewer@example.com", "display_name": "View Only", "role": "viewer"}).json()
        viewer_id = invited["account"]["user_id"]
        app.state.notifications.notify(owner["organization_id"], user_ids=[owner["user_id"]], kind="x", title="Owner only")
        app.state.notifications.notify(owner["organization_id"], user_ids=[viewer_id], kind="x", title="For the viewer")
        client.post("/v1/auth/logout")
        accept_invite(client, invited, "a-very-long-new-password")
        page = client.get("/v1/notifications")
        assert page.status_code == 200
        assert [item["title"] for item in page.json()["items"]] == ["For the viewer", "Welcome to GenAI Protos"]
        note_id = page.json()["items"][0]["id"]
        assert client.post(f"/v1/notifications/{note_id}/read").status_code == 200
        assert client.post("/v1/notifications/read-all").status_code == 200
        assert client.delete(f"/v1/notifications/{note_id}").status_code == 204
        assert client.get("/v1/background-jobs").json() == []
        assert client.post(f"/v1/background-jobs/{uuid4()}/cancel").status_code == 404


def _vexa(statuses: list[str]) -> VexaCaptureAdapter:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/bots":
            return httpx.Response(201, json={"id": 42, "platform": "google_meet",
                                             "native_meeting_id": "abc-defg-hij", "status": "awaiting_admission"})
        if request.method == "GET" and request.url.path == "/meetings/42":
            status = statuses.pop(0) if len(statuses) > 1 else statuses[0]
            return httpx.Response(200, json={"id": 42, "status": status, "failure_reason": "bot was removed"})
        raise AssertionError(f"unexpected Vexa request: {request.method} {request.url.path}")
    return VexaCaptureAdapter("http://vexa.test", transport=httpx.MockTransport(handler))


def test_meeting_status_transitions_notify_admins_once_each() -> None:
    app = create_app(database_url="sqlite+pysqlite:///:memory:", credential_key="test-key",
                     vexa_adapter=_vexa(["active", "active", "needs_help", "completed"]))
    with TestClient(app) as client:
        meeting_id = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij", "title": "Board sync"}).json()["id"]
        assert client.post(f"/v1/meetings/{meeting_id}/join").status_code == 200
        for _ in range(4):  # detail polling repeats statuses; each fact is announced once
            client.post(f"/v1/meetings/{meeting_id}/refresh")
        kinds = [item["kind"] for item in reversed(client.get("/v1/notifications").json()["items"])]
        assert kinds == ["assistant.lobby", "assistant.joined", "assistant.attention", "assistant.capture_finished"]
        joined = next(item for item in client.get("/v1/notifications").json()["items"] if item["kind"] == "assistant.joined")
        assert joined["link_view"] == "meeting" and joined["link_id"] == meeting_id and joined["meeting_id"] == meeting_id
        assert "Board sync" in joined["title"]


def test_failed_join_notifies_with_the_reason() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"detail": "capture service unavailable"})
    app = create_app(database_url="sqlite+pysqlite:///:memory:", credential_key="test-key",
                     vexa_adapter=VexaCaptureAdapter("http://vexa.test", transport=httpx.MockTransport(handler)))
    with TestClient(app) as client:
        meeting_id = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij", "title": "Client call"}).json()["id"]
        assert client.post(f"/v1/meetings/{meeting_id}/join").status_code >= 400
        note = client.get("/v1/notifications").json()["items"][0]
        assert (note["kind"], note["severity"]) == ("assistant.join_failed", "danger")
        assert note["body"]


class _MinutesAdapter:
    async def generate_text(self, profile, request):
        import re
        segment_id = re.search(r"ID=([^\n]+)", request.prompt).group(1)
        payload = {
            "title": "Weekly sync", "executive_summary": "Agreed.", "discussion_points": [], "decisions": [],
            "action_items": [], "open_questions": [], "questions_asked": [],
            "speaker_contributions": [{"speaker": "Anna", "summary": "Spoke.", "evidence_segment_ids": [segment_id]}],
        }
        return TextGenerationResult(text=json.dumps(payload), structured_output=payload, provider="fake", model="m")


def test_post_meeting_worker_and_recap_delivery_notify() -> None:
    sent: list[dict] = []

    def resend(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "email_1"})

    from app.adapters.resend import ResendAdapter
    app = create_app(database_url="sqlite+pysqlite:///:memory:", credential_key="test-key",
                     vexa_adapter=_vexa(["completed"]),
                     resend_adapter=ResendAdapter("key", "Meetings AI <m@example.test>", transport=httpx.MockTransport(resend)))
    app.state.profile_service.adapters[ProviderType.OPENAI] = _MinutesAdapter()
    with TestClient(app) as client:
        profile = client.post("/v1/provider-profiles", json={
            "name": "MOM", "provider_type": "openai", "execution_location": "cloud",
            "capabilities": [{"capability": "text_generation", "model": "m"}], "api_key": "k"}).json()
        client.put("/v1/provider-defaults/text_generation", json={"policy": "cloud_only", "cloud_profile_id": profile["id"]})
        meeting_id = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij", "title": "Weekly sync"}).json()["id"]
        meeting = app.state.repository.get_meeting(UUID(meeting_id))
        meeting.status, meeting.vexa_meeting_id = MeetingStatus.COMPLETED, 42
        app.state.repository.save_meeting(meeting)
        app.state.repository.replace_transcript(meeting.id, [MeetingTranscriptSegment(
            start_seconds=0, end_seconds=3, speaker="Anna", text="Ship it.")])

        async def no_refetch(_meeting_id):
            return None
        app.state.meeting_service.transcript = no_refetch
        from app.tenant import tenant_scope
        with tenant_scope(LEGACY_ORGANIZATION_ID):
            asyncio.run(app.state.post_meeting_worker.process_meeting(UUID(meeting_id)))
        kinds = [item["kind"] for item in client.get("/v1/notifications").json()["items"]]
        assert "minutes.ready" in kinds
        assert client.post(f"/v1/meetings/{meeting_id}/minutes/approve").status_code == 200
        delivered = client.post(f"/v1/meetings/{meeting_id}/minutes/send", json={"recipients": ["team@example.test"]})
        assert delivered.status_code == 200, delivered.text
        recap = client.get("/v1/notifications").json()["items"][0]
        assert (recap["kind"], recap["severity"], recap["body"]) == ("recap.sent", "success", "Delivered to 1 recipient.")


def test_schedule_reminder_is_sent_once_about_ten_minutes_before() -> None:
    app = create_app(database_url="sqlite+pysqlite:///:memory:", credential_key="test-key")
    with TestClient(app) as client:
        meeting_id = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij", "title": "Planning"}).json()["id"]
        now = datetime.now(UTC)
        with app.state.database.session_factory.begin() as session:
            session.add(CalendarScheduleRow(
                meeting_id=meeting_id, organization_id=str(LEGACY_ORGANIZATION_ID), user_id=str(LEGACY_ADMIN_USER_ID),
                connection_id="manual", provider="manual", event_id=meeting_id, starts_at=now + timedelta(minutes=8),
                ends_at=now + timedelta(hours=1), status="pending", attempts=0, last_error=None,
                created_at=now, updated_at=now))
        events: NotificationEvents = app.state.notification_events
        assert events.schedule_reminders(now) == 1
        assert events.schedule_reminders(now + timedelta(seconds=15)) == 0
        note = client.get("/v1/notifications").json()["items"][0]
        assert note["kind"] == "meeting.reminder" and "starts in 8 min" in note["title"]
        with app.state.database.session_factory() as session:
            assert session.query(NotificationRow).count() == 1


def test_document_and_knowledge_events_reach_the_uploader_with_links() -> None:
    database = _database()
    service = NotificationService(database)
    events = NotificationEvents(service, database)
    legacy = str(LEGACY_ORGANIZATION_ID)
    uploader = _add_user(database, legacy, "member")
    event_id = str(uuid4())
    document = {"id": str(uuid4()), "organization_id": legacy, "scope": "prep", "scope_id": event_id,
                "filename": "deck.pdf", "created_by": uploader, "attempt_key": "1"}
    events.document_indexed(document)
    events.document_indexed(document)  # the same indexing pass is announced once
    events.document_failed({**document, "attempt_key": "2"}, "OCR could not read page 3")
    events.document_indexed({**document, "created_by": None})  # migrated documents have no uploader
    notes = service.list(_Actor(legacy, uploader)).items
    assert [(note.kind, note.link_view, note.link_id) for note in notes] == [
        ("document.failed", "prep", event_id), ("document.processed", "prep", event_id)]
    assert notes[0].body == "OCR could not read page 3"
    events.knowledge_index_failed(legacy, uuid4(), "embedding provider unavailable", reference="r1", user_id=uploader)
    assert service.list(_Actor(legacy, uploader)).items[0].kind == "knowledge.index_failed"


def test_title_lookups_never_read_another_workspace() -> None:
    from app.database import KnowledgeBaseRow, MeetingRow, MeetingTenantRow

    database = _database()
    events = NotificationEvents(NotificationService(database), database)
    other_org = str(uuid4())
    _add_user(database, other_org, "owner", new_org=True)
    now = datetime.now(UTC)
    meeting_id, base_id = str(uuid4()), str(uuid4())
    with database.session_factory.begin() as session:
        session.add(MeetingRow(id=meeting_id, title="Secret merger", **_meeting_defaults(now)))
        session.flush()
        session.add(MeetingTenantRow(meeting_id=meeting_id, organization_id=other_org))
        session.add(KnowledgeBaseRow(id=base_id, organization_id=other_org, name="Secret base",
                                     **_base_defaults(now)))
    assert "Secret" not in events._meeting_title(meeting_id, LEGACY_ORGANIZATION_ID)
    assert "Secret merger" in events._meeting_title(meeting_id, other_org)
    assert events._base(base_id, LEGACY_ORGANIZATION_ID) == ("Knowledge base", None)
    assert events._base(base_id, other_org)[0] == "“Secret base”"


def _meeting_defaults(now: datetime) -> dict:
    return {"meeting_url": "https://meet.google.com/abc-defg-hij", "bot_name": "Bot", "transcribe_enabled": True,
            "recording_enabled": False, "platform": "google_meet", "native_meeting_id": "abc-defg-hij",
            "status": "requested", "created_at": now, "updated_at": now}


def _base_defaults(now: datetime) -> dict:
    return {"created_by": str(uuid4()), "visibility": "private", "created_at": now, "updated_at": now}
