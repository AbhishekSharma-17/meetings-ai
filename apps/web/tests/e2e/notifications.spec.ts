import { expect, test, type Page, type Route } from "@playwright/test";

const workspace = {
  id: "00000000-0000-4000-8000-000000000001", slug: "genai-protos", display_name: "GenAI Protos", contact_email: null,
  status: "active", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", tenant_isolation_enabled: true,
};
const owner = {
  user_id: "00000000-0000-4000-8000-000000000002", organization_id: workspace.id, email: "owner@example.test",
  display_name: "Workspace owner", role: "owner", must_change_password: false,
};
const eventId = "00000000-0000-4000-8000-000000000177";
const otherEventId = "00000000-0000-4000-8000-000000000188";
const jobId = "00000000-0000-4000-8000-000000000301";
const usage = { exa_calls: 0, llm_calls: 1, input_tokens: 900, output_tokens: 300, estimated_usd: 0.01, unpriced_calls: 0 };

function event(id: string, title: string, dayOffset: number) {
  const startsAt = new Date(); startsAt.setDate(startsAt.getDate() + dayOffset); startsAt.setHours(10, 0, 0, 0);
  return {
    id, synced_at: new Date().toISOString(), connection_id: "google", provider: "googlecalendar", event_id: `e-${id.slice(-3)}`,
    title, starts_at: startsAt.toISOString(), ends_at: new Date(startsAt.getTime() + 3_600_000).toISOString(),
    meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet", agenda: "Scope a pilot", organizer: "Host",
    invitees: [{ name: "Asha Patel", email: "asha@acme.example" }],
  };
}

const report = {
  report_version: 2, id: "00000000-0000-4000-8000-000000000178", calendar_event_id: eventId, target_company: "Acme Robotics",
  company_website: "https://acme.example", executive_brief: "Acme Robotics is scaling warehouse automation.",
  company: { name: "Acme Robotics", website: "https://acme.example", what_they_do: "Builds warehouse robots.", industry: "Robotics", size_signals: "", headquarters: "", source_ids: [] },
  recent_developments: [], ai_landscape: { summary: "", source_ids: [], initiatives: [], vendors: [], end_clients: [] },
  alignment: { fit_summary: "", relevant_services: [] }, attendees: [],
  meeting_narrative: { recommended_focus: "", opening: "", by_persona: [], agenda_suggestions: [] },
  talking_points: [], questions_to_ask: [], watchouts: [], sources: [], public_research_performed: false, research_steps: [], usage,
  started_at: new Date().toISOString(), generated_at: new Date().toISOString(), provider: "openai", model: "gpt-test",
  findings: [], relevant_offerings: [], people_notes: [],
};

function notification(id: string, overrides: Record<string, unknown>) {
  return {
    id, kind: "prep.ready", severity: "success", title: "Briefing ready", body: null, link_view: null, link_id: null,
    meeting_id: null, created_at: new Date(Date.now() - 5 * 60_000).toISOString(), read_at: null, ...overrides,
  };
}

type Custom = (path: string, method: string, route: Route) => object | null;

async function mockApi(page: Page, custom: Custom = () => null) {
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const answer = custom(path, request.method(), route);
    if (answer) return route.fulfill(answer);
    if (path === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (path === "/v1/auth/me") return route.fulfill({ json: owner });
    if (path === "/v1/workspace") return route.fulfill({ json: workspace });
    if (path === "/v1/workspaces") return route.fulfill({ json: [{ id: workspace.id, slug: workspace.slug, display_name: workspace.display_name, role: "owner" }] });
    if (path === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (path === "/v1/provider-profiles" || path === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (path === "/v1/calendar/synced") return route.fulfill({ json: { events: [event(eventId, "Acme Robotics discovery", 1), event(otherEventId, "Globex planning", 2)], syncs: [] } });
    if (path === "/v1/knowledge/text-profiles") return route.fulfill({ json: [] });
    if (/\/prep\/inputs$/.test(path)) return route.fulfill({ json: { target_company: "Acme Robotics", company_website: null, links: [], notes: "", updated_at: null } });
    if (/\/prep\/history$/.test(path)) return route.fulfill({ json: { calendar_event_id: eventId, items: [], totals: usage } });
    if (/\/calendar\/events\/[^/]+\/prep$/.test(path)) return route.fulfill({ json: null });
    if (path === "/v1/documents") return route.fulfill({ json: [] });
    if (path === "/v1/background-jobs") return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "test route not mocked" } });
  });
}

const bell = (page: Page) => page.getByRole("button", { name: /^Notifications/ });

test("the bell shows unread notifications, marks one read and opens its briefing", async ({ page }) => {
  const read: string[] = [];
  let unread = 2;
  const items = () => [
    notification("00000000-0000-4000-8000-000000000401", { title: "Briefing ready for “Globex planning”", body: "Your meeting briefing is saved.", link_view: "prep", link_id: otherEventId, read_at: read.includes("00000000-0000-4000-8000-000000000401") ? new Date().toISOString() : null }),
    notification("00000000-0000-4000-8000-000000000402", { kind: "assistant.join_failed", severity: "danger", title: "Assistant could not join “Weekly sync”", body: "Check the meeting link.", created_at: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
    notification("00000000-0000-4000-8000-000000000403", { kind: "recap.sent", title: "Recap sent", read_at: new Date().toISOString(), created_at: new Date(Date.now() - 4 * 86_400_000).toISOString() }),
  ];
  await mockApi(page, (path, method) => {
    if (path === "/v1/notifications/unread-count") return { json: { unread_count: unread } };
    if (path === "/v1/notifications") return { json: { items: items(), next_cursor: null, unread_count: unread } };
    const match = /^\/v1\/notifications\/([^/]+)\/read$/.exec(path);
    if (match && method === "POST") { read.push(match[1]); unread -= 1; return { json: { ...items()[0], read_at: new Date().toISOString() } }; }
    if (path === "/v1/notifications/read-all" && method === "POST") { unread = 0; return { json: { unread_count: 0 } }; }
    return null;
  });
  await page.goto("/");
  await expect(bell(page)).toHaveAccessibleName("Notifications, 2 unread");
  await bell(page).click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  await expect(panel.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await expect(panel.getByRole("region", { name: "Today" })).toContainText("Briefing ready for “Globex planning”");
  await expect(panel.getByRole("region", { name: "Earlier" })).toContainText("Assistant could not join “Weekly sync”");
  await panel.getByRole("button", { name: /^Unread/ }).click();
  await expect(panel.getByText("Recap sent")).toHaveCount(0);

  await panel.getByRole("button", { name: /^Briefing ready for “Globex planning”/ }).click();
  await expect(page.getByRole("heading", { name: "Meeting prep" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Globex planning", level: 2 })).toBeVisible();
  expect(read).toEqual(["00000000-0000-4000-8000-000000000401"]);
  await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread");

  await bell(page).click();
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(bell(page)).toHaveAccessibleName("Notifications");
});

test("a briefing keeps running in the background after leaving the page and appears on return", async ({ page }) => {
  let polls = 0;
  let started = false;
  let streamed = false;
  const job = (status: string, stage: string) => ({
    id: jobId, kind: "prep_briefing", subject_id: eventId, status, stage, message: null, result: status === "succeeded" ? { report_id: report.id } : null,
    error: null, attempts: 1, user_id: owner.user_id, created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: null, updated_at: new Date().toISOString(),
  });
  await mockApi(page, (path, method) => {
    if (path === `/v1/calendar/events/${eventId}/prep/jobs` && method === "POST") { started = true; return { status: 202, json: job("running", "planning") }; }
    if (path === "/v1/background-jobs" && started) return { json: polls < 3 ? [job("running", "reading")] : [] };
    if (path === `/v1/background-jobs/${jobId}`) { polls += 1; return { json: polls < 3 ? job("running", polls < 2 ? "reading" : "writing") : job("succeeded", "done") }; }
    if (path === `/v1/calendar/events/${eventId}/prep` && polls >= 3) return { json: report };
    if (path === `/v1/calendar/events/${eventId}/prep/stream`) { streamed = true; return { status: 500, json: { detail: "jobs are available; the stream must not be used" } }; }
    return null;
  });
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meeting prep" }).click();
  await page.getByRole("button", { name: /Acme Robotics discovery/ }).click();
  await page.getByRole("tab", { name: /Inputs/ }).click();
  await page.getByRole("button", { name: "Generate briefing" }).click();
  await expect(page.getByRole("heading", { name: "Preparing your briefing" })).toBeVisible();
  await expect(page.getByText("Running in the background — you can leave this page.", { exact: false })).toBeVisible();

  // Leave for the calendar, then come back: the same job is found again and followed to the end.
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meeting prep" }).click();
  await expect(page.getByRole("heading", { name: "Briefing: Acme Robotics" })).toBeVisible({ timeout: 15_000 });
  expect(polls).toBeGreaterThanOrEqual(3);
  expect(streamed).toBe(false);
});

test("the demo workspace has notifications and a demo briefing runs as a background job", async ({ page }) => {
  test.setTimeout(60_000);
  await page.route("**/v1/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: false } });
    return route.fulfill({ status: 599, json: { detail: "A demo request reached the network." } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Explore the demo" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back, Alex" })).toBeVisible();
  await expect(bell(page)).toHaveAccessibleName("Notifications, 5 unread");
  await bell(page).click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  await expect(panel.getByText("Assistant is waiting in the lobby")).toBeVisible();
  await panel.getByRole("button", { name: /^Assistant joined “Acme Robotics — weekly delivery sync”/ }).click();
  await expect(page.getByRole("heading", { name: "Acme Robotics — weekly delivery sync" })).toBeVisible();
  await expect(bell(page)).toHaveAccessibleName("Notifications, 4 unread");

  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meeting prep" }).click();
  await page.getByRole("list").getByRole("button", { name: /Discovery call: Fabrikam Health/ }).click();
  await page.getByRole("tab", { name: /Inputs/ }).click();
  await page.getByRole("button", { name: "Generate briefing" }).click();
  await expect(page.getByText("Running in the background — you can leave this page.", { exact: false })).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  const toast = page.getByRole("status").filter({ hasText: "Briefing ready for “Discovery call: Fabrikam Health”" });
  await expect(toast).toBeVisible({ timeout: 25_000 });
  await toast.getByRole("button", { name: "View" }).click();
  await expect(page.getByRole("heading", { name: "Discovery call: Fabrikam Health", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Briefing:/ })).toBeVisible();
});
