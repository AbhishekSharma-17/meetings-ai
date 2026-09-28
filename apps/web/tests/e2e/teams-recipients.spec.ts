import { expect, test, type Page } from "@playwright/test";

const ORG = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const PRIYA = "00000000-0000-4000-8000-000000000088";
const LEADERSHIP = "00000000-0000-4000-8000-0000000000a1";
const ACME = "00000000-0000-4000-8000-0000000000a2";
const MEETING = "00000000-0000-4000-8000-000000000099";
const STAMP = "2026-09-25T10:00:00Z";

type Team = { id: string; name: string; description: string | null; created_by: string | null; created_at: string; updated_at: string; member_count: number; meeting_count: number; members: Array<{ email: string; user_id: string | null; display_name: string | null; photo_url: null; active: boolean }> };

const members = [
  { user_id: OWNER, display_name: "Workspace owner", email: "developer@genaiprotos.com", role: "owner", status: "active" },
  { user_id: PRIYA, display_name: "Priya Shah", email: "priya@example.test", role: "member", status: "active" },
];

function team(id: string, name: string, entries: Array<{ user_id?: string; email?: string }>): Team {
  const resolved = entries.map((entry) => {
    const member = members.find((item) => item.user_id === entry.user_id);
    return { email: member?.email ?? entry.email ?? "", user_id: member?.user_id ?? null, display_name: member?.display_name ?? null, photo_url: null, active: true };
  });
  return { id, name, description: null, created_by: OWNER, created_at: STAMP, updated_at: STAMP, member_count: resolved.length, meeting_count: 0, members: resolved };
}

const meeting = {
  id: MEETING, title: "Teams recap", meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet", status: "completed",
  bot_name: "Meetings AI", created_at: STAMP, updated_at: STAMP, joined_at: STAMP, stopped_at: "2026-09-25T10:30:00Z",
  tags: [], knowledge_enabled: false, knowledge_base_id: null,
};

async function mockApp(page: Page, options: { teams?: Team[]; minutesApproved?: boolean } = {}) {
  const state = {
    teams: options.teams ?? [] as Team[],
    teamWrites: [] as Array<{ method: string; body: unknown }>,
    meetingBody: null as Record<string, unknown> | null,
    delivery: { internal_recipients: [] as string[], participant_recipients: [] as string[], send_to_participants: false, include_transcript: false, internal_group_ids: [] as string[] },
    deliveryPuts: [] as Array<Record<string, unknown>>,
  };
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (path === "/v1/auth/me") return route.fulfill({ json: { user_id: OWNER, organization_id: ORG, email: "developer@genaiprotos.com", display_name: "Workspace owner", role: "owner", must_change_password: false } });
    if (path === "/v1/workspace") return route.fulfill({ json: { id: ORG, slug: "genai", display_name: "GenAI Protos", contact_email: null, status: "active", created_at: STAMP, updated_at: STAMP, tenant_isolation_enabled: true } });
    if (path === "/v1/workspaces") return route.fulfill({ json: [{ id: ORG, slug: "genai", display_name: "GenAI Protos", role: "owner" }] });
    if (path === "/v1/workspace/members") return route.fulfill({ json: members });
    if (path === "/v1/workspace/teams" && method === "GET") return route.fulfill({ json: state.teams });
    if (path === "/v1/workspace/teams" && method === "POST") {
      const body = request.postDataJSON();
      state.teamWrites.push({ method, body });
      const created = { ...team(`00000000-0000-4000-8000-0000000000b${state.teams.length}`, body.name, body.members), description: body.description };
      state.teams = [...state.teams, created];
      return route.fulfill({ status: 201, json: created });
    }
    const teamMatch = path.match(/^\/v1\/workspace\/teams\/([^/]+)$/);
    if (teamMatch && method === "PATCH") {
      const body = request.postDataJSON();
      state.teamWrites.push({ method, body });
      const updated = { ...team(teamMatch[1], body.name, body.members), description: body.description };
      state.teams = state.teams.map((item) => item.id === teamMatch[1] ? updated : item);
      return route.fulfill({ json: updated });
    }
    if (teamMatch && method === "DELETE") {
      state.teamWrites.push({ method, body: null });
      state.teams = state.teams.filter((item) => item.id !== teamMatch[1]);
      return route.fulfill({ status: 204, body: "" });
    }
    if (path === "/v1/knowledge-bases" || path === "/v1/provider-profiles" || path === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (path === "/v1/meetings" && method === "GET") return route.fulfill({ json: { items: options.minutesApproved ? [meeting] : [], count: options.minutesApproved ? 1 : 0 } });
    if (path === "/v1/meetings" && method === "POST") {
      state.meetingBody = request.postDataJSON();
      return route.fulfill({ status: 201, json: { ...meeting, status: "created" } });
    }
    if (path.endsWith("/join")) return route.fulfill({ status: 409, json: { detail: "capture unavailable in test" } });
    if (path === `/v1/meetings/${MEETING}`) return route.fulfill({ json: options.minutesApproved ? meeting : { ...meeting, status: "created" } });
    if (path === `/v1/meetings/${MEETING}/transcript`) return route.fulfill({ json: { segments: [
      { segment_id: "s-1", start_seconds: 1, end_seconds: 4, speaker: "Anna", text: "We agreed on the rollout.", completed: true },
    ] } });
    if (path === `/v1/meetings/${MEETING}/minutes`) return options.minutesApproved ? route.fulfill({ json: {
      meeting_id: MEETING, status: "approved", title: "Teams recap", executive_summary: "The rollout was agreed.", discussion_points: [], decisions: [],
      action_items: [], open_questions: [], speaker_contributions: [], questions_asked: [], provider_profile_id: null, provider: "openai", model: "economy",
      created_at: STAMP, updated_at: STAMP, approved_at: STAMP, sent_at: null, last_error: null,
    } }) : route.fulfill({ status: 404, json: { detail: "MOM has not been generated" } });
    if (path === `/v1/meetings/${MEETING}/delivery-settings` && method === "GET") return route.fulfill({ json: state.delivery });
    if (path === `/v1/meetings/${MEETING}/delivery-settings` && method === "PUT") {
      state.delivery = request.postDataJSON();
      state.deliveryPuts.push(state.delivery);
      return route.fulfill({ json: state.delivery });
    }
    if (path === `/v1/meetings/${MEETING}/minutes/send-configured`) {
      const used = state.teams.filter((item) => state.delivery.internal_group_ids.includes(item.id));
      const recipients = [...new Set([...state.delivery.internal_recipients, ...used.flatMap((item) => item.members.map((member) => member.email))])];
      return route.fulfill({ json: { id: "delivery-1", meeting_id: MEETING, recipients, status: "sent", provider_message_id: "email-1", error: null, created_at: STAMP,
        groups: used.map((item) => ({ id: item.id, name: item.name, member_count: item.member_count })) } });
    }
    if (path === "/v1/integrations/resend/status") return route.fulfill({ json: { api_key_configured: true, sender_configured: true, sender: "Meetings AI <m@example.test>", can_attempt_send: true, domain_verification: "not_checked" } });
    return route.fulfill({ status: 404, json: { detail: "not needed in this UI test" } });
  });
  return state;
}

test("an admin creates, renames and deletes a team in Organization & people", async ({ page }) => {
  const state = await mockApp(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Workspace owner developer@genaiprotos.com/ }).click();
  await page.getByRole("button", { name: "Organization & people" }).click();
  const card = page.getByRole("region", { name: "Teams" });
  await expect(card.getByText("No teams yet")).toBeVisible();
  await card.getByRole("button", { name: "Create a team" }).click();

  const dialog = page.getByRole("dialog", { name: "New team" });
  await dialog.getByLabel("Team name").fill("Leadership");
  await dialog.getByLabel("Priya Shah").check();
  await dialog.getByLabel("People outside the workspace").fill("board@example.test");
  await dialog.getByLabel("People outside the workspace").press("Enter");
  await expect(dialog.getByText("2 members")).toBeVisible();
  await dialog.getByRole("button", { name: "Create team" }).click();
  await expect(page.getByText("Team Leadership created.")).toBeVisible();
  expect(state.teamWrites[0]).toEqual({ method: "POST", body: { name: "Leadership", description: null, members: [{ user_id: PRIYA }, { email: "board@example.test" }] } });
  await expect(card.getByText("Leadership", { exact: true })).toBeVisible();

  await card.getByRole("button", { name: "Edit Leadership" }).click();
  const edit = page.getByRole("dialog", { name: "Edit Leadership" });
  await edit.getByLabel("Team name").fill("Leadership team");
  await edit.getByRole("button", { name: "Save team" }).click();
  await expect(page.getByText("Leadership team saved.")).toBeVisible();
  expect(state.teamWrites[1]).toMatchObject({ method: "PATCH", body: { name: "Leadership team", members: [{ user_id: PRIYA }, { email: "board@example.test" }] } });

  await card.getByRole("button", { name: "Delete Leadership team" }).click();
  await card.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page.getByText("Team Leadership team deleted.")).toBeVisible();
  await expect(card.getByText("No teams yet")).toBeVisible();
});

test("the New meeting dialog uses chips for tags, focus fields and teams", async ({ page }) => {
  const state = await mockApp(page, { teams: [team(LEADERSHIP, "Leadership", [{ user_id: OWNER }, { user_id: PRIYA }]), team(ACME, "Acme account team", [{ email: "pm@acme.example" }])] });
  await page.goto("/");
  await page.getByRole("button", { name: "New meeting" }).click();
  const dialog = page.getByRole("dialog", { name: "Send your assistant" });
  await dialog.getByLabel("Meeting link").fill("https://meet.google.com/abc-defg-hij");

  const tags = dialog.getByLabel(/Knowledge tags/);
  await tags.fill("roadmap");
  await tags.press("Enter");
  await tags.pressSequentially("customer research,");
  await expect(dialog.getByRole("button", { name: "Remove customer research" })).toBeVisible();

  await dialog.getByText("Minutes format").click();
  const focus = dialog.getByLabel(/Additional fields to cover/);
  await focus.fill("Risks");
  await focus.press("Enter");
  await focus.fill("Budget");
  await focus.press("Enter");
  await expect(dialog.getByRole("button", { name: "Remove Budget" })).toBeVisible();

  await dialog.getByText("Recap delivery options").click();
  const internal = dialog.getByLabel("Internal team email addresses");
  await internal.pressSequentially("@lead");
  await expect(page.getByRole("option", { name: /Leadership/ })).toBeVisible();
  await internal.press("Enter");
  const chip = dialog.getByRole("button", { name: /Leadership, team of 2 members/ });
  await expect(chip).toBeVisible();
  await chip.hover();
  const tooltip = page.locator(".chip-tooltip");
  await expect(tooltip).toContainText("Priya Shah");
  await expect(tooltip).toContainText("priya@example.test");
  await chip.click();
  expect(state.meetingBody).toBeNull(); // the chip is not a submit button
  await internal.fill("pm@example.test");
  await internal.press("Enter");
  await expect(dialog.getByText("1 team + 1 recipient · sent after approval")).toBeVisible();

  await dialog.getByRole("button", { name: "Send assistant" }).click();
  await expect.poll(() => state.meetingBody).not.toBeNull();
  expect(state.meetingBody).toMatchObject({
    tags: ["roadmap", "customer research"],
    mom_guidance: { focus_fields: ["Risks", "Budget"] },
    delivery_settings: { internal_recipients: ["pm@example.test"], internal_group_ids: [LEADERSHIP] },
  });

  // The next meeting starts with the same team, remembered for this user.
  await expect(page.getByRole("dialog", { name: "Send your assistant" })).toHaveCount(0);
  await page.getByRole("button", { name: "Overview" }).first().click();
  await page.getByRole("button", { name: "New meeting" }).click();
  await page.getByText("Recap delivery options").click();
  await expect(page.getByRole("button", { name: /Leadership, team of 2 members/ })).toBeVisible();
});

test("the recap card sends to a team chosen by name", async ({ page }) => {
  const state = await mockApp(page, { minutesApproved: true, teams: [team(ACME, "Acme account team", [{ user_id: PRIYA }, { email: "pm@acme.example" }])] });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Teams recap" }).click();
  const internal = page.getByLabel("Internal team recipients");
  await internal.pressSequentially("Acme");
  await page.getByRole("option", { name: /Acme account team/ }).click();
  await expect(page.getByRole("button", { name: /Acme account team, team of 2 members/ })).toBeVisible();
  await page.getByRole("button", { name: "Save recipients" }).click();
  await expect(page.getByText("Recipient choices saved for this meeting.")).toBeVisible();
  expect(state.deliveryPuts.at(-1)).toMatchObject({ internal_recipients: [], internal_group_ids: [ACME] });
  await page.getByRole("button", { name: "Send recap" }).click();
  await expect(page.getByText("Recap sent to 2 recipients (including Acme account team).")).toBeVisible();
});
