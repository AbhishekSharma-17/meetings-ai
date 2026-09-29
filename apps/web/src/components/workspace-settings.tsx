"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { CurrentAccount, Workspace, WorkspaceMember, WorkspaceOption } from "@/lib/types";
import { PageHeader } from "./ui/page-header";
import { SettingsToast } from "./settings-toast";
import { WorkspacePeople } from "./workspace-people";
import { WorkspaceDirectory } from "./workspace-directory";
import { WorkspaceBrief } from "./workspace-brief";
import { RetentionCard } from "./workspace-admin-cards";
import { ActivityCard } from "./workspace-activity";
import { WorkspaceTeams } from "./workspace-teams";
import { WorkspaceLeavePolicy } from "./workspace-leave-policy";

type SectionLink = { id: string; label: string; adminOnly?: boolean };
const sectionLinks: SectionLink[] = [
  { id: "settings-organization", label: "Organization" },
  { id: "settings-people", label: "People & access" },
  { id: "settings-teams", label: "Teams" },
  { id: "settings-workspaces", label: "Your workspaces" },
  { id: "settings-brief", label: "Company profile" },
  { id: "settings-leave", label: "Leaving calls" },
  { id: "settings-retention", label: "Data retention", adminOnly: true },
  { id: "settings-activity", label: "Recent activity", adminOnly: true },
];

export function WorkspaceSettings({ workspace, workspaces, account, onWorkspaceChange, onSwitchWorkspace, onCreateWorkspace, onWorkspacesChange, onOpenObservability }: {
  workspace: Workspace;
  workspaces: WorkspaceOption[];
  account: CurrentAccount | null;
  onWorkspaceChange(workspace: Workspace): void;
  onSwitchWorkspace(id: string): Promise<void>;
  onCreateWorkspace(name: string): Promise<void>;
  onWorkspacesChange?(workspaces: WorkspaceOption[]): void;
  /** Usage, spend and job health live on the Observability page (owners and admins). */
  onOpenObservability?(): void;
}) {
  const [name, setName] = useState(workspace.display_name);
  const [contactEmail, setContactEmail] = useState(workspace.contact_email ?? "");
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [meetingTitles, setMeetingTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [baseNames, setBaseNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [teamNames, setTeamNames] = useState<ReadonlyMap<string, string>>(new Map());
  const canManage = account?.role === "owner" || account?.role === "admin";

  const loadMembers = useCallback(() => meetingsService.listWorkspaceMembers()
    .then((next) => { setMembers(next); setMembersError(null); })
    .catch(() => setMembersError("Could not load workspace members."))
    .finally(() => setMembersLoading(false)), []);

  useEffect(() => { void loadMembers(); }, [loadMembers]);

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

  const notice = error ? { tone: "danger" as const, text: error } : message ? { tone: "success" as const, text: message } : null;
  const links = sectionLinks.filter((link) => canManage || !link.adminOnly);

  return <section className="page wide workspace-page" aria-labelledby="workspace-page-title">
    <PageHeader titleId="workspace-page-title" title="Workspace settings" description="Manage your organization, the people in it and what they can access." />
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {links.map((link) => <button key={link.id} type="button" onClick={() => document.getElementById(link.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{link.label}</button>)}
        {canManage && onOpenObservability ? <button type="button" className="settings-nav-external" onClick={onOpenObservability}>
          Usage, spend & job health<ArrowUpRight aria-hidden="true" />
        </button> : null}
      </nav>
      <div className="settings-sections">
        {canManage ? <OrganizationProfileForm slug={workspace.slug} name={name} contactEmail={contactEmail} saving={saving} onName={setName} onContactEmail={setContactEmail} onSubmit={save} /> : <OrganizationSummary workspace={workspace} />}
        <WorkspacePeople members={members} loading={membersLoading} loadError={membersError} account={account} canManage={canManage} workspaceName={workspace.display_name}
          onMembersChange={setMembers} onNotice={(text) => { setError(null); setMessage(text); }} onRetry={() => { setMembersLoading(true); void loadMembers(); }} />
        <WorkspaceTeams members={members} canManage={canManage} onMessage={(text) => { setError(null); setMessage(text); }}
          onTeamsChange={(teams) => setTeamNames(new Map(teams.map((team) => [team.id, team.name])))} />
        <WorkspaceDirectory workspaces={workspaces} account={account} canManage={canManage} onSwitchWorkspace={onSwitchWorkspace} onCreateWorkspace={onCreateWorkspace} onWorkspacesChange={onWorkspacesChange} />
        <WorkspaceBrief workspaceId={workspace.id} canManage={canManage} />
        <WorkspaceLeavePolicy key={workspace.id} onSaved={(text) => { setError(null); setMessage(text); }} />
        {canManage ? <RetentionCard onSaved={setMessage} /> : null}
        {canManage ? <ActivityCard members={members} meetingTitles={meetingTitles} baseNames={baseNames} teamNames={teamNames} /> : null}
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
