import { expect, test, type Page } from "@playwright/test";

const orgId = "00000000-0000-4000-8000-000000000001";
const meetingId = "00000000-0000-4000-8000-000000000077";
const owner = { user_id: "00000000-0000-4000-8000-000000000002", organization_id: orgId, email: "owner@example.test", display_name: "Workspace owner", role: "owner", must_change_password: false };
const cara = { user_id: "00000000-0000-4000-8000-000000000003", display_name: "Cara Lee", email: "cara@example.test", role: "member", status: "active", photo_url: null, invite_expires_at: null };
const pat = { user_id: "00000000-0000-4000-8000-000000000004", display_name: "Pat Invited", email: "pat@example.test", role: "member", status: "invited", photo_url: null, invite_expires_at: null };
const meeting = {
  id: meetingId, title: "Acme renewal", meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet", status: "completed", bot_name: "Meetings AI",
  created_at: "2026-09-25T10:00:00Z", updated_at: "2026-09-25T10:30:00Z", joined_at: "2026-09-25T10:02:00Z", stopped_at: "2026-09-25T10:30:00Z",
  tags: [], knowledge_enabled: false, knowledge_base_id: null,
};
const minutes = {
  meeting_id: meetingId, status: "sent", title: "Acme renewal", executive_summary: "Acme renews for two years.", discussion_points: [],
  decisions: ["Renew for two years"], action_items: [{ description: "Send the contract", owner: "Cara", due_date: null, evidence_segment_ids: [] }],
  open_questions: [], speaker_contributions: [], questions_asked: [], provider_profile_id: null, provider: "openai", model: "economy",
  created_at: meeting.created_at, updated_at: meeting.updated_at, approved_at: meeting.updated_at, sent_at: meeting.updated_at, last_error: null,
};
const transcript = { segments: [{ segment_id: "s1", start_seconds: 10, end_seconds: 14, speaker: "Asha", text: "We renew for two years.", completed: true }] };
const recap = { id: "d1", kind: "recap", recipients: ["team@example.test"], status: "sent", error: null, sent_by: { user_id: owner.user_id, display_name: owner.display_name }, include_transcript: false, created_at: "2026-09-25T10:45:00Z" };

async function common(page: Page, account: typeof owner, extra: (path: string, method: string, body: unknown) => unknown) {
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const handled = extra(path, request.method(), request.postDataJSON());
    if (handled !== undefined) return route.fulfill(handled as Parameters<typeof route.fulfill>[0]);
    if (path === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (path === "/v1/auth/me") return route.fulfill({ json: account });
    if (path === "/v1/workspace") return route.fulfill({ json: { id: orgId, display_name: "GenAI Protos", status: "active", created_at: meeting.created_at, updated_at: meeting.updated_at } });
    if (path === "/v1/workspace/members") return route.fulfill({ json: [{ ...owner, status: "active", photo_url: null, invite_expires_at: null }, cara, pat] });
    if (path === "/v1/meetings") return route.fulfill({ json: { items: [meeting], count: 1 } });
    if (path === `/v1/meetings/${meetingId}`) return route.fulfill({ json: meeting });
    if (path === `/v1/meetings/${meetingId}/transcript`) return route.fulfill({ json: transcript });
    if (path === `/v1/meetings/${meetingId}/minutes`) return route.fulfill({ json: minutes });
    if (path.endsWith("/delivery-settings")) return route.fulfill({ json: { internal_recipients: ["team@example.test"], participant_recipients: [], send_to_participants: false, include_transcript: false } });
    if (path === "/v1/integrations/resend/status") return route.fulfill({ json: { api_key_configured: true, sender_configured: true, sender: "x", can_attempt_send: true, domain_verification: "verified" } });
    if (path === "/v1/knowledge-bases" || path === "/v1/provider-profiles" || path === "/v1/provider-defaults" || path === "/v1/teams") return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "not needed in this UI test" } });
  });
}

test("an admin shares a meeting with a teammate, resends the recap and sees the history", async ({ page }) => {
  let history = { shares: [] as unknown[], deliveries: [recap] as unknown[] };
  const posts: { path: string; body: unknown }[] = [];
  await common(page, owner, (path, method, body) => {
    if (path === `/v1/meetings/${meetingId}/sharing`) return { json: history };
    if (path === `/v1/meetings/${meetingId}/shares` && method === "POST") {
      posts.push({ path, body });
      history = { ...history, shares: [{ id: "sh1", person: { user_id: cara.user_id, display_name: cara.display_name, email: cara.email }, shared_by: { user_id: owner.user_id, display_name: owner.display_name }, note: "Check the actions", created_at: "2026-09-26T09:00:00Z", revoked_at: null, revoked_by: null }] };
      return { json: history };
    }
    if (path === `/v1/meetings/${meetingId}/shares/sh1` && method === "DELETE") {
      history = { ...history, shares: [{ ...(history.shares[0] as object), revoked_at: "2026-09-26T10:00:00Z", revoked_by: { user_id: owner.user_id, display_name: owner.display_name } }] };
      return { json: history };
    }
    if (path === `/v1/meetings/${meetingId}/minutes/resend`) {
      posts.push({ path, body });
      const resent = { ...recap, id: "d2", kind: "resend", recipients: ["late@example.test"], include_transcript: true, created_at: "2026-09-26T09:30:00Z" };
      history = { ...history, deliveries: [resent, recap] };
      return { json: { id: "d2", meeting_id: meetingId, recipients: ["late@example.test"], status: "sent", provider_message_id: "x", error: null, created_at: resent.created_at } };
    }
    return undefined;
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open Acme renewal" }).click();
  const card = page.locator(".sharing-card");
  await expect(card.getByRole("heading", { name: "Sharing" })).toBeVisible();
  await expect(card.getByRole("list", { name: "Recap emails" })).toContainText("team@example.test");

  // Only active non-admin teammates are offered (the invite that isn't accepted yet is not).
  await card.getByLabel("Teammates", { exact: true }).fill("Ca");
  await expect(page.getByRole("option", { name: /Pat Invited/ })).toHaveCount(0);
  await page.getByRole("option", { name: /Cara Lee/ }).click();
  await card.getByLabel("Note").fill("Check the actions");
  await card.getByRole("button", { name: "Share", exact: true }).click();
  await expect(card.getByText("Shared with 1 person. They were notified.")).toBeVisible();
  expect(posts[0].body).toEqual({ user_ids: [cara.user_id], note: "Check the actions" });
  const shared = card.getByRole("list", { name: "Shared with" });
  await expect(shared).toContainText("Cara Lee");
  await expect(shared).toContainText("by Workspace owner");

  await card.getByLabel("Send to").fill("late@example.test");
  await card.getByLabel("Send to").press("Enter");
  await card.getByRole("switch", { name: "Attach the full timestamped transcript (.md)" }).click();
  await card.getByRole("button", { name: "Send again" }).click();
  await expect(card.getByText("Recap sent again to late@example.test.")).toBeVisible();
  expect(posts[1].body).toEqual({ recipients: ["late@example.test"], include_transcript: true });
  await expect(card.getByRole("list", { name: "Recap emails" }).locator("li").first()).toContainText("Sent again");

  const capture = process.env.PLAYWRIGHT_CAPTURE_DIR;
  if (capture) await card.screenshot({ path: `${capture}/meeting-sharing-card.png` });

  await shared.getByRole("button", { name: "Remove access" }).click();
  await expect(shared).toContainText("Access removed");
  await expect(shared).toContainText("Removed");
});

test("the sharing card fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const history = { shares: [{ id: "sh1", person: { user_id: cara.user_id, display_name: cara.display_name, email: cara.email }, shared_by: { user_id: owner.user_id, display_name: owner.display_name }, note: "Please check the action items before the Friday review", created_at: "2026-09-26T09:00:00Z", revoked_at: null, revoked_by: null }],
    deliveries: [{ ...recap, recipients: ["team@example.test", "finance@example.test", "legal@example.test", "ceo@example.test"] }] };
  await common(page, owner, (path) => path === `/v1/meetings/${meetingId}/sharing` ? { json: history } : undefined);
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Meetings", exact: true }).click();
  await page.getByRole("button", { name: "Open Acme renewal" }).click();
  const card = page.locator(".sharing-card");
  await expect(card.getByRole("list", { name: "Shared with" })).toContainText("Cara Lee");
  await expect(card.getByRole("list", { name: "Recap emails" })).toContainText("+1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const capture = process.env.PLAYWRIGHT_CAPTURE_DIR;
  if (capture) await card.screenshot({ path: `${capture}/meeting-sharing-card-360.png` });
});

test("a member opens a meeting shared with them from Shared with me", async ({ page }) => {
  const member = { ...owner, user_id: cara.user_id, email: cara.email, display_name: cara.display_name, role: "member" };
  await common(page, member, (path) => {
    if (path === "/v1/me/shared-meetings") return { json: [{ meeting_id: meetingId, title: "Acme renewal", platform: "google_meet", status: "completed", meeting_at: meeting.joined_at, shared_by: { user_id: owner.user_id, display_name: owner.display_name }, shared_at: "2026-09-26T09:00:00Z", note: "Check the actions" }] };
    if (path === `/v1/meetings/${meetingId}/shared-view`) return { json: { shared_by: { user_id: owner.user_id, display_name: owner.display_name }, shared_at: "2026-09-26T09:00:00Z", note: "Check the actions", minutes } };
    if (path === `/v1/meetings/${meetingId}/minutes`) return { status: 403, json: { detail: "workspace role does not permit this action" } };
    return undefined;
  });

  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Shared with me" }).click();
  await expect(page.getByRole("heading", { name: "Shared with me" })).toBeVisible();
  await page.getByRole("button", { name: /Acme renewal/ }).click();
  await expect(page.getByText("Shared by Workspace owner")).toBeVisible();
  await expect(page.getByText("Check the actions")).toBeVisible();
  await expect(page.getByText("Acme renews for two years.")).toBeVisible();
  await expect(page.getByText("We renew for two years.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sharing" })).toHaveCount(0);  // no sharing controls for members
});
