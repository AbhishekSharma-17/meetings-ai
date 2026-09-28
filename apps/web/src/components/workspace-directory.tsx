"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import { initials } from "@/lib/meeting-status";
import type { CurrentAccount, WorkspaceOption } from "@/lib/types";
import { Badge } from "./ui/feedback";
import { roleLabel } from "./member-access";
import { NewWorkspaceDialog } from "./new-workspace-dialog";
import { NoMatches, SearchToolbar } from "./scroll-panel";
import { useListSearch } from "./use-list-search";

/** "Your workspaces": switch, create, and choose which workspace a new sign-in opens in. */
export function WorkspaceDirectory({ workspaces, account, canManage, onSwitchWorkspace, onCreateWorkspace, onWorkspacesChange }: {
  workspaces: WorkspaceOption[];
  account: CurrentAccount | null;
  canManage: boolean;
  onSwitchWorkspace(id: string): Promise<void>;
  onCreateWorkspace(name: string): Promise<void>;
  onWorkspacesChange?(workspaces: WorkspaceOption[]): void;
}) {
  const [creating, setCreating] = useState(false);
  const [workspaceAction, setWorkspaceAction] = useState(false);
  const [defaultBusy, setDefaultBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const defaultWorkspace = workspaces.find((item) => item.is_default) ?? null;
  const multiple = workspaces.length > 1;
  const search = useListSearch(workspaces, (item) => [item.display_name, roleLabel[item.role] ?? item.role, item.is_default ? "Default" : null, item.id === account?.organization_id ? "Current workspace" : null]);

  async function switchWorkspace(id: string) {
    setWorkspaceAction(true); setActionError(null);
    try { await onSwitchWorkspace(id); }
    catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not switch workspace.");
      setWorkspaceAction(false);
    }
  }

  async function setDefault(id: string | null) {
    setDefaultBusy(id ?? "clear"); setActionError(null);
    try { onWorkspacesChange?.(await meetingsService.setDefaultWorkspace(id)); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : "Could not update your default workspace."); }
    finally { setDefaultBusy(null); }
  }

  return <section className="card settings-section" id="settings-workspaces" aria-labelledby="workspace-directory-title">
    <div className="card-header">
      <div><h2 id="workspace-directory-title">Your workspaces</h2><p>Each workspace keeps its own meetings, people, providers and knowledge.</p></div>
      {canManage ? <button type="button" className="button secondary sm" onClick={() => setCreating(true)}><Plus aria-hidden="true" /><span>New workspace</span></button>
        : <span className="section-count">{workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"}</span>}
    </div>
    {search.offered ? <SearchToolbar id="workspace-search" label="Search workspaces" value={search.query} onChange={search.setQuery} placeholder="Search by workspace name or role" /> : null}
    {search.noMatches ? <NoMatches query={search.query} noun="workspaces" onClear={search.clear} /> : null}
    <ul className="workspace-directory">{search.visible.map((item) => {
      const current = item.id === account?.organization_id;
      return <li key={item.id} className="list-row workspace-directory-row">
        <span className="avatar workspace-avatar" aria-hidden="true">{initials(item.display_name)}</span>
        <span className="workspace-directory-copy">
          <span className="workspace-directory-name"><b>{item.display_name}</b>{item.is_default ? <Badge tone="neutral">Default</Badge> : null}</span>
          <small>{roleLabel[item.role] ?? item.role}</small>
        </span>
        <span className="workspace-directory-actions">
          {multiple && !item.is_default
            ? <button className="button ghost sm" type="button" disabled={defaultBusy !== null} onClick={() => void setDefault(item.id)} aria-label={`Make ${item.display_name} your default workspace`}>
              {defaultBusy === item.id ? "Saving…" : "Make default"}
            </button>
            : null}
          {current ? <Badge tone="brand">Current workspace</Badge> : <button className="button secondary sm" type="button" disabled={workspaceAction} onClick={() => void switchWorkspace(item.id)}>Switch</button>}
        </span>
      </li>;
    })}</ul>
    {multiple ? <div className="workspace-landing" role="note">
      <p>{defaultWorkspace
        ? <>New sign-ins open <b>{defaultWorkspace.display_name}</b>.</>
        : "New sign-ins open the workspace you used last."}</p>
      {defaultWorkspace ? <button className="text-button" type="button" disabled={defaultBusy !== null} onClick={() => void setDefault(null)}>{defaultBusy === "clear" ? "Saving…" : "Use last active instead"}</button> : null}
    </div> : null}
    {canManage ? <NewWorkspaceDialog open={creating} onClose={() => setCreating(false)} onCreate={onCreateWorkspace} /> : null}
    {actionError ? <div className="card-body"><p className="form-error" role="alert">{actionError}</p></div> : null}
  </section>;
}
