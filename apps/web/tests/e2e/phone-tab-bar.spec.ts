import { expect, test, type Locator, type Page } from "@playwright/test";
import { installMediaFakes, mockInPersonApi, newState } from "./in-person-mocks";

/**
 * Phones (≤ 640 px) get a bottom tab bar: Home (Shared for members and viewers), Record, Calendar,
 * Knowledge, More. It is hidden on tablets and desktops and steps aside for the in-person recorder.
 */
const LIVE_MEETING = {
  id: "00000000-0000-4000-8000-0000000000b2", title: "Acme weekly sync", meeting_url: "https://meet.google.com/abc-defg-hij",
  platform: "google_meet", status: "live", bot_name: "Meetings AI", created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:00:00Z",
  joined_at: "2026-09-29T10:00:00Z", stopped_at: null,
};

const tabBar = (page: Page) => page.getByRole("navigation", { name: "Quick navigation" });
const tab = (page: Page, name: string | RegExp) => tabBar(page).getByRole("button", { name });
/** Keyboard activation: also keeps clear of the Next.js dev-tools badge that sits over the bottom-left corner in dev. */
async function press(target: Locator) {
  await target.focus();
  await target.press("Enter");
}
const location = (page: Page) => page.getByRole("navigation", { name: "Breadcrumb" }).locator("[aria-current=page]");

async function setup(page: Page, role: "owner" | "member" | "viewer" = "owner", live = false) {
  await installMediaFakes(page);
  await mockInPersonApi(page, newState(), role === "viewer" ? "member" : role);
  if (role === "viewer") await page.route("**/v1/auth/me", (route) => route.fulfill({ json: {
    user_id: "00000000-0000-4000-8000-000000000002", organization_id: "00000000-0000-4000-8000-000000000001", email: "vic@example.test",
    display_name: "Vic Viewer", must_change_password: false, role: "viewer" } }));
  if (live) await page.route("**/v1/meetings", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { items: [LIVE_MEETING], count: 1 } }) : route.fallback());
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("phone tab bar at 360 px", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("navigates, marks the current place, shows the live count and opens More", async ({ page }) => {
    await setup(page, "owner", true);
    await page.goto("/");
    await expect(tabBar(page)).toBeVisible();
    const names = await tabBar(page).getByRole("button").evaluateAll((items) => items.map((item) => item.textContent?.trim()));
    expect(names).toEqual(["1Home", "Record", "Calendar", "Knowledge", "More"]);
    const home = tab(page, "Home, 1 live");
    await expect(home).toHaveAttribute("aria-current", "page");
    for (const button of await tabBar(page).getByRole("button").all()) {
      const box = await button.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(48);
    }

    await press(tab(page, "Knowledge"));
    await expect(location(page)).toHaveText("AI knowledge");
    await expect(tab(page, "Knowledge")).toHaveAttribute("aria-current", "page");
    await expect(home).not.toHaveAttribute("aria-current", "page");

    await press(tab(page, "Calendar"));
    await expect(location(page)).toHaveText("Calendar");

    const more = tab(page, "More");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await press(more);
    const sheet = page.getByRole("dialog", { name: "Workspace navigation" });
    await expect(sheet).toBeVisible();
    await expect(page.locator('[data-tab="more"]')).toHaveAttribute("aria-expanded", "true");  // the sheet makes the rest inert
    await sheet.getByRole("button", { name: "Meeting prep", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(location(page)).toHaveText("Meeting prep");
    await expect(more).toHaveAttribute("data-active", "true");  // a page that lives under More
    await noHorizontalOverflow(page);

    // Nothing is hidden behind the bar: the page leaves room for it.
    const padding = await page.locator(".workspace-main").evaluate((element) => parseFloat(getComputedStyle(element).paddingBottom));
    const barHeight = (await tabBar(page).boundingBox())?.height ?? 0;
    expect(padding).toBeGreaterThanOrEqual(barHeight - 1);
  });

  test("members get Shared instead of Home; viewers cannot record", async ({ page }) => {
    await setup(page, "member");
    await page.goto("/");
    await expect(tabBar(page).getByRole("button")).toHaveText(["Shared", "Record", "Calendar", "Knowledge", "More"]);
    await press(tab(page, "Shared"));
    await expect(location(page)).toHaveText("Shared with me");

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await setup(page, "viewer");
    await page.goto("/");
    await expect(tabBar(page).getByRole("button")).toHaveText(["Shared", "Knowledge", "More"]);
  });

  test("the in-person recorder's own bottom bar replaces the tab bar while it is in front", async ({ page }) => {
    await setup(page);
    await page.goto("/");
    await press(tab(page, "Record"));
    await expect(page.getByRole("heading", { name: "Record an in-person meeting" })).toBeVisible();
    await page.getByLabel("Meeting title").fill("Office design review");
    await page.getByRole("checkbox", { name: "Everyone present has agreed to be recorded" }).check();
    await page.getByRole("button", { name: "Start recording" }).click();
    await expect(page.getByRole("heading", { name: "Recording" })).toBeVisible();
    await expect(location(page)).toHaveText("In-person recording");
    await expect(tabBar(page)).toHaveCount(0);
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible();
    const stopBox = await stop.boundingBox();
    expect((stopBox?.y ?? 0) + (stopBox?.height ?? 0)).toBeLessThanOrEqual(740);
    await noHorizontalOverflow(page);

    // Leaving the page keeps recording in the background; the tab bar comes back.
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("dialog", { name: "Workspace navigation" }).getByRole("button", { name: "AI knowledge", exact: true }).click();
    await expect(tabBar(page)).toBeVisible();
    await expect(location(page)).toHaveText("AI knowledge");
  });
});

for (const width of [768, 1024]) {
  test(`no tab bar at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(tabBar(page)).toBeHidden();
  });
}

test.describe("demo mode on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the tab bar works with the sample workspace", async ({ page }) => {
    await page.route("**/v1/**", (route) => new URL(route.request().url()).pathname === "/v1/auth/session"
      ? route.fulfill({ json: { authenticated: false } }) : route.fulfill({ status: 599, json: { detail: "A demo request reached the network." } }));
    await page.goto("/");
    await page.getByRole("button", { name: "Explore the demo" }).click();
    await expect(page.getByRole("heading", { name: "Welcome back, Alex" })).toBeVisible();
    await expect(tab(page, /^Home/)).toHaveAttribute("aria-current", "page");
    await press(tab(page, "Knowledge"));
    await expect(location(page)).toHaveText("AI knowledge");
    await press(tab(page, /^Home/));
    await expect(page.getByRole("heading", { name: "Welcome back, Alex" })).toBeVisible();
    await noHorizontalOverflow(page);
  });
});
