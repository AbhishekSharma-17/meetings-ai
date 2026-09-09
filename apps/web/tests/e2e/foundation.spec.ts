import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const screenshotDirectory = path.resolve(
  __dirname,
  "../../../../docs/status/ui-walkthrough",
);
const walkthroughDelay = Number(process.env.PLAYWRIGHT_WALKTHROUGH_DELAY_MS ?? "0");

async function capture(page: Page, name: string) {
  mkdirSync(screenshotDirectory, { recursive: true });
  await page.screenshot({
    path: path.join(screenshotDirectory, name),
    fullPage: true,
  });
  if (walkthroughDelay > 0) await page.waitForTimeout(walkthroughDelay);
}

test("foundation UI walkthrough", async ({ page }) => {
  const profileName = `Foundation MOM test ${Date.now()}`;
  const meeting = {
    id: "meeting-e2e-001",
    title: "Foundation UI witness",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    platform: "google_meet",
    status: "created",
    bot_name: "Meetings AI",
    created_at: "2026-09-09T10:30:00Z",
    updated_at: "2026-09-09T10:30:00Z",
    joined_at: null,
    stopped_at: null,
    participant_count: 0,
  };

  // The UI always uses product API calls to create and join. This route mock
  // keeps the walkthrough from launching a real external-meeting bot.
  await page.route("**/v1/meetings**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/meetings" && request.method() === "GET") return route.fulfill({ json: [] });
    if (pathname === "/v1/meetings" && request.method() === "POST") return route.fulfill({ json: meeting });
    if (pathname === "/v1/meetings/meeting-e2e-001/join" && request.method() === "POST") {
      meeting.status = "joining";
      meeting.updated_at = "2026-09-09T10:31:00Z";
      return route.fulfill({ json: meeting });
    }
    if (pathname === "/v1/meetings/meeting-e2e-001" && request.method() === "GET") return route.fulfill({ json: meeting });
    if (pathname === "/v1/meetings/meeting-e2e-001/transcript" && request.method() === "GET") {
      return route.fulfill({ json: [{ id: "seg-1", speaker_name: "Abhishek", text: "Let us validate this with the internal team first.", started_at: "2026-09-09T10:31:04Z", is_final: true }] });
    }
    return route.fallback();
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your meetings, made useful." })).toBeVisible();
  await expect(page.getByText("No meeting records yet.")).toBeVisible();
  await expect(
    page.getByText("Meetings captured").locator("..").getByText("0", { exact: true }),
  ).toBeVisible();
  await capture(page, "01-dashboard.png");

  await page.getByRole("button", { name: "New meeting" }).click();
  await expect(page.getByRole("dialog", { name: "Join a meeting" })).toBeVisible();
  await expect(page.getByText("Disclosure is required.")).toBeVisible();

  const meetingLink = page.getByLabel("Meeting link");
  await meetingLink.fill("not-a-meeting-url");
  await page.getByRole("button", { name: "Send assistant" }).click();
  await expect(page.getByText("Ready to join")).not.toBeVisible();
  expect(await meetingLink.evaluate((element) => (element as HTMLInputElement).validity.valid)).toBe(false);
  await capture(page, "02-invalid-meeting-url.png");

  await meetingLink.fill("https://meet.google.com/abc-defg-hij");
  await page.getByLabel("Meeting name optional").fill("Foundation UI witness");
  await capture(page, "03-ready-to-submit.png");
  await page.getByRole("button", { name: "Send assistant" }).click();
  await expect(page.getByRole("heading", { name: "Foundation UI witness" })).toBeVisible();
  await expect(page.getByText("Joining", { exact: true })).toBeVisible();
  await expect(page.getByText("Let us validate this with the internal team first.")).toBeVisible();
  await capture(page, "04-meeting-lifecycle.png");
  await page.getByRole("button", { name: "All meetings" }).click();

  await page.getByRole("button", { name: "AI providers" }).click();
  await expect(page.getByRole("heading", { name: "AI providers" })).toBeVisible();

  const vexaProfile = page.getByRole("button", { name: /Vexa local Whisper/ });
  if (!(await vexaProfile.isVisible())) {
    await page.getByRole("button", { name: "Add Transcription profile" }).click();
    await page.getByLabel("Profile name").fill("Vexa local Whisper");
    await page.getByLabel("Provider type").selectOption({ label: "Vexa native / self-hosted" });
    await page.getByLabel("Execution location").selectOption("local");
    await page.getByLabel("Model").fill("Systran/faster-whisper-tiny.en");
    await page.getByLabel("Base endpoint").fill("http://vexa-lite-whisper:8000/v1");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Vexa local Whisper saved.")).toBeVisible();
  }
  await expect(vexaProfile).toBeVisible();
  await capture(page, "05-provider-settings.png");

  await page.getByRole("button", { name: /Vexa local Whisper/ }).click();
  await page.getByRole("button", { name: "Validate configuration" }).click();
  await expect(page.getByText(/Configuration fields are valid/)).toBeVisible();
  await expect(page.getByText("Configuration valid", { exact: true })).toBeVisible();
  await capture(page, "06-vexa-configuration-valid.png");

  await page.getByRole("button", { name: "Add MOM & actions profile" }).click();
  await page.getByLabel("Profile name").fill(profileName);
  await page.getByLabel("Provider type").selectOption({ label: "OpenAI-compatible" });
  await page.getByLabel("Execution location").selectOption("local");
  await page.getByLabel("Model").fill("foundation-test-model");
  await page.getByLabel("Base endpoint").fill("http://localhost:4000/v1");
  await page.getByLabel("API key write-only").fill("foundation-dummy-credential");
  await page.getByLabel(/Use as the default/).check();
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText(`${profileName} saved.`)).toBeVisible();
  await capture(page, "07-provider-saved.png");

  await page.reload();
  await page.getByRole("button", { name: "AI providers" }).click();
  const persistedProfile = page.getByRole("button", { name: new RegExp(profileName) });
  await persistedProfile.click();
  await expect(persistedProfile.getByText("Default", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/Use as the default/)).toBeChecked();
  await expect(page.getByLabel("Text generation")).toBeChecked();
  await expect(page.getByLabel("API key write-only")).toHaveAttribute(
    "placeholder",
    "A key is already configured",
  );
  await expect(page.getByLabel("API key write-only")).toHaveValue("");
  await capture(page, "08-write-only-after-reload.png");
});

test("join failures open the durable meeting record with a retry path", async ({ page }) => {
  const meetingId = "00000000-0000-4000-8000-000000000099";
  const failedMeeting = {
    id: meetingId,
    title: "Admission failure witness",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    platform: "google_meet",
    status: "failed",
    bot_name: "Meetings AI",
    created_at: "2026-09-09T11:30:00Z",
    updated_at: "2026-09-09T11:31:00Z",
    joined_at: null,
    stopped_at: null,
    last_error: "Vexa join failed (503): transcription is not configured",
  };

  await page.route("**/v1/meetings**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/meetings" && request.method() === "GET") return route.fulfill({ json: [] });
    if (pathname === "/v1/meetings" && request.method() === "POST") {
      return route.fulfill({ json: { ...failedMeeting, status: "created", last_error: null } });
    }
    if (pathname === `/v1/meetings/${meetingId}/join` && request.method() === "POST") {
      return route.fulfill({ status: 503, json: { detail: "Vexa is unavailable" } });
    }
    if (pathname === `/v1/meetings/${meetingId}` && request.method() === "GET") {
      return route.fulfill({ json: failedMeeting });
    }
    return route.fallback();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "New meeting" }).click();
  await page.getByLabel("Meeting link").fill(failedMeeting.meeting_url);
  await page.getByLabel("Meeting name optional").fill(failedMeeting.title);
  await page.getByRole("button", { name: "Send assistant" }).click();

  await expect(page.getByRole("heading", { name: failedMeeting.title })).toBeVisible();
  await expect(page.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(page.getByText(/transcription is not configured/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry join" })).toBeVisible();
});
