import { expect, test } from "@playwright/test";

const originalWorkspace = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "genai-protos",
  display_name: "GenAI Protos",
  contact_email: null,
  status: "active",
  created_at: "2026-09-25T00:00:00Z",
  updated_at: "2026-09-25T00:00:00Z",
  tenant_isolation_enabled: true,
};
const owner = {
  user_id: "00000000-0000-4000-8000-000000000002",
  organization_id: originalWorkspace.id,
  email: "owner@example.test",
  display_name: "Workspace owner",
  role: "owner",
  must_change_password: false,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (pathname === "/v1/auth/me") return route.fulfill({ json: owner });
    if (pathname === "/v1/workspace") return route.fulfill({ json: originalWorkspace });
    if (pathname === "/v1/workspaces") return route.fulfill({ json: [{ id: originalWorkspace.id, slug: originalWorkspace.slug, display_name: originalWorkspace.display_name, role: "owner" }] });
    if (pathname === "/v1/workspace/members") return route.fulfill({ json: [{ ...owner, status: "active" }] });
    if (pathname === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (pathname === "/v1/provider-profiles" || pathname === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (pathname === "/v1/calendar/connections") return route.fulfill({ json: [{ id: "outlook-account", provider: "outlook", status: "ACTIVE", label: "Outlook" }] });
    if (pathname === "/v1/calendar/schedules") return route.fulfill({ json: [] });
    if (pathname === "/v1/calendar/synced") return route.fulfill({ json: { events: [], syncs: [] } });
    if (pathname === "/v1/calendar/sync") return route.fulfill({ json: { events: [], syncs: [], errors: {} } });
    if (pathname === "/v1/knowledge/text-profiles") return route.fulfill({ json: [] });
    if (pathname === "/v1/workspace/brief") return route.fulfill({ json: { website: null, overview: "", services: [], products: [], differentiators: "", positioning: "", updated_at: null } });
    if (pathname === "/v1/workspace/brief/documents") return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "test route not mocked" } });
  });
});

test("calendar shows provider status and normalizes browser time zone", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      return { ...original.call(this), timeZone: "Asia/Calcutta" };
    };
  });
  let syncedTimezone: string | null = null;
  await page.route("**/v1/calendar/sync", async (route) => {
    syncedTimezone = route.request().postDataJSON().timezone;
    await route.fulfill({ json: { events: [], syncs: [], errors: {} } });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Integrations/ }).click();
  await expect(page.getByRole("heading", { name: "Connected meeting sources" })).toBeVisible();
  await expect(page.getByText("Outlook Calendar", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Google Calendar", { exact: true })).toBeVisible();
  await expect(page.getByText("Calendly", { exact: true })).toBeVisible();
  await expect(page.getByText("Zoom", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect.poll(() => syncedTimezone).toBe("Asia/Kolkata");
});

test("multiple calendar accounts stay distinct and the selected account is scanned", async ({ page }) => {
  let scannedAccount: string | null = null;
  await page.route("**/v1/calendar/connections", (route) => route.fulfill({ json: [
    { id: "ca-work", provider: "googlecalendar", status: "ACTIVE", label: "work@example.test" },
    { id: "ca-personal", provider: "googlecalendar", status: "ACTIVE", label: "Personal calendar" },
    { id: "ca-outlook", provider: "outlook", status: "ACTIVE", label: "outlook@example.test" },
  ] }));
  await page.route("**/v1/calendar/sync", async (route) => {
    scannedAccount = route.request().postDataJSON().connection_ids[0];
    await route.fulfill({ json: { events: [], syncs: [], errors: {} } });
  });
  await page.goto("/?calendar=connected&status=success&connected_account_id=ca-personal");
  await page.getByRole("tab", { name: /Integrations/ }).click();
  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
  await expect(page.getByText("work@example.test")).toBeVisible();
  await expect(page.getByText("Personal calendar", { exact: true })).toBeVisible();
  await expect(page.getByText("outlook@example.test")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add another Google Calendar account" })).toBeVisible();
  await page.getByRole("tab", { name: "Calendar", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Account" })).toContainText("Personal calendar");
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect.poll(() => scannedAccount).toBe("ca-personal");
});

test("a later account choice survives navigation and reload after an OAuth callback", async ({ page }) => {
  await page.route("**/v1/calendar/connections", (route) => route.fulfill({ json: [
    { id: "ca-work", provider: "googlecalendar", status: "ACTIVE", label: "Work calendar" },
    { id: "ca-personal", provider: "googlecalendar", status: "ACTIVE", label: "Personal calendar" },
  ] }));
  await page.goto("/?calendar=connected&status=success&connected_account_id=ca-personal");
  const account = page.getByRole("combobox", { name: "Account" });
  await expect(account).toContainText("Personal calendar");
  await account.click();
  await page.getByRole("option", { name: /Work calendar/ }).click();
  await expect(account).toContainText("Work calendar");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meetings" }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByRole("combobox", { name: "Account" })).toContainText("Work calendar");
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("meetings-ai:active-view:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002") ?? "null"))).toBe("calendar");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Account" })).toContainText("Work calendar");
});

test("disconnect confirms one account and leaves the other integration connected", async ({ page }) => {
  let removed: string | null = null;
  await page.route("**/v1/calendar/connections**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "DELETE") {
      removed = path;
      return route.fulfill({ json: { cancelled: 0, kept: 0 } });
    }
    return route.fulfill({ json: [
      ...(removed ? [] : [{ id: "ca-work", provider: "googlecalendar", status: "ACTIVE", label: "work@example.test" }]),
      { id: "ca-personal", provider: "outlook", status: "ACTIVE", label: "personal@example.test" },
    ] });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("tab", { name: /Integrations/ }).click();
  await page.locator(".calendar-account-row", { hasText: "work@example.test" }).getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("Saved meetings and briefings remain.", { exact: false })).toBeVisible();
  expect(removed).toBeNull();
  await page.locator(".calendar-account-row", { hasText: "work@example.test" }).getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => removed).toBe("/v1/calendar/connections/ca-work");
  await expect(page.getByText("work@example.test")).toHaveCount(0);
  await expect(page.getByText("personal@example.test")).toBeVisible();
});

test("disconnect asks what happens to scheduled assistants and warns about a personal Microsoft account", async ({ page }) => {
  let removed: string | null = null;
  await page.route("**/v1/calendar/connections**", (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "DELETE") {
      removed = `${url.pathname}${url.search}`;
      return route.fulfill({ json: { cancelled: 2, kept: 0 } });
    }
    return route.fulfill({ json: [
      ...(removed ? [] : [{ id: "ca-work", provider: "googlecalendar", status: "ACTIVE", label: "work@example.test", meetings_found: 4, scheduled: 2, last_synced_at: "2026-09-30T08:00:00Z" }]),
      { id: "ca-personal", provider: "outlook", status: "ACTIVE", label: "personal@example.test", account_type: "personal", meetings_found: 0, scheduled: 0 },
    ] });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("tab", { name: /Integrations/ }).click();
  const work = page.locator(".calendar-account-row", { hasText: "work@example.test" });
  await expect(work).toContainText("4 meetings found · 2 assistants scheduled");
  await expect(page.locator(".calendar-account-row", { hasText: "personal@example.test" })).toContainText("This is a personal Microsoft account");
  await work.getByRole("button", { name: "Disconnect" }).click();
  await expect(work).toContainText("2 assistants are scheduled from it.");
  await expect(work.getByRole("button", { name: "Keep assistants" })).toBeVisible();
  await work.getByRole("button", { name: "Cancel 2 assistants" }).click();
  await expect.poll(() => removed).toBe("/v1/calendar/connections/ca-work?scheduled=cancel");
  await expect(page.getByText("2 scheduled assistants were cancelled.", { exact: false })).toBeVisible();
});

test("calendar connections can be named when added and renamed later", async ({ page }) => {
  let alias = "Original name";
  let requestedAlias: string | null = null;
  await page.route("**/v1/calendar/connections**", (route) => {
    if (route.request().method() === "PATCH") {
      alias = route.request().postDataJSON().alias;
      return route.fulfill({ json: { id: "ca-work", provider: "googlecalendar", status: "ACTIVE", label: alias, identity: "work@example.test" } });
    }
    return route.fulfill({ json: [{ id: "ca-work", provider: "googlecalendar", status: "ACTIVE", label: alias, identity: "work@example.test" }] });
  });
  await page.route("**/v1/calendar/connect/googlecalendar", (route) => {
    requestedAlias = route.request().postDataJSON().alias;
    return route.fulfill({ json: { redirect_url: "https://connect.example.test/auth" } });
  });
  await page.route("https://connect.example.test/auth", (route) => route.fulfill({ body: "Connection started" }));
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("tab", { name: /Integrations/ }).click();
  const account = page.locator(".calendar-account-row", { hasText: "work@example.test" });
  await expect(account.getByText("Original name")).toBeVisible();
  await account.getByRole("button", { name: "Rename" }).click();
  await account.getByRole("textbox", { name: "Connection name" }).fill("Client A");
  await account.getByRole("button", { name: "Save" }).click();
  await expect(account.getByText("Client A")).toBeVisible();
  await expect(account.getByText(/work@example.test/)).toBeVisible();
  await page.getByRole("button", { name: "Add another Google Calendar account" }).click();
  await expect(page.getByText("Name this Google Calendar connection")).toBeVisible();
  await page.getByRole("textbox", { name: "Connection name" }).fill("Personal");
  await page.getByRole("button", { name: "Continue to provider" }).click();
  await expect.poll(() => requestedAlias).toBe("Personal");
});

test("saved calendar range and meetings survive a hard reload without another manual sync", async ({ page }) => {
  const today = new Date();
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const startKey = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;
  const meetingStart = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 12, 12);
  const meetingDay = `${startKey.slice(0, 8)}12`;
  let syncCalls = 0;
  await page.route("**/v1/calendar/synced?**", (route) => {
    // Any window that contains the meeting's day (a month grid may start in the previous month).
    const params = new URL(route.request().url()).searchParams;
    const from = params.get("start_date") ?? "", to = params.get("end_date") ?? from;
    const inWindow = from <= meetingDay && meetingDay <= to;  // this month's grid never reaches the 12th of next month
    return route.fulfill({ json: { events: inWindow ? [{
      id: "00000000-0000-4000-8000-000000000088", synced_at: new Date().toISOString(),
      connection_id: "outlook-account", provider: "outlook", event_id: "saved-event", title: "Saved client meeting",
      starts_at: meetingStart.toISOString(), ends_at: new Date(meetingStart.getTime() + 3600_000).toISOString(),
      meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet", invitees: [],
    }] : [], syncs: [] } });
  });
  await page.route("**/v1/calendar/sync", (route) => { syncCalls += 1; return route.fulfill({ json: { events: [], syncs: [] } }); });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(page.locator(".calendar-month-nav h2")).toHaveText(nextMonth.toLocaleString("en-US", { month: "long", year: "numeric" }));
  await expect(page.getByText("Saved client meeting").first()).toBeVisible();
  await page.locator(".calendar-other-events button", { hasText: "Saved client meeting" }).click();
  await expect(page.locator(".calendar-event-detail h2")).toHaveText("Saved client meeting");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("meetings-ai:calendar-view:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002") ?? "null")?.selectedEventId)).toBe("00000000-0000-4000-8000-000000000088");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
  await expect(page.locator(".calendar-month-nav h2")).toHaveText(nextMonth.toLocaleString("en-US", { month: "long", year: "numeric" }));
  await expect(page.getByText("Saved client meeting").first()).toBeVisible();
  await expect(page.locator(".calendar-event-detail h2")).toHaveText("Saved client meeting");
  expect(syncCalls).toBe(0);
});

test("stale saved meetings appear immediately and update automatically after reload", async ({ page }) => {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  const end = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const meetingStart = new Date(today.getFullYear(), today.getMonth(), Math.min(today.getDate(), 25), 12);
  const baseEvent = {
    id: "00000000-0000-4000-8000-000000000089", synced_at: new Date(Date.now() - 600_000).toISOString(),
    connection_id: "outlook-account", provider: "outlook", event_id: "refreshed-event",
    starts_at: meetingStart.toISOString(), ends_at: new Date(meetingStart.getTime() + 3600_000).toISOString(),
    meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet", invitees: [],
  };
  const oldState = { connection_id: "outlook-account", last_synced_at: new Date(Date.now() - 600_000).toISOString(), range_start: start.toISOString(), range_end: end.toISOString(), truncated: false };
  let syncCalls = 0;
  await page.route("**/v1/calendar/synced?**", (route) => route.fulfill({ json: { events: [{ ...baseEvent, title: "Saved agenda" }], syncs: [oldState] } }));
  await page.route("**/v1/calendar/sync", async (route) => {
    syncCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return route.fulfill({ json: { events: [{ ...baseEvent, title: "Updated agenda", synced_at: new Date().toISOString() }], syncs: [{ ...oldState, last_synced_at: new Date().toISOString() }], errors: {} } });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByText("Saved agenda").first()).toBeVisible();
  await expect(page.getByText("Updated agenda").first()).toBeVisible();
  expect(syncCalls).toBe(1);
});

test("a failed automatic refresh leaves saved calendar meetings visible", async ({ page }) => {
  const today = new Date();
  const starts = new Date(today.getFullYear(), today.getMonth(), Math.min(today.getDate(), 25), 12);
  await page.route("**/v1/calendar/synced?**", (route) => route.fulfill({ json: {
    events: [{
      id: "00000000-0000-4000-8000-000000000090", synced_at: new Date(Date.now() - 600_000).toISOString(),
      connection_id: "outlook-account", provider: "outlook", event_id: "kept-event", title: "Meeting kept after error",
      starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + 3600_000).toISOString(),
      meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet", invitees: [],
    }],
    syncs: [{ connection_id: "outlook-account", last_synced_at: new Date(Date.now() - 600_000).toISOString(),
      range_start: new Date(today.getFullYear(), today.getMonth(), 1).toISOString(),
      range_end: new Date(today.getFullYear(), today.getMonth() + 1, 1).toISOString(), truncated: false }],
  } }));
  await page.route("**/v1/calendar/sync", (route) => route.fulfill({ status: 503, json: { detail: "Calendar source unavailable" } }));
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByText("Meeting kept after error").first()).toBeVisible();
  await expect(page.locator(".calendar-workspace .form-error[role='alert']")).toContainText("Saved meetings are still available");
  await expect(page.getByText("Meeting kept after error").first()).toBeVisible();
});

test("source discovery shows agenda and invitees before scheduling", async ({ page }) => {
  const startsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  await page.route("**/v1/calendar/synced?**", (route) => route.fulfill({ json: { events: [{
    id: "00000000-0000-4000-8000-000000000077", synced_at: startsAt,
    connection_id: "outlook-account", provider: "outlook", event_id: "event-42", title: "Client discovery",
    starts_at: startsAt, ends_at: endsAt, meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet",
    agenda: "Review rollout and owners", organizer: "host@example.test",
    invitees: [{ name: "Asha", email: "asha@example.test", response_status: "accepted" }],
  }], syncs: [] } }));
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("button", { name: /1 meetings/ }).first().click();
  await page.locator(".calendar-agenda-event").click();
  await expect(page.getByText("Review rollout and owners")).toBeVisible();
  await expect(page.getByText("host@example.test")).toBeVisible();
  await expect(page.getByText("asha@example.test")).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare for meeting" })).toBeVisible();
});

test("meeting prep accepts context and shows a cited saved briefing", async ({ page }) => {
  const startsAt = new Date(); startsAt.setHours(12, 0, 0, 0);
  const eventId = "00000000-0000-4000-8000-000000000077";
  let prepInput: Record<string, unknown> | null = null;
  await page.route("**/v1/calendar/synced?**", (route) => route.fulfill({ json: { events: [{
    id: eventId, synced_at: startsAt.toISOString(), connection_id: "outlook-account",
    provider: "outlook", event_id: "client-brief", title: "Acme discovery",
    starts_at: startsAt.toISOString(), ends_at: new Date(startsAt.getTime() + 3600_000).toISOString(),
    meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet",
    agenda: "Discuss partnership", organizer: "Host", invitees: [{ name: "Asha", email: "asha@acme.example" }],
  }], syncs: [] } }));
  await page.route(`**/v1/calendar/events/${eventId}/prep`, (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: null });
    prepInput = route.request().postDataJSON();
    return route.fulfill({ json: {
      id: "00000000-0000-4000-8000-000000000078", calendar_event_id: eventId,
      target_company: "Acme", executive_brief: "A focused discovery conversation.",
      findings: [{ statement: "Acme builds widgets.", source_ids: ["S1"] }],
      relevant_offerings: ["Meeting intelligence"], talking_points: ["Ask about priorities"],
      questions_to_ask: ["What is the timeline?"], watchouts: [], people_notes: [],
      sources: [{ id: "S1", title: "About Acme", url: "https://acme.example/about" }],
      public_research_performed: true, generated_at: new Date().toISOString(), provider: "openai", model: "gpt-test",
    } });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("button", { name: /1 meetings/ }).first().click();
  await page.locator(".calendar-agenda-event").click();
  await page.getByRole("button", { name: "Prepare for meeting" }).click();
  await expect(page.getByRole("heading", { name: "Meeting prep" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meeting prep" })).toHaveAttribute("aria-current", "page");
  await page.getByLabel("Target company").fill("Acme");
  await page.getByLabel("What you already know or want to learn").fill("Explore implementation constraints");
  await page.getByRole("button", { name: "Generate briefing" }).click();
  await expect(page.getByText("A focused discovery conversation.")).toBeVisible();
  await expect(page.getByText("Acme builds widgets.")).toBeVisible();
  await expect(page.getByRole("link", { name: /About Acme/ })).toHaveAttribute("href", "https://acme.example/about");
  expect(prepInput).toMatchObject({ target_company: "Acme", context: "Explore implementation constraints", research_enabled: true });
});

test("meeting prep opens from the sidebar and guides an empty workspace to Calendar", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main navigation" }).getByText("Intelligence")).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meeting prep" }).click();
  await expect(page.getByRole("heading", { name: "Meeting prep" })).toBeVisible();
  await expect(page.getByText("No saved upcoming meetings")).toBeVisible();
  await page.getByRole("button", { name: "Go to Calendar" }).click();
  await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
});

test("meeting prep sidebar section fits a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Meeting prep" }).click();
  await expect(page.getByRole("heading", { name: "Meeting prep" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});

test("teammates can prepare their own meetings without meeting-management controls", async ({ page }) => {
  await page.route("**/v1/auth/me", (route) => route.fulfill({ json: { ...owner, role: "member" } }));
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation.getByRole("button", { name: "Calendar" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Meeting prep" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Meetings", exact: true })).toHaveCount(0);
  await navigation.getByRole("button", { name: "Meeting prep" }).click();
  await expect(page.getByRole("heading", { name: "Meeting prep" })).toBeVisible();
});

test("meetings page filters scheduled and completed records", async ({ page }) => {
  await page.route("**/v1/meetings", (route) => route.fulfill({ json: { items: [
    { id: "00000000-0000-4000-8000-000000000011", title: "Future planning", status: "created", platform: "google_meet", created_at: "2026-09-25T00:00:00Z", meeting_url: "https://meet.google.com/abc-defg-hij" },
    { id: "00000000-0000-4000-8000-000000000012", title: "Past client recap", status: "ready", platform: "google_meet", created_at: "2026-09-24T00:00:00Z", meeting_url: "https://meet.google.com/abc-defg-hij" },
  ], count: 2 } }));
  await page.route("**/v1/calendar/schedules", (route) => route.fulfill({ json: [{
    meeting_id: "00000000-0000-4000-8000-000000000011", connection_id: "ca-calendly", provider: "calendly", event_id: "event-1",
    starts_at: "2026-09-26T09:00:00Z", ends_at: "2026-09-26T10:00:00Z", status: "pending", last_error: null,
  }] }));
  await page.goto("/");
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Meetings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Scheduled/ }).click();
  await expect(page.getByText("Future planning")).toBeVisible();
  await expect(page.getByText("Past client recap")).toHaveCount(0);
  await page.getByRole("button", { name: /Ready to review/ }).click();
  await expect(page.getByText("Past client recap")).toBeVisible();
});

test("workspace creation lives in Organization & people, not the profile menu", async ({ page }) => {
  let createdName: string | null = null;
  await page.route("**/v1/workspaces", async (route) => {
    if (route.request().method() === "POST") {
      createdName = route.request().postDataJSON().display_name;
      return route.fulfill({ status: 201, json: { ...owner, organization_id: "00000000-0000-4000-8000-000000000003" } });
    }
    return route.fulfill({ json: [{ id: originalWorkspace.id, slug: originalWorkspace.slug, display_name: originalWorkspace.display_name, role: "owner" }] });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Current workspace.*Open account/ })).toHaveCount(0);
  await page.getByRole("button", { name: /Workspace owner.*owner@example.test/ }).click();
  await expect(page.getByPlaceholder("New workspace name")).toHaveCount(0);
  await page.getByRole("button", { name: "Organization & people" }).click();
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  await page.getByRole("button", { name: "New workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "New workspace" });
  await dialog.getByLabel("Workspace name").fill("Novaala");
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await expect.poll(() => createdName).toBe("Novaala");
});

const multiAccounts = [
  { id: "ca-work", provider: "googlecalendar", status: "ACTIVE", label: "Work calendar" },
  { id: "ca-outlook", provider: "outlook", status: "ACTIVE", label: "outlook@example.test" },
  { id: "ca-calendly", provider: "calendly", status: "ACTIVE", label: "Sales bookings" },
];

function multiAccountEvents() {
  const at = (hour: number) => { const value = new Date(); value.setHours(hour, 0, 0, 0); return value; };
  const event = (id: string, connection: string, provider: string, title: string, hour: number, url: string, platform: string, invitee: string) => ({
    id: `00000000-0000-4000-8000-0000000004${id}`, synced_at: new Date().toISOString(), connection_id: connection, provider,
    event_id: `event-${id}`, title, starts_at: at(hour).toISOString(), ends_at: at(hour + 1).toISOString(),
    meeting_url: url, platform, invitees: [{ name: invitee.split("@")[0], email: invitee, response_status: null }],
  });
  return [
    event("01", "ca-work", "googlecalendar", "Acme weekly check-in", 12, "https://meet.google.com/abc-defg-hij", "google_meet", "asha@acme.example"),
    event("02", "ca-outlook", "outlook", "Acme weekly check-in", 12, "https://meet.google.com/abc-defg-hij", "google_meet", "asha@acme.example"),
    event("03", "ca-calendly", "calendly", "Northwind pricing call", 15, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0", "teams", "lena@northwind.example"),
  ];
}

test("all connected accounts sync together and one meeting from two accounts shows both sources", async ({ page }) => {
  const scans: unknown[] = [];
  await page.route("**/v1/calendar/connections", (route) => route.fulfill({ json: multiAccounts }));
  await page.route("**/v1/calendar/synced?**", (route) => route.fulfill({ json: { events: multiAccountEvents(), syncs: [] } }));
  await page.route("**/v1/calendar/sync", async (route) => {
    scans.push(route.request().postDataJSON().connection_ids);
    await route.fulfill({ json: { events: multiAccountEvents(), syncs: [], errors: {} } });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByRole("combobox", { name: "Account" })).toContainText("All connected accounts");
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect.poll(() => scans).toEqual([[]]);
  await expect(page.getByRole("button", { name: /2 meetings, from 3 accounts/ })).toBeVisible();
  const rows = page.locator(".calendar-agenda-event");
  await expect(rows).toHaveCount(2);
  const merged = rows.filter({ hasText: "Acme weekly check-in" });
  await expect(merged.getByRole("img", { name: "Google Calendar · Work calendar" })).toBeAttached();
  await expect(merged.getByRole("img", { name: "Outlook Calendar · outlook@example.test" })).toBeAttached();
  await merged.click();
  await expect(page.locator(".calendar-event-detail")).toContainText("Google Meet");
  await expect(page.locator(".calendar-detail-sources li")).toHaveCount(2);
  await rows.filter({ hasText: "Northwind pricing call" }).click();
  await expect(page.locator(".calendar-event-detail")).toContainText("Scheduled via Calendly");
  await expect(page.locator(".calendar-event-detail")).toContainText("Microsoft Teams");
});

test("each connected account can be synced on its own from Integrations", async ({ page }) => {
  let scanned: unknown = null;
  await page.route("**/v1/calendar/connections", (route) => route.fulfill({ json: multiAccounts }));
  await page.route("**/v1/calendar/sync", async (route) => {
    scanned = route.request().postDataJSON().connection_ids;
    await route.fulfill({ json: { events: [], syncs: [{ connection_id: "ca-outlook", last_synced_at: new Date().toISOString(), range_start: new Date().toISOString(), range_end: new Date().toISOString(), truncated: false }], errors: {} } });
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("tab", { name: /Integrations/ }).click();
  await page.getByRole("button", { name: "Sync outlook@example.test" }).click();
  await expect.poll(() => scanned).toEqual(["ca-outlook"]);
  await expect(page.locator(".calendar-account-row", { hasText: "outlook@example.test" })).toContainText("Synced");
});

test("meeting prep search filters by title, invitee or company and offers a way back", async ({ page }) => {
  await page.route("**/v1/calendar/synced?**", (route) => route.fulfill({ json: { events: multiAccountEvents(), syncs: [] } }));
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meeting prep" }).click();
  const list = page.getByRole("complementary", { name: "Meetings to prepare" });
  await expect(list.getByRole("button", { name: /Acme weekly check-in/ })).toHaveCount(1);
  const search = page.getByLabel("Search upcoming meetings");
  await search.fill("northwind"); // invitee company domain
  await expect(list.getByRole("button", { name: /Northwind pricing call/ })).toBeVisible();
  await expect(list.getByRole("button", { name: /Acme weekly check-in/ })).toHaveCount(0);
  await search.fill("globex");
  await expect(page.getByText("No upcoming meetings match “globex”")).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(list.getByRole("button", { name: /Acme weekly check-in/ })).toBeVisible();
});
