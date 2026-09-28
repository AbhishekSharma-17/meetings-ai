import { expect, test, type Page } from "@playwright/test";

/**
 * Personal time zone and clock: the sidebar indicator, its settings popover, and calendar
 * times that re-render in the chosen zone. The browser itself runs in New York.
 */
const workspace = {
  id: "00000000-0000-4000-8000-000000000001", slug: "genai-protos", display_name: "GenAI Protos", contact_email: null,
  status: "active", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", tenant_isolation_enabled: true,
};
const owner = {
  user_id: "00000000-0000-4000-8000-000000000002", organization_id: workspace.id, email: "owner@example.test",
  display_name: "Workspace owner", role: "owner", must_change_password: false,
};
// 20:00 UTC: 4:00 PM on Sep 28 in New York, 1:30 AM on Sep 29 in India.
const lateCall = {
  id: "11111111-1111-4111-8111-111111111111", connection_id: "ca-work", provider: "googlecalendar", event_id: "evt-late",
  title: "Late call with Acme", starts_at: "2026-09-28T20:00:00Z", ends_at: "2026-09-28T20:30:00Z",
  meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet", agenda: null, organizer: null, invitees: [],
  synced_at: "2026-09-28T13:00:00Z",
};

type Prefs = { timezone: string | null; detected: string | null; time_format: "auto" | "12h" | "24h" };

test.use({ timezoneId: "America/New_York", locale: "en-US" });

async function mockApi(page: Page, options: { failSaves?: boolean } = {}) {
  const prefs: Prefs = { timezone: null, detected: null, time_format: "auto" };
  const puts: Array<Record<string, unknown>> = [];
  const syncedZones: string[] = [];
  const payload = () => ({
    timezone: prefs.timezone ?? prefs.detected ?? "UTC", timezone_source: prefs.timezone ? "manual" : "browser",
    detected_timezone: prefs.detected, time_format: prefs.time_format,
  });
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;
    const method = route.request().method();
    if (pathname === "/v1/me/preferences/detected") {
      prefs.detected = route.request().postDataJSON().timezone;
      return route.fulfill({ json: payload() });
    }
    if (pathname === "/v1/me/preferences" && method === "PUT") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      puts.push(body);
      if (options.failSaves) return route.fulfill({ status: 500, json: { detail: "Preferences are temporarily unavailable." } });
      if ("timezone" in body) prefs.timezone = body.timezone as string | null;
      if (typeof body.time_format === "string") prefs.time_format = body.time_format as Prefs["time_format"];
      return route.fulfill({ json: payload() });
    }
    if (pathname === "/v1/me/preferences") return route.fulfill({ json: payload() });
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (pathname === "/v1/auth/me") return route.fulfill({ json: owner });
    if (pathname === "/v1/workspace") return route.fulfill({ json: workspace });
    if (pathname === "/v1/workspaces") return route.fulfill({ json: [{ id: workspace.id, slug: workspace.slug, display_name: workspace.display_name, role: "owner" }] });
    if (pathname === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (pathname === "/v1/provider-profiles" || pathname === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (pathname === "/v1/calendar/connections") return route.fulfill({ json: [{ id: "ca-work", provider: "googlecalendar", status: "ACTIVE", label: "work@example.test" }] });
    if (pathname === "/v1/calendar/schedules") return route.fulfill({ json: [] });
    if (pathname === "/v1/calendar/synced") {
      syncedZones.push(url.searchParams.get("timezone") ?? "");
      return route.fulfill({ json: { events: [lateCall], syncs: [{ connection_id: "ca-work", last_synced_at: "2026-09-28T13:58:00Z", range_start: "2026-08-01T00:00:00Z", range_end: "2026-11-01T00:00:00Z", truncated: false }] } });
    }
    if (pathname === "/v1/calendar/sync") return route.fulfill({ json: { events: [lateCall], syncs: [], errors: {} } });
    if (pathname.startsWith("/v1/notifications")) return route.fulfill({ json: pathname.endsWith("unread-count") ? { unread_count: 0 } : { items: [], next_cursor: null, unread_count: 0 } });
    return route.fulfill({ status: 404, json: { detail: "test route not mocked" } });
  });
  return { puts, syncedZones, prefs };
}

const sidebar = (page: Page) => page.locator(".desktop-sidebar");
const indicator = (page: Page) => sidebar(page).getByRole("button", { name: /^Time zone:/ });

async function openCalendarDay(page: Page, day: RegExp) {
  await page.getByRole("button", { name: day }).click();
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-28T14:00:00Z"));
});

test("sidebar clock follows the browser zone and a picked zone re-renders calendar times", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/");
  await expect(indicator(page)).toContainText("10:00 AM");
  await expect(indicator(page)).toContainText("EDT (New York)");

  await sidebar(page).getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  const agenda = page.getByRole("region", { name: /Monday, September 28/ });
  await expect(agenda.getByRole("button", { name: /Late call with Acme/ })).toContainText("4:00 PM");
  expect(api.syncedZones.at(-1)).toBe("America/New_York");

  await indicator(page).click();
  const popover = page.getByRole("dialog", { name: "Time zone & clock" });
  await expect(popover.getByRole("switch", { name: "Use my browser's time zone" })).toBeChecked();
  await popover.getByRole("combobox", { name: "Search time zones" }).fill("kolkata");
  await popover.getByRole("option", { name: /Kolkata/ }).click();
  await expect.poll(() => api.puts.at(-1)).toEqual({ timezone: "Asia/Kolkata" });
  await expect(indicator(page)).toContainText("7:30 PM");
  await expect(indicator(page)).toContainText("IST (Kolkata)");
  await expect(popover.getByRole("switch", { name: "Use my browser's time zone" })).not.toBeChecked();
  await expect(popover.getByRole("note")).toContainText("Your browser is in EDT (New York)");
  await page.keyboard.press("Escape");

  // In India the call starts after midnight, so it moves to the next day.
  await expect.poll(() => api.syncedZones.at(-1)).toBe("Asia/Kolkata");
  await expect(page.getByRole("region", { name: /Monday, September 28/ })).toContainText("No meetings on this day");
  await openCalendarDay(page, /^Tue Sep 29 2026, 1 meetings/);
  const nextDay = page.getByRole("region", { name: /Tuesday, September 29/ });
  await expect(nextDay.getByRole("button", { name: /Late call with Acme/ })).toContainText("1:30 AM");

  await indicator(page).click();
  await popover.getByRole("button", { name: "24-hour" }).click();
  await expect.poll(() => api.puts.at(-1)).toEqual({ time_format: "24h" });
  await expect(indicator(page)).toContainText("19:30");
  await expect(nextDay.getByRole("button", { name: /Late call with Acme/ })).toContainText("01:30");

  await popover.getByRole("button", { name: "Switch to it" }).click();
  await expect.poll(() => api.puts.at(-1)).toEqual({ timezone: null });
  await expect(indicator(page)).toContainText("10:00");
  await expect(indicator(page)).toContainText("EDT (New York)");
});

test("a failed save rolls the choice back and explains what happened", async ({ page }) => {
  const api = await mockApi(page, { failSaves: true });
  await page.goto("/");
  await expect(indicator(page)).toContainText("10:00 AM");
  await indicator(page).click();
  const popover = page.getByRole("dialog", { name: "Time zone & clock" });
  await popover.getByRole("button", { name: "24-hour" }).click();
  await expect(popover.getByRole("alert")).toContainText("Could not save your clock format.");
  await expect.poll(() => api.puts.length).toBe(1);
  await expect(indicator(page)).toContainText("10:00 AM");
  await expect(popover.getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
});

test("the zone list is searchable by abbreviation and offset and works from the keyboard", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/");
  await indicator(page).click();
  const popover = page.getByRole("dialog", { name: "Time zone & clock" });
  const search = popover.getByRole("combobox", { name: "Search time zones" });
  await search.fill("+5:45");
  await expect(popover.getByRole("option")).toHaveCount(1);
  await expect(popover.getByRole("option")).toContainText("Kathmandu");
  await search.fill("tokyo");
  await search.press("Enter");
  await expect.poll(() => api.puts.at(-1)).toEqual({ timezone: "Asia/Tokyo" });
  await expect(indicator(page)).toContainText("11:00 PM");
  await search.fill("no such place");
  await expect(popover.getByRole("status").filter({ hasText: "No time zone matches" })).toBeVisible();
});

test("a previous person's time zone is never kept for the next person on a shared browser", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("meetings-ai:time-preferences",
      JSON.stringify({ owner: "someone-else", manualTimeZone: "Asia/Kolkata", timeFormat: "24h" }));
  });
  await mockApi(page);
  await page.route("**/v1/auth/logout", (route) => route.fulfill({ status: 204, body: "" }));
  await page.goto("/");
  await expect(indicator(page)).toContainText("10:00 AM");
  await expect(indicator(page)).toContainText("EDT (New York)");
  const cached = () => page.evaluate(() => localStorage.getItem("meetings-ai:time-preferences"));
  await expect.poll(async () => JSON.parse((await cached()) ?? "{}").owner).toBe(owner.user_id);

  await sidebar(page).locator(".profile-trigger").click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(cached).toBeNull();
});
