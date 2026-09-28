import { expect, test, type Page } from "@playwright/test";

const workspace = {
  id: "00000000-0000-4000-8000-000000000001", slug: "genai-protos", display_name: "GenAI Protos", contact_email: null,
  status: "active", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", tenant_isolation_enabled: true,
};
const owner = {
  user_id: "00000000-0000-4000-8000-000000000002", organization_id: workspace.id, email: "owner@example.test",
  display_name: "Workspace owner", role: "owner", must_change_password: false,
};
const eventId = "00000000-0000-4000-8000-000000000177";
const usage = { exa_calls: 11, llm_calls: 2, input_tokens: 9000, output_tokens: 1400, estimated_usd: 0.1234, unpriced_calls: 0 };

function event() {
  const startsAt = new Date(); startsAt.setDate(startsAt.getDate() + 1); startsAt.setHours(10, 0, 0, 0);
  return {
    id: eventId, synced_at: new Date().toISOString(), connection_id: "outlook-account", provider: "outlook", event_id: "acme-1",
    title: "Acme Robotics discovery", starts_at: startsAt.toISOString(), ends_at: new Date(startsAt.getTime() + 3600_000).toISOString(),
    meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet", agenda: "Scope a pilot", organizer: "Host",
    invitees: [{ name: "Asha Patel", email: "asha@acme.example" }, { name: "Ben Ortiz", email: "ben@acme.example" }],
  };
}

const reportV2 = {
  report_version: 2, id: "00000000-0000-4000-8000-000000000178", calendar_event_id: eventId,
  target_company: "Acme Robotics", company_website: "https://acme.example",
  executive_brief: "Acme Robotics is scaling AI-driven warehouse automation.",
  company: { name: "Acme Robotics", website: "https://acme.example", what_they_do: "Builds warehouse robots.", industry: "Robotics", size_signals: "About 500 staff", headquarters: "Austin, Texas", source_ids: ["W1"] },
  recent_developments: [{ title: "MOU with Port of Rotterdam", date: "2026-08-01", type: "mou", summary: "Signed an automation MOU.", source_ids: ["L1"] }],
  ai_landscape: { summary: "Actively buying AI tooling.", source_ids: ["W1"], initiatives: [{ statement: "Vision-based picking.", source_ids: ["W1"] }], vendors: [], end_clients: [] },
  alignment: { fit_summary: "Strong fit for retrieval work.", relevant_services: [{ service: "RAG platforms", why: "Searchable manuals", talking_point: "Offer a two-week pilot", source_ids: ["D1"] }] },
  attendees: [
    { name: "Asha Patel", email: "asha@acme.example", title: "CTO", linkedin_url: "https://www.linkedin.com/in/asha", match_confidence: "confirmed", background: "Leads platform engineering.", likely_interests: ["MLOps"], persona: "technical", angle: "Go deep on architecture.", source_ids: ["P1"] },
    { name: "Ben Ortiz", email: "ben@acme.example", title: null, linkedin_url: null, match_confidence: "unconfirmed", background: "", likely_interests: [], persona: "unknown", angle: "Confirm his role early.", source_ids: [] },
  ],
  meeting_narrative: { recommended_focus: "Technical depth first", opening: "Thank them for the MOU news", by_persona: [{ persona: "technical", focus: "Architecture and data" }], agenda_suggestions: ["Current stack", "Pilot scope"] },
  talking_points: ["Retrieval pilots"], questions_to_ask: ["What blocks rollout?"], watchouts: ["Budget timing"],
  sources: [
    { id: "W1", title: "Acme overview", url: "https://source.example/acme", publisher: "source.example", published_date: "2026-08-01", origin: "web" },
    { id: "P1", title: "Asha Patel - CTO", url: "https://www.linkedin.com/in/asha", publisher: "linkedin.com", published_date: null, origin: "web" },
    { id: "L1", title: "MOU press release", url: "https://acme.example/press/mou", publisher: "acme.example", published_date: null, origin: "provided_link" },
    { id: "D1", title: "acme-proposal.md", url: null, publisher: null, published_date: null, origin: "prep_upload" },
  ],
  public_research_performed: true, research_steps: [], usage, started_at: new Date().toISOString(),
  generated_at: new Date().toISOString(), provider: "openai", model: "gpt-test",
  findings: [], relevant_offerings: ["RAG platforms"], people_notes: [],
};

async function mockApi(page: Page, overrides: (path: string, method: string) => object | null = () => null) {
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const custom = overrides(path, request.method());
    if (custom) return route.fulfill(custom);
    if (path === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (path === "/v1/auth/me") return route.fulfill({ json: owner });
    if (path === "/v1/workspace") return route.fulfill({ json: workspace });
    if (path === "/v1/workspaces") return route.fulfill({ json: [{ id: workspace.id, slug: workspace.slug, display_name: workspace.display_name, role: "owner" }] });
    if (path === "/v1/workspace/members") return route.fulfill({ json: [{ ...owner, status: "active" }] });
    if (path === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (path === "/v1/provider-profiles" || path === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (path === "/v1/calendar/connections") return route.fulfill({ json: [] });
    if (path === "/v1/calendar/schedules") return route.fulfill({ json: [] });
    if (path === "/v1/calendar/synced") return route.fulfill({ json: { events: [event()], syncs: [] } });
    if (path === "/v1/knowledge/text-profiles") return route.fulfill({ json: [] });
    if (path === `/v1/calendar/events/${eventId}/prep`) return route.fulfill({ json: null });
    if (path === `/v1/calendar/events/${eventId}/prep/inputs`) return route.fulfill({ json: { target_company: "Acme Robotics", company_website: "https://acme.example", links: ["https://acme.example/press/mou"], notes: "Learn their AI roadmap", updated_at: "2026-09-26T09:00:00Z" } });
    if (path === `/v1/calendar/events/${eventId}/prep/history`) return route.fulfill({ json: { calendar_event_id: eventId, items: [], totals: { ...usage, exa_calls: 0, llm_calls: 0, input_tokens: 0, output_tokens: 0, estimated_usd: 0 } } });
    if (path === "/v1/documents") return route.fulfill({ json: [{ id: "doc-1", scope: "prep", scope_id: eventId, filename: "acme-proposal.pdf", content_type: "application/pdf", source_url: null, size_bytes: 204800, page_count: 12, ocr_page_count: 3, status: "indexed", error: null, summary: null, chunk_count: 8, character_count: 9000, created_at: "2026-09-26T09:00:00Z" }] });
    return route.fulfill({ status: 404, json: { detail: "test route not mocked" } });
  });
}

async function openPrep(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meeting prep" }).click();
  await expect(page.getByRole("heading", { name: "Meeting prep" })).toBeVisible();
}

const sse = (events: [string, unknown][]) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");

test("prep inputs persist and a streamed v2 briefing renders as a document", async ({ page }) => {
  let savedInputs: Record<string, unknown> | null = null;
  let streamed: Record<string, unknown> | null = null;
  let generated = false;
  await mockApi(page, (path, method) => {
    if (path === `/v1/calendar/events/${eventId}/prep/inputs` && method === "PUT") return { json: { ...(savedInputs ?? {}), updated_at: new Date().toISOString() } };
    if (path === `/v1/calendar/events/${eventId}/prep/history` && generated) return { json: { calendar_event_id: eventId, items: [{ id: reportV2.id, report_version: 2, target_company: "Acme Robotics", generated_at: reportV2.generated_at, provider: "openai", model: "gpt-test", public_research_performed: true, usage }], totals: usage } };
    if (path === `/v1/calendar/events/${eventId}/prep/stream`) {
      generated = true;
      return { status: 200, headers: { "content-type": "text/event-stream" }, body: sse([
        ["progress", { stage: "queued", message: "Preparing research" }], ["progress", { stage: "planning", message: "Planning" }],
        ["progress", { stage: "searching", message: "Searching" }], ["progress", { stage: "reading", message: "Reading" }],
        ["progress", { stage: "writing", message: "Writing" }], ["progress", { stage: "done", message: "Done" }], ["final", reportV2],
      ]) };
    }
    return null;
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/prep/inputs") && request.method() === "PUT") savedInputs = request.postDataJSON();
    if (path.endsWith("/prep/stream")) streamed = request.postDataJSON();
  });
  await openPrep(page);

  await expect(page.getByLabel("Target company")).toHaveValue("Acme Robotics");
  await expect(page.getByLabel("Company website")).toHaveValue("https://acme.example");
  await expect(page.getByText("acme.example/press/mou")).toBeVisible();
  await expect(page.getByText("acme-proposal.pdf")).toBeVisible();
  await expect(page.getByText("12 pages · 3 read with OCR")).toBeVisible();

  const links = page.getByLabel(/Reference links/);
  await links.fill("http://insecure.example");
  await links.press("Enter");
  await expect(page.getByText("isn’t a valid https:// link")).toBeVisible();
  await links.fill("https://acme.example/partners");
  await links.press("Enter");
  await expect(page.getByText("acme.example/partners")).toBeVisible();

  await page.getByRole("button", { name: "Generate briefing" }).click();
  await expect(page.getByRole("heading", { name: "Briefing: Acme Robotics" })).toBeVisible();
  expect(savedInputs).toMatchObject({ target_company: "Acme Robotics", company_website: "https://acme.example", links: ["https://acme.example/press/mou", "https://acme.example/partners"], notes: "Learn their AI roadmap" });
  expect(streamed).toMatchObject({ target_company: "Acme Robotics", research_enabled: true, profile_urls: ["https://acme.example/press/mou", "https://acme.example/partners"] });

  const report = page.getByRole("article", { name: "Briefing: Acme Robotics" });
  await expect(report.getByText("Builds warehouse robots.")).toBeVisible();
  await expect(report.getByText("MOU", { exact: true })).toBeVisible();
  await expect(report.getByText("MOU with Port of Rotterdam")).toBeVisible();
  await expect(report.getByText("Offer a two-week pilot")).toBeVisible();
  const asha = report.getByRole("article", { name: "Asha Patel" });
  await expect(asha.getByText("Profile confirmed")).toBeVisible();
  await expect(asha.getByRole("link", { name: "Public profile for Asha Patel" })).toHaveAttribute("href", "https://www.linkedin.com/in/asha");
  const ben = report.getByRole("article", { name: "Ben Ortiz" });
  await expect(ben.getByText("Profile unconfirmed")).toBeVisible();
  await expect(ben.getByRole("link")).toHaveCount(0);
  await expect(report.getByRole("heading", { name: "Uploaded for this meeting" })).toBeVisible();
  await expect(report.getByRole("heading", { name: "Links you provided" })).toBeVisible();
  await expect(report.getByText("acme-proposal.md")).toBeVisible();
  await expect(report.getByText("Technical depth first")).toBeVisible();

  await page.getByRole("tab", { name: /History/ }).click();
  await expect(page.getByRole("heading", { name: "Briefing history" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "OpenAI / gpt-test" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "$0.12" })).toBeVisible();
});

test("a missing Exa key explains the setup step instead of failing silently", async ({ page }) => {
  await mockApi(page, (path) => {
    if (path === `/v1/calendar/events/${eventId}/prep/stream`) return { status: 409, json: { detail: "Add an Exa key in AI providers to run public research, or turn off public research." } };
    if (path === `/v1/calendar/events/${eventId}/prep/inputs`) return { json: { target_company: null, company_website: null, links: [], notes: "", updated_at: null } };
    return null;
  });
  await openPrep(page);
  await page.getByRole("button", { name: "Generate briefing" }).click();
  await expect(page.getByText("Setup needed")).toBeVisible();
  await expect(page.getByText(/Add an Exa key in AI providers/)).toBeVisible();
});
