"""Schema upgrades must preserve data and refuse undocumented database states."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import insert, select, text
from fastapi.testclient import TestClient

from app.database import (
    Base,
    Database,
    SCHEMA_TABLES_BY_VERSION,
    SchemaMigrationError,
    SchemaVersionRow,
)
from app.main import create_app


def _database(tmp_path, name: str = "migrations.db") -> Database:
    return Database(f"sqlite+pysqlite:///{tmp_path / name}")


def test_fresh_database_records_each_version_and_is_idempotent(tmp_path) -> None:
    database = _database(tmp_path)
    database.migrate()
    database.migrate()

    with database.engine.connect() as connection:
        versions = connection.execute(select(SchemaVersionRow.version)).scalars().all()
    assert versions == [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
    database.engine.dispose()


def test_version_three_upgrade_preserves_existing_rows(tmp_path) -> None:
    database = _database(tmp_path)
    with database.engine.begin() as connection:
        for name in SCHEMA_TABLES_BY_VERSION[3]:
            Base.metadata.tables[name].create(connection)
        connection.execute(insert(SchemaVersionRow).values(
            version=3, applied_at=datetime.now(UTC),
        ))
        connection.execute(text(
            "INSERT INTO provider_defaults (capability, policy) "
            "VALUES ('transcription', 'cloud_only')"
        ))

    database.migrate()
    with database.engine.connect() as connection:
        assert connection.execute(text(
            "SELECT policy FROM provider_defaults WHERE capability='transcription'"
        )).scalar_one() == "cloud_only"
        assert connection.execute(select(SchemaVersionRow.version)).scalars().all() == [
            3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
        ]
        assert connection.execute(text(
            "SELECT policy FROM organization_provider_defaults WHERE capability='transcription'"
        )).scalar_one() == "cloud_only"
    database.engine.dispose()


def test_version_twelve_upgrade_backfills_meeting_and_provider_owners(tmp_path) -> None:
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'tenant-upgrade.db'}",
        credential_key="test-only-credential-key",
    )
    with TestClient(app) as client:
        profile = client.post("/v1/provider-profiles", json={
            "name": "Existing model", "provider_type": "openai",
            "execution_location": "cloud", "api_key": "test-key",
            "capabilities": [{"capability": "text_generation", "model": "test-model"}],
        }).json()
        meeting = client.post("/v1/meetings", json={
            "meeting_url": "https://meet.google.com/abc-defg-hij",
        }).json()
    with app.state.database.engine.begin() as connection:
        connection.execute(text("DROP TABLE knowledge_embeddings"))
        connection.execute(text("DROP TABLE organization_provider_defaults"))
        connection.execute(text("DROP TABLE meeting_tenants"))
        connection.execute(text("DROP TABLE provider_tenants"))
        connection.execute(text("DELETE FROM schema_version WHERE version = 13"))
        connection.execute(text("DELETE FROM schema_version WHERE version = 14"))
        connection.execute(text(
            "INSERT INTO provider_defaults (capability, policy, cloud_profile_id) "
            "VALUES ('text_generation', 'cloud_only', :profile_id)"
        ), {"profile_id": profile["id"]})
    app.state.database.migrate()
    with app.state.database.engine.connect() as connection:
        assert connection.execute(text(
            "SELECT organization_id FROM provider_tenants WHERE provider_id = :id"
        ), {"id": profile["id"]}).scalar_one() == "00000000-0000-4000-8000-000000000001"
        assert connection.execute(text(
            "SELECT organization_id FROM meeting_tenants WHERE meeting_id = :id"
        ), {"id": meeting["id"]}).scalar_one() == "00000000-0000-4000-8000-000000000001"
        assert connection.execute(text(
            "SELECT cloud_profile_id FROM organization_provider_defaults WHERE capability = 'text_generation'"
        )).scalar_one() == profile["id"]
    app.state.database.engine.dispose()


def test_incomplete_recorded_schema_refuses_startup(tmp_path) -> None:
    database = _database(tmp_path)
    with database.engine.begin() as connection:
        for name in SCHEMA_TABLES_BY_VERSION[3]:
            Base.metadata.tables[name].create(connection)
        connection.execute(insert(SchemaVersionRow).values(
            version=7, applied_at=datetime.now(UTC),
        ))

    with pytest.raises(SchemaMigrationError, match="missing tables"):
        database.migrate()
    database.engine.dispose()


def test_unknown_future_version_refuses_startup(tmp_path) -> None:
    database = _database(tmp_path)
    database.migrate()
    with database.engine.begin() as connection:
        connection.execute(insert(SchemaVersionRow).values(
            version=15, applied_at=datetime.now(UTC),
        ))

    with pytest.raises(SchemaMigrationError, match="unsupported database schema version 15"):
        database.migrate()
    database.engine.dispose()


def test_unversioned_existing_database_refuses_startup(tmp_path) -> None:
    database = _database(tmp_path)
    with database.engine.begin() as connection:
        Base.metadata.tables["meetings"].create(connection)

    with pytest.raises(SchemaMigrationError, match="no schema_version"):
        database.migrate()
    database.engine.dispose()


def test_readiness_requires_current_schema(tmp_path) -> None:
    app = create_app(
        database_url=f"sqlite+pysqlite:///{tmp_path / 'readiness.db'}",
        credential_key="test-only-credential-key",
    )
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/ready").json() == {"status": "ready", "schema_version": 14}
        with app.state.database.engine.begin() as connection:
                connection.execute(text("DELETE FROM schema_version WHERE version = 14"))
        response = client.get("/ready")
        assert response.status_code == 503
        assert response.json()["detail"] == "database schema is not current"
