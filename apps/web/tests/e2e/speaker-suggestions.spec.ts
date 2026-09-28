import { expect, test, type Page } from "@playwright/test";

const meetingId = "00000000-0000-4000-8000-000000000099";
const meeting = {
  id: meetingId, title: "Speaker contact review", meeting_url: "https://meet.google.com/abc-defg-hij", platform: "google_meet",
  status: "completed", bot_name: "Meetings AI", created_at: "2026-09-09T12:00:00Z", updated_at: "2026-09-09T12:20:00Z",
  joined_at: "2026-09-09T12:01:00Z", stopped_at: "2026-09-09T12:20:00Z",
};
const segments = ["Abhishek", "Maria Lopez", "Alex", "Priya"].map((speaker, index) => ({
  segment_id: `s${index + 1}`, speaker, raw_speaker: speaker, text: `A line from ${speaker}.`,
  start_seconds: index * 4, end_seconds: index * 4 + 3, completed: true,
}));
const allSuggestions = [
  { speaker: "Abhishek", status: "suggested", email: "abhishek@example.test", display_name: "Abhishek Sharma", source: "invite", confidence: "medium", reason: "First name matches invitee Abhishek Sharma", alternatives: [] },
  { speaker: "Maria Lopez", status: "suggested", email: "maria.lopez@example.test", display_name: "Maria Lopez", source: "invite", confidence: "high", reason: "Full name matches invitee Maria Lopez", alternatives: [] },
  { speaker: "Priya", status: "suggested", email: "priya@example.test", display_name: "Priya Nair", source: "workspace_member", confidence: "high", reason: "Full name matches workspace member Priya Nair", alternatives: [] },
  { speaker: "Alex", status: "ambiguous", email: null, display_name: null, source: null, confidence: null, reason: "“Alex” matches 2 people (Alex Kim, Alex Park); choose the right one",
    alternatives: [{ email: "alex.kim@example.test", display_name: "Alex Kim", source: "invite" }, { email: "alex.park@example.test", display_name: "Alex Park", source: "invite" }] },
];

type Identity = { speaker: string; email: string; confirmed_at: string };
type State = { identities: Identity[]; putBodies: unknown[]; bulkBodies: unknown[] };

async function mockMeeting(page: Page): Promise<State> {
  const state: State = { identities: [], putBodies: [], bulkBodies: [] };
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (pathname === "/v1/auth/me") return route.fulfill({ json: {
      user_id: "00000000-0000-4000-8000-000000000002", organization_id: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test", display_name: "Workspace owner", role: "owner", must_change_password: false,
    } });
    if (pathname === "/v1/provider-profiles" || pathname === "/v1/provider-defaults") return route.fulfill({ json: [] });
    if (pathname === "/v1/meetings" && method === "GET") return route.fulfill({ json: { items: [meeting], count: 1 } });
    if (pathname === `/v1/meetings/${meetingId}`) return route.fulfill({ json: meeting });
    if (pathname === `/v1/meetings/${meetingId}/transcript`) return route.fulfill({ json: { segments } });
    if (pathname === `/v1/meetings/${meetingId}/participants`) return route.fulfill({ json: { meeting_id: meetingId, participants: [], observed_roster: "not_recorded", upstream_available: true } });
    if (pathname === `/v1/meetings/${meetingId}/speaker-identities` && method === "GET") return route.fulfill({ json: state.identities });
    if (pathname === `/v1/meetings/${meetingId}/speaker-identities` && method === "PUT") {
      const body = request.postDataJSON();
      state.putBodies.push(body);
      state.identities = [...state.identities.filter((item) => item.speaker !== body.speaker), { speaker: body.speaker, email: body.email, confirmed_at: "2026-09-09T12:30:00Z" }];
      return route.fulfill({ json: state.identities });
    }
    if (pathname === `/v1/meetings/${meetingId}/speaker-identities/bulk` && method === "POST") {
      const body = request.postDataJSON() as { identities: Array<{ speaker: string; email: string }> };
      state.bulkBodies.push(body);
      const approved = body.identities.map((item) => ({ ...item, confirmed_at: "2026-09-09T12:31:00Z" }));
      state.identities = [...state.identities.filter((item) => !approved.some((next) => next.speaker === item.speaker)), ...approved];
      return route.fulfill({ json: state.identities });
    }
    if (pathname === `/v1/meetings/${meetingId}/speaker-suggestions`) {
      return route.fulfill({ json: allSuggestions.filter((item) => !state.identities.some((identity) => identity.speaker === item.speaker)) });
    }
    if (pathname.endsWith("/delivery-settings")) return route.fulfill({ json: { internal_recipients: [], participant_recipients: [], send_to_participants: false, include_transcript: false } });
    return route.fulfill({ status: 404, json: { detail: "mock route missing" } });
  });
  return state;
}

async function openMeeting(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: `Open ${meeting.title}` }).first().click();
  await expect(page.getByRole("heading", { name: "Confirm speaker contact" })).toBeVisible();
}

test("a suggested speaker email is linked only after one-click approval", async ({ page }) => {
  const state = await mockMeeting(page);
  await openMeeting(page);
  const suggestion = page.getByRole("group", { name: "Suggested email for Abhishek" });
  await expect(suggestion).toContainText("Abhishek Sharma");
  await expect(suggestion).toContainText("abhishek@example.test");
  await expect(suggestion).toContainText("First name matches invitee Abhishek Sharma");
  await expect(suggestion).toContainText("Likely match");
  expect(state.putBodies).toEqual([]);

  await suggestion.getByRole("button", { name: "Approve abhishek@example.test for Abhishek" }).click();
  await expect(page.getByText("abhishek@example.test (confirmed)")).toBeVisible();
  await expect(page.getByRole("group", { name: "Suggested email for Abhishek" })).toHaveCount(0);
  expect(state.putBodies).toEqual([{ speaker: "Abhishek", email: "abhishek@example.test" }]);

  // Ambiguous names are never proposed; choosing an option only pre-fills the form.
  const ambiguous = page.getByRole("group", { name: "Possible matches for Alex" });
  await expect(ambiguous).toContainText("matches 2 people");
  await ambiguous.getByRole("button", { name: "Review alex.park@example.test for Alex" }).click();
  await expect(page.getByLabel("Email for Alex")).toHaveValue("alex.park@example.test");
  expect(state.putBodies).toHaveLength(1);

  // Dismiss hides a suggestion without linking anything.
  await page.getByRole("group", { name: "Suggested email for Priya" }).getByRole("button", { name: "Dismiss suggestion for Priya" }).click();
  await expect(page.getByRole("group", { name: "Suggested email for Priya" })).toHaveCount(0);
  expect(state.putBodies).toHaveLength(1);
});

test("approve all high-confidence links every strong match in one request", async ({ page }) => {
  const state = await mockMeeting(page);
  await openMeeting(page);
  await page.getByRole("button", { name: "Approve all high-confidence (2)" }).click();
  await expect(page.getByText("maria.lopez@example.test (confirmed)")).toBeVisible();
  await expect(page.getByText("priya@example.test (confirmed)")).toBeVisible();
  await expect(page.getByText("Linked 2 speakers to their email.")).toBeVisible();
  expect(state.bulkBodies).toEqual([{ identities: [
    { speaker: "Maria Lopez", email: "maria.lopez@example.test" }, { speaker: "Priya", email: "priya@example.test" },
  ] }]);
  // The medium-confidence match stays a suggestion until approved on its own.
  await expect(page.getByRole("group", { name: "Suggested email for Abhishek" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve all high-confidence/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Approve all suggestions (1)" }).click();
  await expect(page.getByText("abhishek@example.test (confirmed)")).toBeVisible();
  expect(state.bulkBodies).toHaveLength(2);
});
