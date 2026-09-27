"use client";

import { FormEvent, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import { initials } from "@/lib/meeting-status";
import type { CurrentAccount, WorkspaceOption } from "@/lib/types";
import { Badge } from "./ui/feedback";
import { roleLabel } from "./workspace-people";

/** "Your workspaces": switch, create, and choose which workspace a new sign-in opens in. */
export function WorkspaceDirectory({ workspaces, account, canManage, onSwitchWorkspace, onCreateWorkspace, onWorkspacesChange }: {
  workspaces: WorkspaceOption[];
  account: CurrentAccount | null;
  canManage: boolean;
  onSwitchWorkspace(id: string): Promise<void>;
  onCreateWorkspace(name: string): Promise<void>;
  onWorkspacesChange?(workspaces: WorkspaceOption[]): void;
}) {
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [workspaceAction, setWorkspaceAction] = useState(false);
  const [defaultBusy, setDefaultBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const defaultWorkspace = workspaces.find((item) => item.is_default) ?? null;
  const multiple = workspaces.length > 1;

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setWorkspaceAction(true); setActionError(null);
    try { await onCreateWorkspace(newWorkspaceName.trim()); }
    catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not create workspace.");
      setWorkspaceAction(false);
    }
  }

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
    <div className="card-header"><div><h2 id="workspace-directory-title">Your workspaces</h2><p>Each workspace keeps its own meetings, people, providers and knowledge.</p></div></div>
    <ul className="workspace-directory">{workspaces.map((item) => {
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
    {canManage ? <form className="card-footer workspace-create" onSubmit={(event) => void createWorkspace(event)}>
      <label className="sr-only" htmlFor="new-workspace-name">New workspace name</label>
      <input id="new-workspace-name" value={newWorkspaceName} onChange={(event) => setNewWorkspaceName(event.target.value)} minLength={2} maxLength={120} required placeholder="New workspace, e.g. Novaala" disabled={workspaceAction} />
      <button className="button secondary" type="submit" disabled={workspaceAction}>{workspaceAction ? "Creating…" : "Create workspace"}</button>
    </form> : null}
    {actionError ? <div className="card-body"><p className="form-error" role="alert">{actionError}</p></div> : null}
  </section>;
}
