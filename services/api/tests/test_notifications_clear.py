"""Clearing the notification center: DELETE /v1/notifications (optionally only read ones)."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

from account_links import accept_invite
from app.database import (
    LEGACY_ADMIN_USER_ID,
    LEGACY_ORGANIZATION_ID,
    Database,
    OrganizationMembershipRow,
    OrganizationRow,
    UserRow,
)
from app.main import create_app
from app.notifications import NotificationService
from fastapi.testclient import TestClient


def _database() -> Database:
    database = Database("sqlite+pysqlite:///:memory:")
    database.migrate()
    return database


def _add_org(database: Database) -> str:
    now = datetime.now(UTC)
    organization_id = str(uuid4())
    with database.session_factory.begin() as session:
        session.add(OrganizationRow(id=organization_id, slug=f"org-{organization_id[:8]}", display_name="Other",
                                    contact_email=None, status="active", created_at=now, updated_at=now))
    return organization_id


def _add_member(database: Database, organization_id: str, role: str, user_id: str | None = None) -> str:
    now = datetime.now(UTC)
    with database.session_factory.begin() as session:
        if user_id is None:
            user_id = str(uuid4())
            session.add(UserRow(id=user_id, email=f"{user_id[:8]}@example.test", display_name="Person",
                                auth_subject=f"local:{user_id}", status="active", created_at=now, updated_at=now))
            session.flush()
        session.add(OrganizationMembershipRow(organization_id=organization_id, user_id=str(user_id), role=role,
                                              created_at=now))
    return str(user_id)


class _Actor:
    def __init__(self, organization_id, user_id):
        self.organization_id, self.user_id = UUID(str(organization_id)), UUID(str(user_id))


def _titles(service: NotificationService, actor: _Actor) -> list[str]:
    return sorted(item.title for item in service.list(actor).items)


def test_clear_only_touches_my_notifications_in_this_workspace() -> None:
    database = _database()
    service = NotificationService(database)
    legacy = str(LEGACY_ORGANIZATION_ID)
    colleague = _add_member(database, legacy, "member")
    other_org = _add_org(database)
    _add_member(database, other_org, "owner", user_id=str(LEGACY_ADMIN_USER_ID))  # same person, second workspace

    for index in range(3):
        service.notify(legacy, user_ids=[LEGACY_ADMIN_USER_ID], kind="x", title=f"Mine {index}", dedupe_key=f"m{index}")
    service.notify(legacy, user_ids=[colleague], kind="x", title="Colleague", dedupe_key="c")
    service.notify(other_org, user_ids=[LEGACY_ADMIN_USER_ID], kind="x", title="Other workspace", dedupe_key="o")

    me = _Actor(legacy, LEGACY_ADMIN_USER_ID)
    assert service.clear(me) == 3
    assert service.list(me).items == []
    assert service.unread_count(me) == 0
    assert _titles(service, _Actor(legacy, colleague)) == ["Colleague"]
    assert _titles(service, _Actor(other_org, LEGACY_ADMIN_USER_ID)) == ["Other workspace"]
    assert service.clear(me) == 0


def test_clear_read_only_keeps_unread_notifications() -> None:
    database = _database()
    service = NotificationService(database)
    legacy = str(LEGACY_ORGANIZATION_ID)
    for index in range(4):
        service.notify(legacy, user_ids=[LEGACY_ADMIN_USER_ID], kind="x", title=f"Note {index}", dedupe_key=f"n{index}")
    me = _Actor(legacy, LEGACY_ADMIN_USER_ID)
    items = service.list(me).items
    service.mark_read(me, items[0].id)
    service.mark_read(me, items[1].id)

    assert service.clear(me, read_only=True) == 2
    remaining = service.list(me).items
    assert len(remaining) == 2 and all(item.read_at is None for item in remaining)
    assert service.unread_count(me) == 2


def test_clear_api_returns_counts_and_is_not_workspace_activity() -> None:
    app = create_app(database_url="sqlite+pysqlite:///:memory:", credential_key="test-key")
    notifications = app.state.notifications
    with TestClient(app) as client:
        for index in range(3):
            notifications.notify(LEGACY_ORGANIZATION_ID, user_ids=[LEGACY_ADMIN_USER_ID], kind="test",
                                 title=f"Note {index}", dedupe_key=f"note-{index}")
        first = client.get("/v1/notifications").json()["items"][0]["id"]
        client.post(f"/v1/notifications/{first}/read")

        read_only = client.delete("/v1/notifications", params={"read_only": "true"})
        assert read_only.status_code == 200
        assert read_only.json() == {"cleared": 1, "unread_count": 2}
        assert len(client.get("/v1/notifications").json()["items"]) == 2

        everything = client.delete("/v1/notifications")
        assert everything.json() == {"cleared": 2, "unread_count": 0}
        assert client.get("/v1/notifications").json()["items"] == []
        assert client.delete("/v1/notifications").json() == {"cleared": 0, "unread_count": 0}
        assert client.delete("/v1/notifications", params={"read_only": "maybe"}).status_code == 422
        assert not [event for event in client.get("/v1/workspace/audit").json() if "notifications" in event["action"]]


def test_members_and_viewers_clear_only_their_own(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "owner-password-for-test")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", "developer@genaiprotos.com")
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'clear.db'}", credential_key="test-key")
    notifications = app.state.notifications
    with TestClient(app) as client:
        client.post("/v1/auth/login", json={"email": "developer@genaiprotos.com", "password": "owner-password-for-test"})
        owner = client.get("/v1/auth/me").json()
        organization_id = owner["organization_id"]
        accounts = {}
        for role in ("member", "viewer"):
            invited = client.post("/v1/workspace/invite", json={
                "email": f"{role}@example.com", "display_name": role.title(), "role": role}).json()
            accounts[role] = invited
            notifications.notify(organization_id, user_ids=[invited["account"]["user_id"]], kind="x",
                                 title=f"For the {role}", dedupe_key=f"{role}-1")
        notifications.notify(organization_id, user_ids=[owner["user_id"]], kind="x", title="Owner only", dedupe_key="o-1")
        client.post("/v1/auth/logout")

        for role, invited in accounts.items():
            accept_invite(client, invited, "a-very-long-new-password")
            cleared = client.delete("/v1/notifications")
            assert cleared.status_code == 200, role
            assert cleared.json() == {"cleared": 1, "unread_count": 0}
            assert client.delete("/v1/notifications", params={"read_only": True}).status_code == 200
            client.post("/v1/auth/logout")

        owner_actor = _Actor(organization_id, owner["user_id"])
        assert [item.title for item in notifications.list(owner_actor).items] == ["Owner only"]
