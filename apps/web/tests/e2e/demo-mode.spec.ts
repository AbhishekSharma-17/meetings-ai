import { expect, test, type Page } from "@playwright/test";

/**
 * Demo mode is served entirely by the in-browser sample API. The only network
 * /v1 request allowed is the sign-in page's session check before the demo
 * starts (and after it ends); anything else reaching the network fails the test.
 */
test.describe("demo mode", () => {
  let leaks: string[];
  let errors: string[];
  let allowSessionCheck: boolean;

  test.beforeEach(async ({ page }) => {
    leaks = []; errors = []; allowSessionCheck = true;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.route("**/v1/**", (route) => {
      const { pathname } = new URL(route.request().url());
      if (allowSessionCheck && pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: false } });
      leaks.push(`${route.request().method()} ${pathname}`);
      return route.fulfill({ status: 599, json: { detail: "A demo request reached the network." } });
    });
  });

  const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name, exact: true }).click();

  test("a visitor explores every page of the sample workspace without an account", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    await expect(page.getByText("Sample workspace · nothing is saved")).toBeVisible();
    allowSessionCheck = false;
    await page.getByRole("button", { name: "Explore the demo" }).click();

    const banner = page.getByRole("region", { name: "Demo mode" });
    await expect(banner).toContainText("Demo workspace");
    await expect(banner).toContainText("sample data, nothing is saved");
    await expect(page.getByRole("heading", { name: "Welcome back, Alex" })).toBeVisible();
    await expect(page.getByText("Acme Robotics — weekly delivery sync").first()).toBeVisible();

    // Meetings: a draft ready for review, then approve it.
    await nav(page, "Meetings");
    await page.getByRole("button", { name: /Q4 automation roadmap/ }).first().click();
    await expect(page.getByRole("heading", { name: "Acme Robotics — Q4 automation roadmap" })).toBeVisible();
    await expect(page.getByLabel("Executive summary")).toHaveValue(/four-week FieldGuide pilot/);
    await expect(page.getByText(/signed the MOU with the Port of Rotterdam/).first()).toBeVisible();
    await page.getByRole("button", { name: "Save & approve" }).click();
    await expect(page.getByText("MOM approved and ready to send.")).toBeVisible();

    // A live meeting keeps its transcript updating.
    await nav(page, "Meetings");
    await page.getByRole("button", { name: /weekly delivery sync/ }).first().click();
    await expect(page.getByRole("button", { name: "Leave now" })).toBeVisible();
    await expect(page.getByText(/indexed about eleven hundred pages/).first()).toBeVisible();

    // Calendar with three connected accounts.
    await nav(page, "Calendar");
    await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: /Integrations/ }).click();
    await expect(page.getByText("Sales bookings").first()).toBeVisible();

    // Meeting prep: a saved briefing, then a streamed new one.
    await nav(page, "Meeting prep");
    await expect(page.getByRole("heading", { name: "Briefing: Initech" })).toBeVisible();
    await page.getByRole("button", { name: /Discovery call: Fabrikam Health/ }).click();
    await page.getByRole("tab", { name: /Inputs/ }).click();
    await page.getByRole("button", { name: "Generate briefing" }).click();
    await expect(page.getByText("Preparing your briefing")).toBeVisible();
    await expect(page.getByText(/Demo: no web searches or AI calls are made/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Briefing: Fabrikam Health" })).toBeVisible({ timeout: 20_000 });

    // AI knowledge: a saved cited chat, then a streamed answer.
    await nav(page, "AI knowledge");
    await expect(page.getByText("Four owners came out of the Q4 roadmap meeting:")).toBeVisible();
    await page.getByRole("button", { name: "New chat" }).click();
    await page.locator("#knowledge-question").fill("When does the FieldGuide pilot start and end?");
    await page.locator("#knowledge-question").press("Enter");
    await expect(page.getByText(/starts on October 14 and reads out on November 4/)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Wiki" }).click();
    await expect(page.getByText("Connected meetings")).toBeVisible();

    // Administration.
    await nav(page, "AI providers");
    await expect(page.getByText("OpenAI production").first()).toBeVisible();
    await expect(page.getByText("Workspace AI").first()).toBeVisible();
    await nav(page, "Observability");
    await expect(page.getByText("Estimated AI spend")).toBeVisible();
    await page.getByRole("tab", { name: /Usage ledger/ }).click();
    await expect(page.getByRole("heading", { name: "Usage ledger" })).toBeVisible();
    await page.getByRole("tab", { name: /Meeting prep/ }).click();
    await expect(page.getByRole("heading", { name: "Recent briefing runs" })).toBeVisible();
    await page.getByRole("tab", { name: /Data/ }).click();
    await expect(page.getByText("Data stored for this workspace")).toBeVisible();

    await page.getByRole("button", { name: /Alex Morgan/ }).click();
    await page.getByRole("button", { name: "Organization & people" }).click();
    await expect(page.getByText("priya.shah@northwindlabs.example")).toBeVisible();
    await page.getByRole("button", { name: /Alex Morgan/ }).click();
    await page.getByRole("button", { name: "My profile & password" }).click();
    await expect(page.getByRole("heading", { name: "My profile" })).toBeVisible();

    // The banner minimises to a top-bar pill and still offers a way out.
    await banner.getByRole("button", { name: "Minimise demo banner" }).click();
    await expect(banner).toHaveCount(0);
    const pill = page.getByRole("group", { name: "Demo mode" });
    await expect(pill).toBeVisible();
    allowSessionCheck = true;
    await pill.getByRole("button", { name: "Exit demo" }).click();
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("meetings-ai:demo")))).toEqual([]);

    expect(leaks).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("/?demo=1 opens the sample workspace directly", async ({ page }) => {
    allowSessionCheck = false;
    await page.goto("/?demo=1");
    await expect(page.getByRole("region", { name: "Demo mode" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Welcome back, Alex" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    expect(leaks).toEqual([]);
    expect(errors).toEqual([]);
  });
});
