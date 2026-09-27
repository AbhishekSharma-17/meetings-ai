import { expect, test } from "@playwright/test";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const secret = "sk-or-v1-never-shown-9f2a";

test("owner saves an API key once and links it to a new profile", async ({ page }) => {
  const credentials: Array<Record<string, unknown>> = [];
  const profiles: Array<Record<string, unknown>> = [];
  const profileRequests: Array<Record<string, unknown>> = [];
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (pathname === "/v1/auth/me") return route.fulfill({ json: { user_id: userId, organization_id: organizationId, email: "owner@example.test", display_name: "Owner", role: "owner", must_change_password: false } });
    if (pathname === "/v1/workspaces") return route.fulfill({ json: [{ id: organizationId, slug: "example", display_name: "Example", role: "owner" }] });
    if (pathname === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (pathname === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (pathname === "/v1/ai/settings") return route.fulfill({ json: {
      can_edit: true, chat_profile_id: null, chat_model: null, vision_profile_id: null, vision_model: null,
      research_credential_id: null, research_credential_label: null, research_profile_id: null, research_model: null,
      updated_at: null, updated_by: null, vision_configured: false, research_configured: false,
      effective_chat: { profile_id: null, profile_name: null, provider: null, model: null, source: "not_configured" },
    } });
    if (pathname === "/v1/credentials" && method === "GET") return route.fulfill({ json: credentials });
    if (pathname === "/v1/credentials" && method === "POST") {
      const payload = request.postDataJSON();
      expect(payload).toMatchObject({ label: "OpenRouter team", provider_type: "openrouter", secret });
      const created = {
        id: "00000000-0000-4000-8000-0000000000c1", label: payload.label, provider_type: payload.provider_type,
        base_url: "https://openrouter.ai/api/v1", hint: "••••9f2a", created_at: "2026-09-26T00:00:00Z",
        updated_at: "2026-09-26T00:00:00Z", last_used_at: null, used_by_profiles: 0, used_by_settings: false,
      };
      credentials.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    if (pathname === "/v1/provider-profiles" && method === "GET") return route.fulfill({ json: profiles });
    if (pathname === "/v1/provider-profiles" && method === "POST") {
      const payload = request.postDataJSON();
      profileRequests.push(payload);
      const credential = credentials.find((item) => item.id === payload.credential_id);
      if (credential) credential.used_by_profiles = 1;
      const saved = {
        ...payload, id: "00000000-0000-4000-8000-0000000000p1", base_url: payload.base_url ?? null,
        credential_configured: Boolean(credential), credential_hint: credential ? "••••9f2a" : null,
        credential_id: credential ? credential.id : null, credential_label: credential ? credential.label : null,
        created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z",
      };
      profiles.push(saved);
      return route.fulfill({ status: 201, json: saved });
    }
    return route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "AI providers" }).click();
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(page.getByText("No saved keys yet")).toBeVisible();

  await page.getByRole("button", { name: "Add key" }).click();
  const dialog = page.getByRole("dialog", { name: "Add API key" });
  await dialog.getByLabel("Key name").fill("OpenRouter team");
  await dialog.getByLabel("API key", { exact: true }).fill(secret);
  await dialog.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByRole("dialog", { name: "Key saved" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  const keyList = page.locator(".provider-key-list");
  await expect(keyList.getByText("OpenRouter team")).toBeVisible();
  await expect(keyList.getByText("••••9f2a")).toBeVisible();
  await expect(page.getByText(secret)).toHaveCount(0);

  await page.getByRole("button", { name: "Add LLM profile" }).click();
  await page.getByLabel("Profile name").fill("Router minutes");
  await page.getByLabel("Provider type").click();
  await page.getByRole("option", { name: "OpenRouter" }).click();
  await page.getByLabel("Model", { exact: true }).fill("provider/model-id");
  await page.getByRole("button", { name: "Use a saved key" }).click();
  await expect(page.getByLabel("Saved API key")).toContainText("OpenRouter team");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Router minutes saved.")).toBeVisible();

  expect(profileRequests).toHaveLength(1);
  expect(profileRequests[0]).toMatchObject({ credential_id: credentials[0].id, base_url: "https://openrouter.ai/api/v1" });
  expect(profileRequests[0]).not.toHaveProperty("api_key");
  await expect(page.getByRole("button", { name: /Router minutes/ })).toContainText("OpenRouter team");
  await expect(keyList.getByText("Used by 1 profile")).toBeVisible();
  expect(await page.evaluate(() => [...Object.values(sessionStorage), ...Object.values(localStorage)].join(" "))).not.toContain(secret);
});
