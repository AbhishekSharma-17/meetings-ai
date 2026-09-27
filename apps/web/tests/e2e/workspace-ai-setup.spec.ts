import { expect, test } from "@playwright/test";

const owner = {
  user_id: "00000000-0000-4000-8000-000000000002", organization_id: "00000000-0000-4000-8000-000000000001",
  email: "owner@example.test", display_name: "Owner", role: "owner", must_change_password: false,
};
const openRouterKey = {
  id: "00000000-0000-4000-8000-0000000000aa", label: "Team OpenRouter", provider_type: "openrouter", base_url: null,
  hint: "••••0979", created_at: "2026-09-27T09:00:00Z", updated_at: "2026-09-27T09:00:00Z", last_used_at: null,
  used_by_profiles: 0, used_by_settings: false,
};
const settings = {
  can_edit: true, chat_profile_id: null, chat_model: null, vision_profile_id: null, vision_model: null,
  research_credential_id: null, research_credential_label: null, research_profile_id: null, research_model: null,
  vision_configured: false, research_configured: false, updated_at: null, updated_by: null,
  effective_chat: { profile_id: null, profile_name: null, provider: null, model: null, source: "not_configured" },
};

test("owner with only an OpenRouter key sets up recommended GPT-6 models in one click", async ({ page }) => {
  let createdBody: Record<string, unknown> | null = null;
  let defaultBody: Record<string, unknown> | null = null;
  let savedSettings: Record<string, unknown> | null = null;
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (pathname === "/v1/auth/me") return route.fulfill({ json: owner });
    if (pathname === "/v1/credentials") return route.fulfill({ json: [openRouterKey] });
    if (pathname === "/v1/provider-profiles" && request.method() === "POST") {
      createdBody = request.postDataJSON();
      return route.fulfill({ status: 201, json: {
        id: "00000000-0000-4000-8000-0000000000bb", name: createdBody?.name, provider_type: "openai_compatible",
        execution_location: "cloud", base_url: "https://openrouter.ai/api/v1",
        capabilities: [{ capability: "text_generation", model: "openai/gpt-6-sol" }],
        credential_configured: true, credential_hint: "••••0979", credential_id: openRouterKey.id,
        credential_label: openRouterKey.label, created_at: "2026-09-27T09:00:00Z", updated_at: "2026-09-27T09:00:00Z",
      } });
    }
    if (pathname === "/v1/provider-defaults/text_generation") {
      defaultBody = request.postDataJSON();
      return route.fulfill({ json: { capability: "text_generation", ...defaultBody } });
    }
    if (pathname === "/v1/provider-profiles" || pathname === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (pathname === "/v1/ai/settings" && request.method() === "PUT") {
      savedSettings = request.postDataJSON();
      return route.fulfill({ json: { ...settings, ...savedSettings } });
    }
    if (pathname === "/v1/ai/settings") return route.fulfill({ json: settings });
    return route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "AI providers", exact: true }).click();
  await page.getByRole("button", { name: "Set up recommended models" }).click();

  await expect.poll(() => createdBody).toMatchObject({
    provider_type: "openai_compatible", base_url: "https://openrouter.ai/api/v1", credential_id: openRouterKey.id,
    capabilities: [{ capability: "text_generation", model: "openai/gpt-6-sol" }],
  });
  expect(createdBody).not.toHaveProperty("api_key");
  await expect.poll(() => defaultBody).toMatchObject({ policy: "cloud_only" });

  await page.getByRole("button", { name: "Save workspace AI" }).click();
  await expect.poll(() => savedSettings).toMatchObject({
    chat_model: "openai/gpt-6-luna", vision_model: "openai/gpt-6-luna", research_model: "openai/gpt-6-sol",
  });
});
