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

async function mockApp(page: Page, options: { firstListEmpty?: boolean; failCreate?: boolean; role?: "owner" | "member"; visibility?: "private" | "organization" | "specific" } = {}) {
  let baseLists = 0;
  let baseCreates = 0;
  let meetingBody: Record<string, unknown> | null = null;
  let scheduledBody: Record<string, unknown> | null = null;
  let sharingBody: Record<string, unknown> | null = null;
  const currentBase = { ...base, visibility: options.visibility ?? "private" };
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (path === "/v1/auth/me") return route.fulfill({ json: {
      user_id: options.role === "member" ? "00000000-0000-4000-8000-000000000088" : base.created_by, organization_id: base.organization_id,
      email: "developer@genaiprotos.com", display_name: "Workspace owner",
      role: options.role ?? "owner", must_change_password: false,
    } });
    if (path === "/v1/knowledge-bases" && request.method() === "GET") {
      baseLists += 1;
      return route.fulfill({ json: options.firstListEmpty && baseLists === 1 ? [] : [currentBase] });
    }
    if (path === "/v1/knowledge-bases" && request.method() === "POST") {
      baseCreates += 1;
      return route.fulfill({ status: 409, json: { detail: "a knowledge base with this name already exists" } });
    }
    if (path === `/v1/knowledge-bases/${base.id}/sharing` && request.method() === "PUT") {
      sharingBody = request.postDataJSON();
      currentBase.visibility = sharingBody.visibility as typeof currentBase.visibility;
      currentBase.shared_user_ids = sharingBody.user_ids as string[];
      return route.fulfill({ json: currentBase });
    }
    if (path === "/v1/meetings/schedules" && request.method() === "POST") {
      scheduledBody = request.postDataJSON();
      return route.fulfill({ status: 201, json: { schedule: {
        meeting_id: "00000000-0000-4000-8000-000000000099", provider: "manual",
        starts_at: scheduledBody.starts_at, ends_at: scheduledBody.starts_at,
        connection_id: "manual", event_id: "test", status: "pending", last_error: null,
      }, meeting: {
        id: "00000000-0000-4000-8000-000000000099", title: "Scheduled test",
        meeting_url: scheduledBody.meeting.meeting_url, platform: "google_meet",
        status: "created", bot_name: "Meetings AI",
        created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z",
      } } });
    }
    if (path === "/v1/meetings/00000000-0000-4000-8000-000000000099" && request.method() === "GET") {
      return route.fulfill({ json: {
        id: "00000000-0000-4000-8000-000000000099", title: "Scheduled test",
        meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet",
        status: "created", bot_name: "Meetings AI",
        created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z",
      } });
    }
    if (path === "/v1/calendar/schedules/00000000-0000-4000-8000-000000000099" && request.method() === "GET" && scheduledBody) {
      return route.fulfill({ json: {
        meeting_id: "00000000-0000-4000-8000-000000000099", provider: "manual",
        starts_at: scheduledBody.starts_at, ends_at: scheduledBody.starts_at,
        connection_id: "manual", event_id: "test", status: "pending", last_error: null,
      } });
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
    if (path === "/v1/workspace/members") return route.fulfill({ json: [
      { user_id: base.created_by, display_name: "Workspace owner", email: "developer@genaiprotos.com", role: "owner", status: "active" },
      { user_id: "00000000-0000-4000-8000-000000000088", display_name: "Team member", email: "member@example.test", role: "member", status: "active" },
    ] });
    return route.fulfill({ status: 404, json: { detail: "test route not mocked" } });
  });
  return { get baseCreates() { return baseCreates; }, get meetingBody() { return meetingBody; }, get scheduledBody() { return scheduledBody; }, get sharingBody() { return sharingBody; } };
}

async function submitWithBaseName(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New meeting" }).click();
  await page.getByLabel("Meeting link").fill("https://meet.google.com/abc-defg-hij");
  await page.getByLabel(/Or create a knowledge base/).fill("mobius_MEET");
  await page.getByRole("button", { name: "Send assistant" }).click();
}

test("a workspace member can choose a shared base for their own assistant", async ({ page }) => {
  const state = await mockApp(page, { role: "member", visibility: "organization", failCreate: true });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar", exact: true }).click();
  await page.getByRole("button", { name: "New meeting", exact: true }).click();
  await page.getByLabel("Meeting link").fill("https://meet.google.com/abc-defg-hij");
  await page.getByRole("combobox", { name: "Knowledge base", exact: true }).click();
  await page.getByRole("option", { name: base.name, exact: true }).click();
  await expect(page.getByText(/those shared with you/)).toBeVisible();
  await page.getByRole("button", { name: "Send assistant", exact: true }).click();
  await expect.poll(() => state.meetingBody?.knowledge_base_id).toBe(base.id);
  expect(state.baseCreates).toBe(0);
});

test("remembers a successfully scheduled assistant name across dialog closes and reloads", async ({ page }) => {
  const mock = await mockApp(page);
  await page.route("**/v1/me/assistant-name", (route) => route.fulfill({ json: { assistant_name: "Original assistant", updated_at: "2026-09-01T00:00:00Z" } }));
  await page.goto("/");
  await page.getByRole("button", { name: "New meeting" }).click();
  await expect(page.getByLabel("Assistant name", { exact: true })).toHaveValue("Original assistant");
  await page.getByLabel("Assistant name", { exact: true }).fill("My team's assistant");
  await page.getByLabel("Meeting link").fill("https://meet.google.com/abc-defg-hij");
  await page.getByLabel("At the meeting start time").check();
  const tomorrow = new Date(Date.now() + 86_400_000);
  await page.getByLabel(/Meeting start/).fill(new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  await page.getByRole("button", { name: "Schedule assistant" }).click();
  await expect.poll(() => mock.scheduledBody).toMatchObject({ meeting: { bot_name: "My team's assistant" } });
  await page.reload();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "New meeting" }).click();
  await expect(page.getByLabel("Assistant name", { exact: true })).toHaveValue("My team's assistant");
  await page.getByLabel("Assistant name", { exact: true }).fill("Cancelled rename");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "New meeting" }).click();
  await expect(page.getByLabel("Assistant name", { exact: true })).toHaveValue("My team's assistant");
});

test("assistant defaults are isolated by person and workspace", async ({ page }) => {
  await mockApp(page);
  await page.route("**/v1/me/assistant-name", (route) => route.fulfill({ json: { assistant_name: "Meetings AI", updated_at: null } }));
  await page.addInitScript(() => {
    const saved = JSON.stringify({ name: "Other person's assistant", updatedAt: new Date().toISOString() });
    localStorage.setItem("meetings-ai:assistant-name:other-org:other-user", saved);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "New meeting" }).click();
  await expect(page.getByLabel("Assistant name", { exact: true })).toHaveValue("Meetings AI");
});

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

test("queues a future manual meeting without joining immediately", async ({ page }) => {
  const mock = await mockApp(page);
  await page.goto("/");
  await page.getByRole("button", { name: "New meeting" }).click();
  await page.getByLabel("Meeting link").fill("https://meet.google.com/abc-defg-hij");
  await page.getByLabel("At the meeting start time").check();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const localTime = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await page.getByLabel(/Meeting start/).fill(localTime);
  await page.getByRole("button", { name: "Schedule assistant" }).click();
  await expect(page.getByRole("heading", { name: /^Scheduled · the assistant joins/ })).toBeVisible();
  expect(mock.scheduledBody).toMatchObject({ meeting: { meeting_url: "https://meet.google.com/abc-defg-hij" } });
  expect(mock.meetingBody).toBeNull();
});

test("shows and changes sharing for the selected knowledge base", async ({ page }) => {
  const mock = await mockApp(page, { visibility: "organization" });
  await page.goto("/");
  await page.getByRole("button", { name: "AI knowledge" }).click();
  await expect(page.getByText("Shared with everyone in this organization")).toBeVisible();
  await page.getByRole("button", { name: "Manage sharing" }).click();
  await expect(page.getByRole("radio", { name: "Everyone in this workspace" })).toBeChecked();
  await page.getByRole("radio", { name: "Specific teammates" }).check();
  await page.getByRole("dialog").getByRole("checkbox", { name: /Team member/ }).check();
  await page.getByRole("button", { name: "Save sharing" }).click();
  await expect(page.getByText("Sharing saved for Mobius_meet.")).toBeVisible();
  expect(mock.sharingBody).toEqual({ visibility: "specific", user_ids: ["00000000-0000-4000-8000-000000000088"] });
});
