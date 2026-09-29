import { expect, test, type Page } from "@playwright/test";

/* Apollo as a research source: connect in AI providers, briefing facts and sources, credits row, 360px. All /v1 is mocked. */

const workspace = { id: "00000000-0000-4000-8000-000000000001", slug: "example", display_name: "Example", contact_email: null, status: "active", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", tenant_isolation_enabled: true };
const owner = { user_id: "00000000-0000-4000-8000-000000000002", organization_id: workspace.id, email: "owner@example.test", display_name: "Owner", role: "owner", must_change_password: false };
const eventId = "00000000-0000-4000-8000-000000000177";
const apolloKey = "apollo-key-never-shown-4411";
const apolloId = "00000000-0000-4000-8000-0000000000a1";
const credits = [
  { credit_type: "email", label: "Email credits", used: 400, limit: 1000, remaining: 600, unit: "credits" },
  { credit_type: "export", label: "Export credits", used: 950, limit: 1000, remaining: 50, unit: "credits" },
  { credit_type: "dialer", label: "Dialer minutes", used: 0, limit: 120, remaining: 120, unit: "minutes" },
];
type Json = Record<string, unknown>;

function event() {
  const startsAt = new Date(); startsAt.setDate(startsAt.getDate() + 1); startsAt.setHours(10, 0, 0, 0);
  return { id: eventId, synced_at: new Date().toISOString(), connection_id: "outlook-account", provider: "outlook", event_id: "acme-1", title: "Acme Robotics discovery",
    starts_at: startsAt.toISOString(), ends_at: new Date(startsAt.getTime() + 3600_000).toISOString(), meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet",
    agenda: "Scope a pilot", organizer: "Host", invitees: [{ name: "Asha Patel", email: "asha@acme.example" }] };
}

const usage = { exa_calls: 11, llm_calls: 2, input_tokens: 9000, output_tokens: 1400, estimated_usd: 0.1234, unpriced_calls: 0, apollo_calls: 7 };
const asha = { name: "Asha Patel", title: "Chief Technology Officer", seniority: "c_suite", departments: ["engineering technical"], company: "Acme Robotics", role_started: "2022-03-01",
  past_roles: [{ company: "Globex", title: "VP Data Platforms", start_date: "2018-01-01", end_date: "2022-02-01", current: false }], linkedin_url: "https://www.linkedin.com/in/asha",
  location: "Austin, Texas", matched_by: "email", source_id: "A2" };
const report = {
  report_version: 2, id: "00000000-0000-4000-8000-000000000178", calendar_event_id: eventId, target_company: "Acme Robotics", company_website: "https://acme.example",
  executive_brief: "Acme Robotics is scaling AI-driven warehouse automation.",
  company: { name: "Acme Robotics", website: "https://acme.example", what_they_do: "Builds warehouse robots.", industry: "Robotics", size_signals: "", headquarters: "", source_ids: ["A1", "W1"] },
  recent_developments: [], ai_landscape: { summary: "", source_ids: [], initiatives: [], vendors: [], end_clients: [] }, alignment: { fit_summary: "", relevant_services: [] },
  attendees: [{ name: "Asha Patel", email: "asha@acme.example", title: "Chief Technology Officer", linkedin_url: "https://www.linkedin.com/in/asha", match_confidence: "confirmed", background: "Leads platform engineering.", likely_interests: [], persona: "technical", angle: "Go deep on architecture.", source_ids: ["A2"], side: "theirs", apollo: asha }],
  meeting_narrative: { recommended_focus: "", opening: "", by_persona: [], agenda_suggestions: [] }, talking_points: [], questions_to_ask: [], watchouts: [],
  sources: [
    { id: "A1", title: "Apollo · Acme Robotics company profile", url: "https://www.linkedin.com/company/acme", publisher: "linkedin.com", published_date: "2026-09-29", origin: "apollo" },
    { id: "A2", title: "Apollo · Asha Patel (Chief Technology Officer)", url: "https://www.linkedin.com/in/asha", publisher: "linkedin.com", published_date: "2026-09-29", origin: "apollo" },
    { id: "A3", title: "Apollo · News: Acme opens Rotterdam hub", url: "https://news.example/acme-hub", publisher: "news.example", published_date: "2026-09-01", origin: "apollo" },
    { id: "A4", title: "Apollo · Acme Robotics open roles", url: null, publisher: null, published_date: "2026-09-29", origin: "apollo" },
    { id: "A5", title: "Apollo · Acme Robotics in your Apollo CRM", url: null, publisher: null, published_date: "2026-09-29", origin: "apollo" },
    { id: "W1", title: "Acme overview", url: "https://source.example/acme", publisher: "source.example", published_date: "2026-08-01", origin: "web" },
  ],
  public_research_performed: true, research_steps: [], usage, started_at: new Date().toISOString(), generated_at: new Date().toISOString(), provider: "openai", model: "gpt-test",
  findings: [], relevant_offerings: [], people_notes: [],
  apollo: {
    company: { apollo_id: "org_acme", name: "Acme Robotics", domain: "acme.example", website: "https://acme.example", linkedin_url: "https://www.linkedin.com/company/acme", description: null,
      industry: "Industrial automation", employee_count: 1200, revenue_band: "$50M-$100M", total_funding: "$120M", latest_funding_stage: "Series C", latest_funding_date: "2025-06-01",
      latest_funding_amount: "$60M", headquarters: "Austin, Texas, United States", founded_year: 2012, tech_stack: ["AWS", "Snowflake", "Kubernetes"], source_id: "A1" },
    people: [asha],
    news: [{ title: "Acme opens Rotterdam hub", url: "https://news.example/acme-hub", published_at: "2026-09-01", snippet: null, source_id: "A3" }],
    hiring: { open_roles: 12, themes: [{ theme: "Engineering", count: 5 }, { theme: "Sales", count: 3 }], examples: [{ title: "Senior ML Engineer", url: null, location: "Austin, Texas", posted_at: null }], source_id: "A4" },
    relationship: { account_name: "Acme Robotics", stage: "Prospect", owner: null, last_activity_at: "2026-08-20", contacts: [{ name: "Asha Patel", title: "CTO", stage: null, last_activity_at: null }], source_id: "A5" },
    calls: 7, cached_results: 0, notice: null, fetched_at: new Date().toISOString(),
  },
};

function state() {
  return { connected: false, puts: [] as Json[] };
}
type State = ReturnType<typeof state>;
const view = (s: State, withCredits = false) => s.connected
  ? { provider: "apollo", available: true, connected: true, status: "active", hint: "••••4411", connected_by: "Owner", connected_at: "2026-09-29T08:00:00Z", updated_at: "2026-09-29T08:00:00Z", last_checked_at: "2026-09-29T08:00:00Z", last_error: null, credits: withCredits ? credits : [] }
  : { provider: "apollo", available: true, connected: false, status: null, hint: null, connected_by: null, connected_at: null, updated_at: null, last_checked_at: null, last_error: null, credits: [] };

const apolloBalance = { credential_id: apolloId, provider: "apollo", label: "Apollo (workspace)", hint: "••••4411", balance_usd: null, limit_usd: null, remaining_usd: null, spent_usd: null,
  spent_period: null, our_tracked_spend_usd: 0, status: "low", source: "provider_api", checked_at: new Date().toISOString(), note: "Apollo credits for the current billing cycle.",
  dashboard_url: "https://app.apollo.io/#/settings/credits/current", credits };

async function mockApi(page: Page, s: State) {
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (path === "/v1/auth/me") return route.fulfill({ json: owner });
    if (path === "/v1/workspace") return route.fulfill({ json: workspace });
    if (path === "/v1/workspaces") return route.fulfill({ json: [{ id: workspace.id, slug: workspace.slug, display_name: workspace.display_name, role: "owner" }] });
    if (path === "/v1/workspace/members") return route.fulfill({ json: [{ ...owner, status: "active" }] });
    if (path === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (path === "/v1/workspace/integrations/apollo" && method === "GET") return route.fulfill({ json: view(s) });
    if (path === "/v1/workspace/integrations/apollo" && method === "PUT") {
      s.puts.push(request.postDataJSON() as Json);
      s.connected = true;
      return route.fulfill({ json: view(s, true) });
    }
    if (path === "/v1/ai/settings") return route.fulfill({ json: { can_edit: true, chat_profile_id: null, chat_model: null, vision_profile_id: null, vision_model: null, research_credential_id: null, research_credential_label: null, research_profile_id: null, research_model: null, updated_at: null, updated_by: null, vision_configured: false, research_configured: false, effective_chat: { profile_id: null, profile_name: null, provider: null, model: null, source: "not_configured" } } });
    if (path === "/v1/credentials") return route.fulfill({ json: [] });
    if (path === "/v1/provider-balances") return route.fulfill({ json: { items: s.connected ? [apolloBalance] : [], billing_keys: [], low_balance_threshold_usd: 5, checked_at: new Date().toISOString() } });
    if (path === "/v1/workspace/operations") return route.fulfill({ json: { people: 1, meetings_captured: 0, completed_meetings: 0, saved_chats: 0, active_captures: 0, failed_captures: 0, failed_mom_jobs: 0, pending_index_jobs: 0, failed_index_jobs: 0, failed_email_deliveries: 0, latest_audit_at: null } });
    if (path === "/v1/workspace/usage") return route.fulfill({ json: { total_requests: 0, input_tokens: 0, output_tokens: 0, estimated_usd: 0, unpriced_requests: 0, failed_requests: 0, by_meeting: [], by_purpose: [], by_provider: [], by_kind: [], by_model: [], recent: [] } });
    if (["/v1/provider-profiles", "/v1/provider-defaults", "/v1/calendar/connections", "/v1/calendar/schedules", "/v1/knowledge/text-profiles", "/v1/knowledge-bases", "/v1/documents"].includes(path)) return route.fulfill({ json: [] });
    if (path === "/v1/calendar/synced") return route.fulfill({ json: { events: [event()], syncs: [] } });
    if (path === `/v1/calendar/events/${eventId}/prep`) return route.fulfill({ json: report });
    if (path === `/v1/calendar/events/${eventId}/prep/inputs`) return route.fulfill({ json: { target_company: "Acme Robotics", company_website: "https://acme.example", links: [], notes: "", updated_at: null } });
    if (path === `/v1/calendar/events/${eventId}/prep/history`) return route.fulfill({ json: { calendar_event_id: eventId, items: [], totals: usage } });
    return route.fulfill({ status: 404, json: { detail: "test route not mocked" } });
  });
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("owner connects Apollo once under AI providers; the key is never shown again", async ({ page }) => {
  const s = state();
  await mockApi(page, s);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "AI providers" }).click();
  const card = page.locator(".research-sources");
  await expect(card.getByRole("heading", { name: "Research sources" })).toBeVisible();
  await expect(card.getByText("Not connected")).toBeVisible();
  await card.getByRole("button", { name: "Connect Apollo" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect Apollo" });
  await expect(dialog.getByText("Adds verified company and people details", { exact: false })).toBeVisible();
  await dialog.getByLabel("Apollo API key").fill(apolloKey);
  await dialog.getByRole("button", { name: "Connect" }).click();
  await expect(dialog).toBeHidden();
  expect(s.puts).toEqual([{ api_key: apolloKey }]);
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await expect(card.getByText("••••4411")).toBeVisible();
  await expect(card.getByText("50 of 1,000 left")).toBeVisible();
  await expect(card.getByText("120 min of 120 min left")).toBeVisible();
  await expect(page.getByText(apolloKey)).toHaveCount(0);
});

test("a briefing shows the Apollo company snapshot, enriched attendee cards and Apollo sources", async ({ page }) => {
  const s = state();
  s.connected = true;
  await mockApi(page, s);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meeting prep" }).click();
  const article = page.getByRole("article", { name: "Briefing: Acme Robotics" });
  await expect(article).toBeVisible();
  await expect(article.getByText("7 Apollo lookups")).toBeVisible();
  const facts = article.getByLabel("Verified company data from Apollo");
  await expect(facts.getByText("~1,200")).toBeVisible();
  await expect(facts.getByText("$50M-$100M")).toBeVisible();
  await expect(facts.getByText("$120M total · latest Series C, $60M", { exact: false })).toBeVisible();
  await expect(facts.getByRole("link", { name: "Source A1" })).toBeVisible();
  await expect(facts.getByRole("list", { name: "Technologies they use" }).getByText("Snowflake")).toBeVisible();
  await expect(article.getByText("Hiring 12 roles (Engineering 5, Sales 3) · 1 news item in the last 90 days")).toBeVisible();
  await expect(article.locator(".prep-apollo-relationship")).toContainText("In your Apollo CRM: Prospect");
  const person = article.getByRole("article", { name: "Asha Patel" });
  await expect(person.getByText("Chief Technology Officer")).toBeVisible();
  await expect(person.getByText(/c suite · .* in role · Austin, Texas/i)).toBeVisible();
  await expect(person.getByText("Globex")).toBeVisible();
  await expect(person.getByRole("link", { name: "Source A2" }).first()).toBeVisible();
  const sources = article.locator(".prep-sources");
  await expect(sources.getByRole("heading", { name: "Apollo (verified B2B data)" })).toBeVisible();
  await expect(sources.getByText("Apollo · Acme Robotics company profile")).toBeVisible();

  await page.getByRole("tab", { name: "Inputs" }).click();
  await expect(page.getByText("Refresh from Apollo")).toBeVisible();
});

test("Observability lists Apollo credits per type", async ({ page }) => {
  const s = state();
  s.connected = true;
  await mockApi(page, s);
  await page.goto("/");
  await page.getByRole("button", { name: "Observability" }).click();
  const row = page.locator(".provider-credit").filter({ hasText: "Apollo (workspace)" });
  await expect(row.locator(".balance-chip")).toHaveText("Export credits low");
  await expect(row.getByText("Email credits")).toBeVisible();
  await expect(row.getByText("600 of 1,000 left")).toBeVisible();
  await expect(row.locator("[data-state=low] dd")).toHaveText("50 of 1,000 left");
});

test("Apollo views fit a 360px screen", async ({ page }) => {
  const s = state();
  s.connected = true;
  await mockApi(page, s);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Meeting prep" }).last().click();
  await expect(page.getByLabel("Verified company data from Apollo")).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "AI providers" }).last().click();
  await expect(page.locator(".research-sources").getByText("••••4411")).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Observability" }).last().click();
  await expect(page.locator(".provider-credit").first()).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("demo mode: Apollo is connected with sample credits and briefing data, and nothing reaches the network", async ({ page }) => {
  test.setTimeout(90_000);
  const leaks: string[] = [];
  let allowSessionCheck = true;
  await page.route("**/v1/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (allowSessionCheck && pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: false } });
    leaks.push(`${route.request().method()} ${pathname}`);
    return route.fulfill({ status: 599, json: { detail: "A demo request reached the network." } });
  });
  await page.goto("/");
  allowSessionCheck = false;
  await page.getByRole("button", { name: "Explore the demo" }).click();
  const nav = (name: string) => page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name, exact: true }).click();

  await nav("Meeting prep");
  await page.getByRole("button", { name: /Discovery call: Fabrikam Health/ }).click();
  await page.getByRole("tab", { name: /Inputs/ }).click();
  await expect(page.getByText("Refresh from Apollo")).toBeVisible();
  await page.getByRole("button", { name: "Generate briefing" }).click();
  const briefing = page.getByRole("article", { name: "Briefing: Fabrikam Health" });
  await expect(briefing).toBeVisible({ timeout: 20_000 });
  await expect(briefing.getByLabel("Verified company data from Apollo")).toBeVisible();

  await nav("AI providers");
  const card = page.locator(".research-sources");
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await expect(card.getByText("••••7Q2m")).toBeVisible();

  await nav("Observability");
  await expect(page.locator(".provider-credit").filter({ hasText: "Apollo (workspace)" }).locator(".balance-chip")).toHaveText("Export credits low");
  expect(leaks).toEqual([]);
});
