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
  await page.route("**/v1/calendar/events?**", async (route) => {
    expect(new URL(route.request().url()).searchParams.get("timezone")).toBe("Asia/Kolkata");
    await route.fulfill({ json: { events: [], timezone: "Asia/Kolkata", range_start: "2026-09-25T00:00:00Z", range_end: "2026-09-26T00:00:00Z" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  await expect(page.getByLabel("Calendar connections").getByText("Outlook Calendar")).toBeVisible();
  await expect(page.getByLabel("Calendar connections").getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Calendar connections").getByText("Google Calendar")).toBeVisible();
  await page.getByRole("button", { name: "Show meetings" }).click();
  await expect(page.getByText("No upcoming supported meetings in this range")).toBeVisible();
});

test("multiple calendar accounts stay distinct and the selected account is scanned", async ({ page }) => {
  let scannedAccount: string | null = null;
  await page.route("**/v1/calendar/connections", (route) => route.fulfill({ json: [
    { id: "ca-work", provider: "googlecalendar", status: "ACTIVE", label: "work@example.test" },
    { id: "ca-personal", provider: "googlecalendar", status: "ACTIVE", label: "Personal calendar" },
    { id: "ca-outlook", provider: "outlook", status: "ACTIVE", label: "outlook@example.test" },
  ] }));
  await page.route("**/v1/calendar/events?**", async (route) => {
    scannedAccount = new URL(route.request().url()).searchParams.get("connection_id");
    await route.fulfill({ json: { events: [], timezone: "UTC", range_start: "2026-09-25T00:00:00Z", range_end: "2026-09-26T00:00:00Z" } });
  });
  await page.goto("/?calendar=connected&status=success&connected_account_id=ca-personal");
  await expect(page.getByText("2 connected accounts")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connected accounts" })).toBeVisible();
  await expect(page.getByText("work@example.test")).toBeVisible();
  await expect(page.getByText("Personal calendar", { exact: true })).toBeVisible();
  await expect(page.getByText("outlook@example.test")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add another" })).toHaveCount(2);
  await expect(page.getByRole("combobox", { name: "Scan calendar account" })).toContainText("Personal calendar");
  await page.getByRole("button", { name: "Show meetings" }).click();
  await expect.poll(() => scannedAccount).toBe("ca-personal");
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
