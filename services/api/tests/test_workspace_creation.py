"""The first membership must not be inserted before its organization."""

from sqlalchemy import event

from app.accounts import AccountService, OrganizationCreateRequest
from app.database import Database


def test_create_workspace_with_foreign_keys_enforced(tmp_path) -> None:
    database = Database(f"sqlite+pysqlite:///{tmp_path / 'workspace-fk.db'}")

    @event.listens_for(database.engine, "connect")
    def enforce_foreign_keys(connection, _record) -> None:
        connection.execute("PRAGMA foreign_keys=ON")

    database.migrate()
    accounts = AccountService(database)
    accounts.bootstrap_owner("owner@example.test", "test-only-owner-password")
    owner = accounts.login("owner@example.test", "test-only-owner-password")
    created = accounts.create_organization(owner, OrganizationCreateRequest(display_name="Novaala"))
    assert created.organization_id != owner.organization_id
    assert created.role == "owner"
    assert {item.display_name for item in accounts.list_organizations(created)} == {"GenAI Protos", "Novaala"}
    database.engine.dispose()
