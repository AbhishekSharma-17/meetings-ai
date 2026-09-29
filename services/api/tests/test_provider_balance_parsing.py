"""Provider balance parsers and status normalization (no network)."""

from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest

from app.provider_balance_clients import (
    ExaKey,
    ExaTeamReading,
    OpenRouterCredits,
    ProviderCallError,
    failure_for_status,
    fetch_exa_team,
    fetch_openai_costs,
    parse_exa_keys,
    parse_exa_usage,
    parse_openai_costs,
    parse_openrouter_credits,
    parse_openrouter_key,
    probe_billing_key,
)
from app.provider_balance_status import (
    KeyRef,
    classify,
    exa_status,
    failed_key_status,
    match_exa_key,
    openai_status,
    openrouter_status,
)
from app.provider_balances import check_interval_from_env, is_out_of_credit_error, threshold_from_env

NOW = datetime(2026, 9, 29, 12, tzinfo=UTC)


def _key(provider: str = "openrouter", label: str = "Team key") -> KeyRef:
    return KeyRef(credential_id=uuid4(), provider=provider, label=label, hint="••••1234")


# ----- parsers -------------------------------------------------------------------------------------
def test_openrouter_key_with_unlimited_limit() -> None:
    reading = parse_openrouter_key({"data": {
        "label": "sk-or-v1-abc...", "limit": None, "limit_remaining": None, "usage": 12.5,
        "usage_daily": 0.4, "usage_weekly": 2.1, "usage_monthly": 6.25, "is_free_tier": False,
    }})
    assert reading.limit_usd is None and reading.limit_remaining_usd is None
    assert reading.usage_monthly_usd == 6.25 and reading.usage_usd == 12.5 and reading.is_free_tier is False


def test_openrouter_key_with_limit_and_credits() -> None:
    reading = parse_openrouter_key({"data": {"limit": 20, "limit_remaining": 4.2, "usage": 15.8}})
    assert (reading.limit_usd, reading.limit_remaining_usd, reading.usage_monthly_usd) == (20.0, 4.2, None)
    credits = parse_openrouter_credits({"data": {"total_credits": 50, "total_usage": 42.5}})
    assert credits.balance_usd == 7.5


@pytest.mark.parametrize("payload", [None, [], {"data": None}, {"data": "x"}, {"error": "nope"}])
def test_openrouter_unexpected_shapes_raise_friendly_error(payload) -> None:
    with pytest.raises(ProviderCallError) as caught:
        parse_openrouter_key(payload)
    assert caught.value.kind == "error"
    with pytest.raises(ProviderCallError):
        parse_openrouter_credits({"data": {"total_credits": "50"}})


def test_openai_costs_sum_usd_across_buckets() -> None:
    page = {"object": "page", "has_more": False, "next_page": None, "data": [
        {"object": "bucket", "start_time": 1, "end_time": 2, "results": [
            {"object": "organization.costs.result", "amount": {"value": 0.1308, "currency": "usd"}},
            {"object": "organization.costs.result", "amount": {"value": 2.5, "currency": "usd"}},
        ]},
        {"object": "bucket", "start_time": 2, "end_time": 3, "results": []},
        {"object": "bucket", "results": [{"amount": {"value": 9, "currency": "eur"}}]},
    ]}
    assert parse_openai_costs(page) == 2.6308
    with pytest.raises(ProviderCallError):
        parse_openai_costs({"object": "page"})


def test_exa_key_list_and_usage() -> None:
    keys = parse_exa_keys({"apiKeys": [
        {"id": "550e8400-e29b-41d4-a716-446655440000", "name": "Research", "budgetCents": 5000, "isOverBudget": False},
        {"id": "../../secrets", "name": "bad id is skipped"},
        {"id": "k2", "name": None, "budgetCents": None, "isOverBudget": True},
    ]})
    assert keys == (ExaKey("550e8400-e29b-41d4-a716-446655440000", "Research", 50.0, False),
                    ExaKey("k2", None, None, True))
    assert parse_exa_keys({"apiKey": {"id": "k3", "name": "Solo"}})[0].id == "k3"
    assert parse_exa_usage({"total_cost_usd": 45.67, "cost_breakdown": []}) == 45.67
    with pytest.raises(ProviderCallError):
        parse_exa_usage({"cost_breakdown": []})


@pytest.mark.parametrize(("code", "kind"), [(401, "invalid_key"), (403, "invalid_key"), (402, "exhausted"),
                                            (429, "error"), (500, "error")])
def test_http_status_maps_to_friendly_state(code: int, kind: str) -> None:
    assert failure_for_status("OpenRouter", code).kind == kind


@pytest.mark.asyncio
async def test_openai_costs_follow_pages_and_exa_team_calls_fixed_host() -> None:
    seen: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.host == "api.openai.com":
            first = "page" not in request.url.params
            return httpx.Response(200, json={"object": "page", "has_more": first, "next_page": "cursor-2" if first else None,
                                             "data": [{"results": [{"amount": {"value": 1.5, "currency": "usd"}}]}]})
        if request.url.path.endswith("/api-keys"):
            return httpx.Response(200, json={"apiKeys": [{"id": "k1", "name": "A"}, {"id": "k2", "name": "B"}]})
        return httpx.Response(200, json={"total_cost_usd": 2.0 if "k1" in request.url.path else 3.25})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        assert await fetch_openai_costs(client, "sk-admin-x", NOW) == 3.0
        team = await fetch_exa_team(client, "exa-service", NOW)
    assert team.team_spend_usd == 5.25
    assert seen[1].url.params["page"] == "cursor-2"
    assert seen[0].url.params["bucket_width"] == "1d"
    assert {request.url.host for request in seen[2:]} == {"admin-api.exa.ai"}
    assert all(request.headers["x-api-key"] == "exa-service" for request in seen[2:])


@pytest.mark.asyncio
async def test_billing_probe_reports_status_or_unreachable() -> None:
    def ok(request: httpx.Request) -> httpx.Response:
        assert request.url.host in {"openrouter.ai", "api.openai.com", "admin-api.exa.ai"}
        return httpx.Response(200 if request.url.host != "api.openai.com" else 401, json={})

    assert await probe_billing_key("openrouter_management", "sk-or-m", transport=httpx.MockTransport(ok)) == 200
    assert await probe_billing_key("openai_admin", "sk-admin-m", transport=httpx.MockTransport(ok)) == 401

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow", request=request)

    assert await probe_billing_key("exa_service", "svc", transport=httpx.MockTransport(down)) is None
    with pytest.raises(ValueError):
        await probe_billing_key("openai", "sk-x")


# ----- normalization -------------------------------------------------------------------------------
@pytest.mark.parametrize(("remaining", "limit", "expected"), [
    (None, None, "unknown"), (0.0, None, "exhausted"), (-1.0, 20.0, "exhausted"), (4.99, None, "low"),
    (5.0, None, "low"), (5.01, None, "ok"), (9.0, 100.0, "low"), (11.0, 100.0, "ok"), (40.0, None, "ok"),
])
def test_classify_thresholds(remaining, limit, expected) -> None:
    assert classify(remaining, limit, 5.0) == expected


def test_openrouter_status_uses_tightest_of_key_limit_and_account_balance() -> None:
    reading = parse_openrouter_key({"data": {"limit": 20, "limit_remaining": 12, "usage_monthly": 8}})
    status = openrouter_status(_key(), reading, OpenRouterCredits(50, 46), NOW)
    assert (status.remaining_usd, status.balance_usd, status.limit_usd) == (4.0, 4.0, 20.0)
    assert status.status == "low" and status.source == "admin_key" and status.spent_period == "this_month"
    assert "management key" in status.note


def test_openrouter_status_without_management_key_explains_what_to_add() -> None:
    reading = parse_openrouter_key({"data": {"limit": None, "limit_remaining": None, "usage": 3}})
    status = openrouter_status(_key(), reading, None, NOW)
    assert status.status == "unknown" and status.remaining_usd is None and status.spent_period == "all_time"
    assert "Add an OpenRouter management key" in status.note
    failed = openrouter_status(_key(), reading, ProviderCallError("invalid_key", "OpenRouter rejected the key"), NOW)
    assert "couldn't read the account balance" in failed.note


def test_openai_status_never_claims_a_balance() -> None:
    official = openai_status(_key("openai"), 12.4, NOW)
    assert official.remaining_usd is None and official.status == "unknown" and official.spent_usd == 12.4
    assert official.source == "admin_key" and "doesn't share your remaining balance" in official.note
    ours = openai_status(_key("openai"), None, NOW)
    assert ours.source == "our_ledger" and "Add an OpenAI admin key" in ours.note
    assert ours.dashboard_url == "https://platform.openai.com/settings/organization/billing"


def test_exa_status_matches_key_by_name_or_falls_back_to_team_spend() -> None:
    team = ExaTeamReading(keys=(ExaKey("k1", "Research", 50.0, False), ExaKey("k2", "Other", None, True)),
                          spend_by_key={"k1": 12.0, "k2": 3.0})
    key = _key("exa", "research")
    assert match_exa_key(key, "not-an-id", team) == "k1"
    matched = exa_status(key, team, "k1", NOW)
    assert (matched.limit_usd, matched.spent_usd, matched.status) == (50.0, 12.0, "unknown")
    assert exa_status(key, team, "k2", NOW).status == "exhausted"
    unmatched = exa_status(_key("exa", "Nope"), team, None, NOW)
    assert unmatched.spent_usd == 15.0 and "team-wide" in unmatched.note
    assert match_exa_key(_key("exa", "Nope"), "k2", team) == "k2"  # compared locally, never sent
    none = exa_status(key, None, None, NOW)
    assert none.source == "our_ledger" and "Add an Exa service key" in none.note


def test_failed_status_copy() -> None:
    assert failed_key_status(_key(), ProviderCallError("invalid_key", "x"), NOW).note.startswith("OpenRouter rejected")
    assert failed_key_status(_key(), ProviderCallError("exhausted", "x"), NOW).status == "exhausted"
    assert failed_key_status(_key(), ProviderCallError("error", "timed out"), NOW).status == "error"


def test_out_of_credit_detection_and_env_settings() -> None:
    assert is_out_of_credit_error(RuntimeError('OpenAI request failed (429): {"code": "insufficient_quota"}'))
    assert is_out_of_credit_error(RuntimeError("Compatible provider request failed (402): no credits"))
    assert not is_out_of_credit_error(RuntimeError("OpenAI request failed (429): rate limit"))
    assert check_interval_from_env({}) == 6 * 3600
    assert check_interval_from_env({"PROVIDER_BALANCE_CHECK_HOURS": "0"}) == 0
    assert check_interval_from_env({"PROVIDER_BALANCE_CHECK_HOURS": "abc"}) == 6 * 3600
    assert threshold_from_env({"PROVIDER_LOW_BALANCE_USD": "10"}) == 10.0
    assert threshold_from_env({"PROVIDER_LOW_BALANCE_USD": "-1"}) == 5.0
