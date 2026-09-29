"""Who may record in person, upload audio and see recordings: members yes, viewers never, recorder-only controls."""

from __future__ import annotations

import pytest
from account_links import accept_invite
from fastapi.testclient import TestClient
from in_person_helpers import FakeOpenRouterStt, FakeTextModel, configure_providers, no_vexa, start_recording, upload

from app.main import create_app

OWNER_EMAIL, OWNER_PASSWORD = "developer@genaiprotos.com", "owner-password-for-test"


def _login(client: TestClient, email: str, password: str) -> dict:
    client.post("/v1/auth/logout")
    response = client.post("/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return client.get("/v1/auth/me").json()


@pytest.fixture()
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER_PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "in-person-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER_EMAIL)
    monkeypatch.setenv("IN_PERSON_CLEANUP_ENABLED", "0")
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'access.db'}", credential_key="test-key",
                     vexa_adapter=no_vexa())
    with TestClient(app) as client:
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
        configure_providers(app, client, FakeOpenRouterStt(), FakeTextModel())
        invites = {key: client.post("/v1/workspace/invite", json={
            "email": f"{key}@example.com", "display_name": key.title(), "role": role}).json()
            for key, role in (("ada", "admin"), ("mo", "member"), ("mia", "member"), ("vic", "viewer"))}
        for key, invited in invites.items():
            client.post("/v1/auth/logout")
            accept_invite(client, invited, f"{key}-password-long-enough")
        yield {"app": app, "client": client}


def _as(client: TestClient, who: str) -> TestClient:
    if who == "owner":
        _login(client, OWNER_EMAIL, OWNER_PASSWORD)
    else:
        _login(client, f"{who}@example.com", f"{who}-password-long-enough")
    return client


def test_members_can_record_and_open_their_meeting_viewers_cannot(world) -> None:
    client = world["client"]
    _as(client, "vic")
    denied = client.post("/v1/in-person/meetings", json={
        "device": "phone", "mime_type": "audio/webm", "consent": {"everyone_agreed": True}})
    assert denied.status_code == 403

    _as(client, "mo")
    session = start_recording(client)
    meeting_id = session["meeting_id"]
    assert session["recorded_by"]["display_name"] == "Mo" and session["is_recorder"]
    assert upload(client, meeting_id, 0).status_code == 200
    assert client.get(f"/v1/meetings/{meeting_id}").status_code == 200  # the recorder owns the meeting
    assert client.get(f"/v1/meetings/{meeting_id}/transcript").status_code == 200
    assert client.post(f"/v1/meetings/{meeting_id}/join").status_code == 403  # still no Vexa controls for members
    # Call coordination (one assistant per call) never considers in-person recordings.
    assert client.get("/v1/call-coordination/meetings").json() == []
    assert client.get(f"/v1/meetings/{meeting_id}/coordination").status_code == 404

    _as(client, "vic")
    assert client.get(f"/v1/in-person/meetings/{meeting_id}").status_code == 403
    assert upload(client, meeting_id, 1).status_code == 403


def test_only_the_recorder_controls_a_recording_admins_can_view_it(world) -> None:
    client = world["client"]
    _as(client, "mo")
    meeting_id = start_recording(client)["meeting_id"]

    _as(client, "mia")  # another member: the recording doesn't exist for them
    assert client.get(f"/v1/in-person/meetings/{meeting_id}").status_code == 404
    assert upload(client, meeting_id, 0).status_code == 404
    assert client.post(f"/v1/in-person/meetings/{meeting_id}/stop", json={"final_seq": -1}).status_code == 404
    assert client.get(f"/v1/meetings/{meeting_id}").status_code == 404

    _as(client, "ada")  # an admin may view, but not upload into or stop someone else's recording
    viewed = client.get(f"/v1/in-person/meetings/{meeting_id}")
    assert viewed.status_code == 200 and viewed.json()["is_recorder"] is False
    assert upload(client, meeting_id, 0).status_code == 403
    assert client.post(f"/v1/in-person/meetings/{meeting_id}/pause").status_code == 403
    assert client.post(f"/v1/in-person/meetings/{meeting_id}/discard").status_code == 403

    _as(client, "mo")
    assert upload(client, meeting_id, 0).status_code == 200


def test_recordings_are_invisible_to_other_workspaces(world) -> None:
    client = world["client"]
    _as(client, "owner")
    meeting_id = start_recording(client)["meeting_id"]
    created = client.post("/v1/workspaces", json={"display_name": "Second workspace"})
    assert created.status_code in {200, 201}, created.text
    second = created.json()
    target = second.get("organization_id") or second.get("id")
    switched = client.post(f"/v1/workspaces/{target}/switch")
    assert switched.status_code == 200, switched.text
    assert client.get(f"/v1/in-person/meetings/{meeting_id}").status_code == 404
    assert upload(client, meeting_id, 0).status_code == 404
    assert client.get(f"/v1/in-person/meetings/{meeting_id}/speaker-names").status_code == 404


def test_calendar_links_show_members_only_their_own_recordings(world, monkeypatch) -> None:
    from datetime import UTC, datetime, timedelta

    from app.composio_calendar import CalendarEvent, CalendarEventsResponse

    start = datetime(2026, 9, 29, 15, tzinfo=UTC)
    event = CalendarEvent(connection_id="google", provider="googlecalendar", event_id="evt-9", title="Onsite",
                          starts_at=start, ends_at=start + timedelta(hours=1), meeting_url="https://meet.google.com/abc-defg-hij",
                          platform="google_meet", invitees=[])

    async def events_for_window(actor, connection_id, first, last, timezone, **kwargs):
        return CalendarEventsResponse(events=[event], range_start=first, range_end=last, timezone=timezone)

    app, client = world["app"], world["client"]
    monkeypatch.setattr(app.state.calendar_schedule.calendar, "events_for_window", events_for_window, raising=False)
    reference = {"connection_id": "google", "event_id": "evt-9", "event_date": "2026-09-29", "timezone": "UTC"}
    _as(client, "mo")
    mine = start_recording(client, title=None, calendar_event=reference)["meeting_id"]
    start_recording(client)  # not from a calendar event: never listed
    assert client.get("/v1/in-person/calendar-links").json() == [
        {"meeting_id": mine, "connection_id": "google", "event_id": "evt-9", "status": "recording", "title": "Onsite"}]
    _as(client, "mia")
    assert client.get("/v1/in-person/calendar-links").json() == []
    _as(client, "ada")
    assert [item["meeting_id"] for item in client.get("/v1/in-person/calendar-links").json()] == [mine]
    _as(client, "vic")
    assert client.get("/v1/in-person/calendar-links").status_code == 403
