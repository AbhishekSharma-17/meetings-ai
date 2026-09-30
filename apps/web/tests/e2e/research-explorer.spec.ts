import { expect, test, type Page, type Route } from "@playwright/test";

/* Research (Apollo Explorer): search → profile → history → Ask AI → save to knowledge → prepare; people look-up; roles; 360px. All /v1 is mocked. */

const workspace = { id: "00000000-0000-4000-8000-000000000001", slug: "example", display_name: "Example", contact_email: null, status: "active", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", tenant_isolation_enabled: true };
const account = (role: string) => ({ user_id: "00000000-0000-4000-8000-000000000002", organization_id: workspace.id, email: `${role}@example.test`, display_name: role === "owner" ? "Owner" : "Mo", role, must_change_password: false });
const acmeId = "00000000-0000-4000-8000-0000000000c1";
const ashaId = "00000000-0000-4000-8000-0000000000c2";
const eventId = "00000000-0000-4000-8000-0000000000e1";
const meetingId = "00000000-0000-4000-8000-0000000000d1";
const baseId = "00000000-0000-4000-8000-0000000000b1";
const usage = (used: number) => ({ used_today: used, daily_limit: 100 });
type Json = Record<string, unknown>;

const acmeHit = { apollo_id: "org_acme", name: "Acme Robotics", domain: "acme.example", website: "https://www.acme.example", linkedin_url: null, logo_url: null, industry: "industrial automation", employee_count: 540, headquarters: "Austin, Texas", in_apollo_account: true, saved_profile_id: null };
const company = { apollo_id: "org_acme", name: "Acme Robotics", domain: "acme.example", website: "https://www.acme.example", linkedin_url: "https://www.linkedin.com/company/acme", description: "Warehouse robots.", industry: "Industrial automation", employee_count: 540, revenue_band: "$50M-$100M", total_funding: "$212M", latest_funding_stage: "Series C", latest_funding_date: "2026-05-02", latest_funding_amount: "$120M", headquarters: "Austin, Texas", founded_year: 2016, tech_stack: ["AWS", "Kubernetes"], source_id: null };
const hiring = { open_roles: 12, themes: [{ theme: "Engineering", count: 7 }, { theme: "Sales", count: 5 }], examples: [{ title: "Senior ML Engineer", url: null, location: "Austin", posted_at: null }], source_id: null };
const acmeProfile = { id: acmeId, kind: "company", apollo_id: "org_acme", domain: "acme.example", name: "Acme Robotics", title: null, company: "Acme Robotics", logo_url: null, company_facts: company, person: null,
  news: [{ title: "Acme opens Rotterdam hub", url: "https://news.example/acme", published_at: "2026-09-10", snippet: null, source_id: null }], hiring,
  job_groups: [{ theme: "Engineering", count: 7, jobs: hiring.examples }, { theme: "Sales", count: 5, jobs: [] }],
  created_by: { id: "u1", name: "Owner" }, created_at: "2026-09-27T10:00:00Z", updated_at: "2026-09-27T10:00:00Z", fetched_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), apollo_calls: 3, can_delete: true };
const ashaPerson = { name: "Asha Patel", title: "Chief Technology Officer", seniority: "c_suite", departments: ["engineering technical"], company: "Acme Robotics", role_started: "2022-03-01", past_roles: [{ company: "Globex", title: "VP Data", start_date: "2018-01-01", end_date: "2022-02-01", current: false }], linkedin_url: "https://www.linkedin.com/in/asha", location: "Austin, Texas", matched_by: "name", source_id: null };
const ashaProfile = { ...acmeProfile, id: ashaId, kind: "person", apollo_id: "per_asha", name: "Asha Patel", title: "Chief Technology Officer", company_facts: null, person: ashaPerson, news: [], hiring: null, job_groups: [] };
const history = { meetings: [{ meeting_id: meetingId, title: "Acme discovery", date: "2026-09-20T15:00:00Z", status: "completed", reasons: ["Invitee from acme.example"] }],
  briefings: [{ calendar_event_id: eventId, title: "Acme pilot scoping", starts_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), briefing_at: null, executive_brief: null, reasons: ["Prep notes"] }], documents: [], our_company: false };
const event = () => { const starts = new Date(Date.now() + 2 * 86_400_000); starts.setMinutes(0, 0, 0);
  return { id: eventId, synced_at: new Date().toISOString(), connection_id: "g1", provider: "googlecalendar", event_id: "acme-1", title: "Acme pilot scoping", starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + 3_600_000).toISOString(), meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet", agenda: null, organizer: "Owner", invitees: [{ name: "Asha Patel", email: "asha@acme.example" }] }; };
const people = Array.from({ length: 12 }, (_, index) => ({ apollo_id: `per_${index}`, name: index === 0 ? "Asha Pa***l" : `Person ${index} Test`, name_partial: index === 0, title: "Engineer", seniority: "senior", company: "Acme Robotics", company_domain: "acme.example", location: "Austin", linkedin_url: null, in_apollo_contacts: false, saved_profile_id: null }));

function state(role = "owner", connected = true) {
  return { role, connected, saved: [] as Json[], requests: [] as { path: string; method: string; body: Json | null }[], inputs: { target_company: null as string | null, company_website: null as string | null, links: [] as string[], notes: "", updated_at: null } };
}
type State = ReturnType<typeof state>;

async function mockApi(page: Page, s: State) {
  await page.route("**/v1/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() as Json : null;
    if (path.startsWith("/v1/research")) s.requests.push({ path, method, body });
    const admin = s.role === "owner" || s.role === "admin";
    if (path === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (path === "/v1/auth/me") return route.fulfill({ json: account(s.role) });
    if (path === "/v1/workspace") return route.fulfill({ json: workspace });
    if (path === "/v1/workspaces") return route.fulfill({ json: [{ id: workspace.id, slug: workspace.slug, display_name: workspace.display_name, role: s.role }] });
    if (path === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (path === "/v1/research/status") return route.fulfill(s.role === "viewer" ? { status: 403, json: { detail: "no" } } : { json: { connected: s.connected, status: s.connected ? "active" : null, can_manage: admin, can_use: s.connected, usage: s.connected ? usage(4) : null, bulk_confirm_over: 10 } });
    if (path === "/v1/research/profiles" && method === "GET") return route.fulfill({ json: s.saved });
    if (path === "/v1/research/search/companies") return route.fulfill({ json: { items: [acmeHit], page: 1, per_page: 25, total: 1, total_pages: 1, cached: false, usage: usage(5) } });
    if (path === "/v1/research/search/people") return route.fulfill({ json: { items: people, page: 1, per_page: 25, total: 12, total_pages: 1, cached: false, usage: usage(6) } });
    if (path === "/v1/research/people/lookup") {
      const ids = (body?.apollo_ids ?? []) as string[];
      if (ids.length > 10 && !body?.confirm) return route.fulfill({ status: 409, json: { detail: "Confirm to continue." } });
      return route.fulfill({ json: { items: ids.map((id) => ({ apollo_id: id, company_domain: "acme.example", person: id === "per_0" ? ashaPerson : { ...ashaPerson, name: `Person ${id.slice(4)} Test` } })), usage: usage(8) } });
    }
    if (path === "/v1/research/profiles" && method === "POST") { s.saved = [acmeProfile]; return route.fulfill({ status: 201, json: { profile: acmeProfile, created: true, usage: usage(8) } }); }
    if (path === `/v1/research/profiles/${acmeId}`) return route.fulfill({ json: acmeProfile });
    if (path === `/v1/research/profiles/${acmeId}/people`) return route.fulfill({ json: [ashaProfile] });
    if (path === `/v1/research/profiles/${acmeId}/history`) return route.fulfill({ json: history });
    if (path === `/v1/research/profiles/${acmeId}/conversations`) return route.fulfill({ json: [] });
    if (path === `/v1/research/profiles/${acmeId}/chat`) return route.fulfill({ json: { answer: "Acme is hiring engineers [S1] and opened a Rotterdam hub [S2].", conversation_id: "c1", provider: "openai", model: "gpt-test", web_searches: body?.include_web ? 1 : 0, note: null,
      citations: [{ id: "S1", kind: "apollo", title: "Apollo · Acme Robotics open roles", snippet: "Open job postings: 12", url: null, date: "2026-09-27", meeting_id: null, segment_id: null, calendar_event_id: null },
        { id: "S2", kind: "meeting", title: "Acme discovery — approved minutes", snippet: "Rotterdam hub planning.", url: null, date: "2026-09-20", meeting_id: meetingId, segment_id: null, calendar_event_id: null }] } });
    if (path === `/v1/research/profiles/${acmeId}/knowledge`) return route.fulfill({ status: 201, json: { id: "doc1", filename: "Acme Robotics — Apollo research.md" } });
    if (path === `/v1/research/profiles/${acmeId}/prepare`) {
      s.inputs = { ...s.inputs, target_company: "Acme Robotics", company_website: "https://www.acme.example", notes: "From Research: Asha Patel (Chief Technology Officer) will be on their side." };
      return route.fulfill({ json: { calendar_event_id: eventId, target_company: "Acme Robotics", company_website: "https://www.acme.example", attendee_sides: { "asha@acme.example": "theirs" }, matched_people: ["Asha Patel"], unmatched_people: [] } });
    }
    if (path === "/v1/knowledge-bases") return route.fulfill({ json: [{ id: baseId, organization_id: workspace.id, name: "Client research", description: null, created_by: account(s.role).user_id, visibility: "private", text_profile_id: null, meeting_count: 0, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", shared_user_ids: [] }] });
    if (path === "/v1/calendar/synced") return route.fulfill({ json: { events: [event()], syncs: [] } });
    if (path === `/v1/calendar/events/${eventId}/prep`) return route.fulfill({ json: null });
    if (path === `/v1/calendar/events/${eventId}/prep/inputs`) return route.fulfill({ json: s.inputs });
    if (path === `/v1/calendar/events/${eventId}/prep/history`) return route.fulfill({ json: { calendar_event_id: eventId, items: [], totals: { exa_calls: 0, llm_calls: 0, input_tokens: 0, output_tokens: 0, estimated_usd: 0, unpriced_calls: 0, apollo_calls: 0 } } });
    if (["/v1/provider-profiles", "/v1/provider-defaults", "/v1/calendar/connections", "/v1/calendar/schedules", "/v1/knowledge/text-profiles", "/v1/documents", "/v1/background-jobs"].includes(path)) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "test route not mocked" } });
  });
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function openResearch(page: Page) {
  await page.goto("/");
  await nav(page).getByRole("button", { name: "Research" }).click();
  await expect(page.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
}

test("search companies, open the saved profile, ask AI, save to knowledge and prepare a meeting", async ({ page }) => {
  const s = state();
  await mockApi(page, s);
  await openResearch(page);
  await expect(page.getByText("of 100 Apollo lookups used today")).toBeVisible();
  await expect(page.getByText("Nothing saved yet")).toBeVisible();
  await page.getByLabel("Company name").fill("Acme");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const results = page.getByRole("region", { name: "Company results" });
  await expect(results.getByText("Acme Robotics")).toBeVisible();
  await expect(results.getByText("Apollo account")).toBeVisible();
  expect(s.requests.find((item) => item.path.endsWith("/search/companies"))?.body).toMatchObject({ name: "Acme", page: 1 });
  await results.getByRole("button", { name: "Save Acme Robotics" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Acme Robotics" })).toBeVisible();
  await expect(page.getByText("From Apollo · fetched 3 days ago")).toBeVisible();
  await expect(page.getByText("$212M")).toBeVisible();
  await expect(page.getByText("Acme opens Rotterdam hub")).toBeVisible();
  await expect(page.getByText("Senior ML Engineer")).toBeVisible();
  await expect(page.getByRole("button", { name: "Asha Patel" })).toBeVisible();
  const ourHistory = page.getByRole("region", { name: "Our history" });
  await expect(ourHistory.getByRole("button", { name: "Acme discovery" })).toBeVisible();
  await expect(ourHistory.getByText("Invitee from acme.example")).toBeVisible();

  const chat = page.getByRole("region", { name: "Ask AI" });
  await chat.getByRole("switch", { name: "Include web search" }).click();
  await chat.getByLabel("Ask about Acme Robotics").fill("What are they hiring for?");
  await chat.getByRole("button", { name: "Ask" }).click();
  await expect(chat.getByText(/Acme is hiring engineers/)).toBeVisible();
  expect(s.requests.find((item) => item.path.endsWith("/chat"))?.body).toMatchObject({ question: "What are they hiring for?", include_web: true, conversation_id: null });
  await chat.getByRole("button", { name: "Show source 2" }).click();
  await expect(chat.getByText("Acme discovery — approved minutes")).toBeVisible();

  await page.getByRole("button", { name: "Save to knowledge" }).click();
  const knowledge = page.getByRole("dialog", { name: "Save to knowledge" });
  await expect(knowledge.getByText("Client research")).toBeVisible();
  await knowledge.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved to Client research.", { exact: false })).toBeVisible();
  expect(s.requests.find((item) => item.path.endsWith("/knowledge"))?.body).toEqual({ knowledge_base_id: baseId });

  await page.getByRole("button", { name: "Prepare a meeting" }).click();
  const prepare = page.getByRole("dialog", { name: "Prepare a meeting" });
  await expect(prepare.getByText(/Acme pilot scoping/)).toBeVisible();
  await expect(prepare.getByRole("checkbox", { name: /Asha Patel/ })).toBeChecked();
  await prepare.getByRole("button", { name: "Open meeting prep" }).click();
  expect(s.requests.find((item) => item.path.endsWith("/prepare"))?.body).toEqual({ calendar_event_id: eventId, person_profile_ids: [ashaId] });
  await expect(page.getByRole("heading", { name: "Meeting prep" })).toBeVisible();
  await page.getByRole("tab", { name: /Inputs/ }).click();
  await expect(page.getByLabel("Target company")).toHaveValue("Acme Robotics");
});

test("people search shows Apollo's partial names; look up one person, confirm a large batch", async ({ page }) => {
  const s = state("member");
  await mockApi(page, s);
  await openResearch(page);
  await page.getByRole("tab", { name: "People" }).click();
  await page.getByLabel("Company websites").fill("acme.example");
  await page.getByLabel("Company websites").press("Enter");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const results = page.getByRole("region", { name: "People results" });
  await expect(results.getByText("Asha Pa***l")).toBeVisible();
  await expect(results.getByText("Apollo shows the full name after a look-up.").first()).toBeVisible();
  await results.getByRole("button", { name: "Look up Asha Pa***l" }).click();
  await expect(results.getByText("Asha Patel")).toBeVisible();
  await expect(results.getByText("Previously Globex")).toBeVisible();
  expect(s.requests.find((item) => item.path.endsWith("/people/lookup"))?.body).toEqual({ apollo_ids: ["per_0"], confirm: false });
  for (const person of people.slice(1)) await results.getByRole("checkbox", { name: `Select ${person.name}` }).check();
  await results.getByRole("button", { name: "Look up 11" }).click();
  const confirm = page.getByRole("dialog", { name: "Look up 11 people?" });
  await expect(confirm.getByText(/up to 11 Apollo lookups/)).toBeVisible();
  await confirm.getByRole("button", { name: "Look up 11" }).click();
  await expect(confirm).toBeHidden();
  expect(s.requests.filter((item) => item.path.endsWith("/people/lookup")).at(-1)?.body).toMatchObject({ confirm: true });
  await expect(results.getByText("Person 11 Test")).toBeVisible();
});

test("viewers have no Research; members see an admin hint when Apollo is not connected", async ({ page }) => {
  const viewer = state("viewer");
  await mockApi(page, viewer);
  await page.goto("/");
  await expect(nav(page).getByRole("button", { name: "AI knowledge" })).toBeVisible();
  await expect(nav(page).getByRole("button", { name: "Research" })).toHaveCount(0);
  await page.unroute("**/v1/**");

  await mockApi(page, state("member", false));
  await openResearch(page);
  await expect(page.getByText("Apollo isn't connected")).toBeVisible();
  await expect(page.getByText("Ask an admin to connect Apollo.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Apollo in AI providers" })).toHaveCount(0);
});

test("admins are pointed to AI providers when Apollo is not connected", async ({ page }) => {
  await mockApi(page, state("admin", false));
  await openResearch(page);
  await expect(page.getByRole("button", { name: "Connect Apollo in AI providers" })).toBeVisible();
});

test("Research works at 360px: filters collapse and the profile stacks without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const s = state();
  await mockApi(page, s);
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Research" }).click();
  await expect(page.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
  await expect(page.getByLabel("Industry keywords")).toBeHidden();
  await page.getByRole("button", { name: /Filters/ }).first().click();
  await expect(page.getByLabel("Industry keywords")).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.getByLabel("Company name").fill("Acme");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "Save Acme Robotics" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Acme Robotics" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Ask AI" })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  const capture = process.env.PLAYWRIGHT_CAPTURE_DIR;
  if (capture) await page.screenshot({ path: `${capture}/research-profile-360.png`, fullPage: true });
});

test("demo mode: Research works from sample data with no network", async ({ page }) => {
  const leaks: string[] = [];
  let allowSessionCheck = true;
  await page.route("**/v1/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (allowSessionCheck && pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: false } });
    leaks.push(`${route.request().method()} ${pathname}`);
    return route.fulfill({ status: 599, json: { detail: "A demo request reached the network." } });
  });
  await page.goto("/");
  // The signed-out session check (run twice by React in development) happens before the demo starts.
  const explore = page.getByRole("button", { name: "Explore the demo" });
  await explore.waitFor();
  allowSessionCheck = false;
  await explore.click();
  await nav(page).getByRole("button", { name: "Research" }).click();
  await expect(page.getByRole("heading", { name: "Research", exact: true })).toBeVisible();
  const saved = page.getByRole("complementary", { name: "Saved research" });
  await expect(saved.getByText("Asha Patel")).toBeVisible();
  await page.getByLabel("Company name").fill("Globex");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("region", { name: "Company results" }).getByText("Globex Logistics")).toBeVisible();
  await saved.getByRole("button", { name: /^Acme Robotics/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Acme Robotics" })).toBeVisible();
  await expect(page.getByText("Acme Robotics opens Rotterdam service hub", { exact: false })).toBeVisible();
  const ourHistory = page.getByRole("region", { name: "Our history" });
  await expect(ourHistory.getByRole("button", { name: /Q4 automation roadmap/ })).toBeVisible();
  const chat = page.getByRole("region", { name: "Ask AI" });
  await chat.getByLabel("Ask about Acme Robotics").fill("What should I know before our next call?");
  await chat.getByRole("button", { name: "Ask" }).click();
  await expect(chat.getByText(/sample answer/)).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: "Research", exact: true }).click();
  await page.getByRole("tab", { name: "People" }).click();
  await page.getByLabel("Company websites").fill("acme-robotics.example");
  await page.getByLabel("Company websites").press("Enter");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "Look up Grace L*u" }).click();
  await expect(page.getByRole("region", { name: "People results" }).getByText("Grace Liu")).toBeVisible();
  expect(leaks).toEqual([]);
});
