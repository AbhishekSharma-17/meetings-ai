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
  await page.getByLabel("Target company").fill("Acme");
  await page.getByLabel("What you already know or want to learn").fill("Explore implementation constraints");
  await page.getByRole("button", { name: "Generate briefing" }).click();
  await expect(page.getByText("A focused discovery conversation.")).toBeVisible();
  await expect(page.getByText("Acme builds widgets.")).toBeVisible();
  await expect(page.getByRole("link", { name: /About Acme/ })).toHaveAttribute("href", "https://acme.example/about");
  expect(prepInput).toMatchObject({ target_company: "Acme", context: "Explore implementation constraints", research_enabled: true });
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
