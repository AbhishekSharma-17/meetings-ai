"""Minimal Resend delivery adapter with safe, bounded errors."""

from typing import Any

import httpx


class EmailDeliveryError(RuntimeError):
    pass


class ResendAdapter:
    def __init__(
        self,
        api_key: str | None,
        from_email: str | None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.api_key = api_key
        self.from_email = from_email
        self.transport = transport

    def configuration(self) -> dict[str, object]:
        """Expose safe local configuration only; a send-only key cannot check domains."""
        return {
            "api_key_configured": bool(self.api_key),
            "sender_configured": bool(self.from_email),
            "sender": self.from_email or None,
            "can_attempt_send": bool(self.api_key and self.from_email),
            "domain_verification": "not_checked",
        }

    async def send(
        self, *, recipients: list[str], subject: str, html: str, text: str,
        idempotency_key: str | None = None,
    ) -> str:
        if not self.api_key:
            raise EmailDeliveryError("Resend API key is not configured")
        if not self.from_email:
            raise EmailDeliveryError("Resend sender is not configured; set RESEND_FROM_EMAIL")
        try:
            async with httpx.AsyncClient(
                base_url="https://api.resend.com", timeout=30, transport=self.transport
            ) as client:
                response = await client.post(
                    "/emails",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                        **({"Idempotency-Key": idempotency_key} if idempotency_key else {}),
                    },
                    json={
                        "from": self.from_email,
                        "to": recipients,
                        "subject": subject,
                        "html": html,
                        "text": text,
                    },
                )
        except httpx.RequestError as exc:
            raise EmailDeliveryError("Resend is unavailable") from exc
        if response.is_error:
            try:
                body: Any = response.json()
                detail = body.get("message", body) if isinstance(body, dict) else body
            except ValueError:
                detail = response.text[:500]
            raise EmailDeliveryError(
                f"Resend rejected the email ({response.status_code}): {str(detail)[:500]}"
            )
        try:
            body = response.json()
            message_id = body["id"]
        except (ValueError, KeyError, TypeError) as exc:
            raise EmailDeliveryError("Resend returned an invalid response") from exc
        if not isinstance(message_id, str) or not message_id:
            raise EmailDeliveryError("Resend returned no message identifier")
        return message_id
