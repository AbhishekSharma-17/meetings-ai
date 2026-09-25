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

test("disconnect confirms one account and leaves the other integration connected", async ({ page }) => {
  let removed: string | null = null;
  await page.route("**/v1/calendar/connections**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "DELETE") {
      removed = path;
      return route.fulfill({ status: 204 });
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
  await expect(page.getByText("Saved meetings and scheduled assistants remain.")).toBeVisible();
  expect(removed).toBeNull();
  await page.locator(".calendar-account-row", { hasText: "work@example.test" }).getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => removed).toBe("/v1/calendar/connections/ca-work");
  await expect(page.getByText("work@example.test")).toHaveCount(0);
  await expect(page.getByText("personal@example.test")).toBeVisible();
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
  let syncCalls = 0;
  await page.route("**/v1/calendar/synced?**", (route) => {
    const requested = new URL(route.request().url()).searchParams.get("start_date");
    return route.fulfill({ json: { events: requested === startKey ? [{
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
  await page.reload();
  await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
  await expect(page.locator(".calendar-month-nav h2")).toHaveText(nextMonth.toLocaleString("en-US", { month: "long", year: "numeric" }));
  await expect(page.getByText("Saved client meeting").first()).toBeVisible();
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
  await expect(page.getByRole("navigation", { name: "Main navigation" }).getByText("PREPARE")).toBeVisible();
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
  await page.getByLabel("New workspace name").fill("Novaala");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect.poll(() => createdName).toBe("Novaala");
});
