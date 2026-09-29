import { expect, test, type Page, type Route } from "@playwright/test";

/** A rescheduled calendar event is visible everywhere it matters: library, meeting record, calendar, notifications. */
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const MEETING = "00000000-0000-4000-8000-000000000510";
const EVENT = "00000000-0000-4000-8000-000000000511";
const stamp = new Date(Date.now() - 60 * 60_000).toISOString();

function at(dayOffset: number, hour: number): string {
  const date = new Date(); date.setDate(date.getDate() + dayOffset); date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}
const newStart = at(1, 17);
const oldStart = at(1, 15);
const plusHour = (iso: string) => new Date(new Date(iso).getTime() + 3_600_000).toISOString();

const meeting = {
  id: MEETING, title: "Acme pilot review", meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet", status: "created",
  bot_name: "Meetings AI", created_at: stamp, updated_at: stamp, joined_at: null, stopped_at: null, tags: [], knowledge_enabled: false, knowledge_base_id: null,
};
const schedule = {
  meeting_id: MEETING, connection_id: "ca-work", event_id: "evt-1", provider: "googlecalendar", starts_at: newStart, ends_at: plusHour(newStart),
  status: "pending", last_error: null, rescheduled_from: oldStart, last_checked_at: new Date(Date.now() - 2 * 60_000).toISOString(),
};
const calendarEvent = {
  id: EVENT, synced_at: stamp, connection_id: "ca-work", provider: "googlecalendar", event_id: "evt-1", title: "Acme pilot review",
  starts_at: newStart, ends_at: plusHour(newStart), meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet",
  agenda: "Pilot scope", organizer: "Host", invitees: [{ name: "Asha Patel", email: "asha@acme.example", response_status: "accepted" }], rescheduled_from: oldStart,
};
const moved = {
  id: "00000000-0000-4000-8000-000000000520", kind: "moved", provider: "googlecalendar", source: "watcher",
  detected_at: new Date(Date.now() - 30 * 60_000).toISOString(), old_starts_at: oldStart, new_starts_at: newStart,
  old_ends_at: plusHour(oldStart), new_ends_at: plusHour(newStart), old_meeting_url: null, new_meeting_url: null, meeting_id: MEETING, cache_event_id: EVENT,
};
const history = (count: number) => ({
  items: Array.from({ length: count }, (_, index) => index === 0 ? moved : {
    ...moved, id: `00000000-0000-4000-8000-00000000053${index}`, kind: index % 2 ? "link_changed" : "moved",
    new_meeting_url: index % 2 ? `https://zoom.us/j/1234567890${index}` : null,
    detected_at: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
  }),
  provider: "googlecalendar", last_checked_at: schedule.last_checked_at,
});
const notification = {
  id: "00000000-0000-4000-8000-000000000540", kind: "calendar.event_moved", severity: "info",
  title: "“Acme pilot review” moved to Tue, Sep 30, 5:00 PM IST", body: "Was Tue 3:00 PM IST. The assistant will join at the new time.",
  link_view: "meeting", link_id: MEETING, meeting_id: MEETING, created_at: new Date(Date.now() - 60_000).toISOString(), read_at: null,
};

function fixtures(pathname: string, changes: number): unknown {
  const map: Record<string, unknown> = {
    "/v1/auth/session": { authenticated: true },
    "/v1/auth/me": { user_id: USER, organization_id: ORG, email: "owner@example.test", display_name: "Workspace owner", role: "owner", must_change_password: false },
    "/v1/workspace": { id: ORG, slug: "example", display_name: "Example", contact_email: null, status: "active", created_at: stamp, updated_at: stamp, tenant_isolation_enabled: true },
    "/v1/workspaces": [{ id: ORG, slug: "example", display_name: "Example", role: "owner", is_default: false }],
    "/v1/meetings": { items: [meeting], count: 1 },
    [`/v1/meetings/${MEETING}`]: meeting,
    [`/v1/meetings/${MEETING}/transcript`]: { segments: [] },
    [`/v1/meetings/${MEETING}/source`]: { ...calendarEvent, id: undefined, synced_at: undefined },
    [`/v1/meetings/${MEETING}/participants`]: { participants: [] },
    [`/v1/meetings/${MEETING}/schedule/changes`]: history(changes),
    [`/v1/calendar/events/${EVENT}/changes`]: history(1),
    "/v1/calendar/schedules": [schedule],
    [`/v1/calendar/schedules/${MEETING}`]: schedule,
    "/v1/calendar/connections": [{ id: "ca-work", provider: "googlecalendar", status: "ACTIVE", label: "Work" }],
    "/v1/calendar/synced": { events: [calendarEvent], syncs: [{ connection_id: "ca-work", last_synced_at: stamp, range_start: at(-30, 0), range_end: at(60, 0), truncated: false }] },
    "/v1/notifications/unread-count": { unread_count: 1 },
    "/v1/notifications": { items: [notification], next_cursor: null, unread_count: 1 },
  };
  if (pathname in map) return map[pathname];
  if (pathname === "/v1/provider-profiles" || pathname === "/v1/provider-defaults" || pathname === "/v1/background-jobs" || pathname === "/v1/teams"
    || pathname === "/v1/knowledge-bases" || pathname === "/v1/documents" || pathname.endsWith("/speakers")) return [];
  return undefined;
}

async function mockApi(page: Page, changes = 1) {
  await page.route("**/v1/**", (route: Route) => {
    const pathname = new URL(route.request().url()).pathname;
    const json = fixtures(pathname, changes);
    return json === undefined ? route.fulfill({ status: 404, json: { detail: "not mocked" } }) : route.fulfill({ json });
  });
}

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name, exact: true }).click();

test("a rescheduled join shows its chip, where it moved from, the last check and the history", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await nav(page, "Meetings");
  const row = page.getByRole("button", { name: "Open Acme pilot review" });
  await expect(row.getByText("Rescheduled")).toBeVisible();
  await row.click();

  const alert = page.getByRole("status").filter({ hasText: "Calendar assistant · pending" });
  await expect(alert.getByText("Rescheduled")).toBeVisible();
  await expect(alert.getByText(/^Moved from /)).toBeVisible();
  await expect(alert.getByText("Last checked with Google Calendar 2 min ago")).toBeVisible();
  const card = page.getByRole("region", { name: /Calendar changes/ });
  await expect(card.getByText(/^Moved to /)).toBeVisible();
  await expect(card.getByText(/^Was .* · noticed 30 min ago$/)).toBeVisible();
});

test("a long change history can be searched", async ({ page }) => {
  await mockApi(page, 7);
  await page.goto("/");
  await nav(page, "Meetings");
  await page.getByRole("button", { name: "Open Acme pilot review" }).click();
  const card = page.getByRole("region", { name: /Calendar changes/ });
  await expect(card.locator(".change-row")).toHaveCount(7);
  await card.getByRole("searchbox", { name: "Search calendar changes" }).fill("zoom.us");
  await expect(card.locator(".change-row")).toHaveCount(3);
  await card.getByRole("searchbox", { name: "Search calendar changes" }).fill("nothing like this");
  await expect(card.getByText("No changes match “nothing like this”")).toBeVisible();
});

test("the calendar event panel marks the move and the notification opens the meeting", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await nav(page, "Calendar");
  // The event is tomorrow: jump to it from "Other meetings in range", then open it from the day agenda.
  await page.locator(".calendar-other-events").getByRole("button", { name: /Acme pilot review/ }).click();
  await expect(page.locator(".calendar-agenda-event").filter({ hasText: "Acme pilot review" }).getByText("Rescheduled")).toBeVisible();
  const detail = page.getByRole("complementary", { name: "Meeting details" });
  await expect(detail.getByText("Rescheduled")).toBeVisible();
  await expect(detail.getByText(/^Moved from /)).toBeVisible();
  await expect(detail.getByRole("heading", { name: /Calendar changes/ })).toBeVisible();

  await page.getByRole("button", { name: /^Notifications/ }).click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  await expect(panel.getByText("“Acme pilot review” moved to Tue, Sep 30, 5:00 PM IST")).toBeVisible();
  await panel.getByRole("button", { name: /^“Acme pilot review” moved to/ }).click();
  await expect(page.getByRole("heading", { name: "Acme pilot review", level: 1 })).toBeVisible();
});

test("the demo workspace shows a rescheduled meeting and its notification without any network call", async ({ page }) => {
  const leaks: string[] = [];
  let allowSessionCheck = true;
  await page.route("**/v1/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (allowSessionCheck && pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: false } });
    leaks.push(pathname);
    return route.fulfill({ status: 599, json: { detail: "A demo request reached the network." } });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  allowSessionCheck = false;
  await page.getByRole("button", { name: "Explore the demo" }).click();
  await nav(page, "Meetings");
  const row = page.getByRole("button", { name: "Open Initech — pilot scoping workshop" });
  await expect(row.getByText("Rescheduled")).toBeVisible();
  await row.click();
  await expect(page.getByRole("status").filter({ hasText: "Calendar assistant · pending" }).getByText(/^Moved from /)).toBeVisible();
  await expect(page.getByRole("region", { name: /Calendar changes/ }).getByText(/^Moved to /)).toBeVisible();

  await page.getByRole("button", { name: /^Notifications/ }).click();
  await expect(page.getByRole("dialog", { name: "Notifications" }).getByText(/“Initech — pilot scoping workshop” moved to/)).toBeVisible();
  expect(leaks).toEqual([]);
});
