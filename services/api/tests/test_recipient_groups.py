"""Internal teams: CRUD, roles, tenant isolation, send-time expansion and the v24 migration."""

import json
from datetime import UTC, datetime
from uuid import UUID, uuid4

import httpx
from fastapi.testclient import TestClient
from meetings_contracts import MeetingMinutes, MeetingStatus, MeetingTranscriptSegment, MinutesStatus
from sqlalchemy import insert, inspect, select, text

from app.accounts import _hash_password
from app.adapters.resend import ResendAdapter
from app.database import (
    Base,
    Database,
    EmailDeliveryGroupRow,
    MeetingDeliveryGroupRow,
    OrganizationMembershipRow,
    OrganizationRow,
    SCHEMA_TABLES_BY_VERSION,
    SchemaVersionRow,
    UserCredentialRow,
    UserRow,
)
from app.main import create_app
from app.tenant import tenant_scope

LEGACY_ORG = UUID("00000000-0000-4000-8000-000000000001")
V24_TABLES = {
    "recipient_groups", "recipient_group_members", "meeting_delivery_groups",
    "email_delivery_groups", "notifications", "background_jobs",
}


def _add_user(app, email: str, role: str, organization_id: UUID = LEGACY_ORG, password: str | None = None) -> str:
    user_id, now = str(uuid4()), datetime.now(UTC)
    with app.state.database.session_factory.begin() as session:
        session.add(UserRow(id=user_id, email=email, display_name=email.split("@")[0].title(),
                            auth_subject=f"local:{user_id}", status="active", created_at=now, updated_at=now))
        session.flush()
        session.add(OrganizationMembershipRow(organization_id=str(organization_id), user_id=user_id,
                                              role=role, created_at=now))
        if password:
            session.add(UserCredentialRow(user_id=user_id, password_hash=_hash_password(password),
                                          must_change_password=False, session_version=1,
                                          created_at=now, updated_at=now))
    return user_id


def _add_organization(app, name: str) -> UUID:
    org, now = uuid4(), datetime.now(UTC)
    with app.state.database.session_factory.begin() as session:
        session.add(OrganizationRow(id=str(org), slug=name.lower().replace(" ", "-"), display_name=name,
                                    contact_email=None, status="active", created_at=now, updated_at=now))
    return org


def _signed_in_app(tmp_path, monkeypatch):
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "owner-password-for-test")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", "owner@example.test")
    return create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'teams.db'}", credential_key="test-credential-key")


def _login(app, email: str, password: str) -> TestClient:
    client = TestClient(app)
    client.__enter__()
    assert client.post("/v1/auth/login", json={"email": email, "password": password}).status_code == 200
    return client


def test_admins_manage_teams_and_members_read_them(tmp_path, monkeypatch) -> None:
    app = _signed_in_app(tmp_path, monkeypatch)
    member_id = _add_user(app, "member@example.test", "member", password="member-password-1")
    _add_user(app, "viewer@example.test", "viewer", password="viewer-password-1")
    owner = _login(app, "owner@example.test", "owner-password-for-test")
    member = _login(app, "member@example.test", "member-password-1")
    viewer = _login(app, "viewer@example.test", "viewer-password-1")
    try:
        created = owner.post("/v1/workspace/teams", json={
            "name": "  Leadership  team ", "description": "Weekly recap audience",
            "members": [{"user_id": member_id}, {"email": " Partner@External.Example "},
                        {"email": "member@example.test"}],
        })
        assert created.status_code == 201, created.text
        team = created.json()
        assert team["name"] == "Leadership team"
        assert team["member_count"] == 2  # the typed duplicate of a workspace member collapses into the account
        assert {(item["email"], item["user_id"]) for item in team["members"]} == {
            ("member@example.test", member_id), ("partner@external.example", None),
        }
        assert team["meeting_count"] == 0

        assert owner.post("/v1/workspace/teams", json={"name": "LEADERSHIP TEAM"}).status_code == 409
        assert owner.post("/v1/workspace/teams", json={"name": "   "}).status_code == 422
        assert owner.post("/v1/workspace/teams", json={"name": "Bad", "members": [{"email": "not-an-email"}]}).status_code == 422
        assert owner.post("/v1/workspace/teams", json={"name": "Ghost", "members": [{"user_id": str(uuid4())}]}).status_code == 422
        assert owner.post("/v1/workspace/teams", json={"name": "Extra", "unknown": True}).status_code == 422

        # Members and viewers see teams (they appear in recipient pickers) but cannot change them.
        assert [item["id"] for item in member.get("/v1/workspace/teams").json()] == [team["id"]]
        assert viewer.get(f"/v1/workspace/teams/{team['id']}").status_code == 200
        assert member.post("/v1/workspace/teams", json={"name": "Mine"}).status_code == 403
        assert viewer.patch(f"/v1/workspace/teams/{team['id']}", json={"name": "Hijacked"}).status_code == 403
        assert member.delete(f"/v1/workspace/teams/{team['id']}").status_code == 403

        renamed = owner.patch(f"/v1/workspace/teams/{team['id']}", json={
            "name": "Leadership", "members": [{"email": "cfo@example.test"}],
        })
        assert renamed.status_code == 200
        assert renamed.json()["name"] == "Leadership"
        assert renamed.json()["description"] == "Weekly recap audience"  # omitted fields are unchanged
        assert [item["email"] for item in renamed.json()["members"]] == ["cfo@example.test"]
        other = owner.post("/v1/workspace/teams", json={"name": "Sales"}).json()
        assert owner.patch(f"/v1/workspace/teams/{other['id']}", json={"name": "leadership"}).status_code == 409
        assert owner.patch(f"/v1/workspace/teams/{other['id']}", json={"name": "SALES"}).json()["name"] == "SALES"

        audit = owner.get("/v1/workspace/audit").json()
        assert {"POST /v1/workspace/teams", "PATCH /v1/workspace/teams/{team_id}"} <= {item["action"] for item in audit}

        assert owner.delete(f"/v1/workspace/teams/{team['id']}").status_code == 204
        assert owner.get(f"/v1/workspace/teams/{team['id']}").status_code == 404
        assert "DELETE /v1/workspace/teams/{team_id}" in {item["action"] for item in owner.get("/v1/workspace/audit").json()}
    finally:
        for client in (owner, member, viewer):
            client.__exit__(None, None, None)


def test_teams_are_isolated_between_workspaces(tmp_path, monkeypatch) -> None:
    app = _signed_in_app(tmp_path, monkeypatch)
    other_org = _add_organization(app, "Other Company")
    _add_user(app, "other@example.test", "owner", organization_id=other_org, password="other-password-1")
    owner = _login(app, "owner@example.test", "owner-password-for-test")
    other = _login(app, "other@example.test", "other-password-1")
    try:
        team = owner.post("/v1/workspace/teams", json={"name": "Leadership", "members": [{"email": "a@example.test"}]}).json()
        # The same name is free in another workspace.
        assert other.post("/v1/workspace/teams", json={"name": "Leadership"}).status_code == 201
        assert [item["name"] for item in other.get("/v1/workspace/teams").json()] == ["Leadership"]
        assert team["id"] not in {item["id"] for item in other.get("/v1/workspace/teams").json()}
        assert other.get(f"/v1/workspace/teams/{team['id']}").status_code == 404
        assert other.patch(f"/v1/workspace/teams/{team['id']}", json={"name": "Stolen"}).status_code == 404
        assert other.delete(f"/v1/workspace/teams/{team['id']}").status_code == 404
        # Another workspace's owner is not a member here, so they cannot be added by id.
        owner_id = owner.get("/v1/auth/me").json()["user_id"]
        assert other.post("/v1/workspace/teams", json={"name": "Poach", "members": [{"user_id": owner_id}]}).status_code == 422

        # A foreign team cannot be targeted by a meeting, at creation or later.
        rejected = other.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
            "delivery_settings": {"internal_group_ids": [team["id"]]},
        })
        assert rejected.status_code == 422
        assert other.get("/v1/meetings").json()["count"] == 0  # nothing half-created
        meeting = other.post("/v1/meetings", json={"meeting_url": "https://meet.google.com/abc-defg-hij"}).json()
        assert other.put(f"/v1/meetings/{meeting['id']}/delivery-settings", json={
            "internal_recipients": ["x@example.test"], "internal_group_ids": [team["id"]],
        }).status_code == 422
        assert other.get(f"/v1/meetings/{meeting['id']}/delivery-settings").json()["internal_recipients"] == []
    finally:
        owner.__exit__(None, None, None)
        other.__exit__(None, None, None)


def _approve_minutes(app, meeting_id: str) -> None:
    repository = app.state.repository
    with tenant_scope(LEGACY_ORG):
        meeting = repository.get_meeting(UUID(meeting_id))
        meeting.status = MeetingStatus.COMPLETED
        repository.save_meeting(meeting)
        repository.replace_transcript(meeting.id, [MeetingTranscriptSegment(start_seconds=0, end_seconds=3, speaker="Anna", text="We agreed.")])
        repository.save_minutes_source_revision(meeting.id, repository.get_transcript_revision(meeting.id))
        now = datetime.now(UTC)
        repository.save_minutes(MeetingMinutes(meeting_id=meeting.id, title="Review", executive_summary="Agreed.",
                                               status=MinutesStatus.APPROVED, approved_at=now))


def test_recap_expands_teams_to_current_members_at_send_time(tmp_path) -> None:
    sent: list[dict] = []

    def resend(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"id": f"email_{len(sent)}"})

    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'send.db'}", credential_key="test-key",
        resend_adapter=ResendAdapter("resend-test-key", "Meetings AI <meetings@example.test>",
                                     transport=httpx.MockTransport(resend)),
    )
    leaver_id = _add_user(app, "leaver@example.test", "member")
    colleague_id = _add_user(app, "colleague@example.test", "member")
    with TestClient(app) as client:
        leadership = client.post("/v1/workspace/teams", json={"name": "Leadership", "members": [
            {"email": "ceo@example.test"}, {"user_id": leaver_id}, {"user_id": colleague_id},
        ]}).json()
        sales = client.post("/v1/workspace/teams", json={"name": "Sales", "members": [
            {"email": "rep@example.test"}, {"email": "ceo@example.test"},
        ]}).json()
        meeting = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
            "delivery_settings": {
                "internal_recipients": ["pm@example.test", "CEO@example.test"],
                "internal_group_ids": [sales["id"], leadership["id"], leadership["id"]],
                "participant_recipients": ["guest@client.example"], "send_to_participants": False,
            },
        })
        assert meeting.status_code == 201, meeting.text
        meeting_id = meeting.json()["id"]
        settings = client.get(f"/v1/meetings/{meeting_id}/delivery-settings").json()
        assert settings["internal_group_ids"] == [leadership["id"], sales["id"]]
        assert client.get(f"/v1/workspace/teams/{sales['id']}").json()["meeting_count"] == 1

        # Membership changes after the meeting was set up apply to the send.
        client.patch(f"/v1/workspace/teams/{sales['id']}", json={"members": [
            {"email": "rep@example.test"}, {"email": "late.joiner@example.test"},
        ]})
        with app.state.database.session_factory.begin() as session:
            session.execute(text("DELETE FROM organization_memberships WHERE user_id = :id"), {"id": leaver_id})
        leadership_view = client.get(f"/v1/workspace/teams/{leadership['id']}").json()
        assert leadership_view["member_count"] == 2
        assert [item["active"] for item in leadership_view["members"] if item["user_id"] == leaver_id] == [False]

        _approve_minutes(app, meeting_id)
        delivered = client.post(f"/v1/meetings/{meeting_id}/minutes/send-configured")
        assert delivered.status_code == 200, delivered.text
        body = delivered.json()
        assert body["recipients"] == [
            "pm@example.test", "ceo@example.test", "colleague@example.test",
            "late.joiner@example.test", "rep@example.test",
        ]
        assert sent[0]["to"] == body["recipients"]
        assert "leaver@example.test" not in sent[0]["to"]
        assert "guest@client.example" not in sent[0]["to"]  # participant sharing stays opt-in
        assert body["groups"] == [
            {"id": leadership["id"], "name": "Leadership", "member_count": 2},
            {"id": sales["id"], "name": "Sales", "member_count": 2},
        ]
        with app.state.database.session_factory() as session:
            recorded = session.execute(select(EmailDeliveryGroupRow.group_name, EmailDeliveryGroupRow.member_count)
                                       .where(EmailDeliveryGroupRow.delivery_id == body["id"])
                                       .order_by(EmailDeliveryGroupRow.group_name)).all()
        assert recorded == [("Leadership", 2), ("Sales", 2)]

        # Deleting a team keeps delivery history but stops targeting it; deleting the meeting cleans up.
        assert client.delete(f"/v1/workspace/teams/{sales['id']}").status_code == 204
        assert client.get(f"/v1/meetings/{meeting_id}/delivery-settings").json()["internal_group_ids"] == [leadership["id"]]
        assert client.delete(f"/v1/meetings/{meeting_id}").status_code == 204
        with app.state.database.session_factory() as session:
            assert session.execute(select(MeetingDeliveryGroupRow)).first() is None
            assert session.execute(select(EmailDeliveryGroupRow)).first() is None


def test_team_only_audience_and_empty_audience(tmp_path) -> None:
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'team-only.db'}", credential_key="test-key",
        resend_adapter=ResendAdapter("resend-test-key", "Meetings AI <meetings@example.test>",
                                     transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"id": "e1"}))),
    )
    with TestClient(app) as client:
        team = client.post("/v1/workspace/teams", json={"name": "Account team", "members": [{"email": "am@example.test"}]}).json()
        empty = client.post("/v1/workspace/teams", json={"name": "Empty"}).json()
        first = client.post("/v1/meetings", json={"meeting_url": "https://meet.google.com/abc-defg-hij",
                                                  "delivery_settings": {"internal_group_ids": [empty["id"]]}}).json()
        _approve_minutes(app, first["id"])
        refused = client.post(f"/v1/meetings/{first['id']}/minutes/send-configured")
        assert refused.status_code == 409
        assert "internal recipient or team" in refused.json()["detail"]

        assert client.put(f"/v1/meetings/{first['id']}/delivery-settings", json={"internal_group_ids": [team["id"]]}).status_code == 200
        delivered = client.post(f"/v1/meetings/{first['id']}/minutes/send-configured").json()
        assert delivered["recipients"] == ["am@example.test"]
        assert delivered["groups"][0]["name"] == "Account team"


def test_v23_database_upgrades_to_v24(tmp_path) -> None:
    database = Database(f"sqlite+pysqlite:///{tmp_path / 'v23.db'}")
    with database.engine.begin() as connection:
        for version in range(3, 24):
            for name in SCHEMA_TABLES_BY_VERSION[version]:
                Base.metadata.tables[name].create(connection)
            connection.execute(insert(SchemaVersionRow).values(version=version, applied_at=datetime.now(UTC)))
        connection.execute(text(
            "INSERT INTO organizations (id, slug, display_name, status, created_at, updated_at) "
            "VALUES (:id, 'legacy-workspace', 'GenAI Protos', 'active', :now, :now)"
        ), {"id": str(LEGACY_ORG), "now": datetime.now(UTC).isoformat()})
        connection.execute(text(
            "INSERT INTO meeting_delivery_settings (meeting_id, internal_recipients, participant_recipients, "
            "send_to_participants, include_transcript) VALUES ('m-1', '[\"a@example.test\"]', '[]', 0, 0)"
        ))
    assert V24_TABLES.isdisjoint(inspect(database.engine).get_table_names())

    database.migrate()
    with database.engine.connect() as connection:
        assert V24_TABLES <= set(inspect(connection).get_table_names())
        assert max(connection.execute(select(SchemaVersionRow.version)).scalars().all()) == Database.SCHEMA_VERSION
        assert connection.execute(text("SELECT internal_recipients FROM meeting_delivery_settings")).scalar_one() == '["a@example.test"]'
        unique = {tuple(item["column_names"]) for item in inspect(connection).get_unique_constraints("recipient_groups")}
        assert ("organization_id", "name_key") in unique
    database.migrate()  # idempotent
    database.engine.dispose()
