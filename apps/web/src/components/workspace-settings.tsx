"use client";

import { FormEvent, useEffect, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { AuditEvent, CurrentAccount, InviteResult, RetentionPolicy, Workspace, WorkspaceMember, WorkspaceOperations, WorkspaceOption } from "@/lib/types";
import { UiSelect } from "./ui-select";

export function WorkspaceSettings({ workspace, workspaces, account, onWorkspaceChange, onSwitchWorkspace, onCreateWorkspace }: {
  workspace: Workspace;
  workspaces: WorkspaceOption[];
  account: CurrentAccount | null;
  onWorkspaceChange(workspace: Workspace): void;
  onSwitchWorkspace(id: string): Promise<void>;
  onCreateWorkspace(name: string): Promise<void>;
}) {
  const [name, setName] = useState(workspace.display_name);
  const [contactEmail, setContactEmail] = useState(workspace.contact_email ?? "");
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [operations, setOperations] = useState<WorkspaceOperations | null>(null);
  const [operationsError, setOperationsError] = useState<string | null>(null);
  const [retention, setRetention] = useState<RetentionPolicy | null>(null);
  const [retentionBusy, setRetentionBusy] = useState(false);
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [workspaceAction, setWorkspaceAction] = useState(false);
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member" | "viewer">("member");
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
  const [inviting, setInviting] = useState(false);
  const [memberBusy, setMemberBusy] = useState<string | null>(null);
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  const canManage = account?.role === "owner" || account?.role === "admin";
  const ownerCount = members.filter((member) => member.role === "owner").length;

  useEffect(() => {
    void meetingsService.listWorkspaceMembers().then(setMembers).catch(() => {
      setError("Could not load workspace members.");
    });
  }, []);

  useEffect(() => {
    if (!canManage) return;
    void meetingsService.listWorkspaceAudit().then(setAuditEvents).catch(() => {
      setAuditError("Could not load recent activity.");
    });
    void meetingsService.getWorkspaceOperations().then(setOperations).catch(() => {
      setOperationsError("Could not load operations status.");
    });
    void meetingsService.getRetentionPolicy().then(setRetention).catch(() => {
      setRetentionError("Could not load data retention policy.");
    });
  }, [canManage]);

  async function saveRetention() {
    if (!retention) return;
    setRetentionBusy(true); setRetentionError(null);
    try {
      setRetention(await meetingsService.saveRetentionPolicy(retention));
      setMessage(retention.enabled ? "Automatic retention policy saved. Eligible older data can be deleted by the background worker." : "Automatic retention is off. Records remain until manually deleted.");
    } catch (cause) {
      setRetentionError(cause instanceof Error ? cause.message : "Could not save retention policy.");
    } finally { setRetentionBusy(false); }
  }

  async function refreshOperations() {
    setOperationsError(null);
    try { setOperations(await meetingsService.getWorkspaceOperations()); }
    catch { setOperationsError("Could not load operations status."); }
  }

  async function refreshAudit() {
    setAuditError(null);
    try { setAuditEvents(await meetingsService.listWorkspaceAudit()); }
    catch { setAuditError("Could not load recent activity."); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError(null); setMessage(null);
    try {
      const updated = await meetingsService.updateWorkspace({
        display_name: name.trim(), contact_email: contactEmail.trim() || null,
      });
      onWorkspaceChange(updated);
      setName(updated.display_name);
      setContactEmail(updated.contact_email ?? "");
      setMessage("Workspace profile saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save workspace profile.");
    } finally {
      setSaving(false);
    }
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setWorkspaceAction(true); setWorkspaceActionError(null);
    try { await onCreateWorkspace(newWorkspaceName.trim()); }
    catch (cause) {
      setWorkspaceActionError(cause instanceof Error ? cause.message : "Could not create workspace.");
      setWorkspaceAction(false);
    }
  }

  async function switchWorkspace(id: string) {
    setWorkspaceAction(true); setWorkspaceActionError(null);
    try { await onSwitchWorkspace(id); }
    catch (cause) {
      setWorkspaceActionError(cause instanceof Error ? cause.message : "Could not switch workspace.");
      setWorkspaceAction(false);
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setInviting(true); setError(null); setInviteResult(null);
    try {
      const result = await meetingsService.inviteMember(inviteEmail.trim(), inviteName.trim(), inviteRole);
      setInviteResult(result); setInviteEmail(""); setInviteName("");
      setMembers(await meetingsService.listWorkspaceMembers());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create invitation.");
    } finally { setInviting(false); }
  }

  async function resetMember(userId: string) {
    setError(null); setInviteResult(null); setMemberBusy(userId);
    try {
      setInviteResult(await meetingsService.resetMemberPassword(userId));
      setMembers(await meetingsService.listWorkspaceMembers());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reset member access.");
    } finally { setMemberBusy(null); }
  }

  async function changeRole(userId: string, role: WorkspaceMember["role"]) {
    setError(null); setMessage(null); setMemberBusy(userId);
    try {
      await meetingsService.changeMemberRole(userId, role);
      setMembers(await meetingsService.listWorkspaceMembers());
      setMessage("Member role updated.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change member role.");
    } finally { setMemberBusy(null); }
  }

  async function removeMember(userId: string) {
    setError(null); setMessage(null); setMemberBusy(userId);
    try {
      await meetingsService.removeMember(userId);
      setMembers(await meetingsService.listWorkspaceMembers());
      setPendingRemovalId(null);
      setMessage("Member access removed from this workspace.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove member.");
    } finally { setMemberBusy(null); }
  }

  return <section className="page workspace-page" aria-labelledby="workspace-page-title">
    <div className="workspace-heading">
      <div><p className="eyebrow">ORGANIZATION</p><h1 id="workspace-page-title">Workspace settings</h1><p className="intro">Manage organization details, people, and access.</p></div>
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {message ? <p className="workspace-success" role="status">{message}</p> : null}
    <section className="workspace-card workspace-directory" aria-labelledby="workspace-directory-title">
      <div><h2 id="workspace-directory-title">Your workspaces</h2><p>Choose the organization whose meetings, people, providers, and knowledge you want to manage.</p></div>
      <div className="workspace-directory-list">{workspaces.map((item) => <div className={item.id === account?.organization_id ? "workspace-directory-item current" : "workspace-directory-item"} key={item.id}><span className="workspace-avatar" aria-hidden="true">{item.display_name[0]}</span><div><b>{item.display_name}</b><small>{item.role === "owner" ? "Owner" : item.role}</small></div>{item.id === account?.organization_id ? <span className="workspace-current-pill">Current workspace</span> : <button className="button secondary" type="button" disabled={workspaceAction} onClick={() => void switchWorkspace(item.id)}>Switch</button>}</div>)}</div>
      {canManage ? <form className="workspace-create-form" onSubmit={(event) => void createWorkspace(event)}><div><h3>Create another workspace</h3><p>Start a separate organization with its own meetings and knowledge. You can add teammates below after switching to it.</p></div><label className="sr-only" htmlFor="new-workspace-name">New workspace name</label><input id="new-workspace-name" value={newWorkspaceName} onChange={(event) => setNewWorkspaceName(event.target.value)} minLength={2} maxLength={120} required placeholder="e.g. Novaala" disabled={workspaceAction} /><button className="button secondary" type="submit" disabled={workspaceAction}>{workspaceAction ? "Creating…" : "Create workspace"}</button></form> : null}
      {workspaceActionError ? <p className="form-error" role="alert">{workspaceActionError}</p> : null}
    </section>
    <div className="workspace-layout">
      {canManage ? <form className="workspace-card" onSubmit={(event) => void save(event)}>
        <h2>Organization profile</h2>
        <p>These details are stored in PostgreSQL and survive an app restart.</p>
        <label htmlFor="workspace-name">Workspace name</label>
        <input id="workspace-name" value={name} minLength={2} maxLength={120} required onChange={(event) => setName(event.target.value)} disabled={saving} />
        <label htmlFor="workspace-contact">Contact email <span className="optional">optional</span></label>
        <input id="workspace-contact" type="email" maxLength={320} value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} disabled={saving} placeholder="team@example.com" />
        <div className="workspace-field-readonly"><span>Workspace slug</span><b>{workspace.slug}</b><small>Reserved for future organization URLs; it cannot be changed here.</small></div>
        <div className="workspace-actions"><button className="button primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save workspace"}</button></div>
      </form> : <div className="workspace-card"><h2>{workspace.display_name}</h2><p>{workspace.contact_email ?? "No organization contact email"}</p><p>Only an admin can edit this profile.</p></div>}
      <section className="workspace-card" aria-labelledby="workspace-members-title">
        <h2 id="workspace-members-title">People & access</h2>
        <p>People in {workspace.display_name}. New accounts receive a one-time temporary password; existing accounts keep their current sign-in.</p>
        <ul className="workspace-members">{members.map((member) => {
          const canEdit = canManage && account?.user_id !== member.user_id && (account?.role === "owner" || member.role === "member" || member.role === "viewer");
          const ownerProtected = member.role === "owner" && ownerCount <= 1;
          return <li key={member.user_id}><span className="workspace-member-avatar" aria-hidden="true">{member.display_name[0]}</span><span className="workspace-member-identity"><b>{member.display_name}</b><small>{member.email ?? "Local password sign-in"} · {workspace.display_name}</small></span>{canEdit && !ownerProtected ? <div className="workspace-member-controls"><UiSelect id={`role-${member.user_id}`} label={`Role for ${member.display_name}`} value={member.role} disabled={memberBusy === member.user_id} onChange={(role) => void changeRole(member.user_id, role as WorkspaceMember["role"])} options={account?.role === "owner" ? [{ value: "owner", label: "Owner" }, { value: "admin", label: "Admin" }, { value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }] : [{ value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }]} />{member.role !== "owner" ? <button className="text-button" type="button" disabled={memberBusy === member.user_id} onClick={() => void resetMember(member.user_id)}>Reset access</button> : null}{pendingRemovalId === member.user_id ? <><button className="text-button" type="button" onClick={() => setPendingRemovalId(null)}>Cancel</button><button className="text-button destructive" type="button" disabled={memberBusy === member.user_id} onClick={() => void removeMember(member.user_id)}>Confirm remove</button></> : <button className="text-button destructive" type="button" onClick={() => setPendingRemovalId(member.user_id)}>Remove</button>}</div> : <em>{member.role} · {member.status}</em>}</li>;
        })}</ul>
        {canManage ? <><form className="workspace-invite" onSubmit={(event) => void invite(event)}><h3>Add a teammate</h3><label htmlFor="invite-name">Name</label><input id="invite-name" value={inviteName} onChange={(event) => setInviteName(event.target.value)} minLength={2} maxLength={120} required /><label htmlFor="invite-email">Work email</label><input id="invite-email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} required /><UiSelect id="invite-role" label="Role" value={inviteRole} onChange={(role) => setInviteRole(role as "admin" | "member" | "viewer")} options={account?.role === "owner" ? [{ value: "member", label: "Member · shared knowledge" }, { value: "admin", label: "Admin · workspace management" }, { value: "viewer", label: "Viewer · shared knowledge" }] : [{ value: "member", label: "Member · shared knowledge" }, { value: "viewer", label: "Viewer · shared knowledge" }]} /><button className="button primary" disabled={inviting}>{inviting ? "Adding…" : "Add teammate"}</button></form>{inviteResult ? <div className="workspace-invite-secret" role="status"><b>{inviteResult.account.display_name} can sign in</b><p>{inviteResult.note}</p><code>{inviteResult.account.email}</code>{inviteResult.temporary_password ? <><code>{inviteResult.temporary_password}</code><button type="button" className="text-button" onClick={() => void navigator.clipboard.writeText(inviteResult.temporary_password ?? "")}>Copy temporary password</button></> : null}</div> : null}</> : null}
      </section>
      {canManage ? <section className="workspace-card workspace-audit workspace-retention" aria-labelledby="workspace-retention-title">
        <h2 id="workspace-retention-title">Data retention</h2>
        <p>Automatic deletion is off by default. Choose how long to keep each category, then explicitly enable the policy. Meeting deletion also requests Vexa to erase its transcript and recordings; previously sent emails and external backups cannot be recalled.</p>
        {retentionError ? <p className="form-error" role="alert">{retentionError}</p> : null}
        {retention ? <><div className="retention-fields"><UiSelect id="retention-meetings" label="Meeting records, transcripts & MOMs" value={String(retention.meeting_days ?? "forever")} onChange={(value) => setRetention({ ...retention, meeting_days: value === "forever" ? null : Number(value) })} options={retentionOptions} /><UiSelect id="retention-chats" label="Saved AI chats" value={String(retention.chat_days ?? "forever")} onChange={(value) => setRetention({ ...retention, chat_days: value === "forever" ? null : Number(value) })} options={retentionOptions} /><UiSelect id="retention-audit" label="Workspace audit events" value={String(retention.audit_days ?? "forever")} onChange={(value) => setRetention({ ...retention, audit_days: value === "forever" ? null : Number(value) })} options={retentionOptions} /></div><label className="retention-enable"><input type="checkbox" checked={retention.enabled} onChange={(event) => setRetention({ ...retention, enabled: event.target.checked })} /> Enable scheduled deletion for the selected periods</label><button type="button" className="button secondary" disabled={retentionBusy || (retention.enabled && !retention.meeting_days && !retention.chat_days && !retention.audit_days)} onClick={() => void saveRetention()}>{retentionBusy ? "Saving…" : "Save retention policy"}</button></> : !retentionError ? <p>Loading retention policy…</p> : null}
      </section> : null}
      {canManage ? <section className="workspace-card workspace-audit" aria-labelledby="workspace-operations-title">
        <div className="workspace-audit-heading"><div><h2 id="workspace-operations-title">Operations</h2><p>Live workload and jobs needing review in this organization.</p></div><button type="button" className="button secondary" onClick={() => void refreshOperations()}>Refresh</button></div>
        {operationsError ? <p className="form-error" role="alert">{operationsError}</p> : null}
        {operations ? <dl className="workspace-operations-grid"><div><dt>Active captures</dt><dd>{operations.active_captures}</dd></div><div><dt>Capture failures</dt><dd>{operations.failed_captures}</dd></div><div><dt>MOM jobs with errors</dt><dd>{operations.failed_mom_jobs}</dd></div><div><dt>Knowledge jobs pending</dt><dd>{operations.pending_index_jobs}</dd></div><div><dt>Knowledge jobs failed</dt><dd>{operations.failed_index_jobs}</dd></div><div><dt>Email delivery failures</dt><dd>{operations.failed_email_deliveries}</dd></div></dl> : !operationsError ? <p>Loading operations status…</p> : null}
        <p className="field-hint">Counts are workspace-scoped. This does not replace infrastructure logs or alerts.</p>
      </section> : null}
      {canManage ? <section className="workspace-card workspace-audit" aria-labelledby="workspace-audit-title">
        <div className="workspace-audit-heading"><div><h2 id="workspace-audit-title">Recent activity</h2><p>Workspace changes and sign-ins. Request bodies and credentials are never shown.</p></div><button type="button" className="button secondary" onClick={() => void refreshAudit()}>Refresh</button></div>
        {auditError ? <p className="form-error" role="alert">{auditError}</p> : null}
        {auditEvents.length ? <ul className="workspace-audit-list">{auditEvents.map((event) => <li key={event.id}><span><b>{event.action === "auth.login.succeeded" ? "Signed in" : event.action}</b><small>{members.find((member) => member.user_id === event.actor_user_id)?.display_name ?? "Workspace account"}{event.resource_id ? ` · ${event.resource_id.slice(0, 8)}…` : ""}</small></span><time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time></li>)}</ul> : <p>No workspace activity recorded yet.</p>}
      </section> : null}
    </div>
  </section>;
}

const retentionOptions = [
  { value: "forever", label: "Keep until manually deleted" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "730", label: "2 years" },
];
