"""Link-based invitations, access resets and forgot-password: single use, ten minutes, no enumeration."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from hashlib import sha256

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from account_links import ACCEPT_PATH, FakeResend, token_from
from app.database import AccountTokenRow, AuditEventRow, UserCredentialRow, UserRow
from app.main import create_app

OWNER_EMAIL = "owner@example.test"
OWNER_PASSWORD = "owner-password-for-test"
NEW_PASSWORD = "a-fresh-password-for-test"
INSPECT_PATH = "/v1/auth/account-link"
RESET_PATH = "/v1/auth/password-reset"


@pytest.fixture
def make_app(tmp_path, monkeypatch):
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER_PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER_EMAIL)
    monkeypatch.setenv("WEB_ORIGIN", "https://meetings.example.test")

    def build(resend: FakeResend | None = None):
        return create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'links.db'}",
                          credential_key="test-credential-key", resend_adapter=resend or FakeResend())
    return build


def _login(client: TestClient, email: str = OWNER_EMAIL, password: str = OWNER_PASSWORD) -> int:
    return client.post("/v1/auth/login", json={"email": email, "password": password}).status_code


def _invite(client: TestClient, email: str = "mate@example.test", role: str = "member", name: str = "Team Mate"):
    response = client.post("/v1/workspace/invite", json={"email": email, "display_name": name, "role": role})
    assert response.status_code == 201, response.text
    return response.json()


def _accept(client: TestClient, token: str, password: str = NEW_PASSWORD):
    return client.post(ACCEPT_PATH, json={"token": token, "password": password})


def _expire_all_links(app) -> None:
    with app.state.database.session_factory.begin() as session:
        session.execute(update(AccountTokenRow).values(expires_at=datetime.now(UTC) - timedelta(seconds=1)))


def test_invite_emails_a_single_use_link_and_accepting_signs_in(make_app) -> None:
    resend = FakeResend()
    app = make_app(resend)
    with TestClient(app) as owner, TestClient(app) as mate:
        assert _login(owner) == 200
        workspace_id = owner.get("/v1/auth/me").json()["organization_id"]
        invited = _invite(owner)
        assert invited["temporary_password"] is None
        assert invited["accept_url"] is None
        assert invited["email_sent"] is True
        assert invited["link_expires_at"]
        message = resend.sent[0]
        assert message["recipients"] == ["mate@example.test"]
        assert "Accept invite" in message["html"] and "10 minutes" in message["text"]
        assert "Workspace owner" in message["text"] and "mate@example.test" in message["text"]
        token = token_from(message["text"])
        assert f"https://meetings.example.test/#accept={token}" in message["text"]

        listed = {item["email"]: item for item in owner.get("/v1/workspace/members").json()}
        assert listed["mate@example.test"]["status"] == "invited"
        assert listed["mate@example.test"]["invite_expires_at"]
        # No usable password exists before acceptance.
        assert _login(mate, "mate@example.test", "") in {401, 422}

        preview = mate.post(INSPECT_PATH, json={"token": token}).json()
        assert preview["state"] == "valid" and preview["purpose"] == "invite"
        assert preview["email"] == "mate@example.test"
        accepted = _accept(mate, token)
        assert accepted.status_code == 200
        assert accepted.json()["organization_id"] == workspace_id
        me = mate.get("/v1/auth/me").json()
        assert me["email"] == "mate@example.test" and me["must_change_password"] is False
        assert mate.get("/v1/knowledge-bases").status_code == 200
        listed = {item["email"]: item for item in owner.get("/v1/workspace/members").json()}
        assert listed["mate@example.test"]["status"] == "active"
        assert listed["mate@example.test"]["invite_expires_at"] is None
        mate.post("/v1/auth/logout")
        assert _login(mate, "mate@example.test", NEW_PASSWORD) == 200

        # Reusing the link fails even though it has not expired.
        reused = _accept(TestClient(app), token, "another-password-for-test")
        assert reused.status_code == 410
        assert reused.json()["detail"]["reason"] == "used"
        with app.state.database.session_factory() as session:
            row = session.execute(select(AccountTokenRow)).scalar_one()
            assert row.token_hash == sha256(token.encode()).hexdigest()
            actions = set(session.execute(select(AuditEventRow.action)).scalars())
        assert {"auth.invite.accepted", "POST /v1/workspace/invite", "auth.account_link.denied"} <= actions


def test_expired_revoked_and_invalid_links_are_refused(make_app) -> None:
    resend = FakeResend()
    app = make_app(resend)
    with TestClient(app) as owner, TestClient(app) as mate:
        assert _login(owner) == 200
        member_id = _invite(owner)["account"]["user_id"]
        first = token_from(resend.sent[-1]["text"])
        resent = owner.post(f"/v1/workspace/members/{member_id}/resend-invite")
        assert resent.status_code == 200 and resent.json()["email_sent"] is True
        second = token_from(resend.sent[-1]["text"])
        assert first != second
        assert resend.sent[0]["idempotency_key"] != resend.sent[1]["idempotency_key"]

        assert mate.post(INSPECT_PATH, json={"token": first}).json() == {
            "state": "revoked", "purpose": "invite", "email": None, "display_name": None,
            "workspace_name": None, "expires_at": None,
        }
        assert _accept(mate, first).json()["detail"]["reason"] == "revoked"
        assert mate.post(INSPECT_PATH, json={"token": "not-a-real-token-at-all"}).json()["state"] == "invalid"
        assert _accept(mate, "not-a-real-token-at-all").json()["detail"]["reason"] == "invalid"

        _expire_all_links(app)
        assert mate.post(INSPECT_PATH, json={"token": second}).json()["state"] == "expired"
        expired = _accept(mate, second)
        assert expired.status_code == 410 and expired.json()["detail"]["reason"] == "expired"
        assert "expired" in expired.json()["detail"]["message"]
        assert mate.get("/v1/auth/session").json() == {"authenticated": False}
        members = {item["user_id"]: item for item in owner.get("/v1/workspace/members").json()}
        assert members[member_id]["invite_expires_at"] is not None  # still listed; the UI shows "expired"

        # A fresh link works again after expiry.
        assert owner.post(f"/v1/workspace/members/{member_id}/resend-invite").status_code == 200
        assert _accept(mate, token_from(resend.sent[-1]["text"])).status_code == 200


def test_short_password_does_not_consume_the_link(make_app) -> None:
    resend = FakeResend()
    app = make_app(resend)
    with TestClient(app) as owner, TestClient(app) as mate:
        assert _login(owner) == 200
        _invite(owner)
        token = token_from(resend.sent[-1]["text"])
        assert _accept(mate, token, "too-short").status_code == 422
        assert _accept(mate, token).status_code == 200


def test_resend_only_for_pending_members_and_admins(make_app) -> None:
    resend = FakeResend()
    app = make_app(resend)
    with TestClient(app) as owner, TestClient(app) as mate:
        assert _login(owner) == 200
        member_id = _invite(owner)["account"]["user_id"]
        assert _accept(mate, token_from(resend.sent[-1]["text"])).status_code == 200
        assert owner.post(f"/v1/workspace/members/{member_id}/resend-invite").status_code == 409
        assert mate.post(f"/v1/workspace/members/{member_id}/resend-invite").status_code == 403


def test_email_unconfigured_returns_link_once_and_removal_revokes_it(make_app) -> None:
    app = make_app(FakeResend(configured=False))
    with TestClient(app) as owner, TestClient(app) as mate:
        assert _login(owner) == 200
        invited = _invite(owner)
        assert invited["email_sent"] is False
        assert invited["accept_url"].startswith("https://meetings.example.test/#accept=")
        assert "expires in 10 minutes" in invited["note"]
        # The link is not stored or listed anywhere else.
        assert invited["accept_url"] not in owner.get("/v1/workspace/members").text
        assert invited["accept_url"] not in owner.get("/v1/workspace/audit").text

        removed = _invite(owner, "gone@example.test", name="Gone Mate")
        assert owner.delete(f"/v1/workspace/members/{removed['account']['user_id']}").status_code == 204
        assert _accept(mate, token_from(removed["accept_url"])).json()["detail"]["reason"] == "revoked"
        assert _accept(mate, token_from(invited["accept_url"])).status_code == 200


def test_failed_email_falls_back_to_copy_link(make_app) -> None:
    app = make_app(FakeResend(fail=True))
    with TestClient(app) as owner:
        assert _login(owner) == 200
        invited = _invite(owner)
        assert invited["email_sent"] is False and invited["accept_url"]
        assert "couldn't be sent" in invited["note"]


def test_existing_account_is_added_without_a_link(make_app) -> None:
    resend = FakeResend()
    app = make_app(resend)
    with TestClient(app) as owner, TestClient(app) as mate:
        assert _login(owner) == 200
        _invite(owner)
        assert _accept(mate, token_from(resend.sent[-1]["text"])).status_code == 200
        owner.post("/v1/workspaces", json={"display_name": "Second Workspace"})
        added = _invite(owner, role="viewer")
        assert added["accept_url"] is None and added["email_sent"] is True
        email = resend.sent[-1]
        assert "#accept=" not in email["text"] and "existing password" in email["text"]
        assert "Second Workspace" in email["subject"]
        with app.state.database.session_factory() as session:
            assert session.execute(select(AccountTokenRow).where(AccountTokenRow.used_at.is_(None))).first() is None


def test_pending_account_in_another_workspace_never_gets_a_copy_link(make_app) -> None:
    app = make_app(FakeResend(configured=False))
    with TestClient(app) as owner:
        assert _login(owner) == 200
        first = _invite(owner)
        owner.post("/v1/workspaces", json={"display_name": "Second Workspace"})
        second = _invite(owner)
        assert first["accept_url"] and second["accept_url"] is None
        assert "only be sent by email" in second["note"]
        assert owner.post(f"/v1/workspace/members/{second['account']['user_id']}/resend-invite").json()["accept_url"] is None


def test_reset_access_emails_link_and_invalidates_sessions(make_app) -> None:
    resend = FakeResend()
    app = make_app(resend)
    with TestClient(app) as owner, TestClient(app) as mate, TestClient(app) as fresh:
        assert _login(owner) == 200
        member_id = _invite(owner)["account"]["user_id"]
        assert _accept(mate, token_from(resend.sent[-1]["text"])).status_code == 200
        assert mate.get("/v1/auth/me").status_code == 200

        reset = owner.post(f"/v1/workspace/members/{member_id}/reset-access")
        assert reset.status_code == 200, reset.text
        assert reset.json()["email_sent"] is True and reset.json()["accept_url"] is None
        message = resend.sent[-1]
        assert "Set a new password" in message["html"] and "#reset=" in message["text"]
        assert "10 minutes" in message["text"]
        assert mate.get("/v1/auth/me").status_code == 401
        assert _login(fresh, "mate@example.test", NEW_PASSWORD) == 401

        token = token_from(message["text"])
        assert fresh.post(INSPECT_PATH, json={"token": token}).json()["purpose"] == "password_reset"
        assert _accept(fresh, token, "brand-new-password-for-test").status_code == 200
        assert fresh.get("/v1/auth/me").json()["email"] == "mate@example.test"
        with app.state.database.session_factory() as session:
            actions = set(session.execute(select(AuditEventRow.action)).scalars())
        assert {"auth.password_reset.completed", "POST /v1/workspace/members/{user_id}/reset-access"} <= actions


def test_reset_permissions_follow_roles(make_app) -> None:
    resend = FakeResend()
    app = make_app(resend)
    with TestClient(app) as owner, TestClient(app) as admin, TestClient(app) as member:
        assert _login(owner) == 200
        owner_id = owner.get("/v1/auth/me").json()["user_id"]
        admin_id = _invite(owner, "admin@example.test", "admin", "Admin User")["account"]["user_id"]
        assert _accept(admin, token_from(resend.sent[-1]["text"])).status_code == 200
        other_admin = _invite(owner, "admin2@example.test", "admin", "Second Admin")["account"]["user_id"]
        member_id = _invite(owner, "member@example.test", "member", "Member User")["account"]["user_id"]
        assert _accept(member, token_from(resend.sent[-1]["text"])).status_code == 200

        assert admin.post(f"/v1/workspace/members/{owner_id}/reset-access").status_code == 409
        assert admin.post(f"/v1/workspace/members/{other_admin}/reset-access").status_code == 409
        assert admin.post(f"/v1/workspace/members/{other_admin}/resend-invite").status_code == 409
        assert admin.post(f"/v1/workspace/members/{admin_id}/reset-access").status_code == 409  # self
        assert member.post(f"/v1/workspace/members/{admin_id}/reset-access").status_code == 403
        assert admin.post(f"/v1/workspace/members/{member_id}/reset-access").status_code == 200
        assert owner.post(f"/v1/workspace/members/{admin_id}/reset-access").status_code == 200
        # The legacy path still works for older clients.
        assert owner.post(f"/v1/workspace/members/{member_id}/temporary-password").status_code == 200


def test_multi_workspace_reset_needs_email(make_app, tmp_path) -> None:
    for configured, expected in ((False, 409), (True, 200)):
        resend = FakeResend(configured=configured)
        app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / f'multi-{configured}.db'}",
                         credential_key="test-credential-key", resend_adapter=resend)
        with TestClient(app) as owner, TestClient(app) as mate:
            assert _login(owner) == 200
            invited = _invite(owner)
            token = token_from(invited["accept_url"] if not configured else resend.sent[-1]["text"])
            assert _accept(mate, token).status_code == 200
            owner.post("/v1/workspaces", json={"display_name": "Second Workspace"})
            _invite(owner)
            reset = owner.post(f"/v1/workspace/members/{invited['account']['user_id']}/reset-access")
            assert reset.status_code == expected, reset.text
            assert reset.json().get("accept_url") is None
            # A refused reset leaves the password alone.
            assert _login(TestClient(app), "mate@example.test", NEW_PASSWORD) == (200 if not configured else 401)


def test_forgot_password_never_reveals_accounts_and_is_rate_limited(make_app) -> None:
    resend = FakeResend()
    app = make_app(resend)
    with TestClient(app) as owner, TestClient(app) as mate, TestClient(app) as stranger:
        assert _login(owner) == 200
        _invite(owner)
        assert _accept(mate, token_from(resend.sent[-1]["text"])).status_code == 200
        sent_before = len(resend.sent)

        known = stranger.post(RESET_PATH, json={"email": "Mate@Example.test"})
        unknown = stranger.post(RESET_PATH, json={"email": "nobody@example.test"})
        assert known.status_code == unknown.status_code == 202
        assert known.json() == unknown.json()
        assert len(resend.sent) == sent_before + 1
        message = resend.sent[-1]
        assert message["recipients"] == ["mate@example.test"]
        assert "Set a new password" in message["html"]

        # The current password keeps working until the link is used.
        assert _login(TestClient(app), "mate@example.test", NEW_PASSWORD) == 200
        assert _accept(stranger, token_from(message["text"]), "reset-by-link-password").status_code == 200
        assert mate.get("/v1/auth/me").status_code == 401  # older sessions end
        assert _login(TestClient(app), "mate@example.test", "reset-by-link-password") == 200

        for _ in range(2):
            assert stranger.post(RESET_PATH, json={"email": "nobody@example.test"}).status_code == 202
        limited = stranger.post(RESET_PATH, json={"email": "nobody@example.test"})
        assert limited.status_code == 429 and limited.headers["Retry-After"]
        # Per-IP limit: many different addresses from one client are throttled too.
        statuses = [stranger.post(RESET_PATH, json={"email": f"p{index}@example.test"}).status_code for index in range(20)]
        assert statuses[-1] == 429


def test_forgot_password_without_email_delivery_sends_nothing(make_app) -> None:
    app = make_app(FakeResend(configured=False))
    with TestClient(app) as client:
        response = client.post(RESET_PATH, json={"email": OWNER_EMAIL})
        assert response.status_code == 202
        with app.state.database.session_factory() as session:
            assert session.execute(select(AccountTokenRow)).first() is None


def test_invited_user_cannot_sign_in_before_accepting(make_app) -> None:
    app = make_app(FakeResend(configured=False))
    with TestClient(app) as owner:
        assert _login(owner) == 200
        _invite(owner)
        with app.state.database.session_factory() as session:
            user = session.execute(select(UserRow).where(UserRow.email == "mate@example.test")).scalar_one()
            credential = session.get(UserCredentialRow, user.id)
            assert credential.password_hash.startswith("!unusable:")
        assert _login(TestClient(app), "mate@example.test", credential.password_hash) == 401


def test_an_invite_from_another_workspace_never_revokes_this_workspaces_link(make_app) -> None:
    app = make_app(FakeResend(configured=False))
    with TestClient(app) as owner, TestClient(app) as mate:
        assert _login(owner) == 200
        first = token_from(_invite(owner)["accept_url"])
        owner.post("/v1/workspaces", json={"display_name": "Second Workspace"})
        _invite(owner)  # the same person, pending, invited again from an unrelated workspace
        assert owner.post(INSPECT_PATH, json={"token": first}).json()["state"] == "valid"
        user_id = _invite_user_id(app)
        resent = owner.post(f"/v1/workspace/members/{user_id}/resend-invite")
        assert resent.status_code == 200
        # Resending inside the second workspace still leaves the first workspace's link alone.
        assert mate.post(INSPECT_PATH, json={"token": first}).json()["state"] == "valid"
        assert _accept(mate, first).status_code == 200


def _invite_user_id(app) -> str:
    with app.state.database.session_factory() as session:
        return session.execute(select(UserRow.id).where(UserRow.email == "mate@example.test")).scalar_one()
