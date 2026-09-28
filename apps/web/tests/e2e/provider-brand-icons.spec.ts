import { expect, test, type Locator, type Page } from "@playwright/test";
import { providerBrand } from "../../src/components/provider-brand";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const stamp = "2026-09-26T00:00:00Z";

const credential = (id: string, label: string, providerType: string, baseUrl: string | null) => ({
  id: `00000000-0000-4000-8000-0000000000${id}`, label, provider_type: providerType, base_url: baseUrl, hint: "••••1234",
  created_at: stamp, updated_at: stamp, last_used_at: null, used_by_profiles: 0, used_by_settings: false,
});
const credentials = [
  credential("c1", "OpenAI main", "openai", null),
  credential("c2", "OpenRouter team", "openrouter", "https://openrouter.ai/api/v1"),
  credential("c3", "Exa research", "exa", null),
  credential("c4", "Office GPU box", "openai_compatible", "https://llm.office.example/v1"),
];
const profile = (id: string, name: string, providerType: string, baseUrl: string | null, model: string) => ({
  id: `00000000-0000-4000-8000-0000000000${id}`, name, provider_type: providerType, execution_location: "cloud", base_url: baseUrl,
  capabilities: [{ capability: "text_generation", model }], credential_configured: true, credential_hint: "••••1234",
  created_at: stamp, updated_at: stamp,
});
const profiles = [
  profile("p1", "GPT-6 direct", "openai", null, "gpt-6-luna"),
  profile("p2", "GPT-6 via OpenRouter", "openai_compatible", "https://openrouter.ai/api/v1", "openai/gpt-6-sol"),
  profile("p3", "Office Llama", "openai_compatible", "https://llm.office.example/v1", "llama-4"),
];
const aiSettings = {
  can_edit: true, chat_profile_id: profiles[1].id, chat_model: null, vision_profile_id: null, vision_model: null,
  research_credential_id: credentials[2].id, research_credential_label: "Exa research", research_profile_id: null, research_model: null,
  updated_at: null, updated_by: null, vision_configured: false, research_configured: true,
  effective_chat: { profile_id: profiles[1].id, profile_name: "GPT-6 via OpenRouter", provider: "openrouter", model: "openai/gpt-6-sol", source: "workspace_settings" },
};

const usage = {
  total_requests: 3, input_tokens: 1200, output_tokens: 200, estimated_usd: 0.0132, unpriced_requests: 0, failed_requests: 0,
  by_meeting: [], by_purpose: [],
  by_provider: [
    { name: "openai", requests: 1, input_tokens: 600, output_tokens: 100, estimated_usd: 0.001, unpriced_requests: 0 },
    { name: "openai_compatible", requests: 1, input_tokens: 600, output_tokens: 100, estimated_usd: 0.001, unpriced_requests: 0 },
    { name: "exa", requests: 1, input_tokens: 0, output_tokens: 0, estimated_usd: 0.012, unpriced_requests: 0 },
  ],
  by_kind: [], by_model: [], recent: [],
  prep: { sessions: 0, events_prepared: 0, briefings_generated: 0, requests: 0, input_tokens: 0, output_tokens: 0, estimated_usd: 0, unpriced_requests: 0, searches: 0 },
  transcription: { meetings: 0, audio_seconds: 0, estimated_usd: 0, unpriced: 0 },
};
const usageEvent = (index: number, provider: string, model: string, details: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-${String(200000000000 + index)}`, created_at: "2026-09-25T10:00:00Z", kind: provider === "exa" ? "search" : "llm",
  purpose: provider === "exa" ? "meeting_prep_research" : "knowledge_answer", provider, model, input_tokens: 600, output_tokens: 100,
  units: null, unit_type: "tokens", estimated_usd: 0.001, price_source: "catalog_list_price", duration_ms: 1200, status: "succeeded",
  meeting_id: null, meeting_title: null, knowledge_base_id: null, knowledge_base_name: null, prep_event_id: null, prep_event_title: null,
  actor_user_id: userId, actor_display_name: "Owner", details,
});
const events = [
  usageEvent(1, "openai_compatible", "openai/gpt-6-sol", { endpoint_host: "openrouter.ai" }),
  usageEvent(2, "openai", "gpt-6-luna", { endpoint_host: "api.openai.com" }),
  usageEvent(3, "exa", "auto", {}),
  usageEvent(4, "openai_compatible", "llama-4", { endpoint_host: "llm.office.example" }),
];

async function mockApi(page: Page) {
  await page.route("**/v1/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (pathname === "/v1/auth/me") return route.fulfill({ json: { user_id: userId, organization_id: organizationId, email: "owner@example.test", display_name: "Owner", role: "owner", must_change_password: false } });
    if (pathname === "/v1/workspaces") return route.fulfill({ json: [{ id: organizationId, slug: "example", display_name: "Example", role: "owner" }] });
    if (pathname === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (pathname === "/v1/provider-profiles") return route.fulfill({ json: profiles });
    if (pathname === "/v1/provider-defaults") return route.fulfill({ json: [{ capability: "text_generation", ordered_profile_ids: [profiles[0].id] }] });
    if (pathname === "/v1/credentials") return route.fulfill({ json: credentials });
    if (pathname === "/v1/ai/settings") return route.fulfill({ json: aiSettings });
    if (pathname === "/v1/model-catalog") return route.fulfill({ json: { provider: "openai", capability: "text_generation", live_catalog: false, fetched_at: stamp, note: null, models: [] } });
    if (pathname === "/v1/workspace/usage") return route.fulfill({ json: usage });
    if (pathname === "/v1/workspace/usage/events") return route.fulfill({ json: { items: events, next_cursor: null, total: events.length } });
    if (pathname === "/v1/workspace/operations") return route.fulfill({ json: { people: 1, meetings_captured: 0, completed_meetings: 0, saved_chats: 0, active_captures: 0, failed_captures: 0, failed_mom_jobs: 0, pending_index_jobs: 0, failed_index_jobs: 0, failed_email_deliveries: 0, latest_audit_at: null } });
    if (["/v1/workspace/members", "/v1/workspace/calendar-connections", "/v1/knowledge-bases"].includes(pathname)) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });
}

/** The official mark (an SVG path, not the generic server icon) sits next to the provider's name. */
async function expectMark(scope: Locator, brand: "openai" | "openrouter" | "exa") {
  await expect(scope.locator(`[data-provider-brand=${brand}] svg.provider-mark path`).first()).toBeAttached();
}

test("provider names resolve to the right vendor mark", () => {
  expect(providerBrand("openai")).toBe("openai");
  expect(providerBrand("OpenAI", "https://api.openai.com/v1")).toBe("openai");
  expect(providerBrand("OpenRouter")).toBe("openrouter");
  expect(providerBrand("openai_compatible", "openrouter.ai")).toBe("openrouter");
  expect(providerBrand("OpenAI-compatible", "https://openrouter.ai/api/v1")).toBe("openrouter");
  expect(providerBrand("exa")).toBe("exa");
  expect(providerBrand("Exa web research")).toBe("exa");
  expect(providerBrand("openai_compatible", "llm.office.example")).toBeNull();
  expect(providerBrand("openai", "https://llm.office.example/v1")).toBeNull();
  expect(providerBrand("vexa_native")).toBeNull();
  expect(providerBrand("OpenAI-compatible", "not a url")).toBeNull();
  expect(providerBrand(null)).toBeNull();
});

test("AI providers shows the OpenAI, OpenRouter and Exa marks beside their names", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "AI providers" }).click();
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();

  const key = (label: string) => page.locator("li.provider-key").filter({ hasText: label });
  await expect(key("OpenAI main")).toContainText("OpenAI");
  await expectMark(key("OpenAI main"), "openai");
  await expect(key("OpenRouter team")).toContainText("OpenRouter");
  await expectMark(key("OpenRouter team"), "openrouter");
  await expect(key("Exa research")).toContainText("Exa web research");
  await expectMark(key("Exa research"), "exa");
  await expect(key("Office GPU box").locator("[data-provider-brand=generic]")).toBeAttached();

  const row = (label: string) => page.locator(".provider-row").filter({ hasText: label });
  await expectMark(row("GPT-6 direct"), "openai");
  await expectMark(row("GPT-6 via OpenRouter"), "openrouter");
  await expect(row("Office Llama").locator("[data-provider-brand]")).toHaveCount(0);

  const workspaceAi = page.locator("section.workspace-ai");
  await expectMark(workspaceAi.locator("#ai-research-key"), "exa");
  await expectMark(workspaceAi.locator("#ai-chat-profile"), "openrouter");

  await row("GPT-6 direct").click();
  await page.getByRole("combobox", { name: "Provider type" }).click();
  await expectMark(page.getByRole("option", { name: "OpenAI", exact: true }), "openai");
  await expectMark(page.getByRole("option", { name: "OpenRouter" }), "openrouter");
  await expect(page.getByRole("option", { name: "OpenAI-compatible" }).locator("[data-provider-brand=generic]")).toBeAttached();
});

test("observability labels OpenRouter traffic and shows provider marks", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Observability" }).click();
  const byProvider = page.locator("section").filter({ has: page.getByRole("heading", { name: "Cost by provider" }) }).last();
  await expectMark(byProvider.getByRole("row").filter({ hasText: "OpenAI" }).first(), "openai");
  await expectMark(byProvider.getByRole("row").filter({ hasText: "Exa" }), "exa");

  await page.getByRole("tab", { name: /Usage ledger/ }).click();
  const ledgerRow = (model: string) => page.getByRole("row").filter({ hasText: model });
  await expect(ledgerRow("openai/gpt-6-sol")).toContainText("OpenRouter");
  await expectMark(ledgerRow("openai/gpt-6-sol"), "openrouter");
  await expectMark(ledgerRow("gpt-6-luna"), "openai");
  await expect(ledgerRow("llama-4")).toContainText("OpenAI-compatible");
  await expect(ledgerRow("llama-4").locator("[data-provider-brand]")).toHaveCount(0);
});
