import { expect, test, type Page, type Route } from "@playwright/test";

/** Call coordination: teammates set an assistant for the same call and decide who brings it. */
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const ASHA = "00000000-0000-4000-8000-000000000003";
const BEN = "00000000-0000-4000-8000-000000000004";
const MINE = "00000000-0000-4000-8000-000000000710";
const ASHAS = "00000000-0000-4000-8000-000000000711";
const SHARED = "00000000-0000-4000-8000-000000000712";
const TWO = "00000000-0000-4000-8000-000000000713";
const CREATED = "00000000-0000-4000-8000-000000000714";
const EVENT = "00000000-0000-4000-8000-000000000720";
const LINK = "https://meet.google.com/abc-defg-hij";
const stamp = new Date(Date.now() - 60 * 60_000).toISOString();
const soon = (() => { const date = new Date(); date.setMinutes(0, 0, 0); date.setHours(date.getHours() + 2); return date.toISOString(); })();
const plusHour = (iso: string) => new Date(new Date(iso).getTime() + 3_600_000).toISOString();

const you = { user_id: USER, display_name: "Workspace owner", is_you: true };
const asha = { user_id: ASHA, display_name: "Asha Patel", is_you: false };
const ben = { user_id: BEN, display_name: "Ben Ortiz", is_you: false };
const meeting = (id: string, title: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, title, meeting_url: LINK, platform: "google_meet", status, bot_name: "Meetings AI", created_at: stamp, updated_at: stamp,
  joined_at: status === "active" || status === "completed" ? stamp : null, stopped_at: null, tags: [], knowledge_enabled: false, knowledge_base_id: null, ...extra,
});
const ashaAssistant = { meeting_id: ASHAS, owner: asha, starts_at: soon, state: "in_call", covering: [ben], kept_own: false, can_open: true };

type Calls = { checks: unknown[]; created: number; joins: string[]; shared: string[] };
type Options = { role?: "owner" | "member"; conflict?: boolean; sharing?: boolean };

function coordinationFor(id: string, options: Options): unknown {
  if (id === MINE) return {
    meeting_id: MINE, state: "scheduled", starts_at: soon, owner: you, covering: [ben], your_role: "owner", receive_recap: false, kept_own: false,
    handed_to: null, other_assistants: [{ ...ashaAssistant, state: "scheduled", covering: [] }], teammates_on_calendar: 2, can_share: false, can_stop_sharing: false, can_manage: true,
  };
  if (id === ASHAS) return {
    meeting_id: ASHAS, state: "in_call", starts_at: soon, owner: asha, covering: options.sharing ? [you] : [], your_role: options.sharing ? "sharing" : null,
    receive_recap: true, kept_own: false, handed_to: null, other_assistants: [], teammates_on_calendar: 0, can_share: !options.sharing, can_stop_sharing: Boolean(options.sharing), can_manage: options.role !== "member",
  };
  return undefined;
}

async function mockApi(page: Page, options: Options = {}): Promise<Calls> {
  const calls: Calls = { checks: [], created: 0, joins: [], shared: [] };
  const role = options.role ?? "owner";
  await page.route("**/v1/**", (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();
    if (pathname === "/v1/call-coordination/check") {
      calls.checks.push(request.postDataJSON());
      return route.fulfill({ json: { supported: true, platform: "google_meet", assistants: options.conflict === false ? [] : [ashaAssistant], your_assistants: [], teammates_on_calendar: 1 } });
    }
    if (pathname === "/v1/meetings" && method === "POST") { calls.created += 1; return route.fulfill({ status: 201, json: meeting(CREATED, "Design review", "created") }); }
    if (pathname === `/v1/meetings/${CREATED}/join`) { calls.joins.push(url.search); return route.fulfill({ json: meeting(CREATED, "Design review", "requested") }); }
    if (pathname.endsWith("/coverage") && method === "POST") {
      calls.shared.push(pathname.split("/")[3]);
      options.sharing = true;
      return route.fulfill({ json: coordinationFor(ASHAS, options) });
    }
    const coordination = /^\/v1\/meetings\/([0-9a-f-]+)\/coordination$/.exec(pathname);
    if (coordination) {
      const view = coordinationFor(coordination[1], options);
      return view ? route.fulfill({ json: view }) : route.fulfill({ status: 404, json: { detail: "meeting not found" } });
    }
    const map: Record<string, unknown> = {
      "/v1/auth/session": { authenticated: true },
      "/v1/auth/me": { user_id: USER, organization_id: ORG, email: "owner@example.test", display_name: "Workspace owner", role, must_change_password: false },
      "/v1/workspace": { id: ORG, slug: "example", display_name: "Example", contact_email: null, status: "active", created_at: stamp, updated_at: stamp, tenant_isolation_enabled: true },
      "/v1/workspaces": [{ id: ORG, slug: "example", display_name: "Example", role, is_default: false }],
      "/v1/workspace/members": [{ user_id: USER, display_name: "Workspace owner", email: "owner@example.test", role, status: "active" }],
      "/v1/meetings": { items: [meeting(MINE, "Weekly sync", "created"), meeting(ASHAS, "Design review", "active"), meeting(SHARED, "Acme standup", "completed"), meeting(TWO, "Initech workshop", "created")], count: 4 },
      [`/v1/meetings/${MINE}`]: meeting(MINE, "Weekly sync", "created"),
      [`/v1/meetings/${ASHAS}`]: meeting(ASHAS, "Design review", "active"),
      [`/v1/meetings/${CREATED}`]: meeting(CREATED, "Design review", "requested"),
      [`/v1/meetings/${ASHAS}/transcript`]: { segments: [{ segment_id: "s1", start_seconds: 3, end_seconds: 6, text: "Let's start with the launch plan.", speaker: "Asha Patel", completed: true }] },
      [`/v1/meetings/${ASHAS}/coverage/minutes`]: { meeting_id: ASHAS, status: "approved", title: "Design review", executive_summary: "The launch moves to Thursday.", discussion_points: [], decisions: ["Ship on Thursday"], action_items: [{ description: "Update the release notes", owner: "Ben Ortiz", due_date: null }], open_questions: [], speaker_contributions: [], questions_asked: [], provider_profile_id: null, provider: null, model: null, created_at: stamp, updated_at: stamp, approved_at: stamp, sent_at: null, last_error: null },
      [`/v1/calendar/schedules/${MINE}`]: { meeting_id: MINE, connection_id: "manual", event_id: MINE, provider: "manual", starts_at: soon, ends_at: plusHour(soon), status: "pending", last_error: null },
      "/v1/calendar/schedules": [{ meeting_id: MINE, connection_id: "manual", event_id: MINE, provider: "manual", starts_at: soon, ends_at: plusHour(soon), status: "pending", last_error: null }],
      "/v1/call-coordination/meetings": [
        { meeting_id: MINE, owner: you, covering: [ben], your_role: "owner", kept_own: false, handed_to_owner: null, other_assistants: 1 },
        { meeting_id: SHARED, owner: asha, covering: [you], your_role: "sharing", kept_own: false, handed_to_owner: null, other_assistants: 0 },
        { meeting_id: TWO, owner: you, covering: [], your_role: "owner", kept_own: true, handed_to_owner: null, other_assistants: 1 },
      ],
      "/v1/call-coordination/calendar": [{ event_id: EVENT, assistants: [ashaAssistant], your_role: options.sharing ? "sharing" : null, your_meeting_id: options.sharing ? ASHAS : null, shared_from: options.sharing ? asha : null, teammates_on_calendar: 0 }],
      "/v1/calendar/connections": role === "member" ? [{ id: "ca-work", provider: "googlecalendar", status: "ACTIVE", label: "Work" }] : [],
      "/v1/calendar/synced": { events: role === "member" ? [{ id: EVENT, synced_at: stamp, connection_id: "ca-work", provider: "googlecalendar", event_id: "evt-1", title: "Design review", starts_at: soon, ends_at: plusHour(soon), meeting_url: LINK, platform: "google_meet", agenda: null, organizer: "Host", invitees: [], rescheduled_from: null }] : [], syncs: [{ connection_id: "ca-work", last_synced_at: new Date().toISOString(), range_start: new Date(Date.now() - 40 * 86_400_000).toISOString(), range_end: new Date(Date.now() + 60 * 86_400_000).toISOString(), truncated: false }] },
      [`/v1/calendar/events/${EVENT}/changes`]: { items: [], provider: "googlecalendar", last_checked_at: null },
      "/v1/notifications/unread-count": { unread_count: 0 },
      "/v1/notifications": { items: [], next_cursor: null, unread_count: 0 },
      "/v1/workspace/leave-policy": { silence_minutes: 10, quiet_after_end_minutes: 5, no_one_joined_minutes: 10, max_hours: 4, service_max_hours: 4, effective_max_hours: 4, configured: false, can_edit: true, updated_at: null, defaults: {}, limits: {} },
    };
    if (pathname in map) return route.fulfill({ json: map[pathname] });
    if (["/v1/provider-profiles", "/v1/provider-defaults", "/v1/background-jobs", "/v1/teams", "/v1/workspace/teams", "/v1/knowledge-bases", "/v1/documents", "/v1/workspace/brief/documents"].includes(pathname)
      || pathname.endsWith("/speakers") || pathname.endsWith("/speaker-identities")) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "not mocked" } });
  });
  return calls;
}

const nav = (page: Page, name: string) => page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name, exact: true }).click();

async function openSendDialog(page: Page) {
  await page.goto("/");
  await nav(page, "Meetings");
  await page.getByRole("button", { name: "New meeting" }).click();
  await page.getByLabel("Meeting link").fill(`${LINK}?authuser=1`);
  await page.getByRole("button", { name: "Send assistant" }).click();
}

test("the send dialog shows a teammate's assistant before creating a second one, and shares it", async ({ page }) => {
  const calls = await mockApi(page);
  await openSendDialog(page);
  const prompt = page.getByRole("region", { name: "Asha Patel already has the assistant in this call." });
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText("Also covering: Ben Ortiz");
  await expect(prompt).toContainText("1 other teammate has this meeting on their calendar.");
  await expect(page.getByRole("radio", { name: /Share Asha's assistant/ })).toBeChecked();
  expect(calls.created).toBe(0);
  await page.getByRole("button", { name: "Share Asha's assistant" }).click();
  await expect(page.getByRole("heading", { name: "Design review", level: 1 })).toBeVisible();
  expect(calls.shared).toEqual([ASHAS]);
  expect(calls.created).toBe(0);
});

test("choosing to send my own assistant anyway creates it with the explicit decision", async ({ page }) => {
  const calls = await mockApi(page);
  await openSendDialog(page);
  await page.getByRole("radio", { name: /Send my own assistant anyway/ }).check();
  await expect(page.getByText("Only one assistant can be in a call at a time.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Send my own anyway" }).click();
  await expect.poll(() => calls.joins).toEqual(["?coordination=own"]);
  expect(calls.created).toBe(1);
  expect(calls.shared).toEqual([]);
});

test("no prompt when nobody else brings an assistant", async ({ page }) => {
  const calls = await mockApi(page, { conflict: false });
  await openSendDialog(page);
  await expect.poll(() => calls.joins).toEqual([""]);
  await expect(page.getByRole("region", { name: /already has the assistant/ })).toHaveCount(0);
});

test("library chips and the meeting's coordination panel", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/");
  await nav(page, "Meetings");
  await expect(page.getByRole("button", { name: "Open Weekly sync" })).toContainText("Also covered for Ben Ortiz");
  await expect(page.getByRole("button", { name: "Open Acme standup" })).toContainText("Shared with you by Asha");
  await expect(page.getByRole("button", { name: "Open Initech workshop" })).toContainText("Two assistants");
  await page.getByRole("button", { name: "Open Weekly sync" }).click();
  const panel = page.getByRole("region", { name: "Call coordination" });
  await expect(panel).toContainText("Assistant from you · also covering: Ben Ortiz");
  await expect(panel).toContainText("Asha Patel's assistant");
  await expect(panel).toContainText("2 teammates also have this meeting on their calendar.");
  await panel.getByRole("button", { name: "Let Asha's assistant cover it" }).click();
  await expect.poll(() => calls.shared).toEqual([ASHAS]);
});

test("a member shares a teammate's assistant from the calendar and reads its notes", async ({ page }) => {
  const calls = await mockApi(page, { role: "member" });
  await page.goto("/");
  await nav(page, "Calendar");
  const row = page.getByRole("button", { name: /Design review/ }).first();
  await expect(row).toContainText("Asha's assistant");
  await row.click();
  const block = page.getByLabel("Teammates on this call");
  await expect(block).toContainText("Asha Patel has the assistant in this call.");
  await block.getByRole("button", { name: "Share Asha's assistant" }).click();
  await expect.poll(() => calls.shared).toEqual([ASHAS]);
  await expect(block).toContainText("You're sharing Asha Patel's assistant for this call.");
  await block.getByRole("button", { name: "Open its notes" }).click();
  await expect(page.getByText("Shared by Asha Patel")).toBeVisible();
  await expect(page.getByText("The launch moves to Thursday.")).toBeVisible();
  await expect(page.getByText("Let's start with the launch plan.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Call coordination" })).toContainText("You're sharing Asha's assistant");
  // Read-only: no delete, join, leave or delivery controls for a sharer.
  await expect(page.getByRole("button", { name: /Delete|Join meeting|Leave now|Send recap/ })).toHaveCount(0);
});
