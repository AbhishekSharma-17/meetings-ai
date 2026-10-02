import { expect, test, type Page } from "@playwright/test";

const ORG = "00000000-0000-4000-8000-000000000001", USER = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003", MEET = "00000000-0000-4000-8000-000000000901";
const OWN = "00000000-0000-4000-8000-000000000902", PRIVATE = "00000000-0000-4000-8000-000000000903";
const JOB = "00000000-0000-4000-8000-000000000904";
const stamp = "2026-10-02T07:00:00Z";
const draft = { title: "Architecture review", executive_summary: "The team reviewed the technical plan and commercial options.", discussion_points: ["The proposed architecture needs review."], decisions: [], action_items: [], open_questions: ["Which approach will be selected?"], speaker_contributions: [], questions_asked: [] };
const summary = (id: string, mine = false) => ({ id, meeting_id: MEET, label: mine ? "My technical notes" : "Vivek's private commercial notes", creator_id: mine ? USER : OTHER, creator_name: mine ? "Abhishek Sharma" : "Vivek", template: "custom", status: "draft", visibility: "private", revision: 1, is_mine: mine, can_read: mine, created_at: stamp, updated_at: stamp });

async function mock(page: Page, mode: "owner" | "recipient" = "owner") {
  const requests: string[] = [];
  let own: Record<string, unknown> = { ...summary(OWN, true), guidance: { template: "custom", instructions: "Explain technical details", focus_fields: ["Architecture"] }, content: draft, user_ids: [], source_is_current: true, provider: "openai", model: "economy-model" };
  const shared = { ...summary(PRIVATE), label: "Vivek's approved commercial recap", status: "approved", visibility: "specific", can_read: true, guidance: null, content: draft, user_ids: [], source_is_current: true, provider: "openai", model: "economy-model" };
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    requests.push(`${method} ${path}`);
    const body = method === "POST" || method === "PATCH" ? route.request().postDataJSON() : null;
    if (path === `/v1/meetings/${MEET}/minutes-versions`) {
      if (method === "POST") { own = { ...own, label: body.label, guidance: body.guidance, content: null, status: "empty", revision: 1 }; return route.fulfill({ status: 201, json: own }); }
      return route.fulfill({ json: [summary(PRIVATE), { ...summary(OWN, true), ...own }] });
    }
    if (path === `/v1/minutes-versions/${OWN}`) {
      if (method === "PATCH") own = { ...own, ...body, revision: Number(own.revision) + 1, status: body.content ? "draft" : own.status };
      return route.fulfill({ json: own });
    }
    if (path === `/v1/minutes-versions/${OWN}/jobs`) return route.fulfill({ status: 202, json: { id: JOB, kind: "personal_mom", subject_id: OWN, status: "queued", attempts: 0, created_at: stamp, updated_at: stamp } });
    if (path === `/v1/background-jobs/${JOB}`) {
      own = { ...own, content: draft, revision: Number(own.revision) + 1, status: "draft" };
      return route.fulfill({ json: { id: JOB, kind: "personal_mom", subject_id: OWN, status: "succeeded", result: { version_id: OWN }, attempts: 1, created_at: stamp, updated_at: stamp } });
    }
    if (path === `/v1/minutes-versions/${OWN}/approve`) { own = { ...own, status: "approved", revision: Number(own.revision) + 1 }; return route.fulfill({ json: own }); }
    if (path === `/v1/minutes-versions/${OWN}/sharing`) { own = { ...own, visibility: body.visibility, user_ids: body.user_ids, revision: Number(own.revision) + 1 }; return route.fulfill({ json: own }); }
    if (path === `/v1/minutes-versions/${PRIVATE}`) return mode === "recipient" ? route.fulfill({ json: shared }) : route.fulfill({ status: 403, json: { detail: "This MOM is private" } });
    const role = mode === "owner" ? "owner" : "member";
    const meeting = { id: MEET, title: "Engineering and commercial review", meeting_url: "https://meet.google.com/abc-defg-hij", bot_name: "Meetings AI", platform: "google_meet", status: "completed", created_at: stamp, updated_at: stamp, joined_at: stamp, stopped_at: stamp, tags: [], knowledge_enabled: false, knowledge_base_id: null };
    const map: Record<string, unknown> = {
      "/v1/auth/session": { authenticated: true },
      "/v1/auth/me": { user_id: USER, organization_id: ORG, email: "owner@example.test", display_name: "Abhishek Sharma", role, must_change_password: false },
      "/v1/workspace": { id: ORG, slug: "example", display_name: "Example", status: "active", created_at: stamp, updated_at: stamp, tenant_isolation_enabled: true },
      "/v1/workspaces": [{ id: ORG, slug: "example", display_name: "Example", role }],
      "/v1/workspace/members": [{ user_id: USER, display_name: "Abhishek Sharma", email: "owner@example.test", role, status: "active" }, { user_id: OTHER, display_name: "Vivek", email: "vivek@example.test", role: "member", status: "active" }],
      "/v1/meetings": { items: [meeting], count: 1 }, [`/v1/meetings/${MEET}`]: meeting,
      [`/v1/meetings/${MEET}/transcript`]: { segments: [{ segment_id: "s1", start_seconds: 0, end_seconds: 5, speaker: "Abhishek", text: "Let's review the technical and commercial options.", completed: true }] },
      [`/v1/meetings/${MEET}/mom-guidance`]: { template: "standard", instructions: "", focus_fields: [] },
      [`/v1/meetings/${MEET}/delivery-settings`]: { internal_recipients: [], participant_recipients: [], send_to_participants: false, include_transcript: false, internal_group_ids: [] },
      [`/v1/meetings/${MEET}/sharing`]: { shares: [], deliveries: [] },
      "/v1/me/shared-meetings": [], "/v1/me/minutes-versions": mode === "recipient" ? [shared] : [own],
      "/v1/provider-profiles": [], "/v1/provider-defaults": [], "/v1/workspace/teams": [],
      "/v1/call-coordination/meetings": [], "/v1/background-jobs": [],
      "/v1/notifications/unread-count": { unread_count: 0 },
      "/v1/knowledge-bases": [], "/v1/knowledge/text-profiles": [],
    };
    if (path in map) return route.fulfill({ json: map[path] });
    return route.fulfill({ status: 404, json: { detail: "not found" } });
  });
  return requests;
}

test("the organizer sees who made private versions, not their contents", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  await page.getByText("Engineering and commercial review", { exact: true }).first().click();
  const card = page.getByRole("region", { name: "Personal MOM versions" });
  await expect(card.getByText("Vivek's private commercial notes")).toBeVisible();
  const row = card.getByRole("listitem").filter({ hasText: "Vivek's private commercial notes" });
  await expect(row.getByText("Private contents")).toBeVisible();
  await expect(row.getByRole("button")).toHaveCount(0);
});

test("create a technical MOM from the same transcript, approve and share it", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/");
  await page.getByText("Engineering and commercial review", { exact: true }).first().click();
  await page.getByRole("button", { name: "Create my MOM" }).click();
  const dialog = page.getByRole("dialog", { name: "Create your MOM" });
  await dialog.getByLabel("Version name").fill("Architecture deep dive");
  await dialog.getByRole("combobox", { name: "Perspective" }).click();
  await page.getByRole("option", { name: "Technical deep dive" }).click();
  await expect(dialog.getByLabel("Instructions for your MOM")).toHaveValue(/technical discussions in depth/);
  await dialog.getByRole("button", { name: "Generate my MOM", exact: true }).click();
  const saved = page.getByRole("dialog", { name: "Architecture deep dive" });
  await expect(saved.getByLabel("Executive summary")).toHaveValue(draft.executive_summary, { timeout: 10_000 });
  await saved.getByRole("button", { name: "Approve my MOM" }).click();
  await expect(saved.getByText("Reviewed and approved.", { exact: false })).toBeVisible();
  await saved.getByRole("combobox", { name: "Who can read" }).click();
  await page.getByRole("option", { name: "Everyone in this workspace" }).click();
  await saved.getByRole("button", { name: "Save sharing" }).click();
  await expect(saved.getByText("Sharing saved.", { exact: false })).toBeVisible();
  expect(requests.some((request) => request.endsWith("/join"))).toBe(false);
  expect(requests.some((request) => request.includes("/minutes/generate"))).toBe(false);
});

test("a shared MOM opens without granting the recipient transcript or editing access", async ({ page }) => {
  const requests = await mock(page, "recipient");
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Shared with me" }).click();
  await page.getByRole("button", { name: "Read MOM" }).click();
  const dialog = page.getByRole("dialog", { name: "Vivek's approved commercial recap" });
  await expect(dialog.getByText(draft.executive_summary)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save version" })).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "Who can read" })).toHaveCount(0);
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download Markdown" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.md$/);
  expect(requests.some((request) => request.endsWith("/transcript"))).toBe(false);
});

test("the personal MOM dialog remains aligned on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page, "recipient");
  await page.goto("/");
  // The phone's More menu hosts the same navigation.
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Shared with me" }).click();
  await page.getByRole("button", { name: "Read MOM" }).click();
  const dialog = page.getByRole("dialog", { name: "Vivek's approved commercial recap" });
  await expect(dialog.getByText(draft.executive_summary)).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("closing a personal MOM protects unsaved edits", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Shared with me" }).click();
  await page.getByRole("button", { name: "Open my MOM" }).click();
  const dialog = page.getByRole("dialog", { name: "My technical notes" });
  await dialog.getByLabel("Executive summary").fill("My unsaved technical analysis.");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog.getByLabel("Executive summary")).toHaveValue("My unsaved technical analysis.");
});
