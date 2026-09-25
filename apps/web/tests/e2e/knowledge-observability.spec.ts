import { expect, test } from "@playwright/test";

const organizationId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
const baseId = "00000000-0000-4000-8000-000000000066";

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (pathname === "/v1/auth/me") return route.fulfill({ json: { user_id: userId, organization_id: organizationId, email: "owner@example.test", display_name: "Owner", role: "owner", must_change_password: false } });
    if (pathname === "/v1/provider-profiles" || pathname === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (pathname === "/v1/knowledge-bases") return route.fulfill({ json: [{ id: baseId, organization_id: organizationId, name: "Acme research", description: null, created_by: userId, visibility: "private", text_profile_id: null, meeting_count: 1, shared_user_ids: [], created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z" }] });
    if (pathname === `/v1/knowledge-bases/${baseId}/conversations`) return route.fulfill({ json: [] });
    if (pathname === "/v1/workspace/members") return route.fulfill({ json: [] });
    if (pathname === "/v1/workspace/calendar-connections") return route.fulfill({ json: [{ id: "ca-1", provider: "outlook", status: "ACTIVE", label: "Work calendar", user_id: userId, user_name: "Owner", user_email: "owner@example.test" }] });
    if (pathname === "/v1/calendar/connections") return route.fulfill({ json: [{ id: "ca-1", provider: "outlook", status: "ACTIVE", label: "owner@example.test" }] });
    if (pathname === "/v1/calendar/schedules") return route.fulfill({ json: [] });
    if (pathname === "/v1/meetings") return route.fulfill({ json: { items: [{ id: "00000000-0000-4000-8000-000000000099", title: "Acme review", meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet", status: "ready", bot_name: "Meetings AI", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", joined_at: null, stopped_at: null, participant_count: 2 }], count: 1 } });
    if (pathname === "/v1/workspace/operations") return route.fulfill({ json: { people: 2, meetings_captured: 3, completed_meetings: 2, saved_chats: 1, active_captures: 0, failed_captures: 1, failed_mom_jobs: 0, pending_index_jobs: 0, failed_index_jobs: 0, failed_email_deliveries: 0, latest_audit_at: null } });
    if (pathname === "/v1/workspace/usage") return route.fulfill({ json: { total_requests: 3, input_tokens: 1200, output_tokens: 200, estimated_usd: 0.0012, unpriced_requests: 1, by_meeting: [], by_purpose: [{ name: "mom_generation", requests: 2, input_tokens: 1000, output_tokens: 200, estimated_usd: 0.0012, unpriced_requests: 0 }, { name: "knowledge_embedding", requests: 1, input_tokens: 200, output_tokens: 0, estimated_usd: 0, unpriced_requests: 1 }], by_provider: [{ name: "openai", requests: 3, input_tokens: 1200, output_tokens: 200, estimated_usd: 0.0012, unpriced_requests: 1 }], recent: [] } });
    return route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });
});

test("knowledge workspace keeps rail and conversation separate at common widths", async ({ page }) => {
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    if (width < 768) await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "AI knowledge" }).click();
    await expect(page.getByRole("heading", { name: "Your meeting wiki." })).toBeVisible();
    await page.getByRole("button", { name: /Acme research/ }).click();
    const positions = await page.evaluate(() => {
      const rail = document.querySelector(".knowledge-library")!.getBoundingClientRect();
      const main = document.querySelector(".knowledge-main")!.getBoundingClientRect();
      return { rail: { left: rail.left, right: rail.right, bottom: rail.bottom }, main: { left: main.left, right: main.right, top: main.top }, scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth };
    });
    expect(positions.scrollWidth).toBeLessThanOrEqual(positions.viewport + 1);
    if (width > 800) expect(positions.rail.right).toBeLessThanOrEqual(positions.main.left);
    else expect(positions.rail.bottom).toBeLessThanOrEqual(positions.main.top);
  }
});

test("observability shows full-ledger process and provider totals with cost limitations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Observability" }).click();
  await expect(page.getByRole("heading", { name: "Observability" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cost by process" })).toBeVisible();
  await expect(page.getByRole("cell", { name: /mom generation/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cost by provider" })).toBeVisible();
  await expect(page.getByText("not included", { exact: false })).toBeVisible();
  await expect(page.getByText("3", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connected meeting accounts" })).toBeVisible();
  await expect(page.getByText("Acme review")).toBeVisible();
});

test("connected calendar card uses a compact add-account action", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByRole("button", { name: "Add another Outlook Calendar account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add another", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect account" })).toHaveCount(3);
});

test("provider and calendar pages fit a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "AI providers" }).click();
  await expect(page.getByRole("heading", { name: "AI providers" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Meeting sources" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});
