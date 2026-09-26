import { expect, test, type Page } from "@playwright/test";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const meetingId = "00000000-0000-4000-8000-000000000099";
const liveMeetingId = "00000000-0000-4000-8000-000000000098";

const usage = {
  total_requests: 3, input_tokens: 1200, output_tokens: 200, estimated_usd: 0.0132, unpriced_requests: 1, failed_requests: 1,
  by_meeting: [], by_purpose: [{ name: "mom_generation", requests: 2, input_tokens: 1200, output_tokens: 200, estimated_usd: 0.0012, unpriced_requests: 0 }],
  by_provider: [{ name: "openai", requests: 2, input_tokens: 1200, output_tokens: 200, estimated_usd: 0.0012, unpriced_requests: 0 }, { name: "exa", requests: 1, input_tokens: 0, output_tokens: 0, estimated_usd: 0.012, unpriced_requests: 0 }],
  by_kind: [{ name: "llm", requests: 2, input_tokens: 1200, output_tokens: 200, estimated_usd: 0.0012, unpriced_requests: 0 }, { name: "search", requests: 1, input_tokens: 0, output_tokens: 0, estimated_usd: 0.012, unpriced_requests: 0 }],
  by_model: [{ name: "exa/auto", kind: "search", provider: "exa", model: "auto", requests: 1, input_tokens: 0, output_tokens: 0, estimated_usd: 0.012, unpriced_requests: 0, units: 10, unit_type: "results", failed_requests: 0 }],
  prep: { sessions: 1, events_prepared: 1, briefings_generated: 1, requests: 2, input_tokens: 500, output_tokens: 100, estimated_usd: 0.0124, unpriced_requests: 0, searches: 1 },
  transcription: { meetings: 0, audio_seconds: 0, estimated_usd: 0, unpriced: 0 },
  recent: [],
};

const event = (index: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(100000000000 + index)}`, created_at: "2026-09-25T10:00:00Z", kind: "llm", purpose: "mom_generation",
  provider: "openai", model: "gpt-6-luna", input_tokens: 1000, output_tokens: 200, units: null, unit_type: "tokens", estimated_usd: 0.0012,
  price_source: "catalog_list_price", duration_ms: 2400, status: "succeeded", meeting_id: meetingId, meeting_title: "Acme review",
  knowledge_base_id: null, knowledge_base_name: null, prep_event_id: null, prep_event_title: null, actor_user_id: userId,
  actor_display_name: "Owner", details: { profile_name: "OpenAI main", endpoint_host: "api.openai.com" }, ...overrides,
});

async function mockApi(page: Page, record: { events: URLSearchParams[]; purges: unknown[] }) {
  await page.route("**/v1/**", (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (pathname === "/v1/auth/me") return route.fulfill({ json: { user_id: userId, organization_id: organizationId, email: "owner@example.test", display_name: "Owner", role: "owner", must_change_password: false } });
    if (pathname === "/v1/workspace/operations") return route.fulfill({ json: { people: 1, meetings_captured: 1, completed_meetings: 1, saved_chats: 0, active_captures: 0, failed_captures: 0, failed_mom_jobs: 0, pending_index_jobs: 0, failed_index_jobs: 0, failed_email_deliveries: 0, latest_audit_at: null } });
    if (pathname === "/v1/workspace/usage") return route.fulfill({ json: usage });
    if (pathname === "/v1/workspace/usage/events") {
      record.events.push(url.searchParams);
      if (url.searchParams.get("kind") === "search") {
        const page1 = [event(1, { kind: "search", purpose: "meeting_prep_research", provider: "exa", model: "auto", input_tokens: null, output_tokens: null, units: 10, unit_type: "results", estimated_usd: 0.012, meeting_id: null, meeting_title: null, prep_event_id: "e1", prep_event_title: "Acme prep", details: { query_purpose: "news" } })];
        const page2 = [event(2, { kind: "search", purpose: "meeting_prep_research", provider: "exa", model: "auto", estimated_usd: null, status: "failed", meeting_title: null })];
        return route.fulfill({ json: url.searchParams.get("cursor") ? { items: page2, next_cursor: null, total: 2 } : { items: page1, next_cursor: "c1", total: 2 } });
      }
      return route.fulfill({ json: { items: [event(3), event(4)], next_cursor: null, total: 2 } });
    }
    if (pathname === "/v1/workspace/storage") return route.fulfill({ json: {
      organization_id: organizationId, measured_at: "2026-09-26T10:00:00Z", total_bytes: 5_000_000, total_rows: 120,
      categories: [
        { key: "meetings", label: "Meetings & transcripts", description: "Meeting records and transcripts.", rows: 100, bytes: 4_000_000, purgeable: true, tables: [] },
        { key: "logs", label: "Logs", description: "Usage ledger and audit trail.", rows: 20, bytes: 1_000_000, purgeable: true, tables: [] },
        { key: "workspace", label: "Workspace settings", description: "Not deletable here.", rows: 2, bytes: 100, purgeable: false, tables: [] },
      ],
      database: { dialect: "postgresql", size_bytes: 40_000_000, note: "Whole product database." },
      capture: { status: "not_requested", recording_bytes: null, recordings: 0, meetings_checked: 0, meetings_with_capture: 0, note: "" },
      method: "Row data measured per workspace.",
    } });
    if (pathname === "/v1/workspace/storage/items") return route.fulfill({ json: { category: "meetings", items: [
      { id: meetingId, label: "Acme review", created_at: "2026-08-01T00:00:00Z", bytes: 3_000_000, rows: 80, detail: "completed · google_meet" },
      { id: liveMeetingId, label: "Live standup", created_at: "2026-09-26T00:00:00Z", bytes: 500_000, rows: 10, detail: "active · zoom" },
    ] } });
    if (pathname === "/v1/workspace/storage/purge") {
      record.purges.push(route.request().postDataJSON());
      return route.fulfill({ json: { category: "meetings", deleted: { meetings: 1, search_chunks: 3 }, skipped: [{ id: liveMeetingId, reason: "stop the assistant before deleting this meeting" }], remaining: 0, reindex_queued: 0, kept: {}, bytes_before: 5_000_000, bytes_after: 2_000_000, bytes_freed_estimate: 3_000_000 } });
    }
    if (pathname === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (pathname === "/v1/workspace/members" || pathname === "/v1/workspace/calendar-connections" || pathname === "/v1/provider-profiles" || pathname === "/v1/provider-defaults" || pathname === "/v1/knowledge-bases") return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });
}

test("usage ledger filters by kind and search, pages with a cursor and shows call details", async ({ page }) => {
  const record = { events: [] as URLSearchParams[], purges: [] as unknown[] };
  await mockApi(page, record);
  await page.goto("/");
  await page.getByRole("button", { name: "Observability" }).click();
  await expect(page.getByRole("heading", { name: "Spend by kind" })).toBeVisible();
  await page.getByRole("tab", { name: /Usage ledger/ }).click();
  await expect(page.getByRole("button", { name: /Details for Minutes drafting/ }).first()).toBeVisible();
  expect(record.events.at(-1)?.get("since")).toBeTruthy();

  await page.getByRole("combobox", { name: "Kind" }).click();
  await page.getByRole("option", { name: "Web search" }).click();
  await expect(page.getByRole("button", { name: /Details for Meeting prep research/ })).toHaveCount(1);
  expect(record.events.at(-1)?.get("kind")).toBe("search");
  await expect(page.getByRole("link", { name: "Export CSV" })).toHaveAttribute("href", /export\.csv\?.*kind=search/);

  await page.getByRole("searchbox", { name: "Search usage" }).fill("acme");
  await expect.poll(() => record.events.at(-1)?.get("q")).toBe("acme");
  await expect(page.getByText("Showing 1 of 2 calls")).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("Showing 2 of 2 calls")).toBeVisible();
  expect(record.events.at(-1)?.get("cursor")).toBe("c1");
  await expect(page.getByText("Unpriced", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Details for Meeting prep research/ }).first().click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Acme prep")).toBeVisible();
  await expect(sheet.getByText("Query purpose")).toBeVisible();
  await expect(sheet.getByText("10 results").first()).toBeVisible();
});

test("storage purge needs a typed confirmation and reports deleted, skipped and freed space", async ({ page }) => {
  const record = { events: [] as URLSearchParams[], purges: [] as unknown[] };
  await mockApi(page, record);
  await page.goto("/");
  await page.getByRole("button", { name: "Observability" }).click();
  await page.getByRole("tab", { name: /Data & storage/ }).click();
  await expect(page.getByRole("heading", { name: "Data stored for this workspace" })).toBeVisible();
  await expect(page.getByText("Not deletable here", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Manage Meetings & transcripts" }).click();

  await page.getByRole("checkbox", { name: /Acme review/ }).check();
  await page.getByRole("checkbox", { name: /Live standup/ }).check();
  await page.getByRole("button", { name: /Delete selected \(2\)/ }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByText("erased from the capture service", { exact: false })).toBeVisible();
  await expect(confirm.getByText("can't be recalled", { exact: false })).toBeVisible();
  const submit = confirm.getByRole("button", { name: "Delete permanently" });
  await expect(submit).toBeDisabled();
  await confirm.getByLabel("Type DELETE to confirm").fill("delete");
  await expect(submit).toBeDisabled();
  await confirm.getByLabel("Type DELETE to confirm").fill("DELETE");
  await submit.click();

  await expect.poll(() => record.purges.length).toBe(1);
  expect(record.purges[0]).toEqual({ category: "meetings", confirm: "DELETE", reindex: false, ids: [meetingId, liveMeetingId] });
  await expect(page.getByText(/1 meeting · 3 search chunks\. About 2\.9 MB freed\./).first()).toBeVisible();
  await expect(page.getByText("stop the assistant before deleting this meeting").first()).toBeVisible();
});
