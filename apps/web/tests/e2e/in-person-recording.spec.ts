import { expect, test, type Page } from "@playwright/test";
import { counters, installMediaFakes, MEETING_ID, mockInPersonApi, newState, type InPersonMockState } from "./in-person-mocks";

const recorder = (page: Page) => page.getByRole("dialog", { name: /Record an in-person meeting|Recording/ });

async function openSetup(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Record in person" }).first().click();
  await expect(page.getByRole("heading", { name: "Record an in-person meeting" })).toBeVisible();
}

async function startRecording(page: Page, title = "Office design review") {
  await openSetup(page);
  await page.getByLabel("Meeting title").fill(title);
  await page.getByRole("checkbox", { name: "Everyone present has agreed to be recorded" }).check();
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByRole("heading", { name: "Recording" })).toBeVisible();
}

async function stopAndConfirm(page: Page) {
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Stop and create the transcript?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Stop and transcribe" }).click();
}

test.describe("in-person recording", () => {
  let state: InPersonMockState;

  test.beforeEach(async ({ page }) => {
    state = newState();
    await installMediaFakes(page);
    await mockInPersonApi(page, state);
  });

  test("start stays disabled until everyone has agreed, and the consent is sent", async ({ page }) => {
    await openSetup(page);
    const start = page.getByRole("button", { name: "Start recording" });
    await expect(start).toBeDisabled();
    await page.getByRole("switch", { name: "Show a notice to read aloud" }).click();
    await expect(page.getByText("This meeting is being recorded and transcribed by Meetings AI for notes and minutes. Tell me now if you do not agree.")).toBeVisible();
    await page.getByLabel("Who's expected").fill("Priya Shah, Chen Li,");
    await page.getByRole("checkbox", { name: "Everyone present has agreed to be recorded" }).check();
    await expect(start).toBeEnabled();
    await start.click();
    await expect(page.getByRole("heading", { name: "Recording" })).toBeVisible();
    expect(state.createBodies[0]).toMatchObject({
      title: "In-person meeting", device: "laptop", mime_type: "audio/webm;codecs=opus",
      consent: { everyone_agreed: true, notice_shown: true }, expected_people: ["Priya Shah", "Chen Li"], calendar_event: null,
    });
    expect((await counters(page)).wakeLocks).toBeGreaterThan(0);
  });

  test("records, keeps audio while offline, uploads in order and opens the named meeting", async ({ page, context }) => {
    test.setTimeout(90_000);
    await startRecording(page);
    const status = page.getByTestId("upload-status");
    await expect(page.getByRole("log", { name: "Live preview" })).toContainText("Caption line 1 from the room.", { timeout: 10_000 });
    await expect(status).toHaveText("Saved");

    await page.getByRole("button", { name: "Mark moment" }).click();
    await expect(page.getByText(/Moment marked at/)).toBeVisible();
    await expect.poll(() => state.moments.length).toBe(1);

    await context.setOffline(true);
    await expect(status).toHaveText("Offline — keeping audio on this device");
    const before = state.chunkSeqs.length;
    await page.waitForTimeout(1_500);
    expect(state.chunkSeqs.length).toBe(before);
    await context.setOffline(false);
    await expect.poll(() => state.chunkSeqs.length, { timeout: 10_000 }).toBeGreaterThan(before + 2);
    await expect(status).toHaveText("Saved", { timeout: 10_000 });
    expect(state.chunkSeqs).toEqual(state.chunkSeqs.map((_, index) => index));
    expect(state.streamStarts[0]).toBe(1);
    expect(state.streamStarts.slice(1).every((value) => value === 0)).toBe(true);
    expect(new Set(state.contentTypes)).toEqual(new Set(["audio/webm"]));

    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("Paused", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Resume" }).click();

    await stopAndConfirm(page);
    await expect(page.getByRole("heading", { name: "Creating the transcript" })).toBeVisible();
    await expect(page.getByText("You can leave this page; we'll notify you when the transcript is ready.")).toBeVisible();
    expect(state.stopBodies.at(-1)).toEqual({ final_seq: state.chunkSeqs.length - 1 });

    await expect(page.getByRole("heading", { name: "Office design review" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("In person").first()).toBeVisible();
    await expect(page.locator(".page-header").getByText("Recorded in person on Alex Morgan's laptop")).toBeVisible();
    await expect(page.getByText(/Everyone present agreed to be recorded/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Join meeting|Leave now/ })).toHaveCount(0);

    const naming = page.getByRole("region", { name: "Name the speakers" });
    const speakerA = naming.getByRole("group", { name: "Speaker A" });
    await expect(speakerA).toContainText("Alex Morgan");
    await expect(speakerA).toContainText("Introduced themselves as Alex");
    await expect(speakerA).toContainText("I'm Alex");
    await expect(page.getByText("Speaker A").first()).toBeVisible();
    await speakerA.getByRole("button", { name: "Approve Alex Morgan for Speaker A" }).click();
    await expect(speakerA).toContainText("Named Alex Morgan");
    expect(state.approveBodies).toEqual([{ approvals: [{ speaker: "Speaker A", name: "Alex Morgan" }] }]);
    const transcript = page.getByRole("region", { name: "Speaker-attributed transcript" });
    await expect(transcript.getByText("Alex Morgan").first()).toBeVisible();

    const speakerB = naming.getByRole("group", { name: "Speaker B" });
    await speakerB.getByRole("button", { name: "Edit name for Speaker B" }).click();
    await speakerB.getByLabel("Name for Speaker B").fill("Priya Nair");
    await speakerB.getByRole("button", { name: "Save name" }).click();
    await expect(speakerB).toContainText("Named Priya Nair");
    expect(state.approveBodies.at(-1)).toEqual({ approvals: [{ speaker: "Speaker B", name: "Priya Nair" }] });
  });

  test("a failed transcript can be retried", async ({ page }) => {
    test.setTimeout(60_000);
    state.failFinalize = true;
    await startRecording(page);
    await expect.poll(() => state.chunkSeqs.length).toBeGreaterThan(1);
    await stopAndConfirm(page);
    await expect(page.getByText("Speech-to-text timed out after three attempts.")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { name: "Office design review" })).toBeVisible({ timeout: 20_000 });
  });

  test("a missing speech-to-text profile is explained with a link to AI providers", async ({ page }) => {
    state.createError = { status: 409, detail: "No speech-to-text profile is configured. Add one in AI providers." };
    await openSetup(page);
    await page.getByRole("checkbox", { name: "Everyone present has agreed to be recorded" }).check();
    await page.getByRole("button", { name: "Start recording" }).click();
    await expect(page.getByText("No speech-to-text profile is configured. Add one in AI providers.")).toBeVisible();
    await page.getByRole("button", { name: "Open AI providers" }).click();
    await expect(page.getByRole("heading", { name: "Record an in-person meeting" })).toHaveCount(0);
  });

  test("in-person meetings carry an In person chip in lists", async ({ page }) => {
    state.status = "done";
    state.createBodies.push({ title: "Office design review" });
    await page.goto("/");
    const row = page.getByRole("button", { name: "Open Office design review" }).first();
    await expect(row).toContainText("In person");
    await expect(row).toContainText("IP");
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meetings", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open Office design review" })).toContainText("In person");
    await expect(page.getByRole("button", { name: "Record in person" })).toBeVisible();
  });

  test("fits a 360 px phone with thumb-sized controls", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await startRecording(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    for (const name of ["Pause", "Mark moment", "Stop"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
    }
    await expect(recorder(page)).toBeVisible();
  });
});

test("after a reload, saved audio is uploaded in order and the recording finishes", async ({ page }) => {
  test.setTimeout(60_000);
  const state = newState();
  await installMediaFakes(page);
  await mockInPersonApi(page, state);
  await startRecording(page);
  await expect.poll(() => state.chunkSeqs.length).toBeGreaterThan(1);
  state.failChunks = true;
  await expect(page.getByTestId("upload-status")).toHaveText(/Retrying…|Uploading \d+ pieces…/);
  await page.waitForTimeout(1_500);
  const uploaded = state.chunkSeqs.length;
  state.failChunks = false;
  await page.route("**/v1/in-person/meetings/*/chunks*", (route) => route.abort());
  await page.reload();
  await page.unroute("**/v1/in-person/meetings/*/chunks*");
  const banner = page.getByRole("status").filter({ hasText: "didn't finish recording" });
  await expect(banner).toContainText("saved on this device");
  await banner.getByRole("button", { name: "Upload the saved audio and finish" }).click();
  await expect(page.getByRole("heading", { name: "Office design review" })).toBeVisible({ timeout: 25_000 });
  expect(state.chunkSeqs.length).toBeGreaterThan(uploaded);
  expect(state.chunkSeqs).toEqual(state.chunkSeqs.map((_, index) => index));
  expect(state.stopBodies.at(-1)).toEqual({ final_seq: state.chunkSeqs.length - 1 });
});

test("keep recording after a reload starts a new stream", async ({ page }) => {
  test.setTimeout(60_000);
  const state = newState();
  await installMediaFakes(page);
  await mockInPersonApi(page, state);
  await startRecording(page);
  await expect.poll(() => state.chunkSeqs.length).toBeGreaterThan(1);
  await page.reload();
  await page.getByRole("button", { name: "Keep recording" }).click();
  await expect(page.getByText(/Recording paused when the page was reloaded/)).toBeVisible();
  const before = state.chunkSeqs.length;
  await page.getByRole("button", { name: "Resume recording" }).click();
  await expect.poll(() => state.chunkSeqs.length).toBeGreaterThan(before + 1);
  const restart = state.chunkSeqs.findIndex((seq, index) => index > 0 && state.streamStarts[index] === 1);
  expect(restart).toBeGreaterThan(0);
  expect(state.chunkSeqs).toEqual(state.chunkSeqs.map((_, index) => index));
});

test("calendar events recorded in person carry a mark and open the recording", async ({ page }) => {
  const state = newState();
  state.status = "done";
  state.createBodies.push({ title: "Office design review" });
  await installMediaFakes(page);
  await mockInPersonApi(page, state);
  const now = new Date();
  const start = new Date(now.getTime() - 60 * 60_000).toISOString();
  const end = new Date(now.getTime() - 30 * 60_000).toISOString();
  const event = { id: "evt-row-1", connection_id: "cal-1", provider: "googlecalendar", event_id: "evt-1", title: "Office design review", starts_at: start, ends_at: end,
    meeting_url: "", platform: "", synced_at: now.toISOString(), invitees: [{ name: "Priya Shah", email: "priya@example.test", response_status: "accepted" }] };
  await page.route("**/v1/calendar/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/calendar/connections") return route.fulfill({ json: [{ id: "cal-1", provider: "googlecalendar", status: "ACTIVE", label: "Work" }] });
    if (path === "/v1/calendar/synced" || path === "/v1/calendar/sync") return route.fulfill({ json: { events: [event], syncs: [{ connection_id: "cal-1", last_synced_at: now.toISOString(), range_start: new Date(now.getTime() - 40 * 86_400_000).toISOString(), range_end: new Date(now.getTime() + 40 * 86_400_000).toISOString(), truncated: false }] } });
    if (path === "/v1/calendar/schedules") return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });
  await page.route("**/v1/in-person/calendar-links", (route) => route.fulfill({ json: [{ meeting_id: MEETING_ID, connection_id: "cal-1", event_id: "evt-1", status: "done", title: "Office design review" }] }));
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar", exact: true }).click();
  const row = page.getByRole("button", { name: /Office design review/ }).first();
  await expect(row).toContainText("Recorded in person");
  await row.click();
  const detail = page.getByRole("complementary", { name: "Meeting details" });
  await expect(detail).toContainText("Recorded in person");
  await detail.getByRole("button", { name: "Open recording" }).click();
  await expect(page.getByRole("heading", { name: "Office design review" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Name the speakers" })).toBeVisible();
});

test("a blocked microphone is explained in plain words", async ({ page }) => {
  const state = newState();
  await installMediaFakes(page, { denyMic: true });
  await mockInPersonApi(page, state);
  await openSetup(page);
  await page.getByRole("button", { name: "Allow microphone" }).click();
  await expect(page.getByText("Microphone access is blocked")).toBeVisible();
  await expect(page.getByText(/allow the microphone/i).first()).toBeVisible();
  expect(state.createBodies).toHaveLength(0);
});

test("members can record from the calendar", async ({ page }) => {
  const state = newState();
  await installMediaFakes(page);
  await mockInPersonApi(page, state, "member");
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar", exact: true }).click();
  await page.getByRole("button", { name: "Record in person" }).click();
  await expect(page.getByRole("heading", { name: "Record an in-person meeting" })).toBeVisible();
});

test("the demo recorder never touches the microphone and ends on a named demo meeting", async ({ page }) => {
  test.setTimeout(90_000);
  await installMediaFakes(page, { chunkMs: 800 });
  await page.route("**/v1/**", (route) => route.fulfill({ status: 599, json: { detail: "A demo request reached the network." } }));
  await page.goto("/?demo=1");
  await expect(page.getByRole("heading", { name: "Welcome back, Alex" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open .*on-site/ }).first()).toContainText("In person");
  await page.getByRole("button", { name: "Record in person" }).first().click();
  await page.getByLabel("Meeting title").fill("Demo walkthrough");
  await page.getByRole("checkbox", { name: "Everyone present has agreed to be recorded" }).check();
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByRole("heading", { name: "Recording" })).toBeVisible();
  await expect(page.getByRole("log", { name: "Live preview" }).locator("li").first()).toBeVisible({ timeout: 15_000 });
  await stopAndConfirm(page);
  await expect(page.getByRole("heading", { name: "Demo walkthrough" })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByRole("region", { name: "Name the speakers" })).toBeVisible();
  const media = await counters(page);
  expect(media.gum).toBe(0);
  expect(media.recorders).toBe(0);
});
