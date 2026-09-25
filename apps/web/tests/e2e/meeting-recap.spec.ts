import { expect, test } from "@playwright/test";

const meetingId = "00000000-0000-4000-8000-000000000099";
const evidenceId = "csrc-201:9:1790332285194";
const meeting = {
  id: meetingId, title: "Mobius recap", meeting_url: "https://meet.google.com/abc-defg-hij",
  platform: "google_meet", status: "completed", bot_name: "Meetings AI",
  created_at: "2026-09-25T10:00:00Z", updated_at: "2026-09-25T10:30:00Z",
  joined_at: "2026-09-25T10:02:00Z", stopped_at: "2026-09-25T10:30:00Z",
  tags: [], knowledge_enabled: false, knowledge_base_id: null,
};

test("recap hides internal IDs and keeps the newest transcript in a compact expandable view", async ({ page }) => {
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (path === "/v1/auth/me") return route.fulfill({ json: {
      user_id: "00000000-0000-4000-8000-000000000002",
      organization_id: "00000000-0000-4000-8000-000000000001",
      email: "developer@genaiprotos.com", display_name: "Workspace owner", role: "owner", must_change_password: false,
    } });
    if (path === "/v1/meetings") return route.fulfill({ json: { items: [meeting], count: 1 } });
    if (path === `/v1/meetings/${meetingId}`) return route.fulfill({ json: meeting });
    if (path === `/v1/meetings/${meetingId}/transcript`) return route.fulfill({ json: { segments: [
      { segment_id: evidenceId, start_seconds: 100, end_seconds: 104, speaker: "Anna", text: "Earlier discussion", completed: true },
      { segment_id: "csrc-201:10:1790332288000", start_seconds: 120, end_seconds: 124, speaker: "Bob", text: "Latest discussion", completed: true },
    ] } });
    if (path === `/v1/meetings/${meetingId}/minutes`) return route.fulfill({ json: {
      meeting_id: meetingId, status: "draft", title: "Mobius recap",
      executive_summary: `The team agreed to follow up. [${evidenceId}]`,
      discussion_points: [`The plan was reviewed. [${evidenceId}]`],
      decisions: [], action_items: [{ description: "Follow up", owner: "Anna", due_date: null, evidence_segment_ids: [evidenceId] }],
      open_questions: [], speaker_contributions: [], questions_asked: [], provider_profile_id: null,
      provider: "openai", model: "economy", created_at: meeting.created_at, updated_at: meeting.updated_at,
      approved_at: null, sent_at: null, last_error: null,
    } });
    if (path.endsWith("/delivery-settings")) return route.fulfill({ json: {
      internal_recipients: [], participant_recipients: [], send_to_participants: false, include_transcript: false,
    } });
    if (path === "/v1/integrations/resend/status") return route.fulfill({ json: {
      api_key_configured: false, sender_configured: false, sender: null, can_attempt_send: false, domain_verification: "not_checked",
    } });
    if (path === "/v1/knowledge-bases" || path === "/v1/provider-profiles" || path === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (path === "/v1/workspace") return route.fulfill({ json: {
      id: "00000000-0000-4000-8000-000000000001", display_name: "GenAI Protos", status: "active",
      created_at: meeting.created_at, updated_at: meeting.updated_at,
    } });
    return route.fulfill({ status: 404, json: { detail: "not needed in this UI test" } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open Mobius recap" }).click();
  await expect(page.getByRole("heading", { name: "MOM & follow-up" })).toBeVisible();
  await expect(page.getByLabel("Executive summary")).toHaveValue("The team agreed to follow up.");
  await expect(page.getByLabel("Action", { exact: true })).toHaveValue("Follow up");
  await expect(page.getByText(evidenceId)).toHaveCount(0);
  const mom = page.getByRole("heading", { name: "MOM & follow-up" });
  const transcript = page.getByRole("heading", { name: "Speaker-attributed transcript" });
  expect(await mom.evaluate((element) => element.compareDocumentPosition(document.querySelector("#transcript-title")) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
  await expect(transcript).toBeVisible();
  const compact = page.getByRole("list", { name: "Recent transcript turns, newest first" });
  await expect(compact.locator("li").first()).toContainText("Latest discussion");
  await page.getByRole("button", { name: "Open full transcript" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").locator("li").first()).toContainText("Latest discussion");
  await page.getByRole("button", { name: "Close transcript" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download .md" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.md$/);
});
