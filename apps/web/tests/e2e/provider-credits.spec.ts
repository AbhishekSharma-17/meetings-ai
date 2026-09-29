import { expect, test, type Page } from "@playwright/test";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const KEY = { router: "00000000-0000-4000-8000-0000000000c1", openai: "00000000-0000-4000-8000-0000000000c2", exa: "00000000-0000-4000-8000-0000000000c3", bad: "00000000-0000-4000-8000-0000000000c4" };
const adminSecret = "sk-admin-never-shown-77aa";
const now = () => new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

type Json = Record<string, unknown>;

const credential = (id: string, label: string, provider_type: string, hint: string, extra: Json = {}): Json => ({
  id, label, provider_type, base_url: provider_type === "openrouter" ? "https://openrouter.ai/api/v1" : null, hint,
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", last_used_at: null, used_by_profiles: 1, used_by_settings: false, ...extra,
});

const balance = (id: string, provider: string, label: string, hint: string, extra: Json): Json => ({
  credential_id: id, provider, label, hint, balance_usd: null, limit_usd: null, remaining_usd: null, spent_usd: null,
  spent_period: "this_month", our_tracked_spend_usd: 0, status: "unknown", source: "provider_api", checked_at: minutesAgo(4),
  note: "", dashboard_url: `https://${provider}.example/billing`, ...extra,
});

function state() {
  const credentials: Json[] = [
    credential(KEY.router, "OpenRouter team", "openrouter", "••••c81f"),
    credential(KEY.openai, "OpenAI production", "openai", "••••7Qa2"),
    credential(KEY.exa, "Exa research", "exa", "••••4e9d"),
    credential(KEY.bad, "Old router key", "openrouter", "••••dead"),
  ];
  const items: Json[] = [
    balance(KEY.router, "openrouter", "OpenRouter team", "••••c81f", { limit_usd: 20, remaining_usd: 4.2, spent_usd: 15.8, status: "low", note: "Key limit from OpenRouter. Add an OpenRouter management key to see the account balance." }),
    balance(KEY.openai, "openai", "OpenAI production", "••••7Qa2", { spent_usd: 12.4, our_tracked_spend_usd: 12.4, source: "our_ledger", note: "OpenAI doesn't share your remaining balance — check billing." }),
    balance(KEY.exa, "exa", "Exa research", "••••4e9d", { spent_usd: 3.42, our_tracked_spend_usd: 3.42, source: "our_ledger", note: "Exa doesn't share your remaining credit balance — check billing." }),
    balance(KEY.bad, "openrouter", "Old router key", "••••dead", { status: "invalid_key", note: "OpenRouter rejected this key. Replace it under API keys." }),
  ];
  const billing = [
    { provider_type: "openrouter_management", provider: "openrouter", configured: false, credential_id: null, label: null, hint: null, unlocks: "Shows your OpenRouter account balance." },
    { provider_type: "openai_admin", provider: "openai", configured: false, credential_id: null, label: null, hint: null, unlocks: "Shows official OpenAI spend." },
    { provider_type: "exa_service", provider: "exa", configured: false, credential_id: null, label: null, hint: null, unlocks: "Shows official Exa spend." },
  ];
  return { credentials, items, billing, refreshes: [] as string[], created: [] as Json[], tested: [] as string[] };
}

type State = ReturnType<typeof state>;
const overview = (s: State) => ({ items: s.items, billing_keys: s.billing, low_balance_threshold_usd: 5, checked_at: now() });

async function mockApi(page: Page, s: State) {
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (pathname === "/v1/auth/me") return route.fulfill({ json: { user_id: userId, organization_id: organizationId, email: "owner@example.test", display_name: "Owner", role: "owner", must_change_password: false } });
    if (pathname === "/v1/workspaces") return route.fulfill({ json: [{ id: organizationId, slug: "example", display_name: "Example", role: "owner" }] });
    if (pathname === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (pathname === "/v1/ai/settings") return route.fulfill({ json: {
      can_edit: true, chat_profile_id: null, chat_model: null, vision_profile_id: null, vision_model: null,
      research_credential_id: null, research_credential_label: null, research_profile_id: null, research_model: null,
      updated_at: null, updated_by: null, vision_configured: false, research_configured: false,
      effective_chat: { profile_id: null, profile_name: null, provider: null, model: null, source: "not_configured" },
    } });
    if (pathname === "/v1/credentials" && method === "GET") return route.fulfill({ json: s.credentials });
    if (pathname === "/v1/credentials" && method === "POST") {
      const payload = request.postDataJSON() as Json;
      s.created.push(payload);
      const saved = credential("00000000-0000-4000-8000-0000000000b1", String(payload.label), String(payload.provider_type), "••••77aa", { billing_only: true, used_by_profiles: 0 });
      s.credentials.push(saved);
      s.billing = s.billing.map((item) => item.provider_type === payload.provider_type ? { ...item, configured: true, credential_id: String(saved.id), label: String(saved.label), hint: "••••77aa" } : item);
      return route.fulfill({ status: 201, json: saved });
    }
    const test = pathname.match(/^\/v1\/credentials\/([^/]+)\/test$/);
    if (test) {
      s.tested.push(test[1]);
      return route.fulfill({ json: { credential_id: test[1], status: "valid", network_call_performed: true, message: "The provider accepted this key." } });
    }
    if (pathname === "/v1/provider-balances") return route.fulfill({ json: overview(s) });
    if (pathname === "/v1/provider-balances/refresh") {
      const target = url.searchParams.get("credential_id") ?? "all";
      s.refreshes.push(target);
      s.items = s.items.map((item) => target === "all" || item.credential_id === target
        ? { ...item, checked_at: now(), ...(item.credential_id === KEY.router ? { remaining_usd: 3.1, spent_usd: 16.9 } : {}) } : item);
      return route.fulfill({ json: overview(s) });
    }
    if (pathname === "/v1/workspace/operations") return route.fulfill({ json: { people: 1, meetings_captured: 0, completed_meetings: 0, saved_chats: 0, active_captures: 0, failed_captures: 0, failed_mom_jobs: 0, pending_index_jobs: 0, failed_index_jobs: 0, failed_email_deliveries: 0, latest_audit_at: null } });
    if (pathname === "/v1/workspace/usage") return route.fulfill({ json: { total_requests: 0, input_tokens: 0, output_tokens: 0, estimated_usd: 0, unpriced_requests: 0, failed_requests: 0, by_meeting: [], by_purpose: [], by_provider: [], by_kind: [], by_model: [], recent: [] } });
    if (["/v1/provider-profiles", "/v1/provider-defaults", "/v1/workspace/members", "/v1/workspace/calendar-connections", "/v1/knowledge-bases"].includes(pathname)) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });
}

async function openProviders(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "AI providers" }).click();
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
}

test("saved keys show a credit chip, last check and a per-key refresh", async ({ page }) => {
  const s = state();
  await mockApi(page, s);
  await openProviders(page);
  const keys = page.locator(".provider-keys .provider-key");
  const router = keys.filter({ hasText: "OpenRouter team" });
  await expect(router.locator(".balance-chip")).toHaveText("$4.20 left of $20.00 limit");
  await expect(router.locator(".balance-chip")).toHaveAttribute("data-tone", "warning");
  await expect(router.getByText("Checked 4 min. ago").or(router.getByText("Checked 4 minutes ago"))).toBeVisible();
  const openai = keys.filter({ hasText: "OpenAI production" });
  await expect(openai.locator(".balance-chip")).toHaveText("Balance not shared by OpenAI");
  await expect(openai.getByText("$12.40 spent this month")).toBeVisible();
  await expect(openai.getByRole("link", { name: "OpenAI billing" })).toHaveAttribute("href", "https://openai.example/billing");
  const exa = keys.filter({ hasText: "Exa research" });
  await expect(exa.locator(".balance-chip")).toHaveText("Balance not shared by Exa");
  await expect(exa.getByText("$3.42 spent this month")).toBeVisible();
  const bad = keys.filter({ hasText: "Old router key" });
  await expect(bad.locator(".balance-chip")).toHaveText("Invalid key");
  await expect(bad.locator(".balance-chip")).toHaveAttribute("data-tone", "danger");
  await expect(bad.getByText("OpenRouter rejected this key. Replace it under API keys.")).toBeVisible();

  await router.getByRole("button", { name: "Refresh credit for OpenRouter team" }).click();
  await expect(router.locator(".balance-chip")).toHaveText("$3.10 left of $20.00 limit");
  await expect(router.getByText(/Checked just now/i)).toBeVisible();
  expect(s.refreshes).toEqual([KEY.router]);
  await expect(page.getByText("OpenRouter team: credit checked just now.")).toBeVisible();
});

test("owner adds an optional billing key that is checked on save and listed apart from model keys", async ({ page }) => {
  const s = state();
  await mockApi(page, s);
  await openProviders(page);
  const billing = page.locator(".billing-keys");
  await expect(billing.getByRole("heading", { name: "Billing keys" })).toBeVisible();
  await expect(billing.getByText("OpenAI admin key", { exact: true })).toBeVisible();

  await billing.getByRole("button", { name: "Add billing key" }).click();
  const dialog = page.getByRole("dialog", { name: "Add billing key" });
  await expect(dialog.getByText("never used for AI calls or research", { exact: false })).toBeVisible();
  await dialog.getByRole("radio", { name: /OpenAI admin key/ }).check();
  await expect(dialog.getByText("OpenAI never shares the remaining prepaid balance.", { exact: false })).toBeVisible();
  await dialog.getByLabel("OpenAI admin key", { exact: true }).fill(adminSecret);
  await dialog.getByRole("button", { name: "Save and check" }).click();
  const saved = page.getByRole("dialog", { name: "Billing key saved" });
  await expect(saved.getByText("Key works")).toBeVisible();
  expect(s.created).toEqual([{ label: "OpenAI admin key", provider_type: "openai_admin", secret: adminSecret, base_url: null }]);
  expect(s.tested).toEqual(["00000000-0000-4000-8000-0000000000b1"]);
  await saved.getByRole("button", { name: "Done" }).click();

  await expect(billing.locator(".provider-key").filter({ hasText: "OpenAI admin key" })).toContainText("Billing only");
  await expect(billing.getByText("Shows official OpenAI spend this month", { exact: false })).toHaveCount(0);
  await expect(page.locator(".provider-keys > .provider-key-list").getByText("OpenAI admin key")).toHaveCount(0);
  await expect(page.getByText(adminSecret)).toHaveCount(0);
});

test("observability lists provider credit, sorted by what is left, with search and refresh", async ({ page }) => {
  const s = state();
  for (let index = 0; index < 3; index += 1) {
    const id = `00000000-0000-4000-8000-0000000000d${index}`;
    s.credentials.push(credential(id, `Spare router ${index}`, "openrouter", `••••000${index}`));
    s.items.push(balance(id, "openrouter", `Spare router ${index}`, `••••000${index}`, { limit_usd: 50, remaining_usd: 30 + index, status: "ok", note: "Key limit from OpenRouter." }));
  }
  await mockApi(page, s);
  await page.goto("/");
  await page.getByRole("button", { name: "Observability" }).click();
  const card = page.locator(".provider-credits");
  await expect(card.getByRole("heading", { name: "Provider credits" })).toBeVisible();
  const labels = card.locator(".provider-credit-key b");
  await expect(labels).toHaveText(["OpenRouter team", "Spare router 0", "Spare router 1", "Spare router 2", "Old router key", "Exa research", "OpenAI production"]);
  await expect(card.locator(".provider-credit").first().locator(".balance-chip")).toHaveText("$4.20 left of $20.00 limit");
  await expect(card.getByText(/add OpenRouter management key, OpenAI admin key or Exa service key/i)).toBeVisible();

  await card.getByRole("combobox", { name: "Sort keys" }).click();
  await page.getByRole("option", { name: "Most credit left first" }).click();
  await expect(labels.first()).toHaveText("Spare router 2");

  await card.getByRole("searchbox", { name: "Search provider keys" }).or(card.getByLabel("Search provider keys")).first().fill("exa");
  await expect(labels).toHaveText(["Exa research"]);
  await expect(card.locator(".provider-credit").first()).toContainText("$3.42");

  await card.getByRole("button", { name: "Check now" }).click();
  await expect.poll(() => s.refreshes).toEqual(["all"]);
});

test("credit views fit a 360px screen without sideways scrolling", async ({ page }) => {
  const s = state();
  await mockApi(page, s);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "AI providers" }).last().click();
  await expect(page.locator(".provider-keys .balance-chip").first()).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Observability" }).last().click();
  await expect(page.locator(".provider-credit").first()).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});
