"""Apollo, reached through Composio as a workspace-level (not per-person) connected account.

Composio v3.1 requests used here (verified against https://docs.composio.dev, 2026-09-29):

* Auth config (API-key toolkit). ``COMPOSIO_APOLLO_AUTH_CONFIG_ID`` wins when set. Otherwise the
  first ENABLED config named ``Meetings AI Apollo`` from
  ``GET /auth_configs?toolkit_slug=apollo&search=Meetings AI Apollo`` is reused, or one is created
  (idempotent across restarts) with
  ``POST /auth_configs {"toolkit": {"slug": "apollo"}, "auth_config": {"type": "use_custom_auth",
  "authScheme": "API_KEY", "name": "Meetings AI Apollo", "credentials": {}}}`` → ``auth_config.id``.
  Docs: /reference/api-reference/auth-configs/postAuthConfigs, /docs/programmatic-auth-configs.
* Connected account with the customer's API key:
  ``POST /connected_accounts {"auth_config": {"id": …}, "connection": {"user_id": "meetings-ai:org:<id>",
  "alias": …, "state": {"authScheme": "API_KEY", "val": {"status": "ACTIVE", "api_key": "<key>"}}}}``
  → ``id``, ``status``. Docs: /reference/api-reference/connected-accounts/postConnectedAccounts and
  /docs/tools-direct/authenticating-tools (``val: {"api_key": …}`` for API_KEY toolkits).
* Tool calls: ``POST /tools/execute/{TOOL} {"user_id", "connected_account_id", "version", "arguments"}``.
* Disconnect: ``GET /connected_accounts/{id}`` (ownership check) then
  ``DELETE /connected_accounts/{id}``.

The Apollo key is sent to Composio exactly once (the create call) and is never logged, stored,
returned or placed in an exception message.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Literal
from urllib.parse import quote
from uuid import UUID

import httpx

from .composio_http import COMPOSIO_BASE_URL, ComposioHttpError, composio_request, unwrap_tool_result

logger = logging.getLogger(__name__)

APOLLO_TOOLKIT = "apollo"
APOLLO_VERSION_DEFAULT = "20260922_00"
AUTH_CONFIG_NAME = "Meetings AI Apollo"
TOOL_TIMEOUT_SECONDS = 10.0
CREDIT_STATS_TOOL = "APOLLO_VIEW_CREDIT_USAGE_STATS"

ApolloErrorKind = Literal["invalid_key", "out_of_credit", "rate_limited", "plan", "timeout", "not_configured", "error"]
ERROR_MESSAGES: dict[str, str] = {
    "invalid_key": "Apollo rejected the API key",
    "out_of_credit": "Apollo reports no credits left",
    "rate_limited": "Apollo rate limit reached",
    "plan": "not available on this Apollo plan",
    "timeout": "Apollo did not answer in time",
    "not_configured": "Composio is not configured on the server",
    "error": "Apollo request failed",
}
# Order matters: a 402 with "credits" is a credit problem even if the text also says "forbidden".
_PATTERNS: tuple[tuple[ApolloErrorKind, re.Pattern[str]], ...] = (
    ("out_of_credit", re.compile(r"\b402\b|insufficient[_ ]credits?|out of credits?|no credits|payment required|"
                                 r"credit limit", re.I)),
    ("invalid_key", re.compile(r"\b401\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|api key (?:is )?invalid|"
                               r"invalid access credentials", re.I)),
    ("rate_limited", re.compile(r"\b429\b|rate[_ ]limit|too many requests", re.I)),
    ("plan", re.compile(r"\b403\b|forbidden|upgrade|paid plan|not (?:available|accessible)|master key|"
                        r"access denied|not authori[sz]ed", re.I)),
)
_UPSTREAM_STATUS = re.compile(r"\b(4\d\d)\b")


class ApolloError(RuntimeError):
    """A sanitized Apollo/Composio failure; the message is fixed per kind (never provider text)."""

    def __init__(self, kind: ApolloErrorKind, status_code: int | None = None, *,
                 upstream_status: int | None = None) -> None:
        super().__init__(ERROR_MESSAGES[kind])
        self.kind: ApolloErrorKind = kind
        self.status_code = status_code
        # Apollo's own HTTP status when a failed tool call reports one (403 plan, 422 rejected values…).
        self.upstream_status = upstream_status

    @property
    def fatal(self) -> bool:
        """Stop every further Apollo call for this briefing."""
        return self.kind in {"invalid_key", "out_of_credit", "rate_limited", "timeout", "not_configured"}


def classify_tool_error(message: str | None) -> ApolloErrorKind:
    for kind, pattern in _PATTERNS:
        if message and pattern.search(message):
            return kind
    return "error"


def upstream_status(message: str | None) -> int | None:
    """The first 4xx status code quoted in a tool's error text, if any."""
    match = _UPSTREAM_STATUS.search(message or "")
    return int(match.group(1)) if match else None


def _http_kind(exc: ComposioHttpError) -> ApolloErrorKind:
    if exc.timeout:
        return "timeout"
    # A Composio-level 404 is not proof the Apollo key is bad, so it stays a plain error.
    return {402: "out_of_credit", 429: "rate_limited"}.get(exc.status_code or 0, "error")


def workspace_user_id(organization_id: UUID | str) -> str:
    """Composio user id for the WORKSPACE's Apollo connection (never a person's calendar user id)."""
    return f"meetings-ai:org:{organization_id}"


def mask_key(api_key: str) -> str:
    tail = api_key.strip()[-4:]
    return f"••••{tail}" if len(api_key.strip()) >= 8 else "••••"


class ApolloComposio:
    def __init__(self, api_key: str | None = None, *, transport: httpx.AsyncBaseTransport | None = None,
                 environ: dict[str, str] | None = None) -> None:
        env = environ if environ is not None else os.environ
        self.api_key = api_key if api_key is not None else env.get("COMPOSIO_API_KEY", "")
        self.transport = transport
        self.base_url = COMPOSIO_BASE_URL
        self.version = env.get("COMPOSIO_APOLLO_VERSION") or APOLLO_VERSION_DEFAULT
        self._auth_config_id = env.get("COMPOSIO_APOLLO_AUTH_CONFIG_ID", "").strip() or None

    def __repr__(self) -> str:  # never expose keys through debugging output
        return "ApolloComposio()"

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    async def _call(self, method: str, path: str, *, params: dict | None = None, body: dict | None = None,
                    timeout: float = 25.0) -> dict[str, Any]:
        if not self.api_key:
            raise ApolloError("not_configured")
        try:
            return await composio_request(self.api_key, method, path, params=params, body=body,
                                          transport=self.transport, timeout=timeout, base_url=self.base_url)
        except ComposioHttpError as exc:
            raise ApolloError(_http_kind(exc), exc.status_code) from None

    # ----- auth config -------------------------------------------------------------------------
    async def auth_config_id(self) -> str:
        """``COMPOSIO_APOLLO_AUTH_CONFIG_ID``, else our named config, else a newly created one."""
        if self._auth_config_id:
            return self._auth_config_id
        found = await self._call("GET", "/auth_configs", params={
            "toolkit_slug": APOLLO_TOOLKIT, "search": AUTH_CONFIG_NAME, "limit": 50})
        for item in found.get("items") or []:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                continue
            slug = (item.get("toolkit") or {}).get("slug") if isinstance(item.get("toolkit"), dict) else None
            if item.get("name") == AUTH_CONFIG_NAME and slug in {None, APOLLO_TOOLKIT} \
                    and str(item.get("status") or "ENABLED").upper() == "ENABLED":
                self._auth_config_id = item["id"]
                return item["id"]
        created = await self._call("POST", "/auth_configs", body={
            "toolkit": {"slug": APOLLO_TOOLKIT},
            "auth_config": {"type": "use_custom_auth", "authScheme": "API_KEY", "name": AUTH_CONFIG_NAME,
                            "credentials": {}},
        })
        config = created.get("auth_config") if isinstance(created.get("auth_config"), dict) else {}
        config_id = config.get("id") or created.get("id")
        if not isinstance(config_id, str) or not config_id:
            raise ApolloError("error")
        logger.info("created the Composio auth config for Apollo")
        self._auth_config_id = config_id
        return config_id

    # ----- connected account -------------------------------------------------------------------
    async def connect(self, organization_id: UUID | str, apollo_key: str) -> str:
        """Register ``apollo_key`` as the workspace's Apollo connection; returns the connected-account id."""
        auth_config = await self.auth_config_id()
        result = await self._call("POST", "/connected_accounts", body={
            "auth_config": {"id": auth_config},
            "connection": {
                "user_id": workspace_user_id(organization_id), "alias": "Meetings AI workspace Apollo",
                "state": {"authScheme": "API_KEY", "val": {"status": "ACTIVE", "api_key": apollo_key}},
            },
        })
        account_id = result.get("id")
        if not isinstance(account_id, str) or not account_id:
            raise ApolloError("error")
        if str(result.get("status") or "ACTIVE").upper() in {"FAILED", "EXPIRED", "INACTIVE"}:
            await self.disconnect(organization_id, account_id)
            raise ApolloError("invalid_key")
        return account_id

    async def disconnect(self, organization_id: UUID | str, connected_account_id: str) -> None:
        """Delete the connected account, but only when Composio says it belongs to this workspace."""
        path = f"/connected_accounts/{quote(connected_account_id, safe='')}"
        try:
            detail = await self._call("GET", path)
        except ApolloError as exc:
            if exc.status_code == 404:  # already gone upstream
                return
            raise
        owner = detail.get("user_id")
        if detail.get("id") not in {None, connected_account_id} or owner not in {None, workspace_user_id(organization_id)}:
            raise ApolloError("error")
        await self._call("DELETE", path)

    # ----- tools -------------------------------------------------------------------------------
    async def execute(self, organization_id: UUID | str, connected_account_id: str, tool: str,
                      arguments: dict[str, Any], *, timeout: float = TOOL_TIMEOUT_SECONDS) -> dict[str, Any]:
        result = await self._call("POST", f"/tools/execute/{tool}", timeout=timeout, body={
            "user_id": workspace_user_id(organization_id), "connected_account_id": connected_account_id,
            "version": self.version, "arguments": arguments,
        })
        successful, data, error = unwrap_tool_result(result)
        if not successful:
            kind = classify_tool_error(error)
            logger.info("Apollo tool %s failed (%s)", tool, kind)
            raise ApolloError(kind, upstream_status=upstream_status(error))
        return data

    async def credit_stats(self, organization_id: UUID | str, connected_account_id: str) -> dict[str, Any]:
        return await self.execute(organization_id, connected_account_id, CREDIT_STATS_TOOL, {})
