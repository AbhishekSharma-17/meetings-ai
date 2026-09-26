"use client";

import { FormEvent, useEffect, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import { initials } from "@/lib/meeting-status";
import type { CurrentAccount, InviteResult, Workspace, WorkspaceMember, WorkspaceOption } from "@/lib/types";
import { PageHeader } from "./ui/page-header";
import { Badge } from "./ui/feedback";
import { SettingsToast } from "./settings-toast";
import { roleLabel, WorkspacePeople, type InviteRole } from "./workspace-people";
import { WorkspaceBrief } from "./workspace-brief";
import { OperationsCard, RetentionCard } from "./workspace-admin-cards";
import { ActivityCard } from "./workspace-activity";

type SectionLink = { id: string; label: string; adminOnly?: boolean };
const sectionLinks: SectionLink[] = [
  { id: "settings-organization", label: "Organization" },
  { id: "settings-people", label: "People & access" },
  { id: "settings-workspaces", label: "Your workspaces" },
  { id: "settings-brief", label: "Company profile" },
  { id: "settings-retention", label: "Data retention", adminOnly: true },
  { id: "settings-operations", label: "Operations", adminOnly: true },
  { id: "settings-activity", label: "Recent activity", adminOnly: true },
];

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
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [workspaceAction, setWorkspaceAction] = useState(false);
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
  const [inviting, setInviting] = useState(false);
  const [memberBusy, setMemberBusy] = useState<string | null>(null);
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  const [meetingTitles, setMeetingTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [baseNames, setBaseNames] = useState<ReadonlyMap<string, string>>(new Map());
  const canManage = account?.role === "owner" || account?.role === "admin";

  useEffect(() => {
    void meetingsService.listWorkspaceMembers().then(setMembers).catch(() => {
      setError("Could not load workspace members.");
    });
  }, []);

  // Admin cards name meetings and knowledge bases instead of showing record ids. Best effort only.
  useEffect(() => {
    if (!canManage) return;
    void Promise.allSettled([meetingsService.listMeetings(), meetingsService.listKnowledgeBases()]).then(([meetings, bases]) => {
      if (meetings.status === "fulfilled") setMeetingTitles(new Map(meetings.value.map((item) => [item.id, item.title])));
      if (bases.status === "fulfilled") setBaseNames(new Map(bases.value.map((item) => [item.id, item.name])));
    });
  }, [canManage]);

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

  async function invite(email: string, displayName: string, role: InviteRole): Promise<boolean> {
    setInviting(true); setError(null); setInviteResult(null);
    try {
      const result = await meetingsService.inviteMember(email, displayName, role);
      setInviteResult(result);
      setMembers(await meetingsService.listWorkspaceMembers());
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create invitation.");
      return false;
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

  const notice = error ? { tone: "danger" as const, text: error } : message ? { tone: "success" as const, text: message } : null;
  const links = sectionLinks.filter((link) => canManage || !link.adminOnly);

  return <section className="page wide workspace-page" aria-labelledby="workspace-page-title">
    <PageHeader titleId="workspace-page-title" title="Workspace settings" description="Manage your organization, the people in it and what they can access." />
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {links.map((link) => <button key={link.id} type="button" onClick={() => document.getElementById(link.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{link.label}</button>)}
      </nav>
      <div className="settings-sections">
        {canManage ? <OrganizationProfileForm slug={workspace.slug} name={name} contactEmail={contactEmail} saving={saving} onName={setName} onContactEmail={setContactEmail} onSubmit={save} /> : <OrganizationSummary workspace={workspace} />}
        <WorkspacePeople members={members} account={account} canManage={canManage} memberBusy={memberBusy} pendingRemovalId={pendingRemovalId} inviteResult={inviteResult} inviting={inviting}
          onChangeRole={(userId, role) => void changeRole(userId, role)} onReset={(userId) => void resetMember(userId)} onRequestRemoval={setPendingRemovalId} onCancelRemoval={() => setPendingRemovalId(null)}
          onRemove={(userId) => void removeMember(userId)} onInvite={invite} onCopyFailed={() => setError("Could not copy the password. Select it and copy it manually.")} />
        <section className="card settings-section" id="settings-workspaces" aria-labelledby="workspace-directory-title">
          <div className="card-header"><div><h2 id="workspace-directory-title">Your workspaces</h2><p>Each workspace keeps its own meetings, people, providers and knowledge.</p></div></div>
          <ul className="workspace-directory">{workspaces.map((item) => {
            const current = item.id === account?.organization_id;
            return <li key={item.id} className="list-row">
              <span className="avatar workspace-avatar" aria-hidden="true">{initials(item.display_name)}</span>
              <span className="workspace-directory-copy"><b>{item.display_name}</b><small>{roleLabel[item.role] ?? item.role}</small></span>
              {current ? <Badge tone="brand">Current workspace</Badge> : <button className="button secondary sm" type="button" disabled={workspaceAction} onClick={() => void switchWorkspace(item.id)}>Switch</button>}
            </li>;
          })}</ul>
          {canManage ? <form className="card-footer workspace-create" onSubmit={(event) => void createWorkspace(event)}>
            <label className="sr-only" htmlFor="new-workspace-name">New workspace name</label>
            <input id="new-workspace-name" value={newWorkspaceName} onChange={(event) => setNewWorkspaceName(event.target.value)} minLength={2} maxLength={120} required placeholder="New workspace, e.g. Novaala" disabled={workspaceAction} />
            <button className="button secondary" type="submit" disabled={workspaceAction}>{workspaceAction ? "Creating…" : "Create workspace"}</button>
          </form> : null}
          {workspaceActionError ? <div className="card-body"><p className="form-error" role="alert">{workspaceActionError}</p></div> : null}
        </section>
        <WorkspaceBrief workspaceId={workspace.id} canManage={canManage} />
        {canManage ? <RetentionCard onSaved={setMessage} /> : null}
        {canManage ? <OperationsCard meetingTitles={meetingTitles} /> : null}
        {canManage ? <ActivityCard members={members} meetingTitles={meetingTitles} baseNames={baseNames} /> : null}
      </div>
    </div>
    <SettingsToast notice={notice} onDismiss={() => { setError(null); setMessage(null); }} />
  </section>;
}

function OrganizationProfileForm({ slug, name, contactEmail, saving, onName, onContactEmail, onSubmit }: {
  slug: string; name: string; contactEmail: string; saving: boolean;
  onName(value: string): void; onContactEmail(value: string): void; onSubmit(event: FormEvent<HTMLFormElement>): void;
}) {
  return <section className="card settings-section" id="settings-organization" aria-labelledby="organization-profile-title">
    <div className="card-header"><div><h2 id="organization-profile-title">Organization profile</h2><p>How this workspace is named across Meetings AI.</p></div></div>
    <form onSubmit={(event) => void onSubmit(event)}>
      <div className="card-body form-stack">
        <div className="field-row">
          <div className="field"><label htmlFor="workspace-name">Workspace name</label><input id="workspace-name" value={name} minLength={2} maxLength={120} required onChange={(event) => onName(event.target.value)} disabled={saving} /></div>
          <div className="field"><label htmlFor="workspace-contact">Contact email <span className="optional">optional</span></label><input id="workspace-contact" type="email" maxLength={320} value={contactEmail} onChange={(event) => onContactEmail(event.target.value)} disabled={saving} placeholder="team@example.com" /></div>
        </div>
        <div className="field">
          <span className="field-label">Workspace slug</span>
          <code className="settings-readonly">{slug}</code>
          <p className="field-hint">Reserved for organization URLs; it can’t be changed here.</p>
        </div>
      </div>
      <div className="card-footer"><button className="button primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save workspace"}</button></div>
    </form>
  </section>;
}

function OrganizationSummary({ workspace }: { workspace: Workspace }) {
  return <section className="card settings-section" id="settings-organization" aria-labelledby="organization-profile-title">
    <div className="card-header"><div><h2 id="organization-profile-title">Organization profile</h2><p>Only an admin can edit this profile.</p></div></div>
    <div className="card-body"><dl className="meta-list">
      <div><dt>Workspace name</dt><dd>{workspace.display_name}</dd></div>
      <div><dt>Contact email</dt><dd>{workspace.contact_email ?? "No organization contact email"}</dd></div>
    </dl></div>
  </section>;
}
