import { expect, test, type Page, type Route } from "@playwright/test";

/** Every browsable list offers the same search: case/accent-insensitive, clearable, with a distinct "no matches" state. */
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const MEETING = "00000000-0000-4000-8000-000000000099";
const BASE = "00000000-0000-4000-8000-000000000066";
const stamp = "2026-09-25T10:00:00Z";
const id = (prefix: string, index: number) => `00000000-0000-4000-8000-${prefix}${String(index).padStart(12 - prefix.length, "0")}`;

const meetingTitles = ["Café Zürich planning", "Acme kickoff", "Globex renewal", "Initech standup", "Umbrella review", "Hooli roadmap", "Stark sync", "Wayne budget"];
const meetings = meetingTitles.map((title, index) => ({
  id: index === 0 ? MEETING : id("a", index), title, meeting_url: "https://meet.google.com/abc-defg-hij", platform: index % 2 ? "zoom" : "google_meet",
  status: "completed", bot_name: "Meetings AI", created_at: stamp, updated_at: stamp, joined_at: stamp, stopped_at: stamp,
  tags: [], knowledge_enabled: false, knowledge_base_id: null,
}));

const people = [["Workspace owner", "owner@example.test", "owner"], ["José Álvarez", "jose@northwind.example", "admin"], ["Priya Shah", "priya@acme.example", "member"],
  ["Dana Kim", "dana@acme.example", "member"], ["Lee Wong", "lee@globex.example", "member"], ["Sam Ortiz", "sam@initech.example", "member"],
  ["Ana Silva", "ana@initech.example", "member"], ["Omar Haddad", "omar@umbrella.example", "member"]]
  .map(([display_name, email, role], index) => ({ user_id: index === 0 ? USER : id("b", index), display_name, email, role, status: "active", photo_url: null }));

const bases = ["Acme research", "Globex accounts", "Initech support", "Umbrella security", "Hooli roadmap", "Stark engineering", "Wayne finance"]
  .map((name, index) => ({ id: index === 0 ? BASE : id("c", index), organization_id: ORG, name, description: null, created_by: USER, visibility: "private",
    text_profile_id: null, meeting_count: index + 1, shared_user_ids: [], created_at: stamp, updated_at: stamp }));

const profiles = [["Economy MOM", "gpt-6-luna"], ["Research MOM", "gpt-6-sol"], ["Draft writer", "gpt-6-terra"], ["Summaries", "claude-haiku"],
  ["Long context", "gemini-pro"], ["Local drafts", "llama-4"], ["Backup writer", "mistral-large"]]
  .map(([name, model], index) => ({ id: id("d", index + 1), name, provider_type: "openai", execution_location: "cloud", base_url: null,
    capabilities: [{ capability: "text_generation", model }], credential_configured: true, credential_hint: "••••1234" }));

const turns = ["We reviewed the budget for Q3.", "The café vendor confirmed Zürich dates.", "Next step is the pilot.", "Security review is scheduled.",
  "Hiring plan stays the same.", "Budget approval comes next week.", "Marketing needs the deck.", "Let us close with actions."];
const segments = turns.map((text, index) => ({ segment_id: `seg-${index}`, start_seconds: 10 * index, end_seconds: 10 * index + 5, speaker: index % 2 ? "Bob" : "Anna", text, completed: true }));

const storageItems = ["Acme review", "Globex renewal", "Initech standup", "Umbrella review", "Hooli roadmap", "Stark sync", "Café Zürich planning"]
  .map((label, index) => ({ id: id("e", index + 1), label, created_at: stamp, bytes: 1000 * (index + 1), rows: 5, detail: "completed · google_meet" }));

const storage = {
  organization_id: ORG, measured_at: stamp, total_bytes: 50_000, total_rows: 40,
  categories: [{ key: "meetings", label: "Meetings & transcripts", description: "Meeting records and transcripts.", rows: 40, bytes: 50_000, purgeable: true, tables: [] }],
  database: { dialect: "postgresql", size_bytes: 1_000_000, note: "Whole product database." },
  capture: { status: "not_requested", recording_bytes: null, recordings: 0, meetings_checked: 0, meetings_with_capture: 0, note: "" },
  method: "Row data measured per workspace.",
};

function fixtures(pathname: string, members: typeof people): unknown {
  const map: Record<string, unknown> = {
    "/v1/auth/session": { authenticated: true },
    "/v1/auth/me": { user_id: USER, organization_id: ORG, email: "owner@example.test", display_name: "Workspace owner", role: "owner", must_change_password: false },
    "/v1/workspace": { id: ORG, slug: "example", display_name: "Example", contact_email: null, status: "active", created_at: stamp, updated_at: stamp, tenant_isolation_enabled: true },
    "/v1/workspaces": [{ id: ORG, slug: "example", display_name: "Example", role: "owner", is_default: false }],
    "/v1/meetings": { items: meetings, count: meetings.length },
    [`/v1/meetings/${MEETING}`]: meetings[0],
    [`/v1/meetings/${MEETING}/transcript`]: { segments },
    "/v1/workspace/members": members,
    "/v1/knowledge-bases": bases,
    "/v1/provider-profiles": profiles,
    "/v1/workspace/storage": storage,
    "/v1/workspace/storage/items": { category: "meetings", items: storageItems },
    "/v1/workspace/brief": { website: null, overview: "", services: [], products: [], differentiators: "", positioning: "", updated_at: null },
    "/v1/workspace/retention": { enabled: false, meeting_days: null, chat_days: null, audit_days: null },
    "/v1/workspace/usage": { total_requests: 0, input_tokens: 0, output_tokens: 0, estimated_usd: 0, unpriced_requests: 0, recent: [], by_meeting: [], by_purpose: [], by_provider: [], by_kind: [], by_model: [] },
    "/v1/workspace/usage/events": { items: [], next_cursor: null, total: 0 },
    "/v1/calendar/synced": { events: [], syncs: [] },
    "/v1/teams": [],
  };
  if (pathname in map) return map[pathname];
  if (pathname.endsWith("/conversations") || pathname === "/v1/provider-defaults" || pathname === "/v1/credentials" || pathname.endsWith("/documents")
    || pathname === "/v1/workspace/audit" || pathname === "/v1/me/activity" || pathname === "/v1/calendar/schedules" || pathname === "/v1/calendar/connections" || pathname === "/v1/workspace/calendar-connections") return [];
  return undefined;
}

async function mockApi(page: Page, members = people) {
  await page.route("**/v1/**", (route: Route) => {
    const pathname = new URL(route.request().url()).pathname;
    const json = fixtures(pathname, members);
    return json === undefined ? route.fulfill({ status: 404, json: { detail: "not mocked" } }) : route.fulfill({ json });
  });
}

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name, exact: true }).click();

async function openWorkspace(page: Page) {
  await page.getByRole("button", { name: /Workspace owner owner@example.test/ }).click();
  await page.getByRole("button", { name: "Organization & people" }).click();
}

test("meetings library search ignores case and accents, and has its own no-match state", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await nav(page, "Meetings");
  const search = page.getByRole("searchbox", { name: "Search meetings" });
  await search.fill("CAFE zurich");
  await expect(page.getByRole("button", { name: "Open Café Zürich planning" })).toBeVisible();
  const rows = page.locator(".library-list").getByRole("button");
  await expect(rows).toHaveCount(1);

  await search.fill("nothing like this");
  await expect(page.getByText("No meetings match “nothing like this”")).toBeVisible();
  await expect(page.getByText("No meetings yet")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(rows).toHaveCount(meetings.length);

  await search.fill("acme");
  await search.press("Escape");
  await expect(search).toHaveValue("");
});

test("people search matches name, email domain and role, and clears with its button", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await openWorkspace(page);
  const section = page.getByRole("region", { name: "People & access" });
  const search = section.getByRole("searchbox", { name: "Search people" });
  await search.fill("jose");
  await expect(section.getByText("José Álvarez")).toBeVisible();
  await expect(section.getByText("Priya Shah")).toHaveCount(0);
  await search.fill("admin");
  await expect(section.getByText("José Álvarez")).toBeVisible();
  await expect(section.getByText("Priya Shah")).toHaveCount(0);
  await search.fill("acme.example");
  await expect(section.getByText("Priya Shah")).toBeVisible();
  await expect(section.getByText("Dana Kim")).toBeVisible();
  await expect(section.getByText("Lee Wong")).toHaveCount(0);
  await section.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  await expect(section.getByText("Lee Wong")).toBeVisible();
});

test("short lists do not show a search box", async ({ page }) => {
  await mockApi(page, people.slice(0, 3));
  await page.goto("/");
  await openWorkspace(page);
  const section = page.getByRole("region", { name: "People & access" });
  await expect(section.getByText("Priya Shah")).toBeVisible();
  await expect(section.getByRole("searchbox")).toHaveCount(0);
});

test("knowledge bases in the sidebar are searchable", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await nav(page, "AI knowledge");
  const rail = page.getByRole("complementary", { name: "Knowledge bases" });
  const search = rail.getByRole("searchbox", { name: "Search knowledge bases" });
  await search.fill("umbrella");
  await expect(rail.getByRole("button", { name: /Umbrella security/ })).toBeVisible();
  await expect(rail.getByRole("button", { name: /Acme research/ })).toHaveCount(0);
  await search.fill("zzz");
  await expect(rail.getByText("No knowledge bases match “zzz”")).toBeVisible();
});

test("AI provider profiles are searchable by name or model", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await nav(page, "AI providers");
  const search = page.getByRole("searchbox", { name: "Search AI profiles" });
  await search.fill("sol");
  await expect(page.getByRole("button", { name: /Research MOM/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Economy MOM/ })).toHaveCount(0);
  await search.fill("no such model");
  await expect(page.getByText(/profiles match “no such model”/).first()).toBeVisible();
});

test("transcript search filters turns and marks the matching words", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await nav(page, "Meetings");
  await page.getByRole("button", { name: "Open Café Zürich planning" }).click();
  const card = page.locator(".transcript-card");
  const search = card.getByRole("searchbox", { name: "Search transcript" });
  await search.fill("budget");
  const list = card.getByRole("list", { name: "Recent transcript turns, newest first" });
  await expect(list.locator("li")).toHaveCount(2);
  await expect(card.getByText("2 of 8 turns match")).toBeVisible();
  await expect(list.locator("mark.search-hit").first()).toHaveText(/budget/i);

  await search.fill("zurich");
  await expect(list.locator("mark.search-hit")).toHaveText(["Zürich"]);

  await card.getByRole("button", { name: "Open full transcript" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("searchbox", { name: "Search full transcript" })).toHaveValue("zurich");
  await expect(dialog.locator("li")).toHaveCount(1);
  await dialog.getByRole("searchbox", { name: "Search full transcript" }).fill("xyz");
  await expect(dialog.getByText("No turns match “xyz”")).toBeVisible();
});

test("storage items are searchable inside the manage sheet", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await nav(page, "Observability");
  await page.getByRole("tab", { name: /Data & storage/ }).click();
  await page.getByRole("button", { name: "Manage Meetings & transcripts" }).click();
  const search = page.getByRole("searchbox", { name: /Search / }).last();
  await search.fill("zurich");
  await expect(page.getByRole("checkbox", { name: /Café Zürich planning/ })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Globex renewal/ })).toHaveCount(0);
});

test("search boxes fit a 360px phone without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search meetings" });
  await expect(search).toBeVisible();
  await search.fill("acme");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await search.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBeTruthy();
});

test("calendar search narrows the month and agenda to matching meetings", async ({ page }) => {
  const at = (hour: number) => { const value = new Date(); value.setHours(hour, 0, 0, 0); return value.toISOString(); };
  const event = (index: number, title: string, hour: number, invitee: string) => ({
    id: id("f", index), synced_at: new Date().toISOString(), connection_id: "ca-work", provider: "googlecalendar", event_id: `event-${index}`, title,
    starts_at: at(hour), ends_at: at(hour + 1), meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet",
    invitees: [{ name: invitee.split("@")[0], email: invitee, response_status: null }],
  });
  await mockApi(page);
  await page.route("**/v1/calendar/connections", (route) => route.fulfill({ json: [{ id: "ca-work", provider: "googlecalendar", status: "ACTIVE", label: "Work" }] }));
  await page.route("**/v1/calendar/synced?**", (route) => route.fulfill({ json: { events: [event(1, "Acme weekly check-in", 12, "asha@acme.example"), event(2, "Pricing call", 15, "lena@northwind.example")], syncs: [] } }));
  await page.goto("/");
  await nav(page, "Calendar");
  await expect(page.locator(".calendar-agenda-list").getByRole("button")).toHaveCount(2);
  const search = page.getByRole("searchbox", { name: "Search meetings in range" });
  await search.fill("northwind");
  await expect(page.locator(".calendar-agenda-list").getByRole("button")).toHaveCount(1);
  await expect(page.locator(".calendar-agenda-list")).toContainText("Pricing call");
  await search.fill("globex");
  await expect(page.getByText("No meetings in this range match “globex”")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".calendar-agenda-list").getByRole("button")).toHaveCount(2);
});
