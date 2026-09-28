"""Speaker → email suggestions: careful name matching, explicit approval, tenant scoping."""

from datetime import UTC, datetime
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient
from meetings_contracts import MeetingStatus

from app.accounts import _hash_password
from app.adapters.vexa import VexaCaptureAdapter
from app.database import LEGACY_ORGANIZATION_ID, MeetingSourceRow, OrganizationMembershipRow, OrganizationRow, UserCredentialRow, UserRow
from app.main import create_app
from app.speaker_suggestions import Candidate, normalize_name, suggest_speaker_emails

BOT = "Meetings AI"


def invitee(name: str, email: str) -> Candidate:
    return Candidate(email, name, "invite")


def member(name: str, email: str) -> Candidate:
    return Candidate(email, name, "workspace_member")


def suggest(speakers, candidates, confirmed=None):
    results = suggest_speaker_emails(speakers, candidates, confirmed=confirmed or {}, bot_name=BOT)
    return {item.speaker: item for item in results}


def test_normalisation_strips_case_diacritics_punctuation_and_honorifics() -> None:
    assert normalize_name("  Dr. José  O'Brien-Núñez ") == ("jose", "o", "brien", "nunez")
    assert normalize_name("ABHISHEK") == ("abhishek",)


def test_exact_full_name_is_high_confidence() -> None:
    result = suggest(["Abhishek Sharma"], [invitee("Abhishek Sharma", "abhishek@example.test")])["Abhishek Sharma"]
    assert (result.status, result.email, result.confidence, result.source) == ("suggested", "abhishek@example.test", "high", "invite")
    assert result.reason == "Full name matches invitee Abhishek Sharma"


def test_diacritics_and_word_order_still_match_the_full_name() -> None:
    result = suggest(["jose nunez"], [invitee("José Núñez", "jose@example.test")])["jose nunez"]
    assert (result.email, result.confidence) == ("jose@example.test", "high")
    reordered = suggest(["Sharma, Abhishek"], [invitee("Abhishek Sharma", "a@example.test")])["Sharma, Abhishek"]
    assert reordered.confidence == "high"


def test_unique_first_name_and_last_name_are_medium() -> None:
    people = [invitee("Abhishek Sharma", "abhishek@example.test"), invitee("Maria Lopez", "maria@example.test")]
    first = suggest(["Abhishek"], people)["Abhishek"]
    assert (first.email, first.confidence, first.reason) == ("abhishek@example.test", "medium", "First name matches invitee Abhishek Sharma")
    last = suggest(["Lopez"], people)["Lopez"]
    assert (last.email, last.confidence, last.reason) == ("maria@example.test", "medium", "Last name matches invitee Maria Lopez")


def test_email_local_part_matches_the_name() -> None:
    result = suggest(["Abhishek Sharma"], [invitee("abhishek.sharma@example.test", "abhishek.sharma@example.test")])["Abhishek Sharma"]
    assert (result.email, result.confidence) == ("abhishek.sharma@example.test", "medium")
    assert "abhishek.sharma@example.test" in result.reason


def test_ambiguous_first_name_returns_reason_without_email() -> None:
    people = [invitee("Alex Kim", "alex.kim@example.test"), invitee("Alex Park", "alex.park@example.test")]
    result = suggest(["Alex"], people)["Alex"]
    assert result.status == "ambiguous" and result.email is None and result.confidence is None
    assert "2 people" in result.reason and "Alex Kim" in result.reason and "Alex Park" in result.reason
    assert {item.email for item in result.alternatives} == {"alex.kim@example.test", "alex.park@example.test"}


def test_stronger_evidence_wins_over_a_weaker_tie() -> None:
    people = [invitee("Alex Kim", "alex.kim@example.test"), invitee("Alex Park", "alex.park@example.test")]
    assert suggest(["Alex Kim"], people)["Alex Kim"].email == "alex.kim@example.test"


def test_meeting_invitee_outranks_workspace_directory_at_equal_strength() -> None:
    people = [invitee("Abhishek Sharma", "abhishek@example.test"), member("Abhishek Rao", "rao@example.test")]
    assert suggest(["Abhishek"], people)["Abhishek"].email == "abhishek@example.test"
    directory_only = suggest(["Priya Nair"], [member("Priya Nair", "priya@example.test")])["Priya Nair"]
    assert (directory_only.source, directory_only.confidence) == ("workspace_member", "high")
    assert directory_only.reason == "Full name matches workspace member Priya Nair"


def test_initials_and_nicknames_are_low_and_only_when_unambiguous() -> None:
    people = [invitee("Robert Jones", "robert@example.test"), invitee("Anna Svensson", "anna@example.test")]
    assert suggest(["Bob"], people)["Bob"].confidence == "low"
    assert suggest(["A.S."], people)["A.S."].email == "anna@example.test"
    two_roberts = people + [invitee("Robert Brown", "rbrown@example.test")]
    assert suggest(["Bob"], two_roberts)["Bob"].status == "ambiguous"


def test_bot_unidentified_generic_and_confirmed_speakers_are_skipped() -> None:
    people = [invitee("Alice Smith", "alice@example.test"), invitee("Speaker 1", "s1@example.test"), invitee("Bob Stone", "bob@example.test")]
    result = suggest(["Meetings AI", "Speaker 1", "", "Alice Smith", "Bob Stone"], people, confirmed={"Bob Stone": "bob@example.test"})
    assert list(result) == ["Alice Smith"]


def test_email_already_confirmed_for_another_speaker_is_not_suggested_again() -> None:
    people = [invitee("Alice Smith", "alice@example.test")]
    assert suggest(["Alice"], people, confirmed={"Alice Smith": "alice@example.test"}) == {}


def test_one_email_is_not_proposed_for_two_voices() -> None:
    people = [invitee("Alice Smith", "alice@example.test")]
    result = suggest(["Alice Smith", "Alice"], people)
    assert result["Alice Smith"].email == "alice@example.test"
    assert result["Alice"].status == "ambiguous" and "also matches" in result["Alice"].reason


def test_no_match_produces_no_suggestion() -> None:
    assert suggest(["Zed"], [invitee("Alice Smith", "alice@example.test")]) == {}


def _vexa(segments):
    def handler(request):
        if request.url.path == "/transcripts/by-id/42":
            return httpx.Response(200, json={"status": "completed", "segments": segments})
        if request.url.path.endswith("/participants"):
            return httpx.Response(503, json={"detail": "not available"})
        return httpx.Response(200, json={"status": "completed"})
    return VexaCaptureAdapter("http://vexa.test", transport=httpx.MockTransport(handler))


def _segment(segment_id: str, speaker: str, start: int) -> dict:
    return {"segment_id": segment_id, "start": start, "end": start + 1, "speaker": speaker,
            "source": "glow-bound", "text": f"Line from {speaker}.", "completed": True}


def _completed_meeting(app, client) -> str:
    meeting_id = client.post("/v1/meetings", json={"meeting_url": "https://meet.google.com/abc-defg-hij"}).json()["id"]
    meeting = app.state.repository.get_meeting(meeting_id)
    meeting.vexa_meeting_id = 42
    meeting.status = MeetingStatus.COMPLETED
    app.state.repository.save_meeting(meeting)
    assert client.get(f"/v1/meetings/{meeting_id}/transcript").status_code == 200
    return meeting_id


def _add_source(app, meeting_id: str, organization_id: str, invitees: list[dict], organizer: str | None) -> None:
    now = datetime.now(UTC)
    with app.state.database.session_factory.begin() as session:
        session.add(MeetingSourceRow(
            meeting_id=meeting_id, organization_id=organization_id, provider="googlecalendar",
            connection_id="ca-1", event_id="evt-1", title="Launch review", meeting_url="https://meet.google.com/abc-defg-hij",
            platform="google_meet", starts_at=now, ends_at=now, agenda=None, organizer=organizer,
            invitees=invitees, saved_at=now,
        ))


def test_suggestions_endpoint_uses_invitees_organizer_and_directory_then_bulk_approves(tmp_path) -> None:
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'suggest.db'}", credential_key="test-key",
                     vexa_adapter=_vexa([
                         _segment("s1", "Abhishek", 0), _segment("s2", "Maria Lopez", 2),
                         _segment("s3", "Alex", 4), _segment("s4", "Meetings AI", 6), _segment("s5", "seg_9", 8),
                     ]))
    with TestClient(app) as client:
        meeting_id = _completed_meeting(app, client)
        _add_source(app, meeting_id, str(LEGACY_ORGANIZATION_ID), [
            {"name": "Abhishek Sharma", "email": "abhishek@example.test", "response_status": "accepted"},
            {"name": "Alex Kim", "email": "alex.kim@example.test", "response_status": None},
            {"name": "Alex Park", "email": "alex.park@example.test", "response_status": None},
        ], organizer="maria.lopez@example.test")

        response = client.get(f"/v1/meetings/{meeting_id}/speaker-suggestions")
        assert response.status_code == 200
        by_speaker = {item["speaker"]: item for item in response.json()}
        assert set(by_speaker) == {"Abhishek", "Maria Lopez", "Alex"}
        assert by_speaker["Abhishek"]["email"] == "abhishek@example.test"
        assert by_speaker["Abhishek"]["confidence"] == "medium"
        assert by_speaker["Maria Lopez"]["source"] == "organizer"
        assert by_speaker["Alex"]["status"] == "ambiguous" and by_speaker["Alex"]["email"] is None
        # Suggestions alone never link anything.
        assert client.get(f"/v1/meetings/{meeting_id}/speaker-identities").json() == []

        rejected = client.post(f"/v1/meetings/{meeting_id}/speaker-identities/bulk", json={"identities": [
            {"speaker": "Abhishek", "email": "abhishek@example.test"}, {"speaker": "Nobody", "email": "no@example.test"},
        ]})
        assert rejected.status_code == 409
        assert client.get(f"/v1/meetings/{meeting_id}/speaker-identities").json() == []

        approved = client.post(f"/v1/meetings/{meeting_id}/speaker-identities/bulk", json={"identities": [
            {"speaker": "Abhishek", "email": "abhishek@example.test"}, {"speaker": "Maria Lopez", "email": "maria.lopez@example.test"},
        ]})
        assert approved.status_code == 200
        assert {(item["speaker"], item["email"]) for item in approved.json()} == {
            ("Abhishek", "abhishek@example.test"), ("Maria Lopez", "maria.lopez@example.test"),
        }
        remaining = client.get(f"/v1/meetings/{meeting_id}/speaker-suggestions").json()
        assert [item["speaker"] for item in remaining] == ["Alex"]
        assert client.post(f"/v1/meetings/{meeting_id}/speaker-identities/bulk", json={"identities": [
            {"speaker": "Alex", "email": None},
        ]}).status_code == 422


def test_directory_members_are_suggested_without_a_calendar_source(tmp_path) -> None:
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'directory.db'}", credential_key="test-key",
                     vexa_adapter=_vexa([_segment("s1", "Priya", 0)]))
    user_id, now = uuid4(), datetime.now(UTC)
    with app.state.database.session_factory.begin() as session:
        session.add(UserRow(id=str(user_id), email="priya.nair@example.test", display_name="Priya Nair",
                            auth_subject=f"local:{user_id}", status="active", created_at=now, updated_at=now))
        session.add(OrganizationMembershipRow(organization_id=str(LEGACY_ORGANIZATION_ID), user_id=str(user_id),
                                              role="member", created_at=now))
    with TestClient(app) as client:
        meeting_id = _completed_meeting(app, client)
        suggestions = client.get(f"/v1/meetings/{meeting_id}/speaker-suggestions").json()
        assert [(item["speaker"], item["email"], item["source"], item["confidence"]) for item in suggestions] == [
            ("Priya", "priya.nair@example.test", "workspace_member", "medium"),
        ]


def test_other_workspace_cannot_read_suggestions_or_bulk_approve(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", "owner-password-for-test")
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", "owner@example.test")
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'tenants.db'}", credential_key="test-key",
                     vexa_adapter=_vexa([_segment("s1", "Alice", 0)]))
    other_org, other_user = uuid4(), uuid4()
    now = datetime.now(UTC)
    with app.state.database.session_factory.begin() as session:
        session.add(OrganizationRow(id=str(other_org), slug="other", display_name="Other", contact_email=None,
                                    status="active", created_at=now, updated_at=now))
        session.add(UserRow(id=str(other_user), email="other@example.test", display_name="Other Owner",
                            auth_subject=f"local:{other_user}", status="active", created_at=now, updated_at=now))
        session.add(OrganizationMembershipRow(organization_id=str(other_org), user_id=str(other_user), role="owner", created_at=now))
        session.add(UserCredentialRow(user_id=str(other_user), password_hash=_hash_password("other-password-for-test"),
                                      must_change_password=False, session_version=1, created_at=now, updated_at=now))
    with TestClient(app) as owner, TestClient(app) as other:
        assert owner.post("/v1/auth/login", json={"email": "owner@example.test", "password": "owner-password-for-test"}).status_code == 200
        assert other.post("/v1/auth/login", json={"email": "other@example.test", "password": "other-password-for-test"}).status_code == 200
        meeting_id = _completed_meeting(app, owner)
        assert owner.get(f"/v1/meetings/{meeting_id}/speaker-suggestions").status_code == 200
        assert other.get(f"/v1/meetings/{meeting_id}/speaker-suggestions").status_code == 404
        assert other.post(f"/v1/meetings/{meeting_id}/speaker-identities/bulk", json={"identities": [
            {"speaker": "Alice", "email": "alice@example.test"},
        ]}).status_code == 404
