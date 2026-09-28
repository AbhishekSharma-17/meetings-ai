"""Sign-in lands in the default workspace, else the last active one, else the oldest membership."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from account_links import accept_invite, activate
from app.accounts import AccountError, AccountService, InviteRequest, OrganizationCreateRequest
from app.database import Database, OrganizationRow, UserWorkspacePreferenceRow
from app.main import create_app

OWNER_EMAIL = "owner@example.test"
OWNER_PASSWORD = "owner-password-for-test"
MATE_PASSWORD = "mate-password-for-test"


@pytest.fixture()
def accounts(tmp_path):
    database = Database(f"sqlite+pysqlite:///{tmp_path / 'preferences.db'}")
    database.migrate()
    service = AccountService(database)
    service.bootstrap_owner(OWNER_EMAIL, OWNER_PASSWORD)
    yield service
    database.engine.dispose()


def _login(accounts: AccountService):
    return accounts.login(OWNER_EMAIL, OWNER_PASSWORD)


def test_first_sign_in_falls_back_to_oldest_membership(accounts) -> None:
    owner = _login(accounts)
    with accounts.database.session_factory() as session:
        preference = session.get(UserWorkspacePreferenceRow, str(owner.user_id))
        assert preference.last_organization_id == str(owner.organization_id)
        assert preference.default_organization_id is None


def test_switch_updates_last_active_workspace_for_next_sign_in(accounts) -> None:
    owner = _login(accounts)
    legacy = owner.organization_id
    second = accounts.create_organization(owner, OrganizationCreateRequest(display_name="Novaala"))
    assert _login(accounts).organization_id == second.organization_id
    accounts.select_organization(second, legacy)
    assert _login(accounts).organization_id == legacy


def test_default_beats_last_active_and_clearing_restores_last(accounts) -> None:
    owner = _login(accounts)
    legacy = owner.organization_id
    second = accounts.create_organization(owner, OrganizationCreateRequest(display_name="Novaala"))
    options = accounts.set_default_organization(second, legacy)
    assert {str(item.id): item.is_default for item in options} == {
        str(legacy): True, str(second.organization_id): False,
    }
    accounts.select_organization(second, second.organization_id)
    assert _login(accounts).organization_id == legacy
    options = accounts.set_default_organization(second, None)
    assert not any(item.is_default for item in options)
    # The sign-in just above landed in the default, which is now the last active workspace.
    assert _login(accounts).organization_id == legacy
    accounts.select_organization(owner, second.organization_id)
    assert _login(accounts).organization_id == second.organization_id


def test_cannot_default_to_a_workspace_you_do_not_belong_to(accounts) -> None:
    owner = _login(accounts)
    with pytest.raises(AccountError):
        accounts.set_default_organization(owner, uuid4())


def test_removed_membership_never_selected_and_is_forgotten(accounts) -> None:
    owner = _login(accounts)
    legacy_owner = owner
    second_owner = accounts.create_organization(owner, OrganizationCreateRequest(display_name="Novaala"))
    invited = accounts.invite(legacy_owner, InviteRequest(email="mate@example.test", display_name="Team Mate"))
    activate(accounts, invited, MATE_PASSWORD)
    added = accounts.invite(second_owner, InviteRequest(email="mate@example.test", display_name="Team Mate"))
    assert added.link is None  # an existing account keeps its password
    mate = accounts.login("mate@example.test", MATE_PASSWORD)
    assert mate.organization_id == legacy_owner.organization_id  # oldest membership
    accounts.set_default_organization(mate, second_owner.organization_id)
    accounts.select_organization(mate, second_owner.organization_id)
    assert accounts.login("mate@example.test", MATE_PASSWORD).organization_id == second_owner.organization_id

    accounts.remove_member(second_owner, mate.user_id)
    landed = accounts.login("mate@example.test", MATE_PASSWORD)
    assert landed.organization_id == legacy_owner.organization_id
    with accounts.database.session_factory() as session:
        preference = session.get(UserWorkspacePreferenceRow, str(mate.user_id))
        assert preference.default_organization_id is None
        assert preference.last_organization_id == str(legacy_owner.organization_id)


def test_stale_or_archived_preferences_are_ignored(accounts) -> None:
    owner = _login(accounts)
    second = accounts.create_organization(owner, OrganizationCreateRequest(display_name="Novaala"))
    accounts.set_default_organization(second, second.organization_id)
    with accounts.database.session_factory.begin() as session:
        session.get(OrganizationRow, str(second.organization_id)).status = "archived"
    assert _login(accounts).organization_id == owner.organization_id
    with accounts.database.session_factory.begin() as session:
        preference = session.get(UserWorkspacePreferenceRow, str(owner.user_id))
        preference.default_organization_id = str(uuid4())
        preference.last_organization_id = str(uuid4())
        preference.updated_at = datetime.now(UTC)
    assert _login(accounts).organization_id == owner.organization_id


def test_default_workspace_api_for_members(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER_PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER_EMAIL)
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'api.db'}", credential_key="test-credential-key")
    with TestClient(app) as owner, TestClient(app) as mate:
        assert owner.post("/v1/auth/login", json={"email": OWNER_EMAIL, "password": OWNER_PASSWORD}).status_code == 200
        legacy_id = owner.get("/v1/auth/me").json()["organization_id"]
        invited = owner.post("/v1/workspace/invite", json={
            "email": "mate@example.test", "display_name": "Team Mate", "role": "viewer",
        }).json()
        accept_invite(mate, invited, "mate-new-password-for-test")
        second = owner.post("/v1/workspaces", json={"display_name": "Novaala"}).json()
        assert owner.post("/v1/workspace/invite", json={
            "email": "mate@example.test", "display_name": "Team Mate", "role": "member",
        }).status_code == 201

        assert mate.post("/v1/auth/login", json={"email": "mate@example.test", "password": "mate-new-password-for-test"}).status_code == 200
        assert mate.get("/v1/auth/me").json()["organization_id"] == legacy_id

        chosen = mate.put("/v1/workspaces/default", json={"organization_id": second["organization_id"]})
        assert chosen.status_code == 200
        assert {item["id"]: item["is_default"] for item in chosen.json()} == {
            legacy_id: False, second["organization_id"]: True,
        }
        assert mate.put("/v1/workspaces/default", json={"organization_id": str(uuid4())}).status_code == 404

        mate.post("/v1/auth/logout")
        assert mate.post("/v1/auth/login", json={
            "email": "mate@example.test", "password": "mate-new-password-for-test",
        }).status_code == 200
        assert mate.get("/v1/auth/me").json()["organization_id"] == second["organization_id"]

        cleared = mate.put("/v1/workspaces/default", json={"organization_id": None})
        assert cleared.status_code == 200
        assert not any(item["is_default"] for item in cleared.json())
        assert mate.post(f"/v1/workspaces/{legacy_id}/switch").status_code == 200
        mate.post("/v1/auth/logout")
        assert mate.post("/v1/auth/login", json={
            "email": "mate@example.test", "password": "mate-new-password-for-test",
        }).status_code == 200
        assert mate.get("/v1/auth/me").json()["organization_id"] == legacy_id
