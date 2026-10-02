import { expect, test } from "@playwright/test";
import { hasRunningCapture, meetingDuration, type CaptureTiming } from "../../src/lib/meeting-duration";

const start = "2026-10-02T10:00:00Z";
const now = Date.parse("2026-10-02T11:15:19Z");
const finished: CaptureTiming = { joinedAt: start, stoppedAt: "2026-10-02T10:55:41Z", status: "ready" };

test("saved capture timestamps supply completed duration, independent of the current date", () => {
  expect(meetingDuration(finished, now)).toBe("55 min");
  expect(meetingDuration(finished, now + 86_400_000)).toBe("55 min");
  expect(hasRunningCapture(finished)).toBe(false);
});

for (const status of ["live", "needs_attention", "stopping"] as const) {
  test(`${status} uses elapsed capture time until a stop timestamp arrives`, () => {
    const timing = { joinedAt: start, stoppedAt: null, status };
    expect(hasRunningCapture(timing)).toBe(true);
    expect(meetingDuration(timing, now)).toBe("1 hr 15 min");
    expect(meetingDuration(timing, now + 60_000)).toBe("1 hr 16 min");
    expect(meetingDuration({ ...timing, stoppedAt: finished.stoppedAt }, now)).toBe("55 min");
  });
}

for (const status of ["created", "joining", "waiting_room", "processing", "ready", "stopped", "failed"] as const) {
  test(`${status} without a recorded end does not invent a duration`, () => {
    expect(meetingDuration({ joinedAt: start, stoppedAt: null, status }, now)).toBeNull();
    expect(hasRunningCapture({ joinedAt: start, stoppedAt: null, status })).toBe(false);
  });
}

test("never-joined or invalid captures stay unknown rather than displaying a misleading zero", () => {
  expect(meetingDuration({ joinedAt: null, stoppedAt: null, status: "live" }, now)).toBeNull();
  expect(meetingDuration({ ...finished, joinedAt: "invalid" }, now)).toBeNull();
  expect(meetingDuration({ ...finished, stoppedAt: "invalid" }, now)).toBeNull();
  expect(meetingDuration({ ...finished, stoppedAt: "2026-10-02T09:59:59Z" }, now)).toBeNull();
  expect(meetingDuration({ joinedAt: start, status: "live" }, Date.parse(start) - 1000)).toBeNull();
});

test("short captures, hour boundaries and time-zone offsets have readable durations", () => {
  expect(meetingDuration({ ...finished, stoppedAt: start })).toBe("0 sec");
  expect(meetingDuration({ ...finished, stoppedAt: "2026-10-02T10:00:59Z" })).toBe("59 sec");
  expect(meetingDuration({ ...finished, stoppedAt: "2026-10-02T10:01:00Z" })).toBe("1 min");
  expect(meetingDuration({ ...finished, stoppedAt: "2026-10-02T11:00:00Z" })).toBe("1 hr");
  expect(meetingDuration({ ...finished, joinedAt: "2026-10-02T15:30:00+05:30" })).toBe("55 min");
});

test("live overview and library clocks advance, and details freeze once capture stops", async ({ page }) => {
  const id = "00000000-0000-4000-8000-000000000099";
  let stopped = false;
  const capture = () => ({ id, title: "Duration regression", platform: "google_meet", bot_name: "Meetings AI",
    meeting_url: "https://meet.google.com/abc-defg-hij", status: stopped ? "completed" : "active",
    created_at: "2026-10-02T09:00:00Z", updated_at: start, joined_at: start,
    stopped_at: stopped ? "2026-10-02T11:17:00Z" : null, tags: [], knowledge_enabled: false, knowledge_base_id: null });
  await page.clock.install({ time: new Date(now) });
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (path === "/v1/auth/me") return route.fulfill({ json: {
      user_id: "00000000-0000-4000-8000-000000000002", organization_id: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test", display_name: "Owner", role: "owner", must_change_password: false,
    } });
    if (path === "/v1/workspace") return route.fulfill({ json: {
      id: "00000000-0000-4000-8000-000000000001", display_name: "Duration workspace", status: "active", created_at: start, updated_at: start,
    } });
    if (path === "/v1/meetings") return route.fulfill({ json: { items: [capture()], count: 1 } });
    if (path === `/v1/meetings/${id}` || path === `/v1/meetings/${id}/refresh`) return route.fulfill({ json: capture() });
    if (path === `/v1/meetings/${id}/transcript`) return route.fulfill({ json: { status: capture().status, segments: [] } });
    if (["/v1/knowledge-bases", "/v1/provider-profiles", "/v1/provider-defaults", "/v1/calendar/schedules"].includes(path)) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "not needed in this UI test" } });
  });
  await page.goto("/");
  const open = page.getByRole("button", { name: "Open Duration regression" });
  await expect(open.locator(".dashboard-meeting-duration")).toHaveText("1 hr 15 min");
  await page.clock.fastForward(61_000);
  await expect(open.locator(".dashboard-meeting-duration")).toHaveText("1 hr 16 min");
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await expect(open.locator(".library-row-duration")).toHaveText("1 hr 16 min");
  await page.clock.fastForward(61_000);
  await expect(open.locator(".library-row-duration")).toHaveText("1 hr 17 min");
  stopped = true;
  await open.click();
  const duration = page.locator(".meta-list div").filter({ has: page.locator("dt", { hasText: /^Duration$/ }) }).locator("dd");
  await expect(duration).toHaveText("1 hr 17 min");
  await page.clock.fastForward(3_600_000);
  await expect(duration).toHaveText("1 hr 17 min");
});
