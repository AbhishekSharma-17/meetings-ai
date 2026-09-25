import { expect, test } from "@playwright/test";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const baseId = "00000000-0000-4000-8000-000000000066";

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (pathname === "/v1/auth/me") return route.fulfill({ json: { user_id: userId, organization_id: organizationId, email: "owner@example.test", display_name: "Owner", role: "owner", must_change_password: false } });
    if (pathname === "/v1/workspace") return route.fulfill({ json: { id: organizationId, slug: "example", display_name: "Example", contact_email: null, status: "active", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", tenant_isolation_enabled: true } });
    if (pathname === "/v1/workspaces") return route.fulfill({ json: [{ id: organizationId, slug: "example", display_name: "Example", role: "owner" }] });
    if (pathname === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (pathname === "/v1/provider-profiles") return route.fulfill({ json: [
      { id: "profile-one", name: "Economy MOM", provider_type: "openai", execution_location: "cloud", base_url: null, capabilities: [{ capability: "text_generation", model: "gpt-6-luna" }], credential_configured: true, credential_hint: "••••1234" },
      { id: "profile-two", name: "Research MOM", provider_type: "openai", execution_location: "cloud", base_url: null, capabilities: [{ capability: "text_generation", model: "gpt-6-sol" }], credential_configured: true, credential_hint: "••••5678" },
    ] });
    if (pathname === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (pathname === "/v1/calendar/schedules") return route.fulfill({ json: [] });
    if (pathname === "/v1/knowledge-bases") return route.fulfill({ json: [
      { id: baseId, organization_id: organizationId, name: "Client A", description: null, created_by: userId, visibility: "private", text_profile_id: null, meeting_count: 0, shared_user_ids: [], created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z" },
      { id: "base-two", organization_id: organizationId, name: "Client B", description: null, created_by: userId, visibility: "private", text_profile_id: null, meeting_count: 0, shared_user_ids: [], created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z" },
    ] });
    if (pathname === "/v1/knowledge/text-profiles") return route.fulfill({ json: [{ id: "profile-one", name: "Economy MOM", provider_type: "openai", base_url: null, capabilities: [{ capability: "text_generation", model: "gpt-6-luna" }] }] });
    if (pathname === "/v1/knowledge/text-profiles/profile-one/models") return route.fulfill({ json: { profile_id: "profile-one", provider: "openai", configured_model: "gpt-6-luna", live_catalog: true, models: [{ id: "gpt-6-luna", name: "Luna", input_per_million_usd: 0.1, output_per_million_usd: 0.4 }, { id: "gpt-6-sol", name: "Sol", input_per_million_usd: 0.3, output_per_million_usd: 1.2 }] } });
    if (pathname.endsWith("/conversations")) return route.fulfill({ json: [] });
    if (pathname === "/v1/workspace/members") return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });
});

test("provider and meeting-list selections survive page changes and reload", async ({ page }) => {
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("button", { name: "AI providers" }).click();
  await page.getByRole("button", { name: /Research MOM/ }).click();
  await expect(page.getByRole("complementary", { name: /Edit Research MOM/ })).toBeVisible();
  await page.getByRole("textbox", { name: "Profile name" }).fill("Client research MOM");
  await page.getByRole("textbox", { name: /API key/ }).fill("temporary-secret-not-saved");
  await navigation.getByRole("button", { name: "Meetings" }).click();
  await page.getByRole("button", { name: /Needs attention/ }).click();
  await page.getByPlaceholder("Search meetings").fill("Acme");
  await navigation.getByRole("button", { name: "AI providers" }).click();
  await expect(page.getByRole("complementary", { name: /Edit Research MOM/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Profile name" })).toHaveValue("Client research MOM");
  await expect(page.getByRole("textbox", { name: /API key/ })).toHaveValue("");
  expect(await page.evaluate(() => [...Object.values(sessionStorage), ...Object.values(localStorage)].join(" "))).not.toContain("temporary-secret-not-saved");
  await navigation.getByRole("button", { name: "Meetings" }).click();
  await expect(page.getByRole("button", { name: /Needs attention/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByPlaceholder("Search meetings")).toHaveValue("Acme");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Meetings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Needs attention/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByPlaceholder("Search meetings")).toHaveValue("Acme");
});

test("knowledge base and chat model survive navigation", async ({ page }) => {
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("button", { name: "AI knowledge" }).click();
  await page.getByRole("button", { name: /Client B/ }).click();
  await expect(page.getByRole("button", { name: /Client B/ })).toHaveClass(/selected/);
  await page.locator(".knowledge-chat-settings summary").click();
  await page.locator("#chat-model-search").click();
  await page.getByRole("option", { name: /Sol/ }).click();
  await navigation.getByRole("button", { name: "Meetings" }).click();
  await navigation.getByRole("button", { name: "AI knowledge" }).click();
  await expect(page.getByRole("button", { name: /Client B/ })).toHaveClass(/selected/);
  await expect(page.locator(".knowledge-chat-settings summary")).toContainText("Sol");
  await page.reload();
  await expect(page.getByRole("button", { name: /Client B/ })).toHaveClass(/selected/);
  await expect(page.locator(".knowledge-chat-settings summary")).toContainText("Sol");
});

test("preferences are isolated when the signed-in user changes", async ({ page }) => {
  let activeUserId = userId;
  await page.route("**/v1/auth/me", (route) => route.fulfill({ json: {
    user_id: activeUserId, organization_id: organizationId, email: "owner@example.test",
    display_name: "Owner", role: "owner", must_change_password: false,
  } }));
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "AI providers" }).click();
  await page.getByRole("button", { name: /Research MOM/ }).click();
  await expect(page.getByRole("complementary", { name: /Edit Research MOM/ })).toBeVisible();
  activeUserId = "00000000-0000-4000-8000-000000000003";
  await page.reload();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "AI providers" }).click();
  await expect(page.getByRole("complementary", { name: /Edit Economy MOM/ })).toBeVisible();
});

test("a saved knowledge conversation is reopened after leaving the page", async ({ page }) => {
  const conversationId = "00000000-0000-4000-8000-000000000077";
  const conversation = { id: conversationId, knowledge_base_id: baseId, title: "Client decision", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", messages: [
    { role: "user", content: "What did the client decide?", citations: [], provider: null, model: null, created_at: "2026-09-25T00:00:00Z" },
    { role: "assistant", content: "They approved the next review.", citations: [], provider: "openai", model: "gpt-6-luna", created_at: "2026-09-25T00:00:01Z" },
  ] };
  await page.route("**/v1/knowledge-bases/*/conversations**", (route) => route.fulfill({ json: route.request().url().endsWith(`/${conversationId}`) ? conversation : [conversation] }));
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("button", { name: "AI knowledge" }).click();
  await page.getByRole("button", { name: "Client decision" }).click();
  await expect(page.getByText("They approved the next review.")).toBeVisible();
  await navigation.getByRole("button", { name: "Meetings" }).click();
  await navigation.getByRole("button", { name: "AI knowledge" }).click();
  await expect(page.getByText("They approved the next review.")).toBeVisible();
});

test("meeting prep keeps its selected event across navigation and reload", async ({ page }) => {
  const starts = new Date(Date.now() + 3 * 86_400_000);
  const event = (id: string, title: string, offset: number) => ({
    id, title, connection_id: "work-calendar", provider: "outlook", event_id: id,
    starts_at: new Date(starts.getTime() + offset * 3_600_000).toISOString(),
    ends_at: new Date(starts.getTime() + (offset + 1) * 3_600_000).toISOString(),
    synced_at: new Date().toISOString(), meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet", invitees: [],
  });
  await page.route("**/v1/calendar/synced?**", (route) => route.fulfill({ json: { events: [event("event-one", "First prep", 0), event("event-two", "Second prep", 2)], syncs: [] } }));
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation.getByRole("button", { name: "Meeting prep" }).click();
  await page.getByRole("button", { name: /Second prep/ }).click();
  await expect(page.getByRole("button", { name: /Second prep/ })).toHaveClass(/selected/);
  await navigation.getByRole("button", { name: "Meetings" }).click();
  await navigation.getByRole("button", { name: "Meeting prep" }).click();
  await expect(page.getByRole("button", { name: /Second prep/ })).toHaveClass(/selected/);
  await page.reload();
  await expect(page.getByRole("button", { name: /Second prep/ })).toHaveClass(/selected/);
});
