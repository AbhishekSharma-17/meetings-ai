import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const ORG = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const MATE = "00000000-0000-4000-8000-000000000077";
const TOKEN = "Zk3n8Qm1xWv7Lr2pT9aYc4Hs6Ud0Jf5BgNe_Oi-Kq3M";
const captureDirectory = process.env.PLAYWRIGHT_CAPTURE_DIR ?? path.resolve(__dirname, "../../test-results/captures");

const workspace = {
  id: ORG, slug: "genai-protos", display_name: "GenAI Protos", contact_email: null, status: "active",
  created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-24T00:00:00Z", tenant_isolation_enabled: true,
};
const ownerAccount = { user_id: OWNER, organization_id: ORG, email: "owner@example.test", display_name: "Workspace owner", role: "owner", must_change_password: false, photo_url: null };
const mateAccount = { user_id: MATE, organization_id: ORG, email: "mate@example.test", display_name: "Team Mate", role: "member", must_change_password: false, photo_url: null };
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

type Handler = (route: Route, pathname: string, method: string) => Promise<boolean> | boolean;

async function mockApi(page: Page, handler: Handler) {
  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (await handler(route, pathname, method)) return;
    if (pathname === "/v1/workspace") return route.fulfill({ json: workspace });
    if (pathname === "/v1/workspaces") return route.fulfill({ json: [{ id: ORG, slug: "genai-protos", display_name: "GenAI Protos", role: "owner", is_default: false }] });
    if (pathname === "/v1/workspace/brief") return route.fulfill({ json: { website: null, overview: "", services: [], products: [], differentiators: "", positioning: "", updated_at: null } });
    if (pathname === "/v1/workspace/retention") return route.fulfill({ json: { enabled: false, meeting_days: null, chat_days: null, audit_days: null } });
    if (pathname === "/v1/workspace/operations") return route.fulfill({ json: { people: 1, meetings_captured: 0, completed_meetings: 0, saved_chats: 0, active_captures: 0, failed_captures: 0, failed_mom_jobs: 0, pending_index_jobs: 0, failed_index_jobs: 0, failed_email_deliveries: 0, latest_audit_at: null } });
    if (pathname === "/v1/meetings") return route.fulfill({ json: { items: [], count: 0 } });
    if (pathname === "/v1/workspace/teams") return route.fulfill({ json: [] });
    if (pathname === "/v1/notifications/unread-count") return route.fulfill({ json: { count: 0 } });
    if (["/v1/provider-profiles", "/v1/provider-defaults", "/v1/knowledge-bases", "/v1/workspace/audit", "/v1/me/activity", "/v1/workspace/brief/documents"].includes(pathname)) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { detail: "mock route missing" } });
  });
}

async function capture(page: Page, name: string) {
  mkdirSync(captureDirectory, { recursive: true });
  await page.screenshot({ path: path.join(captureDirectory, name), fullPage: true });
}

test("an invite link opens the accept screen, strips the token and signs the person in", async ({ page }) => {
  let signedIn = false;
  let accepted: Record<string, string> | null = null;
  const inspected: string[] = [];
  await mockApi(page, async (route, pathname, method) => {
    if (pathname === "/v1/auth/session") { await route.fulfill({ json: { authenticated: signedIn } }); return true; }
    if (pathname === "/v1/auth/me") { await route.fulfill(signedIn ? { json: mateAccount } : { status: 401, json: { detail: "sign in required" } }); return true; }
    if (pathname === "/v1/auth/account-link" && method === "POST") {
      inspected.push(route.request().postDataJSON().token);
      await route.fulfill({ json: { state: "valid", purpose: "invite", email: "mate@example.test", display_name: "Team Mate", workspace_name: "GenAI Protos", expires_at: inMinutes(9) } });
      return true;
    }
    if (pathname === "/v1/auth/account-link/accept" && method === "POST") {
      accepted = route.request().postDataJSON();
      signedIn = true;
      await route.fulfill({ json: mateAccount });
      return true;
    }
    return false;
  });

  await page.goto(`/#accept=${TOKEN}`);
  await expect(page.getByRole("heading", { name: "Accept your invitation" })).toBeVisible();
  await expect(page.getByText("Join GenAI Protos")).toBeVisible();
  await expect(page.getByText("mate@example.test")).toBeVisible();
  // The credential leaves the address bar and history immediately.
  expect(await page.evaluate(() => window.location.hash)).toBe("");
  expect([...new Set(inspected)]).toEqual([TOKEN]);  // dev StrictMode may check twice; inspecting is read-only
  await capture(page, "account-accept-invite.png");

  const password = page.getByLabel("New password");
  const confirm = page.getByLabel("Confirm password");
  await password.fill("abc12");
  await confirm.fill("abc12");
  await page.getByRole("button", { name: "Accept invite and sign in" }).click();
  await expect(page.getByText("Use at least 6 characters.")).toBeVisible();
  await password.fill("a-long-enough-password");
  await confirm.fill("a-different-password!");
  await page.getByRole("button", { name: "Accept invite and sign in" }).click();
  await expect(page.getByText("The two passwords don’t match.")).toBeVisible();
  expect(accepted).toBeNull();

  await expect(password).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show passwords" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(confirm).toHaveAttribute("type", "text");

  await confirm.fill("a-long-enough-password");
  await page.getByRole("button", { name: "Accept invite and sign in" }).click();
  await expect(page.getByRole("button", { name: /Team Mate mate@example.test/ })).toBeVisible();
  expect(accepted).toEqual({ token: TOKEN, password: "a-long-enough-password" });
  expect(page.url()).not.toContain(TOKEN);
});

test("an expired invitation link explains what to do and leads back to sign in", async ({ page }) => {
  await mockApi(page, async (route, pathname) => {
    if (pathname === "/v1/auth/session") { await route.fulfill({ json: { authenticated: false } }); return true; }
    if (pathname === "/v1/auth/account-link") {
      await route.fulfill({ json: { state: "expired", purpose: "invite", email: null, display_name: null, workspace_name: null, expires_at: null } });
      return true;
    }
    return false;
  });
  await page.goto(`/#accept=${TOKEN}`);
  await expect(page.getByRole("heading", { name: "This link has expired" })).toBeVisible();
  await expect(page.getByText("This invitation link has expired. Invitation links work for 10 minutes; ask your admin to send a new one.")).toBeVisible();
  await expect(page.getByLabel("New password")).toHaveCount(0);
  await capture(page, "account-link-expired.png");
  await page.getByRole("button", { name: "Go to sign in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});

test("a reset link that was already used offers a new one", async ({ page }) => {
  await mockApi(page, async (route, pathname) => {
    if (pathname === "/v1/auth/session") { await route.fulfill({ json: { authenticated: false } }); return true; }
    if (pathname === "/v1/auth/account-link") {
      await route.fulfill({ json: { state: "used", purpose: "password_reset", email: null, display_name: null, workspace_name: null, expires_at: null } });
      return true;
    }
    return false;
  });
  await page.goto(`/#reset=${TOKEN}`);
  await expect(page.getByRole("heading", { name: "This link has already been used" })).toBeVisible();
  await page.getByRole("button", { name: "Request a new link" }).click();
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
});

test("forgot password answers the same way for any address", async ({ page }) => {
  const requested: string[] = [];
  await mockApi(page, async (route, pathname, method) => {
    if (pathname === "/v1/auth/session") { await route.fulfill({ json: { authenticated: false } }); return true; }
    if (pathname === "/v1/auth/password-reset" && method === "POST") {
      requested.push(route.request().postDataJSON().email);
      await route.fulfill({ status: 202, json: { accepted: true, message: "If an account exists…" } });
      return true;
    }
    return false;
  });
  await page.goto("/");
  await page.getByLabel("Work email").fill("mate@example.test");
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await expect(page.getByLabel("Work email")).toHaveValue("mate@example.test");
  await page.getByRole("button", { name: "Email me a reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByText(/If an account exists for/)).toBeVisible();
  expect(requested).toEqual(["mate@example.test"]);
  await page.getByRole("button", { name: "Back to sign in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});

test("add people opens a modal, emails the invite and tracks pending, resent and reset access", async ({ page }) => {
  let members = [
    { user_id: OWNER, display_name: "Workspace owner", email: "owner@example.test", role: "owner", status: "active", photo_url: null, invite_expires_at: null },
    { user_id: "00000000-0000-4000-8000-000000000055", display_name: "Late Joiner", email: "late@example.test", role: "viewer", status: "invited", photo_url: null, invite_expires_at: "2026-01-01T00:00:00Z" },
  ];
  const calls: string[] = [];
  await mockApi(page, async (route, pathname, method) => {
    if (pathname === "/v1/auth/session") { await route.fulfill({ json: { authenticated: true } }); return true; }
    if (pathname === "/v1/auth/me") { await route.fulfill({ json: ownerAccount }); return true; }
    if (pathname === "/v1/workspace/members") { await route.fulfill({ json: members }); return true; }
    if (pathname === "/v1/workspace/invite" && method === "POST") {
      const payload = route.request().postDataJSON();
      calls.push(`invite:${payload.email}:${payload.role}`);
      const member = { user_id: MATE, display_name: payload.display_name, email: payload.email, role: payload.role, status: "invited", photo_url: null, invite_expires_at: inMinutes(10) };
      members = [...members, member];
      await route.fulfill({ status: 201, json: { account: { ...mateAccount, email: payload.email, display_name: payload.display_name, role: payload.role }, temporary_password: null, email_sent: true, accept_url: null, link_expires_at: inMinutes(10), note: `Invitation emailed to ${payload.email}.` } });
      return true;
    }
    const resend = pathname.match(/^\/v1\/workspace\/members\/([^/]+)\/resend-invite$/);
    if (resend && method === "POST") {
      calls.push(`resend:${resend[1]}`);
      members = members.map((member) => member.user_id === resend[1] ? { ...member, invite_expires_at: inMinutes(10) } : member);
      await route.fulfill({ json: { account: { ...mateAccount, user_id: resend[1], email: "late@example.test", display_name: "Late Joiner" }, temporary_password: null, email_sent: true, accept_url: null, link_expires_at: inMinutes(10), note: "New invitation emailed to late@example.test." } });
      return true;
    }
    const reset = pathname.match(/^\/v1\/workspace\/members\/([^/]+)\/reset-access$/);
    if (reset && method === "POST") {
      calls.push(`reset:${reset[1]}`);
      await route.fulfill({ json: { account: mateAccount, temporary_password: null, email_sent: false, accept_url: `http://localhost:3021/#reset=${TOKEN}`, link_expires_at: inMinutes(10), note: "Team Mate's old password and sessions no longer work, but email delivery isn't configured. Copy this one-time link and send it to them privately." } });
      return true;
    }
    return false;
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Workspace owner owner@example.test/ }).click();
  await page.getByRole("button", { name: "Organization & people" }).click();
  const people = page.getByRole("region", { name: "People & access" });
  await expect(people.getByRole("listitem").filter({ hasText: "Late Joiner" }).getByText("Invite expired")).toBeVisible();
  await expect(people.getByLabel("Name", { exact: true })).toHaveCount(0);  // no inline form any more

  await people.getByRole("button", { name: "Add people" }).click();
  const dialog = page.getByRole("dialog", { name: "Add people" });
  await expect(dialog.getByText("expires in 10 minutes", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(dialog.getByText("Enter their name (at least two characters).")).toBeVisible();
  await dialog.getByLabel("Name", { exact: true }).fill("Team Mate");
  await dialog.getByLabel("Work email").fill("Mate@Example.test");
  await dialog.getByRole("combobox", { name: "Role" }).click();
  await page.getByRole("option", { name: "Viewer" }).click();
  await capture(page, "account-add-people-dialog.png");
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  const created = page.getByRole("dialog", { name: "Invitation created" });
  await expect(created.getByText("Invitation sent")).toBeVisible();
  await expect(created.getByRole("textbox")).toHaveCount(0);  // emailed: no link shown
  await created.getByRole("button", { name: "Done" }).click();
  expect(calls).toEqual(["invite:mate@example.test:viewer"]);
  const mateRow = people.getByRole("listitem").filter({ hasText: "Team Mate" });
  await expect(mateRow.getByText("Invite pending")).toBeVisible();
  await expect(mateRow.getByText(/Link expires in \d+ min/)).toBeVisible();

  await people.getByRole("button", { name: "Actions for Late Joiner" }).click();
  await expect(page.getByRole("menuitem", { name: "Reset access" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Resend invite" }).click();
  const resent = page.getByRole("dialog", { name: "Invitation resent to Late Joiner" });
  await expect(resent.getByText("New invitation sent")).toBeVisible();
  await resent.getByRole("button", { name: "Done" }).click();
  await expect(people.getByRole("listitem").filter({ hasText: "Late Joiner" }).getByText("Invite pending")).toBeVisible();

  members = members.map((member) => member.user_id === MATE ? { ...member, status: "active", invite_expires_at: null } : member);
  await page.reload();
  await page.getByRole("button", { name: /Workspace owner owner@example.test/ }).click();
  await page.getByRole("button", { name: "Organization & people" }).click();
  await people.getByRole("button", { name: "Actions for Team Mate" }).click();
  await expect(page.getByRole("menuitem", { name: "Resend invite" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Reset access" }).click();
  const confirm = page.getByRole("dialog", { name: "Reset access for Team Mate?" });
  await expect(confirm.getByText(/every open session stop working/)).toBeVisible();
  await confirm.getByRole("button", { name: "Reset access" }).click();
  const result = page.getByRole("dialog", { name: "Access reset for Team Mate" });
  await expect(result.getByLabel("One-time link · shown once")).toHaveValue(`http://localhost:3021/#reset=${TOKEN}`);
  await expect(result.getByRole("button", { name: "Copy link" })).toBeVisible();
  await capture(page, "account-reset-copy-link.png");
  await result.getByRole("button", { name: "Done" }).click();
  expect(calls.slice(1)).toEqual(["resend:00000000-0000-4000-8000-000000000055", `reset:${MATE}`]);
  // The one-time link is gone once the dialog closes.
  await expect(page.getByText(TOKEN)).toHaveCount(0);
});

test("people rows stay usable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await mockApi(page, async (route, pathname) => {
    if (pathname === "/v1/auth/session") { await route.fulfill({ json: { authenticated: true } }); return true; }
    if (pathname === "/v1/auth/me") { await route.fulfill({ json: ownerAccount }); return true; }
    if (pathname === "/v1/workspace/members") {
      await route.fulfill({ json: [
        { user_id: OWNER, display_name: "Workspace owner", email: "owner@example.test", role: "owner", status: "active", photo_url: null },
        { user_id: MATE, display_name: "A teammate with a rather long display name", email: "a.very.long.address.for.testing@example-company.test", role: "member", status: "invited", photo_url: null, invite_expires_at: inMinutes(6) },
      ] });
      return true;
    }
    return false;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: /Workspace owner owner@example.test/ }).last().click();
  await page.getByRole("button", { name: "Organization & people" }).click();
  const people = page.getByRole("region", { name: "People & access" });
  await expect(people.getByText("Invite pending")).toBeVisible();
  await expect(people.getByRole("button", { name: "Actions for A teammate with a rather long display name" })).toBeInViewport();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
