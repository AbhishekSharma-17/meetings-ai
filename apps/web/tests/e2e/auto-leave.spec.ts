import { expect, test, type Page, type Route } from "@playwright/test";
import { autoLeaveLine, endedLine, headsUpCopy, policyPreview } from "../../src/lib/leave-copy";
import type { LeavePolicyValues, MeetingLeave } from "../../src/lib/types";

/** When the assistant leaves a call: the settings card, the in-call line + heads-up, and the ended line. */
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const LIVE = "00000000-0000-4000-8000-000000000610";
const ENDED = "00000000-0000-4000-8000-000000000611";
const now = Date.now();
const minutes = (value: number) => new Date(now + value * 60_000).toISOString();
const DEFAULTS: LeavePolicyValues = { silence_minutes: 10, quiet_after_end_minutes: 5, no_one_joined_minutes: 10, max_hours: 4 };
const LIMITS = { silence_minutes: [3, 60], quiet_after_end_minutes: [2, 30], no_one_joined_minutes: [2, 60], max_hours: [2, 12] };

const meeting = (id: string, title: string, status: string) => ({
  id, title, meeting_url: "https://teams.microsoft.com/l/meetup-join/abc", platform: "teams", status, bot_name: "Meetings AI",
  created_at: minutes(-60), updated_at: minutes(-1), joined_at: minutes(-51), stopped_at: status === "completed" ? minutes(-5) : null,
  tags: [], knowledge_enabled: false, knowledge_base_id: null,
});

const CAP = { effective_max_hours: 4, service_max_hours: 4, cap_is_service_limit: true };
const liveLeave = (headsUp: boolean, keepUntil: string | null = null): MeetingLeave => ({
  meeting_id: LIVE, in_call: true, policy: DEFAULTS, ...CAP, joined_at: minutes(-51), scheduled_end: minutes(-21), last_speech_at: minutes(-4),
  safety_cap_at: minutes(4 * 60 - 51), keep_until: keepUntil, can_manage: true, can_keep: true,
  next_leave: { leave_at: keepUntil ?? minutes(1), reason: "ended_quiet_after_schedule", quiet_since: minutes(-4), heads_up_sent: headsUp && !keepUntil },
  ended: null, last_error: null,
});
const capLeave: MeetingLeave = {
  ...liveLeave(true), joined_at: minutes(-230), safety_cap_at: minutes(10), can_keep: false,
  next_leave: { leave_at: minutes(10), reason: "time_limit", quiet_since: null, heads_up_sent: true },
};
const endedLeave: MeetingLeave = {
  meeting_id: ENDED, in_call: false, policy: DEFAULTS, ...CAP, joined_at: minutes(-51), scheduled_end: minutes(-15), last_speech_at: null,
  safety_cap_at: null, keep_until: null, can_manage: true, can_keep: true, next_leave: null, last_error: null,
  ended: { reason: "ended_quiet_after_schedule", ended_by: "auto", ended_at: minutes(-5), quiet_since: minutes(-10) },
};

type Calls = { kept: number; stopped: number; saved: unknown[] };

async function mockApi(page: Page, options: { headsUp?: boolean; atCap?: boolean; role?: "owner" | "member" } = {}): Promise<Calls> {
  const calls: Calls = { kept: 0, stopped: 0, saved: [] };
  let policy = { ...DEFAULTS, service_max_hours: 4, effective_max_hours: 4, configured: false, can_edit: options.role !== "member", updated_at: null, defaults: DEFAULTS, limits: LIMITS };
  let live = meeting(LIVE, "Weekly delivery sync", "active");
  let leave = options.atCap ? capLeave : liveLeave(options.headsUp ?? false);
  await page.route("**/v1/**", (route: Route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    if (pathname === "/v1/workspace/leave-policy" && method === "PUT") {
      calls.saved.push(request.postDataJSON());
      policy = { ...policy, ...request.postDataJSON(), configured: true };
      policy = { ...policy, effective_max_hours: Math.min(policy.max_hours, 4) };
      return route.fulfill({ json: policy });
    }
    if (pathname === `/v1/meetings/${LIVE}/keep`) {
      calls.kept += 1;
      leave = liveLeave(false, minutes(30));
      return route.fulfill({ json: leave });
    }
    if (pathname === `/v1/meetings/${LIVE}/stop`) {
      calls.stopped += 1;
      live = { ...live, status: "stopping" };
      return route.fulfill({ json: live });
    }
    const map: Record<string, unknown> = {
      "/v1/auth/session": { authenticated: true },
      "/v1/auth/me": { user_id: USER, organization_id: ORG, email: "owner@example.test", display_name: "Workspace owner", role: options.role ?? "owner", must_change_password: false },
      "/v1/workspace": { id: ORG, slug: "example", display_name: "Example", contact_email: null, status: "active", created_at: minutes(-999), updated_at: minutes(-999), tenant_isolation_enabled: true },
      "/v1/workspaces": [{ id: ORG, slug: "example", display_name: "Example", role: options.role ?? "owner", is_default: false }],
      "/v1/workspace/members": [{ user_id: USER, display_name: "Workspace owner", email: "owner@example.test", role: options.role ?? "owner", status: "active" }],
      "/v1/workspace/leave-policy": policy,
      "/v1/meetings": { items: [live, meeting(ENDED, "Acme roadmap review", "completed")], count: 2 },
      [`/v1/meetings/${LIVE}`]: live,
      [`/v1/meetings/${ENDED}`]: meeting(ENDED, "Acme roadmap review", "completed"),
      [`/v1/meetings/${LIVE}/leave`]: leave,
      [`/v1/meetings/${ENDED}/leave`]: endedLeave,
      [`/v1/meetings/${LIVE}/transcript`]: { segments: [] },
      [`/v1/meetings/${ENDED}/transcript`]: { segments: [] },
      [`/v1/meetings/${LIVE}/participants`]: { participants: [] },
      [`/v1/meetings/${ENDED}/participants`]: { participants: [] },
      "/v1/notifications/unread-count": { unread_count: 0 },
      "/v1/notifications": { items: [], next_cursor: null, unread_count: 0 },
    };
    if (pathname in map) return route.fulfill({ json: map[pathname] });
    if (["/v1/provider-profiles", "/v1/provider-defaults", "/v1/background-jobs", "/v1/teams", "/v1/workspace/teams", "/v1/knowledge-bases", "/v1/documents", "/v1/workspace/brief/documents", "/v1/calendar/schedules"].includes(pathname)
      || pathname.endsWith("/speakers") || pathname.endsWith("/speaker-identities")) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });
  return calls;
}

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name, exact: true }).click();

async function openSettings(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Workspace owner owner@example.test/ }).click();
  await page.getByRole("button", { name: "Organization & people" }).click();
}

test.describe("auto-leave copy", () => {
  const clock = (value: string | Date) => new Date(value).toISOString().slice(11, 16);

  test("the preview is a worked example with the workspace values", () => {
    expect(policyPreview(DEFAULTS, 4)).toContain("leaves at 11:45, 5 minutes after the last words");
    expect(policyPreview({ ...DEFAULTS, quiet_after_end_minutes: 25, max_hours: 6 }, 4)).toContain("leaves at 12:05");
    expect(policyPreview(DEFAULTS, 4)).toContain("never leaves just because the end time passed");
    // The preview never promises more than the meeting-bot service allows.
    expect(policyPreview({ ...DEFAULTS, max_hours: 8 }, 4)).toContain("always leaves after 4 hours in one call");
    expect(policyPreview({ ...DEFAULTS, max_hours: 3 }, 4)).toContain("always leaves after 3 hours in one call");
  });

  test("the in-call line names the silence window and the safety limit", () => {
    const line = autoLeaveLine({ ...liveLeave(false), scheduled_end: null }, clock);
    expect(line).toMatch(/^Leaves automatically after 10 min of silence · no later than \d\d:\d\d \(4-hour limit of the meeting-bot service\)$/);
    expect(autoLeaveLine({ ...liveLeave(false), scheduled_end: null, effective_max_hours: 3, cap_is_service_limit: false }, clock)).toMatch(/\(3-hour safety limit\)$/);
    expect(autoLeaveLine(liveLeave(false), clock)).toMatch(/^Past its \d\d:\d\d end, so it leaves after 5 min with no one speaking/);
  });

  test("the ended line explains why the assistant left", () => {
    expect(endedLine(endedLeave, clock)).toMatch(/^Ended \d\d:\d\d · the assistant left because no one had spoken for 5 minutes after the scheduled end \(\d\d:\d\d\)$/);
    expect(endedLine({ ...endedLeave, ended: { reason: "host_ended", ended_by: "host", ended_at: null, quiet_since: null } }, clock))
      .toBe("the assistant left because the host ended the meeting");
    expect(headsUpCopy(liveLeave(true), clock)?.detail).toMatch(/^It's been quiet since \d\d:\d\d\.$/);
    expect(headsUpCopy(liveLeave(false), clock)).toBeNull();
    expect(headsUpCopy(capLeave, clock)?.detail).toBe("It reaches the 4-hour limit of the meeting-bot service. Everything captured so far is kept.");
    expect(endedLine({ ...endedLeave, ended: { reason: "bot_lost", ended_by: "auto", ended_at: null, quiet_since: null } }, clock))
      .toBe("the assistant left because the meeting-bot service lost track of the call");
  });
});

test("owners set when the assistant leaves, with a live preview and range checks", async ({ page }) => {
  const calls = await mockApi(page);
  await openSettings(page);
  const card = page.getByRole("region", { name: "When the assistant leaves a call" });
  await expect(card.getByText("It stays for as long as people keep talking")).toBeVisible();
  await expect(card.getByText(/leaves at 11:45, 5 minutes after the last words/)).toBeVisible();
  await expect(card.getByText("The meeting-bot service currently ends any call after 4 hours, so a longer safety limit only applies if that service limit is raised.")).toBeVisible();
  await card.getByLabel("Quiet time after the scheduled end").fill("8");
  await expect(card.getByText(/leaves at 11:48, 8 minutes after the last words/)).toBeVisible();
  await card.getByLabel("Safety limit for one call").fill("20");
  await expect(card.getByRole("alert")).toHaveText("Safety limit for one call must be a whole number from 2 to 12 hours.");
  await expect(card.getByRole("button", { name: "Save leave rules" })).toBeDisabled();
  await card.getByLabel("Safety limit for one call").fill("10");
  await expect(card.getByText(/always leaves after 4 hours in one call/)).toBeVisible();
  await card.getByRole("button", { name: "Save leave rules" }).click();
  await expect(page.getByText(/New calls use these rules/)).toBeVisible();
  expect(calls.saved).toEqual([{ silence_minutes: 10, quiet_after_end_minutes: 8, no_one_joined_minutes: 10, max_hours: 10 }]);
});

test("members read the leave rules but cannot change them", async ({ page }) => {
  await mockApi(page, { role: "member" });
  await openSettings(page);
  const card = page.getByRole("region", { name: "When the assistant leaves a call" });
  await expect(card.getByLabel("Silence before the scheduled end")).toBeDisabled();
  await expect(card.getByText("Only a workspace owner or admin can change these rules.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Save leave rules" })).toHaveCount(0);
});

test("an active meeting shows when the assistant will leave and can keep it in the call", async ({ page }) => {
  const calls = await mockApi(page, { headsUp: true });
  await page.goto("/");
  await nav(page, "Meetings");
  await page.getByRole("button", { name: "Open Weekly delivery sync" }).click();
  await expect(page.getByTestId("auto-leave-line")).toContainText(/Past its .* end, so it leaves after 5 min with no one speaking · no later than .* \(4-hour limit of the meeting-bot service\)/);
  const banner = page.locator(".leave-banner");
  await expect(banner).toContainText(/The assistant will leave at /);
  await expect(banner).toContainText(/It's been quiet since /);
  await banner.getByRole("button", { name: "Keep in call (+30 min)" }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("auto-leave-line")).toContainText("kept in the call until");
  expect(calls.kept).toBe(1);
});

test("near the service limit the heads-up explains it and offers no keep", async ({ page }) => {
  await mockApi(page, { atCap: true });
  await page.goto("/");
  await nav(page, "Meetings");
  await page.getByRole("button", { name: "Open Weekly delivery sync" }).click();
  const banner = page.locator(".leave-banner");
  await expect(banner).toContainText("It reaches the 4-hour limit of the meeting-bot service. Everything captured so far is kept.");
  await expect(banner.getByRole("button", { name: /Keep in call/ })).toHaveCount(0);
  await expect(banner.getByRole("button", { name: "Leave now" })).toBeVisible();
});

test("leave now asks for confirmation before the assistant leaves", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/");
  await nav(page, "Meetings");
  await page.getByRole("button", { name: "Open Weekly delivery sync" }).click();
  await page.getByRole("button", { name: "Leave now" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Make Meetings AI leave the call now?" });
  await dialog.getByRole("button", { name: "Stay in call" }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls.stopped).toBe(0);
  await page.getByRole("button", { name: "Leave now" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Leave now" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(calls.stopped).toBe(1);
});

test("an ended meeting says when and why the assistant left", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await nav(page, "Meetings");
  await page.getByRole("button", { name: "Open Acme roadmap review" }).click();
  await expect(page.locator(".leave-ended")).toContainText(/^Ended .* · the assistant left because no one had spoken for 5 minutes after the scheduled end \(.*\)$/);
});

test("the demo shows the auto-leave line on the live call and a reason on an ended one", async ({ page }) => {
  await page.route("**/v1/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: false } });
    return route.fulfill({ status: 599, json: { detail: "A demo request reached the network." } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Explore the demo" }).click();
  await nav(page, "Meetings");
  await page.getByRole("button", { name: "Open Acme Robotics — weekly delivery sync" }).click();
  await expect(page.getByTestId("auto-leave-line")).toContainText(/Leaves after 10 min of silence \(5 min once the .* end has passed\)/);
  await nav(page, "Meetings");
  await page.getByRole("button", { name: "Open Acme Robotics — Q4 automation roadmap" }).click();
  await expect(page.locator(".leave-ended")).toContainText(/no one had spoken for 5 minutes after the scheduled end/);
});
