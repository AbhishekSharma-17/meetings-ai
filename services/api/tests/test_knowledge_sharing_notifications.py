"""Sharing, workspace isolation, transactional alerts and retryable email delivery."""
import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import select
from fastapi.testclient import TestClient

from app.accounts import Actor
from app.adapters.resend import ResendAdapter
from app.database import (LEGACY_ADMIN_USER_ID, LEGACY_ORGANIZATION_ID, NotificationEmailRow,
                          OrganizationMembershipRow, OrganizationRow, UserRow)
from app.knowledge_bases import KnowledgeBaseCreate, KnowledgeBaseConflictError, KnowledgeShareRequest
from app.main import create_app
from app.notification_email_worker import NotificationEmailWorker, access_email


def actor(user_id=LEGACY_ADMIN_USER_ID, org=LEGACY_ORGANIZATION_ID, role="owner"):
    return Actor(user_id=UUID(str(user_id)), organization_id=UUID(str(org)), email="user@example.test",
                 display_name="Sender", role=role, must_change_password=False, session_version=0)


def person(db, org=LEGACY_ORGANIZATION_ID, *, other=False):
    user_id = str(uuid4())
    now = datetime.now(UTC)
    with db.session_factory.begin() as session:
        if other:
            session.add(OrganizationRow(id=str(org), slug=f"org-{org}", display_name="Other workspace",
                                       status="active", created_at=now, updated_at=now))
            session.flush()
        session.add(UserRow(id=user_id, email=f"{user_id}@example.test", display_name="Recipient",
                            auth_subject=f"local:{user_id}", status="active", created_at=now, updated_at=now))
        session.flush()
        session.add(OrganizationMembershipRow(organization_id=str(org), user_id=user_id, role="member", created_at=now))
    return user_id


def setup():
    app = create_app(database_url="sqlite+pysqlite:///:memory:", credential_key="test-key")
    member = person(app.state.database)
    base = app.state.knowledge_bases.create(KnowledgeBaseCreate(name="Client knowledge"), actor())
    return app, member, base


def share(app, base, visibility, ids=()):
    return app.state.knowledge_bases.share(base.id, KnowledgeShareRequest(visibility=visibility, user_ids=ids), actor())


def emails(db):
    with db.session_factory() as session:
        return session.execute(select(NotificationEmailRow)).scalars().all()


def test_specific_sharing_is_personal_and_unchanged_save_is_silent():
    app, member, base = setup()
    share(app, base, "specific", [member])
    assert app.state.knowledge_bases.list(actor(member, role="member"))[0].id == base.id
    notices = app.state.notifications.list(actor(member, role="member"))
    assert len(notices.items) == 1 and notices.items[0].scope == "personal"
    assert notices.items[0].link_id == str(base.id)
    assert len(emails(app.state.database)) == 1
    share(app, base, "specific", [member, member])
    assert len(emails(app.state.database)) == 1
    assert app.state.notifications.list(actor(), scope="workspace").items == []


def test_org_share_all_members_not_other_workspaces_and_individual_reads():
    app, member, base = setup()
    org2 = uuid4()
    outsider = person(app.state.database, org2, other=True)
    share(app, base, "organization")
    assert {row.user_id for row in emails(app.state.database)} == {member, str(LEGACY_ADMIN_USER_ID)}
    owner_notice = app.state.notifications.list(actor(), scope="workspace").items[0]
    assert owner_notice.scope == "workspace"
    app.state.notifications.mark_read(actor(), owner_notice.id)
    assert app.state.notifications.list(actor(member, role="member"), scope="workspace").items[0].read_at is None
    assert app.state.notifications.list(actor(outsider, org2, "member")).items == []
    assert app.state.knowledge_bases.list(actor(outsider, org2, "member")) == []
    assert app.state.notifications.list(actor(member, role="member"), scope="personal").items == []


def test_revoke_cancels_old_grant_email_and_removes_picker_access():
    app, member, base = setup()
    share(app, base, "specific", [member])
    share(app, base, "private")
    assert app.state.knowledge_bases.list(actor(member, role="member")) == []
    jobs = emails(app.state.database)
    assert sum(row.status == "cancelled" for row in jobs) == 1
    assert [row.title for row in jobs if row.status == "pending"] == [f"Access removed for {base.name}"]
    assert app.state.notifications.list(actor(member, role="member")).items[0].link_view is None


def test_foreign_recipient_rejected_without_alerts_or_email():
    app, member, base = setup()
    outsider = person(app.state.database, uuid4(), other=True)
    with pytest.raises(KnowledgeBaseConflictError):
        share(app, base, "specific", [member, outsider])
    assert not emails(app.state.database)
    assert app.state.knowledge_bases.get(base.id, actor()).visibility == "private"


def test_outbox_failure_rolls_back_sharing(monkeypatch):
    app, member, base = setup()
    def fail(*args, **kwargs):
        raise RuntimeError("storage failed")
    monkeypatch.setattr(app.state.notifications, "access_notice", fail)
    with pytest.raises(RuntimeError):
        share(app, base, "specific", [member])
    assert app.state.knowledge_bases.get(base.id, actor()).visibility == "private"
    assert not emails(app.state.database)


def test_email_branded_escaped_linked_and_individually_addressed():
    app, member, base = setup()
    person(app.state.database)
    share(app, base, "organization")
    payloads = []
    def handler(request):
        payloads.append(json.loads(request.content))
        assert request.headers["idempotency-key"].startswith("workspace-access-")
        return httpx.Response(200, json={"id": str(uuid4())})
    sender = ResendAdapter("test", "Meetings AI <m@example.test>", transport=httpx.MockTransport(handler))
    worker = NotificationEmailWorker(app.state.database, sender, "https://meeting.example.test")
    assert asyncio.run(worker.process_pending()) == 2
    assert all(len(item["to"]) == 1 for item in payloads)
    assert all("Client knowledge" in item["html"] and "workspace=" in item["html"] and "record=" in item["html"] for item in payloads)
    assert all(item["attachments"][0]["content_id"] == "meetings-ai-logo" for item in payloads)
    assert asyncio.run(worker.process_pending()) == 0
    content = access_email(title="<script>", body="<img onerror=bad>", workspace="<org>", name="<name>", url="https://app.test")
    assert "<script>" not in content.html and "&lt;script&gt;" in content.html


def test_retry_survives_worker_restart_with_same_idempotency_key():
    app, member, base = setup()
    share(app, base, "specific", [member])
    keys = []
    def handler(request):
        keys.append(request.headers["idempotency-key"])
        return httpx.Response(503, json={"message": "unavailable"}) if len(keys) == 1 else httpx.Response(200, json={"id": "sent"})
    sender = ResendAdapter("test", "m@example.test", transport=httpx.MockTransport(handler))
    assert asyncio.run(NotificationEmailWorker(app.state.database, sender, "https://app.test").process_pending()) == 0
    job = emails(app.state.database)[0]
    assert job.status == "pending" and job.attempts == 1
    with app.state.database.session_factory.begin() as session:
        session.get(NotificationEmailRow, job.id).next_retry_at = datetime.now(UTC) - timedelta(seconds=1)
    assert asyncio.run(NotificationEmailWorker(app.state.database, sender, "https://app.test").process_pending()) == 1
    assert keys[0] == keys[1]


def test_removed_member_never_gets_queued_email():
    app, member, base = setup()
    share(app, base, "specific", [member])
    with app.state.database.session_factory.begin() as session:
        session.delete(session.get(OrganizationMembershipRow, (str(LEGACY_ORGANIZATION_ID), member)))
    def handler(request):
        raise AssertionError("email must not leave this workspace")
    sender = ResendAdapter("test", "m@example.test", transport=httpx.MockTransport(handler))
    assert asyncio.run(NotificationEmailWorker(app.state.database, sender, "https://app.test").process_pending()) == 0
    assert emails(app.state.database)[0].status == "cancelled"


def test_scope_filter_api_and_read_count():
    app, member, base = setup()
    share(app, base, "organization")
    app.state.notifications.notify(LEGACY_ORGANIZATION_ID, user_ids=[LEGACY_ADMIN_USER_ID], kind="test", title="Personal")
    with TestClient(app) as client:
        assert len(client.get("/v1/notifications?scope=workspace").json()["items"]) == 1
        assert client.get("/v1/notifications?scope=personal").json()["items"][0]["title"] == "Personal"
        assert client.get("/v1/notifications?scope=other").status_code == 422
        assert client.get("/v1/notifications/unread-count").json()["unread_count"] == 2
        assert client.post("/v1/notifications/read-all?scope=workspace").json()["unread_count"] == 1
        assert client.get("/v1/notifications?scope=personal").json()["items"][0]["read_at"] is None
        assert client.delete("/v1/notifications?scope=workspace").json()["cleared"] == 1
        assert len(client.get("/v1/notifications").json()["items"]) == 1


def test_explicit_share_to_admin_is_not_silent():
    app, admin, base = setup()
    with app.state.database.session_factory.begin() as session:
        session.get(OrganizationMembershipRow, (str(LEGACY_ORGANIZATION_ID), admin)).role = "admin"
    share(app, base, "specific", [admin])
    assert app.state.notifications.list(actor(admin, role="admin"), scope="personal").items[0].title.startswith("You have access")
    assert [job.user_id for job in emails(app.state.database)] == [admin]


def test_deleting_shared_base_replaces_pending_access_emails():
    app, member, base = setup()
    share(app, base, "organization")
    app.state.knowledge_bases.delete_base(base.id, actor())
    jobs = emails(app.state.database)
    assert len([job for job in jobs if job.status == "cancelled"]) == 2
    pending = [job for job in jobs if job.status == "pending"]
    assert {job.user_id for job in pending} == {member, str(LEGACY_ADMIN_USER_ID)}
    assert all(job.link_view is None and job.title.endswith("was deleted") for job in pending)
