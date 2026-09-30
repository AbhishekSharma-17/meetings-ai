import { expect, test, type Page, type Request } from "@playwright/test";
import { counters, installMediaFakes } from "./in-person-mocks";

/**
 * My profile → Voice sample: record 5–10 s with the (faked) microphone, play it back, save it with
 * explicit consent, play the saved copy, delete it. Also the blocked-microphone state and demo mode.
 */
const workspace = {
  id: "00000000-0000-4000-8000-000000000001", slug: "genai-protos", display_name: "GenAI Protos", contact_email: null,
  status: "active", created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z", tenant_isolation_enabled: true,
};
const owner = {
  user_id: "00000000-0000-4000-8000-000000000002", organization_id: workspace.id, email: "alex@example.test",
  display_name: "Alex Morgan", role: "owner", must_change_password: false,
};

type Matching = "available" | "unsupported" | "not_configured";
type VoiceState = { sample: null | { mime_type: string; duration_ms: number; byte_size: number; updated_at: string }; puts: Request[]; deletes: number; audioReads: number };

const matchingCopy: Record<Matching, string> = {
  available: "Your workspace's speech-to-text model uses voice samples to suggest names.",
  unsupported: "Your workspace's speech-to-text model doesn't use voice samples yet. Your sample is kept and will be used if the workspace switches to a model that does.",
  not_configured: "Speech-to-text isn't set up in this workspace yet, so voice samples aren't used.",
};

async function mockApi(page: Page, matching: Matching = "unsupported"): Promise<VoiceState> {
  const state: VoiceState = { sample: null, puts: [], deletes: 0, audioReads: 0 };
  const status = () => ({ sample: state.sample, matching: { status: matching, message: matchingCopy[matching] }, min_duration_ms: 5000, max_duration_ms: 10000, max_bytes: 1048576 });
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    if (pathname === "/v1/me/voice-sample" && method === "GET") return route.fulfill({ json: status() });
    if (pathname === "/v1/me/voice-sample" && method === "PUT") {
      state.puts.push(request);
      state.sample = { mime_type: "audio/webm", duration_ms: 6000, byte_size: 512, updated_at: "2026-09-30T10:00:00Z" };
      return route.fulfill({ json: status() });
    }
    if (pathname === "/v1/me/voice-sample" && method === "DELETE") { state.deletes += 1; state.sample = null; return route.fulfill({ status: 204, body: "" }); }
    if (pathname === "/v1/me/voice-sample/audio") {
      state.audioReads += 1;
      return state.sample ? route.fulfill({ status: 200, body: Buffer.alloc(64), headers: { "content-type": "audio/webm", "cache-control": "no-store" } })
        : route.fulfill({ status: 404, json: { detail: "you have no voice sample in this workspace" } });
    }
    if (pathname === "/v1/me/preferences" || pathname === "/v1/me/preferences/detected") return route.fulfill({ json: { timezone: "UTC", timezone_source: "browser", detected_timezone: "UTC", time_format: "auto" } });
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (pathname === "/v1/auth/me") return route.fulfill({ json: owner });
    if (pathname === "/v1/workspace") return route.fulfill({ json: workspace });
    if (pathname === "/v1/workspaces") return route.fulfill({ json: [{ id: workspace.id, slug: workspace.slug, display_name: workspace.display_name, role: "owner" }] });
    if (pathname === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (pathname === "/v1/provider-profiles" || pathname === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (pathname.startsWith("/v1/notifications")) return route.fulfill({ json: pathname.endsWith("unread-count") ? { unread_count: 0 } : { items: [], next_cursor: null, unread_count: 0 } });
    return route.fulfill({ status: 404, json: { detail: "test route not mocked" } });
  });
  return state;
}

/** Headless Chromium can't decode the fake recorder's bytes: record play() calls instead of playing. */
async function stubPlayback(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __plays: string[] };
    w.__plays = [];
    HTMLMediaElement.prototype.play = function play(this: HTMLMediaElement) { w.__plays.push(this.src); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function pause() { /* nothing is playing */ };
  });
}

const plays = (page: Page) => page.evaluate(() => (window as unknown as { __plays: string[] }).__plays);
const card = (page: Page) => page.getByRole("region", { name: "Voice sample" });

async function openProfile(page: Page) {
  await page.goto("/");
  await page.locator(".desktop-sidebar").getByRole("button", { name: /Alex Morgan/ }).click();
  await page.getByRole("button", { name: "My profile & password" }).click();
  await expect(page.getByRole("heading", { name: "My profile" })).toBeVisible();
}

async function recordFiveSeconds(page: Page) {
  await card(page).getByRole("button", { name: "Record a sample" }).click();
  const recording = card(page).getByRole("group", { name: "Recording your voice sample" });
  await expect(recording).toBeVisible();
  await expect(recording.getByText(/Read this aloud: “Hi, this is Alex\./)).toBeVisible();
  const stop = recording.getByRole("button", { name: "Stop" });
  await expect(stop).toBeDisabled();
  await expect(recording.getByText(/Keep going — at least 5 s/)).toBeVisible();
  await expect(stop).toBeEnabled({ timeout: 8_000 });
  await stop.click();
}

test.describe("voice sample on My profile", () => {
  test.beforeEach(async ({ page }) => {
    await installMediaFakes(page);
    await stubPlayback(page);
  });

  test("records, plays back, saves with consent, plays the saved sample and deletes it", async ({ page }) => {
    const state = await mockApi(page);
    await openProfile(page);
    await expect(card(page).getByText("Not used for matching yet")).toBeVisible();
    await expect(card(page).getByText(/doesn't use voice samples yet/)).toBeVisible();
    await expect(card(page).getByText("Used only to suggest your name when you're recorded in person in this workspace. Delete any time.")).toBeVisible();

    await recordFiveSeconds(page);
    await expect(card(page).getByText(/New recording · [5-9] s/)).toBeVisible();
    await card(page).getByRole("button", { name: "Play what you recorded" }).click();
    await expect.poll(async () => (await plays(page)).length).toBe(1);
    expect((await plays(page))[0]).toMatch(/^blob:/);

    const save = card(page).getByRole("button", { name: "Save sample" });
    await expect(save).toBeDisabled();  // explicit consent first
    await card(page).getByRole("checkbox", { name: /Used only to suggest your name/ }).check();
    await save.click();
    await expect(card(page).getByText("Voice sample saved.")).toBeVisible();
    expect(state.puts).toHaveLength(1);
    const body = state.puts[0].postDataBuffer()?.toString("latin1") ?? "";
    expect(state.puts[0].headers()["content-type"]).toMatch(/^multipart\/form-data/);
    const duration = Number(/name="duration_ms"\r\n\r\n(\d+)/.exec(body)?.[1]);
    expect(duration).toBeGreaterThanOrEqual(5000);
    expect(duration).toBeLessThanOrEqual(10000);
    expect(body).toContain('name="file"; filename="voice-sample.webm"');
    expect((await counters(page)).gum).toBe(1);

    await expect(card(page).getByText("Saved", { exact: true })).toBeVisible();
    await card(page).getByRole("button", { name: "Play your voice sample" }).click();
    await expect.poll(() => state.audioReads).toBe(1);
    await expect.poll(async () => (await plays(page)).length).toBe(2);

    await card(page).getByRole("button", { name: "Delete" }).click();
    const confirm = card(page).getByRole("group", { name: "Delete your voice sample?" });
    await confirm.getByRole("button", { name: "Keep it" }).click();
    expect(state.deletes).toBe(0);
    await card(page).getByRole("button", { name: "Delete" }).click();
    await confirm.getByRole("button", { name: "Delete sample" }).click();
    await expect(card(page).getByText("Voice sample deleted.")).toBeVisible();
    expect(state.deletes).toBe(1);
    await expect(card(page).getByRole("button", { name: "Record a sample" })).toBeVisible();
  });

  test("a model that uses voice samples says so", async ({ page }) => {
    await mockApi(page, "available");
    await openProfile(page);
    await expect(card(page).getByText("Used for name suggestions")).toBeVisible();
  });

  test("cancelling a recording keeps nothing", async ({ page }) => {
    const state = await mockApi(page);
    await openProfile(page);
    await card(page).getByRole("button", { name: "Record a sample" }).click();
    await card(page).getByRole("button", { name: "Cancel" }).click();
    await expect(card(page).getByRole("button", { name: "Record a sample" })).toBeVisible();
    expect(state.puts).toHaveLength(0);
  });
});

test("a blocked microphone is explained with a way to try again", async ({ page }) => {
  await installMediaFakes(page, { denyMic: true });
  await mockApi(page);
  await openProfile(page);
  await card(page).getByRole("button", { name: "Record a sample" }).click();
  await expect(card(page).getByRole("alert")).toContainText("Microphone access is blocked");
  await expect(card(page).getByRole("button", { name: "Try again" })).toBeVisible();
});

test("demo mode records a simulated sample without the microphone", async ({ page }) => {
  await installMediaFakes(page);
  await stubPlayback(page);
  const leaks: string[] = [];
  await page.route("**/v1/**", (route) => {
    const { pathname } = new URL(route.request().url());
    // The sign-in page checks the session before the demo starts; nothing else may reach the network.
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: false } });
    leaks.push(pathname);
    return route.fulfill({ status: 599, json: { detail: "A demo request reached the network." } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Explore the demo" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back, Alex" })).toBeVisible();
  await page.locator(".desktop-sidebar").getByRole("button", { name: /Alex Morgan/ }).click();
  await page.getByRole("button", { name: "My profile & password" }).click();
  await expect(card(page).getByText("Used for name suggestions")).toBeVisible();
  await recordFiveSeconds(page);
  await card(page).getByRole("checkbox", { name: /Used only to suggest your name/ }).check();
  await card(page).getByRole("button", { name: "Save sample" }).click();
  await expect(card(page).getByText("Voice sample saved.")).toBeVisible();
  await card(page).getByRole("button", { name: "Play your voice sample" }).click();
  await expect.poll(async () => (await plays(page)).length).toBe(1);
  expect((await counters(page)).gum).toBe(0);  // the demo never opens the microphone
  expect(leaks).toEqual([]);
});
