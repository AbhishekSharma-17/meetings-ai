import { expect, test, type Page } from "@playwright/test";

const base = {
  id: "00000000-0000-4000-8000-000000000066",
  organization_id: "00000000-0000-4000-8000-000000000001",
  name: "Mobius_meet",
  description: null,
  created_by: "00000000-0000-4000-8000-000000000002",
  visibility: "private",
  text_profile_id: null,
  meeting_count: 1,
  shared_user_ids: [],
  created_at: "2026-09-25T00:00:00Z",
  updated_at: "2026-09-25T00:00:00Z",
};

async function mockApp(page: Page, options: { firstListEmpty?: boolean; failCreate?: boolean } = {}) {
  let baseLists = 0;
  let baseCreates = 0;
  let meetingBody: Record<string, unknown> | null = null;
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (path === "/v1/auth/me") return route.fulfill({ json: {
      user_id: base.created_by, organization_id: base.organization_id,
      email: "developer@genaiprotos.com", display_name: "Workspace owner",
      role: "owner", must_change_password: false,
    } });
    if (path === "/v1/knowledge-bases" && request.method() === "GET") {
      baseLists += 1;
      return route.fulfill({ json: options.firstListEmpty && baseLists === 1 ? [] : [base] });
    }
    if (path === "/v1/knowledge-bases" && request.method() === "POST") {
      baseCreates += 1;
      return route.fulfill({ status: 409, json: { detail: "a knowledge base with this name already exists" } });
    }
    if (path === "/v1/meetings" && request.method() === "POST") {
      meetingBody = request.postDataJSON();
      if (options.failCreate) return route.fulfill({ status: 422, json: {
        detail: [{ loc: ["body", "meeting_url"], msg: "meeting link is not permitted" }],
      } });
      return route.fulfill({ status: 201, json: {
        id: "00000000-0000-4000-8000-000000000099",
        title: "Mobius test", meeting_url: meetingBody.meeting_url,
        platform: "google_meet", status: "created", bot_name: "Meetings AI",
        created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z",
      } });
    }
    if (path.endsWith("/join")) return route.fulfill({ status: 409, json: { detail: "capture unavailable in test" } });
    if (path === "/v1/meetings" && request.method() === "GET") return route.fulfill({ json: { items: [], count: 0 } });
    if (path === "/v1/provider-profiles" || path === "/v1/provider-defaults" || path === "/v1/workspaces") {
      return route.fulfill({ json: [] });
    }
    if (path === "/v1/workspace") return route.fulfill({ json: {
      id: base.organization_id, display_name: "GenAI Protos", contact_email: null,
      status: "active", created_at: base.created_at, updated_at: base.updated_at,
    } });
    return route.fulfill({ status: 404, json: { detail: "test route not mocked" } });
  });
  return { get baseCreates() { return baseCreates; }, get meetingBody() { return meetingBody; } };
}

async function submitWithBaseName(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New meeting" }).click();
  await page.getByLabel("Meeting link").fill("https://meet.google.com/abc-defg-hij");
  await page.getByLabel(/Or create a knowledge base/).fill("mobius_MEET");
  await page.getByRole("button", { name: "Send assistant" }).click();
}

test("reuses a visible knowledge base and renders structured API errors", async ({ page }) => {
  const mock = await mockApp(page, { failCreate: true });
  await submitWithBaseName(page);
  await expect(page.getByRole("alert")).toContainText("meeting_url: meeting link is not permitted");
  await expect(page.getByRole("alert")).not.toContainText("[object Object]");
  expect(mock.baseCreates).toBe(0);
  expect(mock.meetingBody).toMatchObject({ knowledge_base_id: base.id, knowledge_enabled: true });
});

test("resolves a knowledge-base creation race by reloading the base", async ({ page }) => {
  const mock = await mockApp(page, { firstListEmpty: true, failCreate: true });
  await submitWithBaseName(page);
  await expect(page.getByRole("alert")).toContainText("meeting_url: meeting link is not permitted");
  expect(mock.baseCreates).toBe(1);
  expect(mock.meetingBody).toMatchObject({ knowledge_base_id: base.id, knowledge_enabled: true });
});

test("checks participant delivery before creating a knowledge base or meeting", async ({ page }) => {
  const mock = await mockApp(page, { firstListEmpty: true });
  await page.goto("/");
  await page.getByRole("button", { name: "New meeting" }).click();
  await page.getByLabel("Meeting link").fill("https://meet.google.com/abc-defg-hij");
  await page.getByLabel(/Or create a knowledge base/).fill("New client wiki");
  await page.getByText("Recap delivery options").click();
  await page.getByLabel(/Also send to listed participants/).check();
  await page.getByRole("button", { name: "Send assistant" }).click();
  await expect(page.getByRole("alert")).toContainText("Add at least one participant email address");
  expect(mock.baseCreates).toBe(0);
  expect(mock.meetingBody).toBeNull();
});
