"""Retryable access-change emails. Driven only by the elected background leader."""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from html import escape
from urllib.parse import urlencode

from sqlalchemy import select, update

from .account_emails import EmailContent, _layout
from .database import NotificationEmailRow, OrganizationMembershipRow, OrganizationRow, UserRow
from .minutes_service import _email_attachments

logger = logging.getLogger(__name__)


def access_email(*, title: str, body: str, workspace: str, name: str, url: str) -> EmailContent:
    html = _layout(
        heading=title, paragraphs=[f"Hi {escape(name)},", escape(body),
                                 f"Workspace: <b>{escape(workspace)}</b>"],
        button_text="Open Meetings AI", button_url=url,
        footnote="This update belongs only to this workspace. Sign in with your invited email to view it.",
    ).replace("&#9635; Meetings AI", '<img src="cid:meetings-ai-logo" width="36" height="36" '
              'alt="Meetings AI" style="vertical-align:middle;border-radius:8px;margin-right:10px">Meetings AI')
    return EmailContent(subject=f"{title} · {workspace}", html=html,
                        text=f"Hi {name},\n\n{body}\n\nWorkspace: {workspace}\nOpen Meetings AI: {url}\n")


class NotificationEmailWorker:
    def __init__(self, database, resend, origin: str):
        self.database, self.resend, self.origin = database, resend, origin.rstrip("/")

    async def run(self):
        while True:
            try:
                await self.process_pending()
            except Exception:
                logger.exception("access-change email worker failed")
            await asyncio.sleep(10)

    async def process_pending(self, *, limit: int = 10) -> int:
        # No configured sender: keep the outbox intact until an admin configures delivery.
        if not self.resend.configuration()["can_attempt_send"]:
            return 0
        now = datetime.now(UTC)
        with self.database.session_factory() as session:
            ids = session.execute(select(NotificationEmailRow.id).where(
                NotificationEmailRow.status.in_(("pending", "sending")),
                NotificationEmailRow.next_retry_at <= now,
            ).order_by(NotificationEmailRow.created_at).limit(limit)).scalars().all()
        sent = 0
        for row_id in ids:
            # Atomic lease permits restarts without duplicated sending. Resend dedupes network retries.
            with self.database.session_factory.begin() as session:
                won = session.execute(update(NotificationEmailRow).where(
                    NotificationEmailRow.id == row_id,
                    NotificationEmailRow.status.in_(("pending", "sending")),
                    NotificationEmailRow.next_retry_at <= now,
                ).values(status="sending", next_retry_at=now + timedelta(minutes=5),
                         attempts=NotificationEmailRow.attempts + 1)).rowcount
                if not won:
                    continue
                row = session.get(NotificationEmailRow, row_id)
                member = session.get(OrganizationMembershipRow, (row.organization_id, row.user_id))
                user = session.get(UserRow, row.user_id)
                workspace = session.get(OrganizationRow, row.organization_id)
                if not member or not user or user.status not in {"active", "invited"} or not user.email or not workspace or workspace.status != "active":
                    row.status, row.last_error = "cancelled", "Recipient is no longer an active workspace member."
                    continue
                # Resend's idempotency retention is finite; never replay uncertain sends after a day.
                created = row.created_at.replace(tzinfo=row.created_at.tzinfo or UTC)
                if now - created > timedelta(hours=23) and row.attempts > 1:
                    row.status, row.last_error = "failed", "Delivery could not be confirmed within the retry window."
                    continue
                query = {"workspace": row.organization_id}
                if row.link_view:
                    query["view"] = row.link_view
                if row.link_id:
                    query["record"] = row.link_id
                content = access_email(title=row.title, body=row.body, workspace=workspace.display_name,
                                       name=user.display_name, url=f"{self.origin}/?{urlencode(query)}")
                recipient, attempts = user.email, row.attempts
            try:
                await self.resend.send(recipients=[recipient], subject=content.subject,
                    html=content.html, text=content.text, attachments=_email_attachments("", []),
                    idempotency_key=f"workspace-access-{row_id}")
            except Exception:
                logger.warning("access-change email attempt failed for job %s", row_id)
                with self.database.session_factory.begin() as session:
                    row = session.get(NotificationEmailRow, row_id)
                    if row.status == "sending":
                        row.status = "failed" if attempts >= 6 else "pending"
                        row.last_error = "The email provider could not confirm delivery."
                        row.next_retry_at = datetime.now(UTC) + timedelta(seconds=min(3600, 30 * 2 ** attempts))
            else:
                with self.database.session_factory.begin() as session:
                    row = session.get(NotificationEmailRow, row_id)
                    row.status, row.sent_at, row.last_error = "sent", datetime.now(UTC), None
                sent += 1
        return sent
