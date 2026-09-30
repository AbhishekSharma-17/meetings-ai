import { expect, test, type Page } from "@playwright/test";

const orgId = "00000000-0000-4000-8000-000000000001";
const owner = { user_id: "00000000-0000-4000-8000-000000000002", organization_id: orgId, email: "owner@example.test", display_name: "Workspace owner", role: "owner", must_change_password: false };
const base = {
  meeting_url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x", platform: "teams", status: "created", bot_name: "Meetings AI",
  created_at: "2026-09-28T12:40:00Z", updated_at: "2026-09-28T12:40:00Z", joined_at: null, stopped_at: null, tags: [], knowledge_enabled: false, knowledge_base_id: null,
};
const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
const earlier = new Date(Date.now() + 86_400_000).toISOString();
const plan = (status: string, extra: Record<string, unknown> = {}) => ({ status, provider: "outlook", starts_at: later, ends_at: later, note: null, changed_at: "2026-09-30T16:00:00Z", rescheduled_from: null, ...extra });
const meetings = [
  { ...base, id: "00000000-0000-4000-8000-0000000000a1", title: "Weekly sync", schedule: plan("pending") },
  { ...base, id: "00000000-0000-4000-8000-0000000000a2", title: "Pricing review", schedule: plan("pending", { rescheduled_from: earlier }) },
  { ...base, id: "00000000-0000-4000-8000-0000000000a3", title: "Discovery call: Utica", schedule: plan("cancelled", { note: "Cancelled in Outlook Calendar" }) },
  { ...base, id: "00000000-0000-4000-8000-0000000000a4", title: "Investor update", schedule: plan("pending", { provider: "manual", note: "Waiting for a free assistant: all of them are in other calls right now" }) },
];
const scheduleOf = (meeting: typeof meetings[number]) => ({
  meeting_id: meeting.id, connection_id: "ca-1", provider: "outlook", event_id: `evt-${meeting.id.slice(-2)}`, starts_at: meeting.schedule.starts_at, ends_at: meeting.schedule.ends_at,
  status: meeting.schedule.status, last_error: meeting.schedule.note, rescheduled_from: meeting.schedule.rescheduled_from, last_checked_at: "2026-09-30T16:05:00Z",
});

async function mock(page: Page) {
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const meeting = meetings.find((item) => path.startsWith(`/v1/meetings/${item.id}`) || path === `/v1/calendar/schedules/${item.id}`);
    if (path === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (path === "/v1/auth/me") return route.fulfill({ json: owner });
    if (path === "/v1/workspace") return route.fulfill({ json: { id: orgId, display_name: "GenAI Protos", status: "active", created_at: base.created_at, updated_at: base.updated_at } });
    if (path === "/v1/meetings") return route.fulfill({ json: { items: meetings, count: meetings.length } });
    if (path === "/v1/assistants/capacity") return route.fulfill({ json: { limit: 3, in_use: 3, available: 0, waiting: 1, tested_capacity: null, checked_at: "2026-09-30T16:00:00Z", error: null } });
    if (path === "/v1/calendar/schedules") return route.fulfill({ json: meetings.map(scheduleOf) });
    if (meeting && path === `/v1/calendar/schedules/${meeting.id}`) return route.fulfill({ json: scheduleOf(meeting) });
    if (meeting && path === `/v1/meetings/${meeting.id}`) return route.fulfill({ json: meeting });
    if (meeting && path.endsWith("/transcript")) return route.fulfill({ json: { segments: [] } });
    if (path === "/v1/knowledge-bases" || path === "/v1/provider-profiles" || path === "/v1/provider-defaults" || path === "/v1/workspace/members") return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "not needed in this UI test" } });
  });
}

test("the meetings list says scheduled, rescheduled or cancelled instead of created", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meetings", exact: true }).click();
  const row = (title: string) => page.getByRole("button", { name: `Open ${title}` });
  await expect(row("Weekly sync")).toContainText("Scheduled");
  await expect(row("Pricing review")).toContainText("Rescheduled");
  await expect(row("Pricing review")).toContainText("(was ");
  await expect(row("Discovery call: Utica")).toContainText("Cancelled");
  await expect(page.getByText("Created", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /Cancelled or missed/ }).click();
  await expect(row("Discovery call: Utica")).toBeVisible();
  await expect(row("Weekly sync")).toHaveCount(0);
});

test("a cancelled meeting explains what happened and offers what to do next", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meetings", exact: true }).click();
  await page.getByRole("button", { name: "Open Discovery call: Utica" }).click();
  await expect(page.getByRole("heading", { name: "Cancelled in Outlook Calendar" })).toBeVisible();
  await expect(page.getByText("The assistant didn't join and nothing was recorded", { exact: false })).toBeVisible();
  await expect(page.locator(".page-header .status")).toHaveText("Cancelled");
  // Nothing to capture, review or share for a meeting that didn't happen.
  await expect(page.getByRole("heading", { name: "MOM & follow-up" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sharing" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Join meeting" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "It's on after all — join now" })).toBeVisible();
  const capture = process.env.PLAYWRIGHT_CAPTURE_DIR;
  if (capture) await page.screenshot({ path: `${capture}/meeting-cancelled.png`, fullPage: true });
  await page.getByRole("button", { name: "Delete this record" }).click();
  await expect(page.getByRole("heading", { name: "Delete meeting" })).toBeInViewport();
});

test("a rescheduled meeting shows the new time and where it moved from", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meetings", exact: true }).click();
  await page.getByRole("button", { name: "Open Pricing review" }).click();
  await expect(page.getByRole("heading", { name: /Rescheduled · the assistant joins/ })).toBeVisible();
  await expect(page.getByText("Moved in Outlook Calendar from", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel auto-join" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "MOM & follow-up" })).toBeVisible();
});

test("the overview shows assistant capacity and a waiting meeting says so", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  const tile = page.locator(".capacity-stat");
  await expect(tile).toContainText("Assistants in calls");
  await expect(tile).toContainText("3 / 3");
  await expect(tile).toContainText("All in calls · 1 waiting");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meetings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open Investor update" })).toContainText("Waiting for assistant");
  await page.getByRole("button", { name: "Open Investor update" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for a free assistant" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop waiting" })).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Observability" }).click();
  const card = page.locator(".capacity-card");
  await expect(card.getByRole("heading", { name: "Meeting assistants" })).toBeVisible();
  await expect(card).toContainText("3 of 3");
  await expect(card).toContainText("Not load-tested yet");
});
