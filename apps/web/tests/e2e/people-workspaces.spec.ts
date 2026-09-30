import { expect, test, type Page, type Route } from "@playwright/test";

const ORG = "00000000-0000-4000-8000-000000000001";
const SECOND = "00000000-0000-4000-8000-000000000011";
const USER = "00000000-0000-4000-8000-000000000002";
// 1×1 PNG; the mocked API serves it as the "processed" photo.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkaPhfDwAEhgGAWqvKGQAAAABJRU5ErkJggg==", "base64");

const workspace = {
  id: ORG, slug: "genai-protos", display_name: "GenAI Protos", contact_email: null, status: "active",
  created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-24T00:00:00Z", tenant_isolation_enabled: true,
};

async function mockApi(page: Page, handler: (route: Route, pathname: string, method: string) => Promise<boolean> | boolean) {
  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (await handler(route, pathname, method)) return;
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (pathname === "/v1/workspace") return route.fulfill({ json: workspace });
    if (pathname === "/v1/workspace/brief") return route.fulfill({ json: { website: null, overview: "", services: [], products: [], differentiators: "", positioning: "", updated_at: null } });
    if (pathname === "/v1/workspace/members") return route.fulfill({ json: [{ user_id: USER, display_name: "Workspace owner", email: "owner@example.test", role: "owner", status: "active", photo_url: null }] });
    if (pathname === "/v1/workspace/retention") return route.fulfill({ json: { enabled: false, meeting_days: null, chat_days: null, audit_days: null } });
    if (pathname === "/v1/workspace/operations") return route.fulfill({ json: { people: 1, meetings_captured: 0, completed_meetings: 0, saved_chats: 0, active_captures: 0, failed_captures: 0, failed_mom_jobs: 0, pending_index_jobs: 0, failed_index_jobs: 0, failed_email_deliveries: 0, latest_audit_at: null } });
    if (pathname === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (pathname === "/v1/provider-profiles" || pathname === "/v1/provider-defaults" || pathname === "/v1/knowledge-bases" || pathname.endsWith("/documents") || pathname === "/v1/workspace/audit" || pathname === "/v1/me/activity") return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "mock route missing" } });
  });
}

const account = (photoUrl: string | null) => ({
  user_id: USER, organization_id: ORG, email: "owner@example.test", display_name: "Workspace owner",
  role: "owner", must_change_password: false, photo_url: photoUrl,
});

test("a default workspace can be chosen and cleared", async ({ page }) => {
  let defaultId: string | null = null;
  const requests: Array<string | null> = [];
  const options = () => [
    { id: ORG, slug: "genai-protos", display_name: "GenAI Protos", role: "owner", is_default: defaultId === ORG },
    { id: SECOND, slug: "novaala", display_name: "Novaala", role: "admin", is_default: defaultId === SECOND },
  ];
  await mockApi(page, async (route, pathname, method) => {
    if (pathname === "/v1/auth/me") { await route.fulfill({ json: account(null) }); return true; }
    if (pathname === "/v1/workspaces") { await route.fulfill({ json: options() }); return true; }
    if (pathname === "/v1/workspaces/default" && method === "PUT") {
      defaultId = route.request().postDataJSON().organization_id;
      requests.push(defaultId);
      await route.fulfill({ json: options() });
      return true;
    }
    return false;
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Workspace owner owner@example.test/ }).click();
  await page.getByRole("button", { name: "Organization & people" }).click();
  const directory = page.getByRole("region", { name: "Your workspaces" });
  await expect(directory.getByText("Current workspace")).toBeVisible();
  await expect(directory.getByText("New sign-ins open the workspace you used last.")).toBeVisible();

  await directory.getByRole("button", { name: "Make Novaala your default workspace" }).click();
  await expect(directory.getByRole("listitem").filter({ hasText: "Novaala" }).getByText("Default", { exact: true })).toBeVisible();
  await expect(directory.getByText("New sign-ins open Novaala.")).toBeVisible();
  await expect(directory.getByRole("button", { name: "Make Novaala your default workspace" })).toHaveCount(0);

  await page.getByRole("button", { name: /Workspace owner owner@example.test/ }).click();
  const menu = page.getByRole("dialog", { name: "Account and workspace menu" });
  await expect(menu.getByRole("button", { name: /Novaala/ }).getByText("Default", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await directory.getByRole("button", { name: "Use last active instead" }).click();
  await expect(directory.getByText("New sign-ins open the workspace you used last.")).toBeVisible();
  await expect(directory.getByText("Default", { exact: true })).toHaveCount(0);
  expect(requests).toEqual([SECOND, null]);
});

test("a profile photo can be uploaded, shown and removed", async ({ page }) => {
  let photoUrl: string | null = null;
  let uploads = 0;
  await mockApi(page, async (route, pathname, method) => {
    if (pathname === "/v1/auth/me") { await route.fulfill({ json: account(photoUrl) }); return true; }
    if (pathname === "/v1/workspaces") { await route.fulfill({ json: [{ id: ORG, slug: "genai-protos", display_name: "GenAI Protos", role: "owner", is_default: false }] }); return true; }
    if (pathname === "/v1/auth/me/photo" && method === "PUT") {
      uploads += 1;
      photoUrl = `/v1/users/${USER}/photo?v=${uploads}`;
      await route.fulfill({ json: account(photoUrl) });
      return true;
    }
    if (pathname === "/v1/auth/me/photo" && method === "DELETE") {
      photoUrl = null;
      await route.fulfill({ json: account(null) });
      return true;
    }
    if (pathname === `/v1/users/${USER}/photo`) {
      await route.fulfill(photoUrl ? { status: 200, contentType: "image/png", body: PNG } : { status: 404, json: { detail: "photo not found" } });
      return true;
    }
    return false;
  });

  await page.goto("/");
  const trigger = page.getByRole("button", { name: /Workspace owner owner@example.test/ });
  await trigger.click();
  await page.getByRole("button", { name: "My profile & password" }).click();
  await expect(page.getByRole("heading", { name: "My profile" })).toBeVisible();
  const identity = page.locator(".profile-identity");
  await expect(identity.locator(".avatar")).toHaveText("WO");

  const input = page.getByLabel("Profile photo");
  await input.setInputFiles({ name: "animation.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
  await expect(page.getByText("Choose a PNG, JPEG or WebP image.")).toBeVisible();
  expect(uploads).toBe(0);

  await input.setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByText("Profile photo updated.")).toBeVisible();
  await expect(identity.locator(".avatar img")).toHaveAttribute("src", `/v1/users/${USER}/photo?v=1`);
  await expect(trigger.locator(".avatar img")).toHaveAttribute("src", `/v1/users/${USER}/photo?v=1`);
  await expect.poll(() => identity.locator(".avatar img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  await expect(page.getByRole("button", { name: "Change photo" })).toBeVisible();

  await page.getByRole("button", { name: "Remove photo" }).click();
  await expect(page.getByText("Profile photo removed.")).toBeVisible();
  await expect(identity.locator(".avatar img")).toHaveCount(0);
  await expect(identity.locator(".avatar")).toHaveText("WO");
  await expect(page.getByRole("button", { name: "Upload photo" })).toBeVisible();
});

test("workspace settings link to Observability instead of repeating its numbers", async ({ page }) => {
  await mockApi(page, async (route, pathname) => {
    if (pathname === "/v1/auth/me") { await route.fulfill({ json: account(null) }); return true; }
    if (pathname === "/v1/workspaces") { await route.fulfill({ json: [{ id: ORG, slug: "genai-protos", display_name: "GenAI Protos", role: "owner", is_default: false }] }); return true; }
    if (pathname === "/v1/workspace/usage") {
      await route.fulfill({ json: { total_requests: 0, input_tokens: 0, output_tokens: 0, estimated_usd: 0, unpriced_requests: 0, failed_requests: 0, by_meeting: [], by_purpose: [], by_provider: [], by_kind: [], by_model: [], recent: [] } });
      return true;
    }
    return false;
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Workspace owner owner@example.test/ }).click();
  await page.getByRole("button", { name: "Organization & people" }).click();
  await expect(page.getByRole("region", { name: "Your workspaces" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Operations" })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: /Usage, spend & job health/ }).click();
  await expect(page.getByRole("heading", { name: "Pipeline status" })).toBeVisible();
});
