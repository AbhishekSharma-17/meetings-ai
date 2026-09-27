import type { CurrentAccount, InviteResult, RetentionPolicy, WorkspaceMember } from "../../types";
import { DEMO_WORKSPACE_KEY } from "../../demo-mode";
import { newId, ORG_MAIN, ORG_VENTURES } from "../fixtures/ids";
import { ownerAccount, workspaceOptions } from "../fixtures/people";
import { workspaceCalendarConnections } from "../fixtures/calendar";
import { json, noContent, notify, problem, str } from "../http";
import type { DemoRouter } from "../router";
import type { DemoStore } from "../store";

export const accountOf = (store: DemoStore): CurrentAccount => ownerAccount(store.orgId, store.photoUrl, store.displayName);

function demoPassword(): string {
  const words = ["harbor", "maple", "orbit", "cedar", "lumen", "delta", "quartz", "willow"];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `demo-${pick()}-${pick()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function memberAccount(store: DemoStore, member: WorkspaceMember): CurrentAccount {
  return { user_id: member.user_id, organization_id: store.orgId, email: member.email, display_name: member.display_name, role: member.role, must_change_password: true, photo_url: null };
}

function operations(store: DemoStore) {
  const statuses = store.seeds.map((seed) => seed.meeting.status);
  return {
    people: store.members.filter((member) => member.status === "active").length, meetings_captured: store.seeds.filter((seed) => seed.meeting.joined_at).length + 27,
    completed_meetings: statuses.filter((status) => status === "completed").length + 24, saved_chats: store.conversations.length,
    active_captures: statuses.filter((status) => ["live", "waiting_room", "joining"].includes(status)).length, failed_captures: statuses.filter((status) => status === "failed").length,
    failed_mom_jobs: Object.values(store.jobs).filter((job) => job.last_error).length, pending_index_jobs: Object.keys(store.reindexedAt).length ? 1 : 0,
    failed_index_jobs: 0, failed_email_deliveries: 0, latest_audit_at: store.audit[0]?.created_at ?? null,
  };
}

export function registerWorkspace(router: DemoRouter): void {
  router
    .on("GET", "/v1/auth/session", () => json({ authenticated: true }))
    .on("GET", "/v1/auth/me", ({ store }) => json(accountOf(store)))
    .on("PATCH", "/v1/auth/me", ({ store, body }) => {
      const name = str(body.display_name)?.trim();
      if (!name) return problem(422, "Enter a display name.");
      store.displayName = name.slice(0, 120);
      return json(accountOf(store));
    })
    .on("PUT", "/v1/auth/me/photo", ({ store, form }) => {
      const file = form?.get("file");
      if (!(file instanceof Blob) || !file.type.startsWith("image/")) return problem(422, "Choose a JPEG, PNG or WebP image.");
      if (store.photoUrl?.startsWith("blob:")) URL.revokeObjectURL(store.photoUrl);
      store.photoUrl = URL.createObjectURL(file);
      notify("Demo: your photo stays in this browser tab only and disappears when you leave the demo.");
      return json(accountOf(store));
    })
    .on("DELETE", "/v1/auth/me/photo", ({ store }) => { store.photoUrl = null; return json(accountOf(store)); })
    .on("POST", "/v1/auth/login", () => json({ authenticated: true }))
    .on("POST", "/v1/auth/logout", () => noContent())
    .on("POST", "/v1/auth/change-password", () => { notify("Demo: the sample account has no real password, so nothing was changed."); return json({ changed: true }); })
    .on("GET", "/v1/workspace", ({ store }) => json(store.workspace))
    .on("PATCH", "/v1/workspace", ({ store, body }) => {
      const name = str(body.display_name)?.trim();
      if (!name) return problem(422, "Enter a workspace name.");
      store.workspace = { ...store.workspace, display_name: name, contact_email: str(body.contact_email), updated_at: new Date().toISOString() };
      return json(store.workspace);
    })
    .on("GET", "/v1/workspaces", ({ store }) => json(workspaceOptions(store.defaultWorkspaceId)))
    .on("POST", "/v1/workspaces", () => problem(409, "Demo: new workspaces can't be created in the sample. Try switching to Northwind Ventures instead."))
    .on("PUT", "/v1/workspaces/default", ({ store, body }) => {
      const id = str(body.organization_id);
      store.defaultWorkspaceId = id === ORG_MAIN || id === ORG_VENTURES ? id : null;
      return json(workspaceOptions(store.defaultWorkspaceId));
    })
    .on("POST", "/v1/workspaces/:id/switch", ({ store, params }) => {
      if (params.id !== ORG_MAIN && params.id !== ORG_VENTURES) return problem(404, "workspace not found");
      try { window.sessionStorage.setItem(DEMO_WORKSPACE_KEY, JSON.stringify(params.id)); } catch { /* Switch still applies to this page. */ }
      return json(ownerAccount(params.id, store.photoUrl, store.displayName));
    })
    .on("GET", "/v1/workspace/brief", ({ store }) => json(store.brief))
    .on("PUT", "/v1/workspace/brief", ({ store, body }) => {
      store.brief = { ...store.brief, ...body, updated_at: new Date().toISOString() } as DemoStore["brief"];
      return json(store.brief);
    })
    .on("GET", "/v1/workspace/brief/documents", ({ store }) => json(store.briefDocuments))
    .on("POST", "/v1/workspace/brief/documents", ({ store, form }) => {
      const file = form?.get("file");
      if (!(file instanceof File)) return problem(422, "Choose a document to upload.");
      const record = { id: newId(8), filename: file.name, content_type: file.type || "application/octet-stream", character_count: Math.max(800, Math.round(file.size / 3)), uploaded_at: new Date().toISOString() };
      store.briefDocuments = [record, ...store.briefDocuments];
      notify("Demo: the file was read in your browser only; nothing was uploaded.");
      return json(record, 201);
    })
    .on("DELETE", "/v1/workspace/brief/documents/:id", ({ store, params }) => { store.briefDocuments = store.briefDocuments.filter((doc) => doc.id !== params.id); return noContent(); })
    .on("GET", "/v1/workspace/members", ({ store }) => json(store.members))
    .on("POST", "/v1/workspace/invite", ({ store, body }) => {
      const email = str(body.email)?.trim().toLowerCase();
      const name = str(body.display_name)?.trim();
      if (!email || !email.includes("@") || !name) return problem(422, "Enter a name and a valid email address.");
      if (store.members.some((member) => member.email === email)) return problem(409, "That person is already in this workspace.");
      const member: WorkspaceMember = { user_id: newId(2), display_name: name, email, role: (str(body.role) as WorkspaceMember["role"]) ?? "member", status: "invited", photo_url: null };
      store.members = [...store.members, member];
      const result: InviteResult = { account: memberAccount(store, member), temporary_password: demoPassword(), email_sent: false, note: "Demo: no invitation email was sent and this temporary password works nowhere. In a real workspace you would share it securely; it must be changed at first sign-in." };
      return json(result, 201);
    })
    .on("POST", "/v1/workspace/members/:id/temporary-password", ({ store, params }) => {
      const member = store.members.find((item) => item.user_id === params.id);
      if (!member) return problem(404, "member not found");
      return json({ account: memberAccount(store, member), temporary_password: demoPassword(), email_sent: false, note: "Demo: a sample temporary password — it does not work anywhere." } satisfies InviteResult);
    })
    .on("PATCH", "/v1/workspace/members/:id/role", ({ store, params, body }) => {
      const role = str(body.role) as WorkspaceMember["role"] | null;
      const member = store.members.find((item) => item.user_id === params.id);
      if (!member || !role) return problem(404, "member not found");
      if (member.role === "owner") return problem(409, "The workspace owner's role can't be changed.");
      store.members = store.members.map((item) => item.user_id === params.id ? { ...item, role } : item);
      return json({ ...memberAccount(store, { ...member, role }), must_change_password: false });
    })
    .on("DELETE", "/v1/workspace/members/:id", ({ store, params }) => {
      const member = store.members.find((item) => item.user_id === params.id);
      if (member?.role === "owner") return problem(409, "The workspace owner can't be removed.");
      store.members = store.members.filter((item) => item.user_id !== params.id);
      return noContent();
    })
    .on("GET", "/v1/workspace/audit", ({ store, query }) => json(store.audit.slice(0, Number(query.get("limit")) || 40)))
    .on("GET", "/v1/workspace/operations", ({ store }) => json(operations(store)))
    .on("GET", "/v1/workspace/retention", ({ store }) => json(store.retention))
    .on("PUT", "/v1/workspace/retention", ({ store, body }) => {
      const days = (value: unknown) => typeof value === "number" && value > 0 ? Math.round(value) : null;
      store.retention = { enabled: Boolean(body.enabled), meeting_days: days(body.meeting_days), chat_days: days(body.chat_days), audit_days: days(body.audit_days) } satisfies RetentionPolicy;
      return json(store.retention);
    })
    .on("GET", "/v1/workspace/calendar-connections", ({ store }) => json(workspaceCalendarConnections(store.connections)))
    .on("GET", "/v1/integrations/resend/status", () => json({ api_key_configured: true, sender_configured: true, sender: "Northwind Labs recaps <recaps@northwindlabs.example>", can_attempt_send: true, domain_verification: "not_checked" }));
}
