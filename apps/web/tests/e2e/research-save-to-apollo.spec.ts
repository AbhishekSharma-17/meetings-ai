import { expect, test, type Page, type Route } from "@playwright/test";

/* Research "Save to Apollo": confirm dialog → duplicate check → create anyway / link to existing; members see it disabled; demo stays offline. All /v1 is mocked. */

const workspace = { id: "00000000-0000-4000-8000-000000000001", slug: "example", display_name: "Example", contact_email: null, status: "active", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", tenant_isolation_enabled: true };
const account = (role: string) => ({ user_id: "00000000-0000-4000-8000-000000000002", organization_id: workspace.id, email: `${role}@example.test`, display_name: role === "owner" ? "Owner" : "Mo", role, must_change_password: false });
const acmeId = "00000000-0000-4000-8000-0000000000c1";
const ashaId = "00000000-0000-4000-8000-0000000000c2";
const usage = (used: number) => ({ used_today: used, daily_limit: 100 });
type Json = Record<string, unknown>;

const company = { apollo_id: "org_acme", name: "Acme Robotics", domain: "acme.example", website: "https://www.acme.example", linkedin_url: "https://www.linkedin.com/company/acme", description: "Warehouse robots.", industry: "Industrial automation", employee_count: 540, revenue_band: null, total_funding: null, latest_funding_stage: null, latest_funding_date: null, latest_funding_amount: null, headquarters: "Austin, Texas", founded_year: 2016, tech_stack: [], source_id: null };
const acmeProfile = { id: acmeId, kind: "company", apollo_id: "org_acme", domain: "acme.example", name: "Acme Robotics", title: null, company: "Acme Robotics", logo_url: null, company_facts: company, person: null, news: [], hiring: null, job_groups: [],
  created_by: { id: "u1", name: "Owner" }, created_at: "2026-09-27T10:00:00Z", updated_at: "2026-09-27T10:00:00Z", fetched_at: "2026-09-27T10:00:00Z", apollo_calls: 3, can_delete: true, apollo_crm: null };
const ashaPerson = { name: "Asha Patel", title: "Chief Technology Officer", seniority: "c_suite", departments: [], company: "Acme Robotics", role_started: null, past_roles: [], linkedin_url: "https://www.linkedin.com/in/asha", location: "Austin, Texas", matched_by: "name", source_id: null };
const ashaProfile = { ...acmeProfile, id: ashaId, kind: "person", apollo_id: "per_asha", name: "Asha Patel", title: "Chief Technology Officer", company_facts: null, person: ashaPerson };

const contactPreview = { record_type: "contact", matches: [{ id: "con_1", name: "Asha Patel", detail: "CTO at Acme Robotics", url: "https://app.apollo.io/#/contacts/con_1" }],
  fields: [{ label: "First name", value: "Asha" }, { label: "Last name", value: "Patel" }, { label: "Title", value: "Chief Technology Officer" }, { label: "Company", value: "Acme Robotics" }, { label: "Company website", value: "https://acme.example" }],
  not_sent: ["LinkedIn profile: Apollo's create-contact tool has no field for it.", "Emails and phone numbers: never stored in Research, so never sent."],
  stages: [{ id: "cs_new", name: "New" }, { id: "cs_cold", name: "Cold" }], stages_note: null, owners: [], owners_note: null, usage: usage(6) };
const accountPreview = { record_type: "account", matches: [{ id: "acc_1", name: "Acme Robotics, Inc.", detail: "acme.example", url: "https://app.apollo.io/#/accounts/acc_1" }],
  fields: [{ label: "Account name", value: "Acme Robotics" }, { label: "Domain", value: "acme.example" }], not_sent: ["Phone numbers: never stored in Research, so never sent."],
  stages: [{ id: "as_target", name: "Target" }], stages_note: null, owners: [{ id: "usr_olive", name: "Olive Owner" }], owners_note: null, usage: usage(7) };
const linked = (recordType: string, id: string, action: string) => ({ record_type: recordType, record_id: id, record_name: "x", action, url: `https://app.apollo.io/#/${recordType}s/${id}`, by: { id: "u1", name: "Owner" }, at: "2026-09-30T10:00:00Z" });

function state(role = "owner") {
  return { role, profiles: { [acmeId]: { ...acmeProfile } as Json, [ashaId]: { ...ashaProfile } as Json }, requests: [] as { path: string; method: string; body: Json | null }[] };
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
    if (path === "/v1/research/status") return route.fulfill({ json: { connected: true, status: "active", can_manage: admin, can_use: true, usage: usage(4), bulk_confirm_over: 10 } });
    if (path === "/v1/research/profiles" && method === "GET") return route.fulfill({ json: Object.values(s.profiles) });
    const match = path.match(/^\/v1\/research\/profiles\/([0-9a-f-]{36})(\/.*)?$/);
    if (match) {
      const [, id, rest = ""] = match;
      if (rest === "") return route.fulfill({ json: s.profiles[id] });
      if (rest === "/apollo" && !admin) return route.fulfill({ status: 403, json: { detail: "workspace role does not permit this action" } });
      if (rest === "/apollo" && method === "GET") return route.fulfill({ json: id === ashaId ? contactPreview : accountPreview });
      if (rest === "/apollo" && method === "POST") {
        const recordType = id === ashaId ? "contact" : "account";
        const crm = body?.action === "link" ? linked(recordType, String(body.record_id), "linked") : linked(recordType, "new_1", "created");
        s.profiles[id] = { ...s.profiles[id], apollo_crm: crm };
        return route.fulfill({ json: { profile: s.profiles[id], created: body?.action === "create", usage: usage(8) } });
      }
      if (rest === "/history") return route.fulfill({ json: id === ashaId ? { meetings: [] } : { meetings: [], briefings: [], documents: [], our_company: false } });
      if (rest === "/people" || rest === "/conversations") return route.fulfill({ json: [] });
    }
    if (["/v1/provider-profiles", "/v1/provider-defaults", "/v1/calendar/connections", "/v1/calendar/schedules", "/v1/knowledge/text-profiles", "/v1/documents", "/v1/background-jobs", "/v1/knowledge-bases"].includes(path)) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "test route not mocked" } });
  });
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });

async function openSaved(page: Page, name: RegExp) {
  await page.goto("/");
  await nav(page).getByRole("button", { name: "Research" }).click();
  await page.getByRole("complementary", { name: "Saved research" }).getByRole("button", { name }).click();
}

test("an admin saves a person: the dialog shows what is written, a likely match first, then creates anyway", async ({ page }) => {
  const s = state();
  await mockApi(page, s);
  await openSaved(page, /^Asha Patel/);
  await expect(page.getByRole("heading", { level: 1, name: "Asha Patel" })).toBeVisible();
  await page.getByRole("button", { name: "Save to Apollo" }).click();
  const dialog = page.getByRole("dialog", { name: "Save to Apollo" });
  await expect(dialog.getByText("Apollo already has a likely match")).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Link to Asha Patel/ })).toBeChecked();
  await expect(dialog.getByRole("link", { name: "Open in Apollo" })).toHaveAttribute("href", "https://app.apollo.io/#/contacts/con_1");
  await expect(dialog.getByRole("button", { name: "Link to existing" })).toBeVisible();
  expect(s.requests.filter((item) => item.method === "POST" && item.path.endsWith("/apollo"))).toEqual([]);

  await dialog.getByRole("radio", { name: /Create a new contact anyway/ }).check();
  const written = dialog.getByRole("region", { name: "What will be written" });
  await expect(written.getByText("Chief Technology Officer")).toBeVisible();
  await expect(written.getByText("https://acme.example")).toBeVisible();
  await expect(written.getByText(/LinkedIn profile: Apollo's create-contact tool has no field/)).toBeVisible();
  await expect(written.getByText(/Emails and phone numbers/)).toBeVisible();
  await dialog.getByRole("combobox", { name: "Contact stage" }).click();
  await page.getByRole("option", { name: "New", exact: true }).click();
  await dialog.getByRole("button", { name: "Create anyway" }).click();

  await expect(dialog).toBeHidden();
  expect(s.requests.find((item) => item.method === "POST" && item.path.endsWith("/apollo"))?.body).toEqual({ action: "create", create_anyway: true, stage_id: "cs_new", owner_id: null });
  await expect(page.getByText("Created in Apollo as a new contact.")).toBeVisible();
  await expect(page.getByRole("link", { name: "In Apollo" })).toHaveAttribute("href", "https://app.apollo.io/#/contacts/new_1");
  await expect(page.getByText("Created as an Apollo contact by Owner", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save to Apollo" })).toHaveCount(0);
});

test("an admin links a company to the existing Apollo account without creating anything", async ({ page }) => {
  const s = state("admin");
  await mockApi(page, s);
  await openSaved(page, /^Acme Robotics/);
  await page.getByRole("button", { name: "Save to Apollo" }).click();
  const dialog = page.getByRole("dialog", { name: "Save to Apollo" });
  await expect(dialog.getByRole("radio", { name: /Link to Acme Robotics, Inc\./ })).toBeChecked();
  await expect(dialog.getByRole("region", { name: "What will be written" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Link to existing" }).click();
  await expect(dialog).toBeHidden();
  expect(s.requests.find((item) => item.method === "POST" && item.path.endsWith("/apollo"))?.body).toEqual({ action: "link", record_id: "acc_1" });
  await expect(page.getByRole("link", { name: "In Apollo" })).toHaveAttribute("href", "https://app.apollo.io/#/accounts/acc_1");
  await expect(page.getByText("Linked to an existing Apollo account by Owner", { exact: false })).toBeVisible();
});

test("members see Save to Apollo disabled with a hint to ask an admin", async ({ page }) => {
  const s = state("member");
  await mockApi(page, s);
  await openSaved(page, /^Asha Patel/);
  const button = page.getByRole("button", { name: "Save to Apollo" });
  await expect(button).toBeDisabled();
  await expect(page.getByText("Ask an admin")).toBeVisible();
  expect(s.requests.filter((item) => item.path.endsWith("/apollo"))).toEqual([]);
});

test("the Save to Apollo dialog fits a 360px phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const s = state();
  await mockApi(page, s);
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Research" }).click();
  await page.getByRole("complementary", { name: "Saved research" }).getByRole("button", { name: /^Asha Patel/ }).click();
  await page.getByRole("button", { name: "Save to Apollo" }).click();
  const dialog = page.getByRole("dialog", { name: "Save to Apollo" });
  await dialog.getByRole("radio", { name: /Create a new contact anyway/ }).check();
  const box = await dialog.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const capture = process.env.PLAYWRIGHT_CAPTURE_DIR;
  if (capture) await page.screenshot({ path: `${capture}/research-save-to-apollo-360.png` });
});

test("demo mode: Save to Apollo is simulated with no network", async ({ page }) => {
  const leaks: string[] = [];
  let allowSessionCheck = true;
  await page.route("**/v1/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (allowSessionCheck && pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: false } });
    leaks.push(`${route.request().method()} ${pathname}`);
    return route.fulfill({ status: 599, json: { detail: "A demo request reached the network." } });
  });
  await page.goto("/");
  const explore = page.getByRole("button", { name: "Explore the demo" });
  await explore.waitFor();
  allowSessionCheck = false;
  await explore.click();
  await nav(page).getByRole("button", { name: "Research" }).click();
  await page.getByRole("complementary", { name: "Saved research" }).getByRole("button", { name: /^Acme Robotics/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Acme Robotics" })).toBeVisible();
  await page.getByRole("button", { name: "Save to Apollo" }).click();
  const dialog = page.getByRole("dialog", { name: "Save to Apollo" });
  await expect(dialog.getByRole("radio", { name: /Link to Acme Robotics/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Link to existing" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("link", { name: "In Apollo" })).toBeVisible();
  expect(leaks).toEqual([]);
});
