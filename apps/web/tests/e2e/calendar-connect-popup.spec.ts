import { expect, test, type Page } from "@playwright/test";

const workspace = {
  id: "00000000-0000-4000-8000-000000000001", slug: "genai-protos", display_name: "GenAI Protos", contact_email: null,
  status: "active", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", tenant_isolation_enabled: true,
};
const owner = {
  user_id: "00000000-0000-4000-8000-000000000002", organization_id: workspace.id, email: "owner@example.test",
  display_name: "Workspace owner", role: "owner", must_change_password: false,
};
const existing = { id: "ca-work", provider: "outlook", status: "ACTIVE", label: "Work", identity: "work@example.test" };
const added = { id: "ca-new", provider: "googlecalendar", status: "ACTIVE", label: "Personal", identity: "me@example.test" };
const PROVIDER_URL = "https://connect.example.test/auth";

type Mock = { connected: boolean; connectBodies: Array<Record<string, unknown>>; syncedIds: string[][] };

async function mockApi(page: Page): Promise<Mock> {
  const mock: Mock = { connected: false, connectBodies: [], syncedIds: [] };
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (pathname === "/v1/auth/me") return route.fulfill({ json: owner });
    if (pathname === "/v1/workspace") return route.fulfill({ json: workspace });
    if (pathname === "/v1/workspaces") return route.fulfill({ json: [{ id: workspace.id, slug: workspace.slug, display_name: workspace.display_name, role: "owner" }] });
    if (pathname === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (pathname === "/v1/provider-profiles" || pathname === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (pathname === "/v1/calendar/connections") return route.fulfill({ json: mock.connected ? [existing, added] : [existing] });
    if (pathname === "/v1/calendar/connect/googlecalendar") {
      mock.connectBodies.push(request.postDataJSON());
      return route.fulfill({ json: { redirect_url: PROVIDER_URL } });
    }
    if (pathname === "/v1/calendar/schedules") return route.fulfill({ json: [] });
    if (pathname === "/v1/calendar/synced") return route.fulfill({ json: { events: [], syncs: [] } });
    if (pathname === "/v1/calendar/sync") {
      mock.syncedIds.push(request.postDataJSON().connection_ids ?? []);
      return route.fulfill({ json: { events: [], syncs: [], errors: {} } });
    }
    return route.fulfill({ status: 404, json: { detail: "test route not mocked" } });
  });
  return mock;
}

/** The provider's consent page, stood in for by a redirect back to the app's callback page. */
async function mockProvider(page: Page, mock: Mock, query: string, onConsent: () => void = () => { mock.connected = true; }) {
  await page.context().route(`${PROVIDER_URL}**`, (route) => {
    onConsent();
    const origin = new URL(page.url()).origin;
    return route.fulfill({ status: 302, headers: { location: `${origin}/calendar/connected?popup=1&${query}` } });
  });
}

async function openIntegrations(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar" }).click();
  await page.getByRole("tab", { name: /Integrations/ }).click();
}

async function startGoogleConnect(page: Page) {
  await page.locator(".calendar-provider-card", { hasText: "Google Calendar" }).getByRole("button", { name: "Connect account" }).click();
  await page.getByRole("textbox", { name: "Connection name" }).fill("Personal");
  await page.getByRole("button", { name: "Continue to provider" }).click();
}

test("calendar consent opens in a new tab and the opener picks up the new account", async ({ page }) => {
  const mock = await mockApi(page);
  await mockProvider(page, mock, "status=success&connected_account_id=ca-new");
  await openIntegrations(page);

  const popupPromise = page.waitForEvent("popup");
  await startGoogleConnect(page);
  const popup = await popupPromise;
  await expect(page.getByText("Finish connecting in the new tab…")).toBeVisible();
  await expect.poll(() => popup.isClosed(), { timeout: 10_000 }).toBe(true);

  expect(mock.connectBodies[0]).toMatchObject({ alias: "Personal", popup: true });
  await expect(page.getByText("Google Calendar connected: Personal. Loading its meetings…")).toBeVisible();
  await expect(page.getByText("Finish connecting in the new tab…")).toHaveCount(0);
  await expect(page.locator(".calendar-account-row", { hasText: "me@example.test" })).toBeVisible();
  // The new account is selected and synced on its own.
  await expect.poll(() => mock.syncedIds).toContainEqual(["ca-new"]);
  await page.getByRole("tab", { name: /Calendar/ }).first().click();
  await expect(page.getByRole("combobox", { name: "Account" })).toContainText("Personal");
});

test("a declined consent in the new tab reports a clear error and changes nothing", async ({ page }) => {
  const mock = await mockApi(page);
  await mockProvider(page, mock, "status=failed&error=access_denied", () => undefined);
  await openIntegrations(page);

  const popupPromise = page.waitForEvent("popup");
  await startGoogleConnect(page);
  const popup = await popupPromise;
  await expect.poll(() => popup.isClosed(), { timeout: 10_000 }).toBe(true);
  await expect(page.locator(".calendar-error")).toContainText("Google Calendar didn't finish connecting (access_denied)");
  await expect(page.locator(".calendar-account-row")).toHaveCount(1);
  expect(mock.syncedIds).toEqual([]);
});

test("if the new tab never reports back, polling the account list still finishes the connection", async ({ page }) => {
  const mock = await mockApi(page);
  // The consent tab stays on the provider (no callback message), but the account appears server-side.
  await page.context().route(`${PROVIDER_URL}**`, (route) => { mock.connected = true; return route.fulfill({ body: "Provider sign-in" }); });
  await openIntegrations(page);
  const popupPromise = page.waitForEvent("popup");
  await startGoogleConnect(page);
  await popupPromise;
  await expect(page.getByText("Google Calendar connected: Personal. Loading its meetings…")).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => mock.syncedIds).toContainEqual(["ca-new"]);
});

test("waiting for the new tab can be cancelled", async ({ page }) => {
  const mock = await mockApi(page);
  await page.context().route(`${PROVIDER_URL}**`, (route) => route.fulfill({ body: "Provider sign-in" }));
  await openIntegrations(page);
  const popupPromise = page.waitForEvent("popup");
  await startGoogleConnect(page);
  const popup = await popupPromise;
  await expect(page.getByRole("button", { name: "Open again" })).toBeEnabled();
  await page.locator(".calendar-connect-wait").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Finish connecting in the new tab…")).toHaveCount(0);
  await expect.poll(() => popup.isClosed()).toBe(true);
  expect(mock.connectBodies).toHaveLength(1);
});

test("a blocked new tab falls back to the same-tab provider redirect", async ({ page }) => {
  await page.addInitScript(() => { window.open = () => null; });
  const mock = await mockApi(page);
  await page.context().route(`${PROVIDER_URL}**`, (route) => route.fulfill({ body: "Provider sign-in" }));
  await openIntegrations(page);
  await startGoogleConnect(page);
  await page.waitForURL(PROVIDER_URL);
  expect(mock.connectBodies[0]).toMatchObject({ alias: "Personal", popup: false });
});

test("the callback page left open explains the result and links back", async ({ page }) => {
  await page.goto("/calendar/connected?popup=1&status=success&connected_account_id=ca-new");
  await expect(page.getByRole("heading", { name: "Connected — you can close this tab" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Meetings AI" })).toHaveAttribute("href", "/?calendar=connected&status=success&connected_account_id=ca-new");
});
