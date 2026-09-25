import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const screenshotDirectory = path.resolve(
  __dirname,
  "../../../../docs/status/ui-walkthrough",
);
const walkthroughDelay = Number(process.env.PLAYWRIGHT_WALKTHROUGH_DELAY_MS ?? "0");

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title.startsWith("same-origin API proxy")) return;
  // UI walkthroughs isolate product behavior from the local admin password.
  // Individual tests override these defaults for their target API actions.
  await page.route("**/v1/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/auth/session") return route.fulfill({ json: { authenticated: true } });
    if (pathname === "/v1/auth/me") return route.fulfill({ json: {
      user_id: "00000000-0000-4000-8000-000000000002",
      organization_id: "00000000-0000-4000-8000-000000000001",
      email: "developer@genaiprotos.com", display_name: "Workspace owner",
      role: "owner", must_change_password: false,
    } });
    if (pathname === "/v1/provider-profiles" || pathname === "/v1/provider-defaults") {
      return route.fulfill({ json: [] });
    }
    if (pathname.endsWith("/delivery-settings")) return route.fulfill({ json: {
      internal_recipients: [], participant_recipients: [], send_to_participants: false, include_transcript: false,
    } });
    return route.fulfill({ status: 404, json: { detail: "mock route missing" } });
  });
});

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

  expect([200, 401]).toContain(response.status);
  if (response.status === 200) {
    expect(response.body).toMatchObject({ items: expect.any(Array), count: expect.any(Number) });
  } else {
    expect(response.body).toMatchObject({ detail: "sign in required" });
  }
});

test("workspace profile can be edited", async ({ page }) => {
  let workspace = {
    id: "00000000-0000-4000-8000-000000000001", slug: "legacy-workspace",
    display_name: "GenAI Protos", contact_email: null as string | null,
    status: "active", created_at: "2026-09-24T00:00:00Z",
    updated_at: "2026-09-24T00:00:00Z", tenant_isolation_enabled: false,
  };
  await page.route("**/v1/workspace**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/workspace/audit") return route.fulfill({ json: [{
      id: "00000000-0000-4000-8000-000000000099",
      actor_user_id: "00000000-0000-4000-8000-000000000002",
      action: "auth.login.succeeded", resource_path: "/v1/auth/login",
      resource_id: null, status_code: 200, created_at: "2026-09-24T00:00:00Z",
    }] });
    if (pathname === "/v1/workspace/members") return route.fulfill({ json: [{
      user_id: "00000000-0000-4000-8000-000000000002",
      display_name: "Local administrator", email: null, role: "owner", status: "active",
    }] });
    if (route.request().method() === "PATCH") {
      workspace = { ...workspace, ...route.request().postDataJSON() };
    }
    return route.fulfill({ json: workspace });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workspace settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Organization profile" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity" })).toBeVisible();
  await expect(page.getByRole("region", { name: "People & access" }).getByText("Local administrator")).toBeVisible();
  await page.getByLabel("Workspace name").fill("Research Team");
  await page.getByLabel("Contact email optional").fill("team@example.com");
  await page.getByRole("button", { name: "Save workspace" }).click();
  await expect(page.getByText("Workspace profile saved.")).toBeVisible();
  await expect(page.getByText("Research Team", { exact: true })).toBeVisible();
  expect(workspace.contact_email).toBe("team@example.com");
  await capture(page, "11-workspace-settings.png");
});

test("owner can invite a teammate and share a named knowledge base", async ({ page }) => {
  const memberId = "00000000-0000-4000-8000-000000000088";
  const baseId = "00000000-0000-4000-8000-000000000066";
  const members = [{
    user_id: "00000000-0000-4000-8000-000000000002", display_name: "Workspace owner",
    email: "developer@genaiprotos.com", role: "owner", status: "active",
  }];
  let sharing: Record<string, unknown> | null = null;
  const base = {
    id: baseId, organization_id: "00000000-0000-4000-8000-000000000001",
    name: "Client account", description: null,
    created_by: "00000000-0000-4000-8000-000000000002",
    visibility: "private", text_profile_id: null, meeting_count: 0,
    shared_user_ids: [] as string[], created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-24T00:00:00Z",
  };
  await page.route("**/v1/workspace**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/workspace") return route.fulfill({ json: {
      id: base.organization_id, slug: "legacy-workspace", display_name: "GenAI Protos",
      contact_email: null, status: "active", created_at: base.created_at,
      updated_at: base.updated_at, tenant_isolation_enabled: false,
    } });
    if (pathname === "/v1/workspace/members") return route.fulfill({ json: members });
    if (pathname === "/v1/workspace/invite") {
      const payload = route.request().postDataJSON();
      members.push({ user_id: memberId, display_name: payload.display_name,
        email: payload.email, role: payload.role, status: "invited" });
      return route.fulfill({ status: 201, json: {
        account: { ...members[1], organization_id: base.organization_id, must_change_password: true },
        temporary_password: "one-time-test-password", note: "Shown once.",
      } });
    }
    return route.fallback();
  });
  await page.route("**/v1/knowledge-bases**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/knowledge-bases") return route.fulfill({ json: [base] });
    if (pathname === `/v1/knowledge-bases/${baseId}/conversations`) return route.fulfill({ json: [] });
    if (pathname === `/v1/knowledge-bases/${baseId}/sharing`) {
      sharing = route.request().postDataJSON();
      Object.assign(base, { visibility: "specific", shared_user_ids: [memberId] });
      return route.fulfill({ json: base });
    }
    return route.fallback();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Team Member");
  await page.getByLabel("Work email").fill("teammate@example.com");
  await page.getByRole("button", { name: "Generate temporary password" }).click();
  await expect(page.getByText("one-time-test-password")).toBeVisible();
  await expect(page.getByText("Team Member", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "AI knowledge" }).click();
  await page.getByRole("button", { name: /Client account/ }).click();
  await page.getByLabel("Share this base").selectOption("specific");
  await page.getByLabel(/Team Member/).check();
  await page.getByRole("button", { name: "Save sharing" }).click();
  expect(sharing).toEqual({ visibility: "specific", user_ids: [memberId] });
  await capture(page, "13-knowledge-sharing.png");
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
  let createdDeliverySettings: Record<string, unknown> | null = null;
  let createdKnowledgeSettings: Record<string, unknown> | null = null;
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
    if (profileMatch && request.method() === "DELETE") {
      const index = providerProfiles.findIndex((item) => item.id === profileMatch[1]);
      if (index < 0) return route.fulfill({ status: 404, json: { detail: "provider profile not found" } });
      providerProfiles.splice(index, 1);
      for (let i = providerDefaults.length - 1; i >= 0; i -= 1) {
        if (providerDefaults[i].local_profile_id === profileMatch[1] || providerDefaults[i].cloud_profile_id === profileMatch[1]) providerDefaults.splice(i, 1);
      }
      return route.fulfill({ status: 204, body: "" });
    }
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
    if (pathname === "/v1/meetings" && request.method() === "POST") {
      const payload = request.postDataJSON();
      createdDeliverySettings = payload.delivery_settings;
      createdKnowledgeSettings = { tags: payload.tags, knowledge_enabled: payload.knowledge_enabled };
      return route.fulfill({ json: meeting });
    }
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
  await expect(page.getByRole("heading", { name: "From conversation to clarity." })).toBeVisible();
  await expect(page.getByText("No meetings yet")).toBeVisible();
  await expect(
    page.getByText("All meetings").locator("..").getByText("0", { exact: true }),
  ).toBeVisible();
  await capture(page, "01-dashboard.png");

  await page.getByRole("button", { name: "New meeting" }).click();
  await expect(page.getByRole("dialog", { name: "Send your assistant" })).toBeVisible();
  await expect(page.getByText("Disclosure is required.")).toBeVisible();

  const meetingLink = page.getByLabel("Meeting link");
  await meetingLink.fill("not-a-meeting-url");
  await page.getByRole("button", { name: "Send assistant" }).click();
  await expect(page.getByText("Ready to join")).not.toBeVisible();
  expect(await meetingLink.evaluate((element) => (element as HTMLInputElement).validity.valid)).toBe(false);
  await capture(page, "02-invalid-meeting-url.png");

  await meetingLink.fill("https://meet.google.com/abc-defg-hij");
  await page.getByLabel("Meeting name optional").fill("Foundation UI witness");
  await page.getByLabel(/Knowledge tags/).fill("roadmap, customer research");
  await page.getByLabel("Add this meeting to AI knowledge").check();
  await page.getByText("Recap delivery options").click();
  await page.getByLabel("Internal team email addresses").fill("team@example.test");
  await page.getByLabel("Participant email addresses").fill("guest@example.test");
  await capture(page, "03-ready-to-submit.png");
  await page.getByRole("button", { name: "Send assistant" }).click();
  expect(createdDeliverySettings).toMatchObject({
    internal_recipients: ["team@example.test"],
    participant_recipients: ["guest@example.test"],
    send_to_participants: false,
  });
  expect(createdKnowledgeSettings).toEqual({ tags: ["roadmap", "customer research"], knowledge_enabled: true });
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
    await page.getByLabel("Provider type").click();
    await page.getByRole("option", { name: "Vexa native / self-hosted" }).click();
    await page.getByLabel("Execution location").click();
    await page.getByRole("option", { name: "Local / self-hosted" }).click();
    await page.getByLabel("Model").fill("Systran/faster-whisper-tiny.en");
    await page.getByLabel("Base endpoint").fill("http://vexa-lite-whisper:8000/v1");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Vexa local Whisper saved.")).toBeVisible();
  }
  await expect(vexaProfile).toBeVisible();
  await capture(page, "05-provider-settings.png");

  await page.getByRole("button", { name: /Vexa local Whisper/ }).click();
  await page.getByRole("button", { name: "Validate saved configuration" }).click();
  await expect(page.getByText(/Configuration fields are valid/)).toBeVisible();
  await expect(page.getByText("Configuration valid", { exact: true })).toBeVisible();
  await capture(page, "06-vexa-configuration-valid.png");

  await page.getByRole("button", { name: "Add MOM & actions profile" }).click();
  await page.getByLabel("Profile name").fill(profileName);
  await page.getByLabel("Provider type").click();
  await page.getByRole("option", { name: "OpenAI-compatible" }).click();
  await page.getByLabel("Execution location").click();
  await page.getByRole("option", { name: "Local / self-hosted" }).click();
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

  await page.getByRole("button", { name: "Add MOM & actions profile" }).click();
  await page.getByLabel("Profile name").fill("OpenRouter economy");
  await page.getByLabel("Provider type").click();
  await page.getByRole("option", { name: "OpenRouter" }).click();
  await expect(page.getByLabel("Base endpoint")).toHaveValue("https://openrouter.ai/api/v1");
  await page.getByLabel("Model").fill("provider/model-id");
  await page.getByLabel("API key write-only").fill("test-openrouter-key");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("button", { name: /OpenRouter economy/ })).toBeVisible();
  await page.getByRole("button", { name: "Delete configuration" }).click();
  await page.getByRole("button", { name: "Delete profile" }).click();
  await expect(page.getByRole("button", { name: /OpenRouter economy/ })).toHaveCount(0);
});

test("AI knowledge links tagged evidence to the exact transcript turn", async ({ page }) => {
  const meetingId = "00000000-0000-4000-8000-000000000055";
  const baseId = "00000000-0000-4000-8000-000000000066";
  const base = {
    id: baseId, organization_id: "00000000-0000-4000-8000-000000000001",
    name: "Acme client", description: null, created_by: "00000000-0000-4000-8000-000000000002",
    visibility: "private", text_profile_id: null, meeting_count: 1,
    created_at: "2026-09-19T09:00:00Z", updated_at: "2026-09-19T09:00:00Z",
  };
  const meeting = {
    id: meetingId, title: "Launch planning", meeting_url: "https://meet.google.com/abc-defg-hij",
    platform: "google_meet", status: "ready", bot_name: "Meetings AI",
    created_at: "2026-09-19T09:00:00Z", updated_at: "2026-09-20T10:00:00Z",
    joined_at: "2026-09-20T09:30:00Z", stopped_at: "2026-09-20T10:00:00Z",
    tags: ["roadmap"], knowledge_enabled: true, knowledge_base_id: baseId,
  };
  const source = {
    source_id: "source-1", kind: "transcript", meeting_id: meetingId,
    meeting_title: "Launch planning", meeting_created_at: meeting.created_at,
    meeting_joined_at: meeting.joined_at, segment_id: "segment-1",
    start_seconds: 13.2, end_seconds: 18.4, speaker: "Alice",
    text: "Alice will submit the roadmap on Friday.", tags: ["roadmap"],
    evidence_segment_ids: ["segment-1"],
  };
  let searchPayload: Record<string, unknown> | null = null;
  await page.route("**/v1/knowledge-bases**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/knowledge-bases") return route.fulfill({ json: [base] });
    if (pathname === `/v1/knowledge-bases/${baseId}/conversations`) return route.fulfill({ json: [] });
    return route.fallback();
  });
  await page.route("**/v1/knowledge/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/knowledge/search") {
      searchPayload = route.request().postDataJSON();
      return route.fulfill({ json: { sources: [source], count: 1, retrieval_mode: "lexical", truncated_meeting_scope: false } });
    }
    if (pathname === "/v1/knowledge/chat") {
      return route.fulfill({ json: {
        answer: "Alice committed to the roadmap on Friday [K1].", citations: [source],
        provider: "test-provider", model: "economy-test", retrieval_mode: "lexical", conversation_id: "00000000-0000-4000-8000-000000000077",
        note: "Verify the transcript.",
      } });
    }
    return route.fallback();
  });
  await page.route("**/v1/meetings**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/meetings") return route.fulfill({ json: [meeting] });
    if (pathname === `/v1/meetings/${meetingId}`) return route.fulfill({ json: meeting });
    if (pathname === `/v1/meetings/${meetingId}/transcript`) return route.fulfill({ json: [{
      segment_id: "segment-1", speaker: "Alice", text: source.text,
      start_seconds: 13.2, end_seconds: 18.4, completed: true,
    }] });
    return route.fallback();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "AI knowledge" }).click();
  await expect(page.getByRole("heading", { name: "Your meeting wiki." })).toBeVisible();
  await page.getByRole("button", { name: "Find sources" }).click();
  await page.getByLabel("Search meetings").fill("roadmap");
  await page.getByLabel("Limit to tags").fill("roadmap");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText(source.text)).toBeVisible();
  await expect(page.getByText("Speaker: Alice", { exact: true })).toBeVisible();
  expect(searchPayload).toMatchObject({ query: "roadmap", tags: ["roadmap"] });
  await capture(page, "12-ai-knowledge-search.png");
  await page.getByRole("button", { name: "Open cited transcript" }).click();
  await expect(page.locator("#transcript-segment-1")).toHaveClass(/focused-source/);
  await page.getByRole("button", { name: /All meetings/ }).first().click();
  await page.getByRole("button", { name: /Acme client/ }).click();
  await page.getByRole("button", { name: "Ask AI" }).first().click();
  await page.getByLabel("Ask a question").fill("Who owns the roadmap?");
  await page.getByRole("button", { name: "Ask AI", exact: true }).last().click();
  await expect(page.getByText("Alice committed to the roadmap on Friday [K1].")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open cited transcript" })).toBeVisible();
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
  await page.route("**/v1/integrations/resend/status", (route) => route.fulfill({ json: {
    api_key_configured: true,
    sender_configured: true,
    sender: "Meetings AI <meetings@example.test>",
    can_attempt_send: true,
    domain_verification: "not_checked",
  } }));
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
    action_items: [{ description: "Review the MOM", owner: "Bob", due_date: null, evidence_segment_ids: ["s2"] }],
    open_questions: ["When will deployment begin?"],
    speaker_contributions: [
      { speaker: "Alice", summary: "Asked about the next release.", evidence_segment_ids: ["s1"] },
      { speaker: "Bob", summary: "Committed to reviewing the MOM.", evidence_segment_ids: ["s2"] },
    ],
    questions_asked: [{ speaker: "Alice", question: "When will deployment begin?", evidence_segment_ids: ["s1"] }],
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
  let secondSpeakerCorrected = false;
  let speakerIdentities: Array<Record<string, unknown>> = [];
  let deliverySettings = {
    internal_recipients: [] as string[], participant_recipients: [] as string[],
    send_to_participants: false, include_transcript: false,
  };

  await page.route("**/v1/meetings**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/meetings" && request.method() === "GET") {
      return route.fulfill({ json: { items: [meeting], count: 1 } });
    }
    if (pathname === `/v1/meetings/${meetingId}` && request.method() === "GET") {
      return route.fulfill({ json: meeting });
    }
    if (pathname === `/v1/meetings/${meetingId}/transcription-route` && request.method() === "GET") {
      return route.fulfill({ json: {
        mode: "profile", profile_id: "00000000-0000-4000-8000-000000000077",
        profile_name: "OpenRouter STT", provider_type: "openai_compatible",
        model: "microsoft/mai-transcribe-2", endpoint_host: "openrouter.ai",
        selected_at: "2026-09-09T12:00:00Z",
      } });
    }
    if (pathname === `/v1/meetings/${meetingId}/transcript` && request.method() === "GET") {
      return route.fulfill({ json: { segments: [
        { segment_id: "s1", speaker: "Alice", raw_speaker: "Alice", text: "When will deployment begin?", start_seconds: 1, end_seconds: 3, completed: true },
        { segment_id: "s2", speaker: secondSpeakerCorrected ? "Bob" : null, raw_speaker: "seg_2", speaker_reviewed: secondSpeakerCorrected, text: "I will review the MOM.", start_seconds: 4, end_seconds: 6, completed: true },
      ] } });
    }
    if (pathname === `/v1/meetings/${meetingId}/transcript/segments/s2/speaker` && request.method() === "PUT") {
      secondSpeakerCorrected = request.postDataJSON().display_name === "Bob";
      return route.fulfill({ json: { segments: [
        { segment_id: "s1", speaker: "Alice", raw_speaker: "Alice", text: "When will deployment begin?", start_seconds: 1, end_seconds: 3, completed: true },
        { segment_id: "s2", speaker: "Bob", raw_speaker: "seg_2", speaker_reviewed: true, text: "I will review the MOM.", start_seconds: 4, end_seconds: 6, completed: true },
      ] } });
    }
    if (pathname === `/v1/meetings/${meetingId}/speaker-identities` && request.method() === "GET") {
      return route.fulfill({ json: speakerIdentities });
    }
    if (pathname === `/v1/meetings/${meetingId}/speaker-identities` && request.method() === "PUT") {
      const payload = request.postDataJSON();
      speakerIdentities = [{ speaker: payload.speaker, email: payload.email, confirmed_at: "2026-09-09T12:25:00Z" }];
      return route.fulfill({ json: speakerIdentities });
    }
    if (pathname === `/v1/meetings/${meetingId}/delivery-settings` && request.method() === "GET") {
      return route.fulfill({ json: deliverySettings });
    }
    if (pathname === `/v1/meetings/${meetingId}/delivery-settings` && request.method() === "PUT") {
      deliverySettings = request.postDataJSON();
      return route.fulfill({ json: deliverySettings });
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
    if (pathname === `/v1/meetings/${meetingId}/minutes/send-configured` && request.method() === "POST") {
      minutes = { ...(minutes ?? baseMinutes), status: "sent", sent_at: "2026-09-09T12:26:00Z" };
      return route.fulfill({ json: { id: "delivery-1", meeting_id: meetingId, recipients: deliverySettings.internal_recipients, status: "sent", provider_message_id: "email-1", error: null, created_at: "2026-09-09T12:26:00Z" } });
    }
    return route.fallback();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open MOM workflow witness" }).click();
  await expect(page.getByRole("region", { name: "Transcription runtime route" })).toContainText(
    "OpenRouter STT · microsoft/mai-transcribe-2 · openrouter.ai",
  );
  await expect(page.getByText("1 unidentified turn")).toBeVisible();
  await page.getByRole("button", { name: "Review speaker" }).nth(1).click();
  await page.getByLabel("Correct speaker name").fill("Bob");
  await page.getByRole("button", { name: "Save speaker" }).click();
  await expect(page.getByText("Speakers heard: Alice, Bob")).toBeVisible();
  await page.getByRole("button", { name: "Confirm email" }).nth(1).click();
  await page.getByLabel("Email for Bob").fill("bob@example.test");
  await page.getByRole("button", { name: "Save mapping" }).click();
  await expect(page.getByText("bob@example.test (confirmed)")).toBeVisible();
  await expect(page.getByText("No MOM draft yet.")).toBeVisible();
  await page.getByRole("button", { name: "Generate MOM" }).click();
  await expect(page.getByLabel("Executive summary")).toHaveValue("The team validated live meeting capture.");
  await expect(page.getByLabel("Contribution by Bob")).toHaveValue("Committed to reviewing the MOM.");
  await expect(page.getByLabel("Question asked by Alice")).toHaveValue("When will deployment begin?");
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(page, "09-mom-draft-review.png");
  await page.getByLabel("Executive summary").fill("Human-reviewed meeting summary.");
  await page.getByRole("button", { name: "Save & approve" }).click();
  await expect(page.getByText("MOM approved and ready to send.")).toBeVisible();
  await page.getByLabel("Internal team recipients").fill("team@example.test");
  await page.getByLabel("Participant recipients").fill("guest@example.test");
  await page.getByLabel("Also send to listed participants").check();
  await page.getByRole("button", { name: "Save recipients" }).click();
  expect(deliverySettings).toMatchObject({
    internal_recipients: ["team@example.test"],
    participant_recipients: ["guest@example.test"],
    send_to_participants: true,
  });
  await page.getByLabel("Also send to listed participants").uncheck();
  await page.getByRole("button", { name: "Send recap" }).click();
  await expect(page.getByText("Recap sent", { exact: true })).toBeVisible();
  await expect(page.getByText("Recap sent to 1 recipient.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Regenerate draft" })).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture(page, "10-mom-sent.png");
});

test("failed automatic drafting can be retried from the meeting", async ({ page }) => {
  const meetingId = "00000000-0000-4000-8000-000000000099";
  const meeting = {
    id: meetingId, title: "Retry witness", meeting_url: "https://meet.google.com/abc-defg-hij",
    platform: "google_meet", status: "completed", bot_name: "Meetings AI",
    created_at: "2026-09-09T12:00:00Z", updated_at: "2026-09-09T12:20:00Z",
  };
  let retried = false;
  await page.route("**/v1/meetings**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/meetings") return route.fulfill({ json: { items: [meeting], count: 1 } });
    if (pathname === `/v1/meetings/${meetingId}`) return route.fulfill({ json: meeting });
    if (pathname.endsWith("/transcript")) return route.fulfill({ json: { segments: [] } });
    if (pathname.endsWith("/speaker-identities")) return route.fulfill({ json: [] });
    if (pathname.endsWith("/participants")) return route.fulfill({ json: { participants: [] } });
    if (pathname.endsWith("/post-meeting-job/retry")) {
      retried = true;
      return route.fulfill({ json: { enabled: true, attempts: 0, next_retry_at: null, last_error: null, completed_at: "2026-09-09T12:30:00Z", exhausted: false } });
    }
    if (pathname.endsWith("/post-meeting-job")) return route.fulfill({ json: {
      enabled: true, attempts: 5, next_retry_at: null,
      last_error: "temporary model outage", completed_at: null, exhausted: true,
    } });
    if (pathname.endsWith("/minutes")) return retried ? route.fulfill({ json: {
      meeting_id: meetingId, status: "draft", title: "Retry witness",
      executive_summary: "A draft was recovered.", discussion_points: [],
      decisions: [], action_items: [], open_questions: [],
      speaker_contributions: [], questions_asked: [], provider: "openai",
      model: "economy-model", created_at: "2026-09-09T12:30:00Z",
      updated_at: "2026-09-09T12:30:00Z", approved_at: null, sent_at: null,
    } }) : route.fulfill({ status: 404, json: { detail: "MOM has not been generated" } });
    return route.fallback();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open Retry witness" }).click();
  await expect(page.getByText("Automatic drafting stopped after repeated failures", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Retry automatic draft" }).click();
  await expect(page.getByLabel("Executive summary")).toHaveValue("A draft was recovered.");
  await expect(page.getByText("MOM draft recovered. Review every field before approval.")).toBeVisible();
});
