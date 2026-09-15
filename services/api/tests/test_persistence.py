import os
from uuid import uuid4

import pytest
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateTable

from app.database import Base, Database, MeetingRow, ProviderProfileRow, SchemaVersionRow
from app.security import CredentialCipher
from app.sqlalchemy_repository import SQLAlchemyRepository
from meetings_contracts import (
    Capability,
    ExecutionLocation,
    Meeting,
    MeetingPlatform,
    MeetingTranscriptSegment,
    ProviderProfile,
    ProviderType,
)


def test_repository_persists_meetings_and_encrypts_credentials(tmp_path) -> None:
    database_path = tmp_path / "meetings-ai.db"
    database_url = f"sqlite+pysqlite:///{database_path}"
    secret = "provider-secret-plaintext"
    first_database = Database(database_url)
    first_database.migrate()
    first_repository = SQLAlchemyRepository(
        first_database, CredentialCipher("stable-server-key")
    )
    profile = ProviderProfile(
        name="Cloud",
        provider_type=ProviderType.OPENAI,
        execution_location=ExecutionLocation.CLOUD,
        base_url=None,
        models={Capability.TEXT_GENERATION: "configured-model"},
        api_key=secret,
    )
    meeting = Meeting(
        meeting_url="https://meet.google.com/abc-defg-hij",
        bot_name="Meetings AI",
        platform=MeetingPlatform.GOOGLE_MEET,
        native_meeting_id="abc-defg-hij",
    )
    first_repository.save_profile(profile)
    first_repository.save_meeting(meeting)
    first_repository.replace_transcript(
        meeting.id,
        [
            MeetingTranscriptSegment(
                start_seconds=1,
                end_seconds=2,
                text="Persisted words",
                speaker="speaker-1",
                completed=True,
            )
        ],
    )

    with first_database.session_factory() as session:
        row = session.get(ProviderProfileRow, str(profile.id))
        assert row is not None
        assert row.credential_ciphertext != secret
        assert secret not in row.credential_ciphertext
        assert session.get(SchemaVersionRow, Database.SCHEMA_VERSION) is not None
    first_database.engine.dispose()

    # A new repository instance using the same database and server key can read both.
    second_database = Database(database_url)
    second_database.migrate()
    second_repository = SQLAlchemyRepository(
        second_database, CredentialCipher("stable-server-key")
    )
    assert second_repository.get_profile(profile.id).api_key == secret
    assert second_repository.get_meeting(meeting.id).native_meeting_id == "abc-defg-hij"
    assert second_repository.get_transcript(meeting.id)[0].text == "Persisted words"
    second_database.engine.dispose()


@pytest.mark.skipif(
    not os.getenv("TEST_DATABASE_URL"),
    reason="set TEST_DATABASE_URL to run the live PostgreSQL repository witness",
)
def test_repository_round_trip_on_configured_postgresql() -> None:
    database = Database(os.environ["TEST_DATABASE_URL"])
    database.migrate()
    repository = SQLAlchemyRepository(database, CredentialCipher("postgres-test-key"))
    unique = uuid4().hex[:10]
    meeting = Meeting(
        meeting_url=f"https://meet.google.com/abc-defg-hij?test={unique}",
        bot_name="Postgres witness",
        platform=MeetingPlatform.GOOGLE_MEET,
        native_meeting_id=f"abc-defg-hij-{unique}",
    )
    try:
        repository.save_meeting(meeting)

        persisted = repository.get_meeting(meeting.id)

        assert persisted.native_meeting_id == meeting.native_meeting_id
        assert database.engine.dialect.name == "postgresql"
    finally:
        # Keep the developer dashboard free of witness fixtures.
        with database.session_factory.begin() as session:
            session.query(MeetingRow).filter_by(id=str(meeting.id)).delete()
        database.engine.dispose()


def test_schema_compiles_for_postgresql() -> None:
    """Guards portable SQLAlchemy types used by the PostgreSQL Compose deployment."""

    dialect = postgresql.dialect()
    compiled = {
        table.name: str(CreateTable(table).compile(dialect=dialect))
        for table in Base.metadata.sorted_tables
    }
    assert {
        "provider_profiles",
        "provider_defaults",
        "meetings",
        "transcript_segments",
        "schema_version",
    } <= set(compiled)
    assert "BIGINT" in compiled[MeetingRow.__tablename__]
    assert "JSON" in compiled[ProviderProfileRow.__tablename__]
