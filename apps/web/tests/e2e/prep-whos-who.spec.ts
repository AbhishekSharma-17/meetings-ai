import { expect, test, type Page, type Request } from "@playwright/test";

/* Meeting prep "who's who": our company vs. the client, attendee corrections, the "target looks like us"
   warning, the company identity editor and a 360px layout check. Every /v1 call is mocked. */

const workspace = {
  id: "00000000-0000-4000-8000-000000000001", slug: "genai-protos", display_name: "GenAI Protos", contact_email: null,
  status: "active", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", tenant_isolation_enabled: true,
};
const owner = {
  user_id: "00000000-0000-4000-8000-000000000002", organization_id: workspace.id, email: "owner@genaiprotos.com",
  display_name: "Workspace owner", role: "owner", must_change_password: false,
};
const eventId = "00000000-0000-4000-8000-000000000277";
const usage = { exa_calls: 0, llm_calls: 0, input_tokens: 0, output_tokens: 0, estimated_usd: 0, unpriced_calls: 0 };

function event() {
  const startsAt = new Date(); startsAt.setDate(startsAt.getDate() + 1); startsAt.setHours(10, 0, 0, 0);
  return {
    id: eventId, synced_at: new Date().toISOString(), connection_id: "google", provider: "googlecalendar", event_id: "acme-2",
    title: "GenAI Protos <> Acme Robotics weekly", starts_at: startsAt.toISOString(), ends_at: new Date(startsAt.getTime() + 3600_000).toISOString(),
    meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet", agenda: "https://acme-robotics.example/a/very/long/agenda/link/that/should/wrap/without/pushing/the/page/sideways", organizer: "Host",
    invitees: [
      { name: "Workspace owner", email: "owner@genaiprotos.com" }, { name: "Asha Patel", email: "asha.patel.with.a.long.mailbox@acme-robotics.example" },
      { name: "Gee Mail", email: "gee@gmail.com" }, { name: "Room 4", email: "c_4@resource.calendar.google.com" },
    ],
  };
}

type Preview = { target_company: string | null; company_website: string | null; attendee_sides: Record<string, "ours" | "theirs"> };

/** A tiny stand-in for the API resolver, enough to exercise the UI. */
function whosWho(input: Preview) {
  const targetIsUs = /genai\s*protos/i.test(input.target_company ?? "");
  const side = (key: string, auto: string) => input.attendee_sides[key] ?? auto;
  const person = (key: string, name: string, auto: string, reason: string) => ({
    key, name, email: key, side: side(key, auto), overridden: key in input.attendee_sides,
    reason: key in input.attendee_sides ? `You marked them as ${side(key, auto) === "ours" ? "your team" : "the client"}` : reason,
  });
  return {
    our_company: { name: "GenAI Protos", aliases: ["GAP"], domains: ["genaiprotos.com"], website: null, source: "identity", reason: "From your Organization brief" },
    target: { name: targetIsUs ? null : input.target_company || "Acme Robotics", aliases: [], domains: ["acme-robotics.example"], website: "https://acme-robotics.example", source: targetIsUs || !input.target_company ? "email_domain" : "inputs", reason: targetIsUs || !input.target_company ? "From email domain acme-robotics.example" : "Set in the prep inputs" },
    attendees: [
      person("owner@genaiprotos.com", "Workspace owner", "ours", "Email domain genaiprotos.com is yours"),
      person("asha.patel.with.a.long.mailbox@acme-robotics.example", "Asha Patel", "theirs", "From email domain acme-robotics.example"),
      person("gee@gmail.com", "Gee Mail", "unknown", "Personal email (gmail.com); company unknown"),
    ],
    ignored: ["c_4@resource.calendar.google.com"],
    warnings: targetIsUs ? [{ code: "target_is_us", message: "The target looked like your own company; add the client's name or website." }] : [],
  };
}

const identity = { company_name: "GenAI Protos", aliases: [], domains: ["genaiprotos.com"], configured: false, can_edit: true, updated_at: null, suggestions: { company_name: "GenAI Protos", domains: ["genaiprotos.com"] } };
const brief = { website: "https://genaiprotos.com", overview: "", services: [], products: [], differentiators: "", positioning: "", updated_at: null };

async function mockApi(page: Page, overrides: (path: string, request: Request) => object | null = () => null) {
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const custom = overrides(path, request);
    if (custom) return route.fulfill(custom);
    if (path === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (path === "/v1/auth/me") return route.fulfill({ json: owner });
    if (path === "/v1/workspace") return route.fulfill({ json: workspace });
    if (path === "/v1/workspaces") return route.fulfill({ json: [{ id: workspace.id, slug: workspace.slug, display_name: workspace.display_name, role: "owner" }] });
    if (path === "/v1/workspace/members") return route.fulfill({ json: [{ ...owner, status: "active" }] });
    if (path === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (path === "/v1/provider-profiles" || path === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (path === "/v1/calendar/connections" || path === "/v1/calendar/schedules") return route.fulfill({ json: [] });
    if (path === "/v1/calendar/synced") return route.fulfill({ json: { events: [event()], syncs: [] } });
    if (path === "/v1/knowledge/text-profiles") return route.fulfill({ json: [] });
    if (path === `/v1/calendar/events/${eventId}/prep`) return route.fulfill({ json: null });
    if (path === `/v1/calendar/events/${eventId}/prep/inputs`) return route.fulfill({ json: { target_company: null, company_website: null, links: [], notes: "", updated_at: null } });
    if (path === `/v1/calendar/events/${eventId}/prep/history`) return route.fulfill({ json: { calendar_event_id: eventId, items: [], totals: usage } });
    if (path === `/v1/calendar/events/${eventId}/prep/whos-who`) return route.fulfill({ json: whosWho(request.postDataJSON() as Preview) });
    if (path === "/v1/documents") return route.fulfill({ json: [] });
    if (path === "/v1/workspace/identity") return route.fulfill({ json: identity });
    if (path === "/v1/workspace/brief") return route.fulfill({ json: brief });
    if (path === "/v1/workspace/brief/documents") return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "test route not mocked" } });
  });
}

async function openPrep(page: Page, { mobile = false } = {}) {
  await page.goto("/");
  if (mobile) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "Meeting prep" }).click();
  } else {
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meeting prep" }).click();
  }
  await expect(page.getByRole("heading", { name: "Meeting prep" })).toBeVisible();
}

test("who's who separates our side from the client and corrections reach the briefing", async ({ page }) => {
  const previews: Preview[] = [];
  let generated: Record<string, unknown> | null = null;
  await mockApi(page, (path, request) => {
    if (path.endsWith("/prep/whos-who")) previews.push(request.postDataJSON() as Preview);
    if (path === `/v1/calendar/events/${eventId}/prep/inputs` && request.method() === "PUT") return { json: { ...(request.postDataJSON() as object), updated_at: new Date().toISOString() } };
    if (path === `/v1/calendar/events/${eventId}/prep/jobs`) { generated = request.postDataJSON(); return { status: 404, json: { detail: "no jobs" } }; }
    if (path === `/v1/calendar/events/${eventId}/prep/stream`) return { status: 500, json: { detail: "The briefing could not be completed." } };
    return null;
  });
  await openPrep(page);

  const panel = page.getByRole("region", { name: "Who’s who" });
  const ours = panel.getByRole("region", { name: "Your side" });
  const client = panel.getByRole("region", { name: "Client" });
  await expect(ours.getByText("GenAI Protos", { exact: true })).toBeVisible();
  await expect(ours.getByText("From your Organization brief")).toBeVisible();
  await expect(ours.getByText("Workspace owner")).toBeVisible();
  await expect(client.getByText("Acme Robotics", { exact: true })).toBeVisible();
  await expect(client.getByText("From email domain acme-robotics.example").first()).toBeVisible();
  await expect(client.getByText("Asha Patel")).toBeVisible();
  const others = panel.getByRole("region", { name: "Others in the invite" });
  await expect(others.getByText("Gee Mail")).toBeVisible();
  await expect(others.getByText("Unclassified")).toBeVisible();
  await expect(panel.getByText("1 calendar or system address ignored (rooms, groups, no-reply).")).toBeVisible();

  await others.getByRole("group", { name: "Which side is Gee Mail on?" }).getByRole("button", { name: "Client" }).click();
  await expect(client.getByText("Gee Mail")).toBeVisible();
  await expect(client.getByText("Corrected")).toBeVisible();
  await expect.poll(() => previews.at(-1)?.attendee_sides).toEqual({ "gee@gmail.com": "theirs" });

  await page.getByRole("button", { name: "Generate briefing" }).click();
  await expect.poll(() => generated?.attendee_sides).toEqual({ "gee@gmail.com": "theirs" });

  await client.getByRole("button", { name: "Undo the correction for Gee Mail" }).click();
  await expect(others.getByText("Gee Mail")).toBeVisible();
});

test("a target that looks like our own company is flagged", async ({ page }) => {
  await mockApi(page);
  await openPrep(page);
  await page.getByLabel("Target company").fill("GenAI Protos");
  const warning = page.getByRole("region", { name: "Who’s who" }).getByText("The target looked like your own company; add the client's name or website.");
  await expect(warning).toBeVisible();
  await expect(page.getByText("That looks like your own company")).toBeVisible();
  await page.getByLabel("Target company").fill("Acme Robotics");
  await expect(warning).toBeHidden();
});

test("the company identity is edited in the Organization brief", async ({ page }) => {
  let saved: Record<string, unknown> | null = null;
  await mockApi(page, (path, request) => {
    if (path === "/v1/workspace/identity" && request.method() === "PUT") {
      saved = request.postDataJSON();
      return { json: { ...identity, ...saved, configured: true, updated_at: new Date().toISOString() } };
    }
    if (path === "/v1/workspace/brief" && request.method() === "PUT") return { json: request.postDataJSON() };
    return null;
  });
  await openPrep(page);
  await page.getByRole("button", { name: "Company profile" }).click();
  const card = page.locator("#settings-brief");
  await expect(card.getByLabel("Company name")).toHaveValue("GenAI Protos");
  await expect(card.getByText("Suggested from your workspace name and member emails", { exact: false })).toBeVisible();
  const aliases = card.getByLabel(/Other names/);
  await aliases.fill("GAP");
  await aliases.press("Enter");
  const domains = card.getByLabel("Our email domains");
  await domains.fill("gmail.com");
  await domains.press("Enter");
  await expect(card.getByText("is a personal email provider", { exact: false })).toBeVisible();
  await card.getByRole("button", { name: "Remove gmail.com" }).click();
  await domains.fill("https://www.GenAIProtos.ai/about");
  await domains.press("Enter");
  await expect(card.getByText("genaiprotos.ai", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save company profile" }).click();
  await expect.poll(() => saved).toEqual({ company_name: "GenAI Protos", aliases: ["GAP"], domains: ["genaiprotos.com", "genaiprotos.ai"] });
});

test("the prep page has no horizontal scroll at 360px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mockApi(page);
  await openPrep(page, { mobile: true });
  await expect(page.getByRole("region", { name: "Who’s who" }).getByText("Asha Patel")).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByRole("tab", { name: /History/ }).click();
  expect(await overflow()).toBeLessThanOrEqual(0);
});
