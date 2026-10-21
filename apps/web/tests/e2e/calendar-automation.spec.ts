import { expect, test, type Page } from "@playwright/test";
import type { AutomationView, MeetingAutomation } from "../../src/lib/calendar-automation-service";

const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const MEETING = "00000000-0000-4000-8000-000000000710";
const STAMP = "2026-10-21T08:00:00Z";
const event = { connection_id: "work", provider: "outlook", event_id: "evt", title: "Leadership sync", starts_at: "2026-10-22T10:00:00Z", ends_at: "2026-10-22T11:00:00Z", meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet", organizer: null, agenda: null, invitees: [] };

async function mock(page: Page, options: { member?: boolean; owned?: boolean; unavailable?: boolean; readonly?: boolean; rule?: Partial<AutomationView>; automation?: Partial<MeetingAutomation> } = {}) {
  let rule: AutomationView = { enabled: false, connection_ids: [], meeting_types: "all", enrolment_scope: "upcoming", bot_name: "Meetings AI", recording_disclosure_acknowledged: false, mom_mode: "draft", mom_guidance: { template: "standard", instructions: "", focus_fields: [] }, delivery: { internal_group_ids: [], include_transcript: false }, knowledge_enabled: false, knowledge_base_id: null, availability: { calendar_configured: true, scheduler_enabled: !options.unavailable }, last_scan_at: null, next_scan_at: null, last_error: null, can_edit: !options.readonly, can_manage_policy: !options.member, can_auto_send: false };
  rule = { ...rule, ...options.rule };
  let policy = { automatic_delivery_enabled: false, allowed_group_ids: [] as string[], can_manage: !options.member };
  let override: MeetingAutomation = { automated: true, can_edit: true, skip: false, hold_delivery: false, mom_mode: "inherit", internal_group_ids: null, knowledge_base_id: null, delivery_status: "pending", last_error: null };
  override = { ...override, ...options.automation };
  let meeting = { id: MEETING, title: "Leadership sync", meeting_url: event.meeting_url, platform: "google_meet", status: "completed", bot_name: "Meetings AI", created_at: STAMP, updated_at: STAMP, joined_at: STAMP, stopped_at: STAMP, tags: [], knowledge_enabled: false, knowledge_base_id: null };
  const calls = { writes: [] as Record<string, unknown>[], previews: 0, checks: 0, overrides: [] as Record<string, unknown>[], knowledge: [] as Record<string, unknown>[], minutesReads: 0, minutesWrites: [] as Record<string, unknown>[], manualSends: 0 };
  let minutes = { meeting_id: MEETING, status: "draft", title: "Leadership sync", executive_summary: "Review the launch approval.", discussion_points: [], decisions: [], action_items: [], open_questions: [], speaker_contributions: [], questions_asked: [], provider_profile_id: null, provider: "configured provider", model: "configured model", created_at: STAMP, updated_at: STAMP, approved_at: null as string | null, sent_at: null as string | null, last_error: null };
  const account = { user_id: USER, organization_id: ORG, email: "owner@example.test", display_name: "Meeting owner", role: options.member ? "member" : "owner", must_change_password: false };
  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/v1/calendar/automation") {
      if (method === "PUT") { const body = route.request().postDataJSON(); calls.writes.push(body); rule = { ...rule, ...body }; }
      return route.fulfill({ json: rule });
    }
    if (path === "/v1/workspace/automation-policy") { if (method === "PUT") policy = { ...policy, ...route.request().postDataJSON() }; return route.fulfill({ json: policy }); }
    if (path === "/v1/calendar/automation/preview") { calls.previews++; return route.fulfill({ json: { eligible: [{ event, reason: "eligible" }], excluded: [{ event: { ...event, title: "Personal appointment" }, reason: "unsupported_meeting_link" }], truncated: false } }); }
    if (path === "/v1/calendar/automation/reconcile") { calls.checks++; return route.fulfill({ json: { scheduled: 1, excluded: 1, errors: [] } }); }
    if (path === `/v1/meetings/${MEETING}/automation`) { if (options.owned === false) return route.fulfill({ status: 404, json: { detail: "meeting not found" } }); if (method === "PATCH") { const body = route.request().postDataJSON(); calls.overrides.push(body); override = { ...override, ...body }; } return route.fulfill({ json: override }); }
    if (path === `/v1/meetings/${MEETING}/knowledge` && method === "PATCH") { const body = route.request().postDataJSON(); calls.knowledge.push(body); meeting = { ...meeting, ...body }; return route.fulfill({ json: meeting }); }
    if (path === `/v1/meetings/${MEETING}/minutes`) {
      if (method === "GET") calls.minutesReads++;
      if (method === "PUT") { const body = route.request().postDataJSON(); calls.minutesWrites.push(body); minutes = { ...minutes, ...body }; }
      return route.fulfill({ json: minutes });
    }
    if (path === `/v1/meetings/${MEETING}/minutes/approve`) { minutes = { ...minutes, status: "approved", approved_at: STAMP }; return route.fulfill({ json: minutes }); }
    if (path === `/v1/meetings/${MEETING}/minutes/send-configured`) { calls.manualSends++; minutes = { ...minutes, status: "sent", sent_at: STAMP }; return route.fulfill({ json: { recipients: ["leader@example.test"], groups: [], status: "sent" } }); }
    const data: Record<string, unknown> = {
      "/v1/auth/session": { authenticated: true }, "/v1/auth/me": account,
      "/v1/workspace": { id: ORG, slug: "example", display_name: "Example", status: "active", created_at: STAMP, updated_at: STAMP },
      "/v1/workspaces": [{ id: ORG, display_name: "Example", role: account.role }],
      "/v1/workspace/members": [{ ...account, status: "active" }],
      "/v1/calendar/connections": [{ id: "work", provider: "outlook", label: "Work calendar", identity: "me@example.test", status: "ACTIVE" }],
      "/v1/calendar/schedules": [], "/v1/calendar/synced": { events: [], syncs: [] },
      "/v1/meetings": { items: [meeting], count: 1 }, [`/v1/meetings/${MEETING}`]: meeting,
      [`/v1/meetings/${MEETING}/transcript`]: { segments: [{ segment_id: "turn-1", text: "The launch is approved.", speaker: "Owner", completed: true, start_seconds: 0, end_seconds: 4 }] },
      [`/v1/meetings/${MEETING}/coverage/minutes`]: { ...minutes, status: "approved" },
      [`/v1/meetings/${MEETING}/minutes-versions`]: [],
      [`/v1/meetings/${MEETING}/mom-guidance`]: { template: "standard", instructions: "", focus_fields: [] },
      [`/v1/meetings/${MEETING}/delivery-settings`]: { internal_recipients: [], internal_group_ids: ["leadership"], participant_recipients: [], send_to_participants: false, include_transcript: false },
      "/v1/integrations/resend/status": { api_key_configured: true, sender_configured: true, sender: "recap@example.test", can_attempt_send: true, domain_verification: "not_checked" },
      [`/v1/meetings/${MEETING}/coordination`]: { meeting_id: MEETING, state: "ended", starts_at: STAMP, owner: { user_id: options.owned === false ? "other" : USER, display_name: "Meeting owner", is_you: options.owned !== false }, your_role: options.owned === false ? "sharing" : "owner", can_manage: options.owned !== false, covering: [], other_assistants: [], teammates_on_calendar: 0, can_share: false, can_stop_sharing: false, kept_own: false, handed_to: null, receive_recap: false },
      "/v1/workspace/teams": [{ id: "leadership", name: "Leadership", member_count: 2, members: [] }],
      "/v1/knowledge-bases": [{ id: "kb", name: "Leadership knowledge" }],
      "/v1/notifications/unread-count": { unread_count: 0 }, "/v1/notifications": { items: [], unread_count: 0, next_cursor: null },
    };
    if (path in data) return route.fulfill({ json: data[path] });
    if (["/v1/provider-profiles", "/v1/provider-defaults", "/v1/background-jobs", "/v1/documents", "/v1/knowledge/text-profiles", "/v1/call-coordination/meetings"].includes(path)) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });
  return calls;
}
async function automation(page: Page) {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Calendar", exact: true }).click();
  await page.getByRole("tab", { name: "Automation" }).click();
  await expect(page.getByLabel("Automatically schedule my assistant")).toBeVisible();
}
async function openMemberMeeting(page: Page) {
  await page.addInitScript(({ org, user, meeting }) => { sessionStorage.setItem(`meetings-ai:active-view:${org}:${user}`, JSON.stringify("meeting")); sessionStorage.setItem(`meetings-ai:active-meeting:${org}:${user}`, JSON.stringify(meeting)); }, { org: ORG, user: USER, meeting: MEETING });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Leadership sync", level: 1 })).toBeVisible();
}

test("opt-in rule previews without writes, persists safely and checks saved settings", async ({ page }) => {
  const calls = await mock(page);
  await automation(page);
  await expect(page.getByLabel("Automatically schedule my assistant")).not.toBeChecked();
  await expect(page.getByLabel("Include automatically enrolled meetings")).not.toBeChecked();
  await page.getByLabel("Automatically schedule my assistant").check();
  await page.getByRole("checkbox", { name: "Work calendar me@example.test" }).check();
  await page.getByLabel("I will disclose recording").check();
  await page.getByLabel("Default assistant name").fill("Leadership recorder");
  await page.getByRole("button", { name: "Preview matches" }).click();
  await expect(page.getByText("1 eligible · 1 excluded")).toBeVisible();
  await expect(page.getByText(/Personal appointment · unsupported meeting link/)).toBeVisible();
  expect(calls.writes).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Check now" })).toBeDisabled();
  await page.getByRole("button", { name: "Save automation" }).click();
  await expect(page.getByText("Automation settings saved.")).toBeVisible();
  expect(calls.writes[0]).toMatchObject({ enabled: true, connection_ids: ["work"], bot_name: "Leadership recorder", knowledge_enabled: false, knowledge_base_id: null, mom_mode: "draft" });
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByText("1 assistants scheduled; 1 excluded.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Default assistant name")).toHaveValue("Leadership recorder");
  await expect(page.getByLabel("Automatically schedule my assistant")).toBeChecked();
  expect(calls.checks).toBe(1);
});

test("admin policy authorizes a selected team before a personal automatic send rule", async ({ page }) => {
  const calls = await mock(page);
  await automation(page);
  await page.getByLabel("Allow automatic MOM email").check();
  await page.getByRole("group", { name: "Authorized teams" }).getByLabel("Leadership").check();
  await page.getByRole("button", { name: "Save delivery policy" }).click();
  await expect(page.getByText("Workspace delivery policy saved.")).toBeVisible();
  await page.getByRole("combobox", { name: "After the MOM is generated" }).click();
  await page.getByRole("option", { name: "Save and email automatically to authorized teams" }).click();
  await page.getByRole("group", { name: "Recipient teams" }).getByLabel("Leadership").check();
  await page.getByRole("button", { name: "Save automation" }).click();
  await expect.poll(() => calls.writes.length).toBe(1);
  expect(calls.writes[0]).toMatchObject({ mom_mode: "send_automatically", delivery: { internal_group_ids: ["leadership"], include_transcript: false } });
});

test("own member meeting supports skip, review hold and late transcript knowledge inclusion", async ({ page }) => {
  const calls = await mock(page, { member: true });
  await openMemberMeeting(page);
  await page.getByLabel("Skip this occurrence").click();
  await expect(page.getByLabel("Skip this occurrence")).toBeChecked();
  await page.getByLabel("Require manual review").click();
  await expect.poll(() => calls.overrides.length).toBe(2);
  expect(calls.overrides).toEqual([{ skip: true }, { hold_delivery: true }]);
  await page.getByRole("switch", { name: "Include in AI knowledge" }).click();
  await page.getByRole("combobox", { name: "Knowledge base", exact: true }).click();
  await page.getByRole("option", { name: "Leadership knowledge" }).click();
  await page.getByRole("button", { name: "Save knowledge settings" }).click();
  await expect.poll(() => calls.knowledge.length).toBe(1);
  expect(calls.knowledge[0]).toMatchObject({ knowledge_enabled: true, knowledge_base_id: "kb" });
  await expect(page.getByText(/saved transcript can be indexed without recording again/)).toBeVisible();
});

test("a member sharing another person's meeting has no knowledge management controls", async ({ page }) => {
  const calls = await mock(page, { member: true, owned: false });
  await openMemberMeeting(page);
  await expect(page.getByRole("button", { name: "Save knowledge settings" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "MOM & follow-up" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save & approve" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send recap" })).toHaveCount(0);
  await expect(page.getByLabel("Skip this occurrence")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Minutes", exact: true })).toBeVisible();
  expect(calls.minutesReads).toBe(0);
});

test("an owned member meeting can review, approve and manually send its held MOM", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await mock(page, { member: true, automation: { delivery_status: "held", last_error: "assistant stopped manually; review MOM before sending" } });
  await openMemberMeeting(page);
  await expect(page.getByRole("heading", { name: "MOM & follow-up" })).toBeVisible();
  await expect(page.getByText(/Automatic email is suspended because the assistant was stopped manually/)).toBeVisible();
  await page.getByLabel("Executive summary").fill("The saved transcript confirms launch approval.");
  await page.getByRole("button", { name: "Save & approve" }).click();
  await expect(page.getByRole("heading", { name: "Send approved recap" })).toBeVisible();
  expect(calls.minutesWrites[0]).toMatchObject({ executive_summary: "The saved transcript confirms launch approval." });
  await expect(page.getByRole("button", { name: "Send recap", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Send recap", exact: true }).click();
  await expect(page.getByText("Recap sent", { exact: true })).toBeVisible();
  expect(calls.manualSends).toBe(1);
  await expect(page.getByRole("switch", { name: "Include in AI knowledge" })).not.toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/calendar-automation-member-review-390.png", fullPage: true });
  expect(pageErrors).toEqual([]);
});

test("unsaved edits survive tab navigation and loading errors offer retry", async ({ page }) => {
  await mock(page);
  await automation(page);
  await page.getByLabel("Default assistant name").fill("Unsaved recorder");
  await page.getByRole("tab", { name: "Calendar", exact: true }).click();
  await page.getByRole("tab", { name: "Automation" }).click();
  await expect(page.getByLabel("Default assistant name")).toHaveValue("Unsaved recorder");
  await expect(page.getByText(/You have unsaved changes/)).toBeVisible();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByLabel("Default assistant name")).toHaveValue("Meetings AI");
  await page.route("**/v1/calendar/automation", (route) => route.fulfill({ status: 503, json: {} }));
  await page.getByRole("tab", { name: "Calendar", exact: true }).click();
  await page.getByRole("tab", { name: "Automation" }).click();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
});

test("a revoked delivery policy cannot prevent turning an enabled rule off", async ({ page }) => {
  const calls = await mock(page, { rule: { enabled: true, mom_mode: "send_automatically", delivery: { internal_group_ids: ["deleted-team"], include_transcript: false } } });
  await automation(page);
  await page.getByLabel("Automatically schedule my assistant").uncheck();
  await page.getByRole("button", { name: "Save automation" }).click();
  await expect(page.getByText("Automation settings saved.")).toBeVisible();
  expect(calls.writes[0]).toMatchObject({ enabled: false });
});

test("malformed session drafts are ignored and validation errors preserve typed settings", async ({ page }) => {
  await page.addInitScript(({ org, user }) => sessionStorage.setItem(`meetings-ai:automation-draft:${org}:${user}`, JSON.stringify({ connection_ids: [], delivery: {}, mom_guidance: { focus_fields: null } })), { org: ORG, user: USER });
  await mock(page);
  await automation(page);
  await expect(page.getByLabel("Default assistant name")).toHaveValue("Meetings AI");
  await page.route("**/v1/calendar/automation", (route) => route.request().method() === "PUT" ? route.fulfill({ status: 422, json: { detail: "Selected team contains external addresses. Choose an internal team." } }) : route.fallback());
  await page.getByLabel("Default assistant name").fill("Keep this name");
  await page.getByRole("button", { name: "Save automation" }).click();
  await expect(page.getByText("Selected team contains external addresses. Choose an internal team.")).toBeVisible();
  await expect(page.getByLabel("Default assistant name")).toHaveValue("Keep this name");
});

test("member capabilities keep policy hidden and saved rules explain worker unavailability", async ({ page }) => {
  await mock(page, { member: true, unavailable: true, readonly: true, rule: { enabled: true, availability: { calendar_configured: true, scheduler_enabled: false, auto_mom_enabled: false } } });
  await automation(page);
  await expect(page.getByLabel("Automatically schedule my assistant")).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Workspace automatic delivery policy" })).toHaveCount(0);
  await expect(page.getByText(/automatic joining is paused/)).toBeVisible();
  await expect(page.getByText(/Automatic MOM processing is disabled/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Check now" })).toBeDisabled();
});

for (const width of [390, 768, 1440]) for (const theme of ["light", "dark"]) test(`automation renders at ${width}px in ${theme} without overflow`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
  await mock(page);
  await page.goto("/?calendar=connected&status=success");
  await page.getByRole("tab", { name: "Automation" }).click();
  await expect(page.getByLabel("Automatically schedule my assistant")).toBeVisible();
  await expect(page.locator("html")).toHaveClass(new RegExp(theme));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/calendar-automation-${theme}-${width}.png`, fullPage: true });
});
