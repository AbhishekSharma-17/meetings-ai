"""Sharing a meeting with workspace members, resending the recap, and the sharing history.

Resend (email) is a mocked transport; nothing leaves the test process.
"""

from datetime import UTC, datetime, timedelta

import pytest
from account_links import ACCEPT_PATH, FakeResend, token_from
from fastapi.testclient import TestClient
from meetings_contracts import (
    MeetingMinutes,
    MeetingStatus,
    MeetingTranscriptSegment,
    MinutesStatus,
)
from sqlalchemy import select, text, update

from app.database import (
    Database,
    EmailDeliveryRow,
    EmailDeliverySenderRow,
    MeetingShareRow,
    NotificationRow,
    OrganizationMembershipRow,
    SchemaVersionRow,
)
from app.main import create_app

OWNER_EMAIL, OWNER_PASSWORD = "developer@genaiprotos.com", "owner-password-for-test"


@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER_PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "sharing-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER_EMAIL)
    mail = FakeResend()
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'sharing.db'}", credential_key="test-key",
                     resend_adapter=mail)
    # Approval bookkeeping (transcript revisions) is covered by the minutes tests.
    app.state.minutes_service._require_current_transcript = lambda _meeting_id: None
    with TestClient(app) as client:
        owner = _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        client.patch("/v1/auth/me", json={"display_name": "Asha Patel"})
        ids = {"asha": owner["user_id"]}
        for key, name, role in (("cara", "Cara Lee", "member"), ("dan", "Dan Wu", "member"), ("vic", "Vic Ray", "viewer")):
            _login(client, OWNER_EMAIL, OWNER_PASSWORD)
            invited = client.post("/v1/workspace/invite", json={"email": f"{key}@example.com", "display_name": name, "role": role})
            assert invited.status_code in {200, 201}, invited.text
            token = token_from(str(mail.sent[-1].get("text") or mail.sent[-1].get("html")))
            client.post("/v1/auth/logout")
            accepted = client.post(ACCEPT_PATH, json={"token": token, "password": f"{key}-password-long-enough"})
            assert accepted.status_code == 200, accepted.text
            ids[key] = accepted.json()["user_id"]
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        pending = client.post("/v1/workspace/invite", json={"email": "pat@example.com", "display_name": "Pat", "role": "member"}).json()
        ids["pat"] = pending.get("user_id") or next(
            (item["user_id"] for item in client.get("/v1/workspace/members").json() if item["email"] == "pat@example.com"), None)
        mail.sent.clear()
        meeting_id = _completed_meeting(app, client)
        yield {"app": app, "client": client, "mail": mail, "meeting": meeting_id, **ids}


def _login(client: TestClient, email: str, password: str) -> dict:
    client.post("/v1/auth/logout")
    response = client.post("/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return client.get("/v1/auth/me").json()


def _as(world, who: str) -> TestClient:
    client = world["client"]
    if who == "asha":
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
    else:
        _login(client, f"{who}@example.com", f"{who}-password-long-enough")
    return client


def _completed_meeting(app, client: TestClient, *, minutes_status: MinutesStatus = MinutesStatus.APPROVED) -> str:
    meeting_id = client.post("/v1/meetings", json={"meeting_url": "https://meet.google.com/abc-defg-hij", "title": "Acme renewal"}).json()["id"]
    repository = app.state.repository
    meeting = repository.get_meeting(meeting_id)
    meeting.status = MeetingStatus.COMPLETED
    meeting.joined_at = datetime.now(UTC) - timedelta(hours=1)
    repository.save_meeting(meeting)
    repository.replace_transcript(meeting.id, [MeetingTranscriptSegment(
        segment_id="s1", start_seconds=0, end_seconds=4, speaker="Asha", text="We renew for two years.", completed=True)])
    repository.save_minutes(MeetingMinutes(
        meeting_id=meeting.id, title="Acme renewal", executive_summary="Acme renews for two years.",
        decisions=["Renew for two years"], status=minutes_status,
        approved_at=datetime.now(UTC) if minutes_status is not MinutesStatus.DRAFT else None))
    return meeting_id


def _notes(world, user_id: str) -> list[NotificationRow]:
    with world["app"].state.database.session_factory() as session:
        return session.execute(select(NotificationRow).where(NotificationRow.user_id == user_id)).scalars().all()


# ----- sharing ---------------------------------------------------------------------------------

def test_a_shared_member_reads_the_transcript_and_approved_minutes(world) -> None:
    meeting = world["meeting"]
    cara = _as(world, "cara")
    assert cara.get(f"/v1/meetings/{meeting}").status_code == 404  # nothing shared yet
    assert cara.get(f"/v1/meetings/{meeting}/shared-view").status_code == 404

    admin = _as(world, "asha")
    shared = admin.post(f"/v1/meetings/{meeting}/shares", json={"user_ids": [world["cara"]], "note": "  Read before Friday  "})
    assert shared.status_code == 200, shared.text
    share = shared.json()["shares"][0]
    assert share["person"]["display_name"] == "Cara Lee" and share["shared_by"]["display_name"] == "Asha Patel"
    assert share["note"] == "Read before Friday" and share["revoked_at"] is None

    cara = _as(world, "cara")
    assert cara.get(f"/v1/meetings/{meeting}").status_code == 200
    assert cara.get(f"/v1/meetings/{meeting}/transcript").json()["segments"][0]["text"] == "We renew for two years."
    view = cara.get(f"/v1/meetings/{meeting}/shared-view").json()
    assert view["minutes"]["executive_summary"] == "Acme renews for two years."
    assert view["shared_by"]["display_name"] == "Asha Patel" and view["note"] == "Read before Friday"
    listed = cara.get("/v1/me/shared-meetings").json()
    assert [(item["meeting_id"], item["title"]) for item in listed] == [(meeting, "Acme renewal")]
    # Reading only: no minutes editing, no sharing onward, no history, no delete.
    assert cara.get(f"/v1/meetings/{meeting}/minutes").status_code == 403
    assert cara.post(f"/v1/meetings/{meeting}/shares", json={"user_ids": [world["dan"]]}).status_code == 403
    assert cara.get(f"/v1/meetings/{meeting}/sharing").status_code == 403
    assert cara.delete(f"/v1/meetings/{meeting}").status_code in {403, 404}

    # Someone it isn't shared with still sees nothing.
    dan = _as(world, "dan")
    assert dan.get(f"/v1/meetings/{meeting}/transcript").status_code == 404
    assert dan.get("/v1/me/shared-meetings").json() == []

    notes = [note for note in _notes(world, world["cara"]) if note.kind == "meeting.shared"]
    assert len(notes) == 1 and notes[0].title == "Asha Patel shared “Acme renewal” with you"
    assert notes[0].link_view == "meeting" and notes[0].link_id == meeting


def test_draft_minutes_stay_hidden_from_a_shared_member(world) -> None:
    admin = _as(world, "asha")
    draft = _completed_meeting(world["app"], admin, minutes_status=MinutesStatus.DRAFT)
    admin.post(f"/v1/meetings/{draft}/shares", json={"user_ids": [world["cara"]]})
    view = _as(world, "cara").get(f"/v1/meetings/{draft}/shared-view").json()
    assert view["minutes"] is None


def test_revoking_ends_access_and_the_history_keeps_it(world) -> None:
    meeting = world["meeting"]
    admin = _as(world, "asha")
    share_id = admin.post(f"/v1/meetings/{meeting}/shares", json={"user_ids": [world["cara"], world["dan"]]}).json()["shares"]
    cara_share = next(item["id"] for item in share_id if item["person"]["user_id"] == world["cara"])
    # Sharing again with someone who already has access adds nothing and notifies no one twice.
    again = admin.post(f"/v1/meetings/{meeting}/shares", json={"user_ids": [world["cara"]]}).json()
    assert len(again["shares"]) == 2

    revoked = admin.delete(f"/v1/meetings/{meeting}/shares/{cara_share}")
    assert revoked.status_code == 200
    row = next(item for item in revoked.json()["shares"] if item["id"] == cara_share)
    assert row["revoked_at"] and row["revoked_by"]["display_name"] == "Asha Patel"

    cara = _as(world, "cara")
    assert cara.get(f"/v1/meetings/{meeting}/transcript").status_code == 404
    assert cara.get("/v1/me/shared-meetings").json() == []
    assert len([note for note in _notes(world, world["cara"]) if note.kind == "meeting.shared"]) == 1

    # Sharing after a revoke grants access again as a new entry in the history.
    admin = _as(world, "asha")
    history = admin.post(f"/v1/meetings/{meeting}/shares", json={"user_ids": [world["cara"]]}).json()["shares"]
    assert sum(item["person"]["user_id"] == world["cara"] for item in history) == 2
    assert _as(world, "cara").get(f"/v1/meetings/{meeting}/transcript").status_code == 200


def test_only_active_members_of_this_workspace_can_be_chosen(world) -> None:
    meeting = world["meeting"]
    admin = _as(world, "asha")
    stranger = "00000000-0000-4000-8000-00000000abcd"
    refused = admin.post(f"/v1/meetings/{meeting}/shares", json={"user_ids": [world["cara"], stranger]})
    assert refused.status_code == 422 and "not an active member" in refused.json()["detail"]
    if world["pat"]:  # an invite that hasn't been accepted yet
        assert admin.post(f"/v1/meetings/{meeting}/shares", json={"user_ids": [world["pat"]]}).status_code == 422
    assert admin.post(f"/v1/meetings/{meeting}/shares", json={"user_ids": [world["asha"]]}).status_code == 422
    assert admin.post(f"/v1/meetings/{meeting}/shares", json={"user_ids": []}).status_code == 422
    assert admin.get(f"/v1/meetings/{meeting}/sharing").json()["shares"] == []  # nothing half-applied


def test_a_viewer_can_be_shared_with_too(world) -> None:
    meeting = world["meeting"]
    _as(world, "asha").post(f"/v1/meetings/{meeting}/shares", json={"user_ids": [world["vic"]]})
    vic = _as(world, "vic")
    assert vic.get(f"/v1/meetings/{meeting}/shared-view").status_code == 200
    assert vic.get(f"/v1/meetings/{meeting}/transcript").status_code == 200


# ----- recap emails ----------------------------------------------------------------------------

def test_recap_then_resend_to_someone_else_with_history(world) -> None:
    meeting = world["meeting"]
    admin = _as(world, "asha")
    assert admin.post(f"/v1/meetings/{meeting}/minutes/resend", json={"recipients": ["late@example.com"]}).status_code == 409

    first = admin.post(f"/v1/meetings/{meeting}/minutes/send", json={"recipients": ["team@example.com"]})
    assert first.status_code == 200, first.text
    assert admin.get(f"/v1/meetings/{meeting}/minutes").json()["status"] == "sent"

    again = admin.post(f"/v1/meetings/{meeting}/minutes/resend", json={"recipients": ["Late@Example.com"], "include_transcript": True})
    assert again.status_code == 200, again.text
    assert again.json()["recipients"] == ["late@example.com"] and again.json()["status"] == "sent"
    twice = admin.post(f"/v1/meetings/{meeting}/minutes/resend", json={"recipients": ["late@example.com"]})
    assert twice.status_code == 200  # a deliberate repeat is a new email, not deduplicated away

    emails = world["mail"].sent
    assert [item["recipients"] for item in emails] == [["team@example.com"], ["late@example.com"], ["late@example.com"]]
    assert len({item["idempotency_key"] for item in emails}) == 3
    assert emails[1].get("attachments")  # the transcript was attached to the resend
    assert admin.get(f"/v1/meetings/{meeting}/minutes").json()["status"] == "sent"  # the MOM is unchanged

    deliveries = admin.get(f"/v1/meetings/{meeting}/sharing").json()["deliveries"]
    assert [(item["kind"], item["recipients"]) for item in deliveries] == [
        ("resend", ["late@example.com"]), ("resend", ["late@example.com"]), ("recap", ["team@example.com"])]
    assert all(item["sent_by"]["display_name"] == "Asha Patel" for item in deliveries)
    assert deliveries[1]["include_transcript"] is True and deliveries[2]["include_transcript"] is False


def test_a_failed_resend_is_recorded_and_the_mom_stays_sent(world) -> None:
    meeting = world["meeting"]
    admin = _as(world, "asha")
    admin.post(f"/v1/meetings/{meeting}/minutes/send", json={"recipients": ["team@example.com"]})
    world["mail"].fail = True
    failed = admin.post(f"/v1/meetings/{meeting}/minutes/resend", json={"recipients": ["late@example.com"]})
    assert failed.status_code == 502
    minutes = admin.get(f"/v1/meetings/{meeting}/minutes").json()
    assert minutes["status"] == "sent" and not minutes.get("last_error")
    latest = admin.get(f"/v1/meetings/{meeting}/sharing").json()["deliveries"][0]
    assert latest["kind"] == "resend" and latest["status"] == "failed" and latest["sent_by"]["display_name"] == "Asha Patel"


def test_deliveries_from_before_senders_were_recorded_still_show(world) -> None:
    meeting = world["meeting"]
    now = datetime.now(UTC)
    with world["app"].state.database.session_factory.begin() as session:
        session.add(EmailDeliveryRow(id="11111111-1111-4111-8111-111111111111", meeting_id=meeting, recipients=["a@example.com"],
                                     status="sent", provider_message_id="x", error=None, created_at=now - timedelta(hours=2)))
        session.add(EmailDeliveryRow(id="22222222-2222-4222-8222-222222222222", meeting_id=meeting, recipients=["b@example.com"],
                                     status="sent", provider_message_id="y", error=None, created_at=now - timedelta(hours=1)))
    deliveries = _as(world, "asha").get(f"/v1/meetings/{meeting}/sharing").json()["deliveries"]
    assert [(item["kind"], item["sent_by"]) for item in deliveries] == [("resend", None), ("recap", None)]


def test_members_cannot_resend_and_resends_are_rate_limited(world) -> None:
    meeting = world["meeting"]
    admin = _as(world, "asha")
    admin.post(f"/v1/meetings/{meeting}/minutes/send", json={"recipients": ["team@example.com"]})
    admin.post(f"/v1/meetings/{meeting}/shares", json={"user_ids": [world["cara"]]})
    assert _as(world, "cara").post(f"/v1/meetings/{meeting}/minutes/resend", json={"recipients": ["x@example.com"]}).status_code == 403
    admin = _as(world, "asha")
    codes = [admin.post(f"/v1/meetings/{meeting}/minutes/resend", json={"recipients": ["x@example.com"]}).status_code for _ in range(11)]
    assert codes[:10] == [200] * 10 and codes[10] == 429


def test_deleting_the_meeting_removes_its_shares(world) -> None:
    meeting = world["meeting"]
    admin = _as(world, "asha")
    admin.post(f"/v1/meetings/{meeting}/shares", json={"user_ids": [world["cara"]]})
    admin.post(f"/v1/meetings/{meeting}/minutes/send", json={"recipients": ["team@example.com"]})
    assert admin.delete(f"/v1/meetings/{meeting}").status_code in {200, 204}
    assert _as(world, "cara").get("/v1/me/shared-meetings").json() == []


def test_v31_database_upgrades_to_v32_with_sharing_tables(tmp_path) -> None:
    url = f"sqlite+pysqlite:///{tmp_path / 'upgrade.db'}"
    database = Database(url)
    database.migrate()
    with database.engine.begin() as connection:
        connection.execute(text("DROP TABLE meeting_shares"))
        connection.execute(text("DROP TABLE email_delivery_senders"))
        connection.execute(text("DELETE FROM schema_version WHERE version >= 32"))
    database.engine.dispose()
    upgraded = Database(url)
    upgraded.migrate()
    with upgraded.session_factory() as session:
        assert max(session.execute(select(SchemaVersionRow.version)).scalars().all()) == Database.SCHEMA_VERSION >= 32
    with upgraded.engine.connect() as connection:
        names = set(upgraded.engine.dialect.get_table_names(connection))
    assert {"meeting_shares", "email_delivery_senders"} <= names
    upgraded.engine.dispose()


def test_removing_a_member_ends_their_shares_even_if_they_are_invited_again(world) -> None:
    meeting = world["meeting"]
    admin = _as(world, "asha")
    admin.post(f"/v1/meetings/{meeting}/shares", json={"user_ids": [world["cara"]]})
    assert admin.delete(f"/v1/workspace/members/{world['cara']}").status_code in {200, 204}
    share = admin.get(f"/v1/meetings/{meeting}/sharing").json()["shares"][0]
    assert share["revoked_at"] and share["revoked_by"]["display_name"] == "Asha Patel"
    # Invited again later: a share from the earlier membership (even one left unrevoked) grants nothing.
    with world["app"].state.database.session_factory.begin() as session:
        session.execute(update(MeetingShareRow).values(revoked_at=None, revoked_by=None))
        org = session.execute(select(MeetingShareRow.organization_id)).scalars().first()
        session.add(OrganizationMembershipRow(organization_id=org, user_id=world["cara"], role="member",
                                              created_at=datetime.now(UTC) + timedelta(seconds=1)))
    cara = _as(world, "cara")
    assert cara.get(f"/v1/meetings/{meeting}/transcript").status_code == 404
    assert cara.get("/v1/me/shared-meetings").json() == []


def test_the_sender_is_recorded_only_when_an_email_is_attempted(world) -> None:
    meeting = world["meeting"]
    admin = _as(world, "asha")
    assert admin.post(f"/v1/meetings/{meeting}/minutes/resend", json={"recipients": ["x@example.com"]}).status_code == 409
    with world["app"].state.database.session_factory() as session:
        assert session.execute(select(EmailDeliverySenderRow)).scalars().all() == []


def test_everyone_sees_only_their_own_activity_and_admins_see_the_workspace(world) -> None:
    meeting = world["meeting"]
    admin = _as(world, "asha")
    admin.post(f"/v1/meetings/{meeting}/shares", json={"user_ids": [world["cara"]]})
    cara = _as(world, "cara")
    cara.put("/v1/me/preferences", json={"time_zone": "Asia/Kolkata"})
    mine = cara.get("/v1/me/activity")
    assert mine.status_code == 200
    assert mine.json() and {item["actor_user_id"] for item in mine.json()} == {world["cara"]}
    assert cara.get("/v1/workspace/audit").status_code == 403
    admin = _as(world, "asha")
    assert {item["actor_user_id"] for item in admin.get("/v1/me/activity").json()} == {world["asha"]}
    everyone = {item["actor_user_id"] for item in admin.get("/v1/workspace/audit").json()}
    assert {world["asha"], world["cara"]} <= everyone


def test_a_webex_link_is_refused_with_a_clear_reason(world) -> None:
    response = _as(world, "asha").post("/v1/meetings", json={"meeting_url": "https://acme.webex.com/meet/jane", "title": "Webex call"})
    assert response.status_code == 422
    assert "Webex meetings aren't supported yet" in response.text
