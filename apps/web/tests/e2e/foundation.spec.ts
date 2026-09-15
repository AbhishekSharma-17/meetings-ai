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

test("same-origin API proxy reaches the product API", async ({ page }) => {
  await page.goto("/");
  const response = await page.evaluate(async () => {
    const result = await fetch("/v1/meetings");
    return { status: result.status, body: await result.json() };
  });

  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ items: expect.any(Array), count: expect.any(Number) });
});

test("foundation UI walkthrough", async ({ page }) => {
  const profileName = "Foundation MOM test";
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

  const providerProfiles: Array<Record<string, unknown>> = [];
  const providerDefaults: Array<Record<string, unknown>> = [];
  let profileCounter = 0;
  await page.route("**/v1/provider-**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/provider-profiles" && request.method() === "GET") {
      return route.fulfill({ json: providerProfiles });
    }
    if (pathname === "/v1/provider-defaults" && request.method() === "GET") {
      return route.fulfill({ json: providerDefaults });
    }
    if (pathname === "/v1/provider-profiles" && request.method() === "POST") {
      const payload = request.postDataJSON();
      profileCounter += 1;
      const profile = {
        ...payload,
        id: `00000000-0000-4000-8000-${String(profileCounter).padStart(12, "0")}`,
        base_url: payload.base_url ?? null,
        credential_configured: Boolean(payload.api_key),
        created_at: "2026-09-09T10:00:00Z",
        updated_at: "2026-09-09T10:00:00Z",
      };
      delete profile.api_key;
      providerProfiles.push(profile);
      return route.fulfill({ status: 201, json: profile });
    }
    const profileMatch = pathname.match(/^\/v1\/provider-profiles\/([^/]+)$/);
    if (profileMatch && request.method() === "PATCH") {
      const payload = request.postDataJSON();
      const index = providerProfiles.findIndex((item) => item.id === profileMatch[1]);
      if (index < 0) return route.fulfill({ status: 404, json: { detail: "provider profile not found" } });
      const previous = providerProfiles[index];
      const updated = {
        ...previous,
        ...payload,
        credential_configured: Boolean(payload.api_key) || Boolean(previous.credential_configured),
        updated_at: "2026-09-09T10:05:00Z",
      };
      delete updated.api_key;
      providerProfiles[index] = updated;
      return route.fulfill({ json: updated });
    }
    const testMatch = pathname.match(/^\/v1\/provider-profiles\/([^/]+)\/test$/);
    if (testMatch && request.method() === "POST") {
      const profile = providerProfiles.find((item) => item.id === testMatch[1]);
      return route.fulfill({ json: { profile_id: testMatch[1], status: "configuration_valid", network_call_performed: false, capabilities: profile?.capabilities ?? [], message: "Configuration fields are valid." } });
    }
    const defaultMatch = pathname.match(/^\/v1\/provider-defaults\/([^/]+)$/);
    if (defaultMatch && request.method() === "PUT") {
      const payload = request.postDataJSON();
      const selectedId = payload.local_profile_id ?? payload.cloud_profile_id;
      const value = { ...payload, capability: defaultMatch[1], ordered_profile_ids: [selectedId] };
      const existing = providerDefaults.findIndex((item) => item.capability === defaultMatch[1]);
      if (existing >= 0) providerDefaults[existing] = value; else providerDefaults.push(value);
      return route.fulfill({ json: value });
    }
    return route.fallback();
  });

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
  const persistedProfile = page.getByRole("button", { name: new RegExp(profileName) }).filter({ hasText: "Default" });
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

test("finished meeting supports MOM review approval and delivery", async ({ page }) => {
  const meetingId = "00000000-0000-4000-8000-000000000088";
  const meeting = {
    id: meetingId,
    title: "MOM workflow witness",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    platform: "google_meet",
    status: "completed",
    bot_name: "Meetings AI",
    created_at: "2026-09-09T12:00:00Z",
    updated_at: "2026-09-09T12:20:00Z",
    joined_at: "2026-09-09T12:01:00Z",
    stopped_at: "2026-09-09T12:20:00Z",
  };
  const baseMinutes = {
    meeting_id: meetingId,
    status: "draft",
    title: "MOM workflow witness",
    executive_summary: "The team validated live meeting capture.",
    discussion_points: ["Live transcription worked."],
    decisions: ["Build the MOM workflow next."],
    action_items: [{ description: "Review the MOM", owner: "Abhishek", due_date: null }],
    open_questions: ["When will deployment begin?"],
    provider_profile_id: "00000000-0000-4000-8000-000000000077",
    provider: "openai",
    model: "economy-model",
    created_at: "2026-09-09T12:21:00Z",
    updated_at: "2026-09-09T12:21:00Z",
    approved_at: null,
    sent_at: null,
    last_error: null,
  };
  let minutes: Record<string, unknown> | null = null;

  await page.route("**/v1/meetings**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/meetings" && request.method() === "GET") {
      return route.fulfill({ json: { items: [meeting], count: 1 } });
    }
    if (pathname === `/v1/meetings/${meetingId}` && request.method() === "GET") {
      return route.fulfill({ json: meeting });
    }
    if (pathname === `/v1/meetings/${meetingId}/transcript` && request.method() === "GET") {
      return route.fulfill({ json: { segments: [{ speaker: "Abhishek", text: "Build the MOM workflow next.", start_seconds: 1, end_seconds: 4, completed: true }] } });
    }
    if (pathname === `/v1/meetings/${meetingId}/minutes` && request.method() === "GET") {
      return minutes ? route.fulfill({ json: minutes }) : route.fulfill({ status: 404, json: { detail: "MOM has not been generated" } });
    }
    if (pathname === `/v1/meetings/${meetingId}/minutes/generate` && request.method() === "POST") {
      minutes = structuredClone(baseMinutes);
      return route.fulfill({ json: minutes });
    }
    if (pathname === `/v1/meetings/${meetingId}/minutes` && request.method() === "PUT") {
      const update = request.postDataJSON();
      minutes = { ...baseMinutes, ...update, status: "draft" };
      return route.fulfill({ json: minutes });
    }
    if (pathname === `/v1/meetings/${meetingId}/minutes/approve` && request.method() === "POST") {
      minutes = { ...(minutes ?? baseMinutes), status: "approved", approved_at: "2026-09-09T12:25:00Z" };
      return route.fulfill({ json: minutes });
    }
    if (pathname === `/v1/meetings/${meetingId}/minutes/send` && request.method() === "POST") {
      minutes = { ...(minutes ?? baseMinutes), status: "sent", sent_at: "2026-09-09T12:26:00Z" };
      return route.fulfill({ json: { id: "delivery-1", meeting_id: meetingId, recipients: ["team@example.test"], status: "sent", provider_message_id: "email-1", error: null, created_at: "2026-09-09T12:26:00Z" } });
    }
    return route.fallback();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open MOM workflow witness" }).click();
  await expect(page.getByText("No MOM draft yet.")).toBeVisible();
  await page.getByRole("button", { name: "Generate MOM" }).click();
  await expect(page.getByLabel("Executive summary")).toHaveValue("The team validated live meeting capture.");
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(page, "09-mom-draft-review.png");
  await page.getByLabel("Executive summary").fill("Human-reviewed meeting summary.");
  await page.getByRole("button", { name: "Save & approve" }).click();
  await expect(page.getByText("MOM approved and ready to send.")).toBeVisible();
  await page.getByLabel("Recipients").fill("team@example.test");
  await page.getByRole("button", { name: "Send recap" }).click();
  await expect(page.getByText("Recap sent", { exact: true })).toBeVisible();
  await expect(page.getByText("Recap sent to 1 recipient.")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(page, "10-mom-sent.png");
});
