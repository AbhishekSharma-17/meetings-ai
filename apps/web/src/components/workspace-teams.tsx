"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Users } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { Team, TeamInput, WorkspaceMember } from "@/lib/types";
import { Avatar } from "./ui/avatar";
import { Alert, EmptyState, LoadingRow } from "./ui/feedback";
import { TeamDialog } from "./workspace-team-dialog";
import { NoMatches, SearchToolbar } from "./scroll-panel";
import { useListSearch } from "./use-list-search";

const STACK_SIZE = 4;

type Editing = { team: Team | null; readOnly: boolean };

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Internal teams (recipient groups) for meeting recaps. Everyone sees them; owners and admins
 * create, rename, re-member and delete them. Deleting asks for confirmation inline.
 */
export function WorkspaceTeams({ members, canManage, onTeamsChange, onMessage }: {
  members: WorkspaceMember[];
  canManage: boolean;
  onTeamsChange?(teams: Team[]): void;
  onMessage(message: string): void;
}) {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Kept in a ref so a parent's inline callback never retriggers the initial load.
  const notify = useRef(onTeamsChange);
  useEffect(() => { notify.current = onTeamsChange; }, [onTeamsChange]);
  const publish = useCallback((next: Team[]) => { setTeams(next); notify.current?.(next); }, []);

  const fetchTeams = useCallback(() => meetingsService.listTeams().then(publish).catch(() => setLoadError("Teams could not be loaded.")), [publish]);

  useEffect(() => { void fetchTeams(); }, [fetchTeams]);

  function retry() {
    setLoadError(null);
    void fetchTeams();
  }

  function open(team: Team | null, readOnly = false) {
    setSaveError(null);
    setEditing({ team, readOnly });
  }

  async function save(input: TeamInput) {
    if (!editing) return;
    setSaving(true); setSaveError(null);
    try {
      const saved = editing.team ? await meetingsService.updateTeam(editing.team.id, input) : await meetingsService.createTeam(input);
      const rest = (teams ?? []).filter((team) => team.id !== saved.id);
      publish([...rest, saved].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })));
      setEditing(null);
      onMessage(editing.team ? `${saved.name} saved.` : `Team ${saved.name} created.`);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not save the team.");
    } finally { setSaving(false); }
  }

  async function remove(team: Team) {
    setDeletingId(team.id); setDeleteError(null);
    try {
      await meetingsService.deleteTeam(team.id);
      publish((teams ?? []).filter((item) => item.id !== team.id));
      setPendingDeleteId(null);
      onMessage(`Team ${team.name} deleted.`);
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : "Could not delete the team.");
    } finally { setDeletingId(null); }
  }

  const count = teams?.length ?? 0;
  const search = useListSearch(teams ?? [], (team) => [team.name, team.description, team.members.map((member) => [member.display_name, member.email])]);
  return <section className="card settings-section" id="settings-teams" aria-labelledby="workspace-teams-title">
    <div className="card-header">
      <div><h2 id="workspace-teams-title">Teams</h2><p>{canManage ? "Groups you can send meeting recaps to in one step." : "Groups your admins set up for meeting recaps."}</p></div>
      {canManage && count ? <button type="button" className="button secondary sm" onClick={() => open(null)}><Plus aria-hidden="true" />New team</button>
        : count ? <span className="section-count">{plural(count, "team")}</span> : null}
    </div>
    {loadError ? <div className="card-body"><Alert tone="danger" actions={<button type="button" className="button secondary sm" onClick={retry}>Retry</button>}>{loadError}</Alert></div>
      : teams === null ? <div className="card-body"><LoadingRow>Loading teams…</LoadingRow></div>
      : !teams.length ? <EmptyState icon={<Users />} title="No teams yet"
        action={canManage ? <button type="button" className="button secondary sm" onClick={() => open(null)}><Plus aria-hidden="true" />Create a team</button> : undefined}>
        {canManage ? "Create one to send a recap to a whole group, like Leadership or an account team." : "An admin can create teams for meeting recaps."}
      </EmptyState>
      : <>
        {search.offered ? <SearchToolbar id="team-search" label="Search teams" value={search.query} onChange={search.setQuery} placeholder="Search by team, member name or email" /> : null}
        {search.noMatches ? <NoMatches query={search.query} noun="teams" onClear={search.clear} /> : <ul className="team-list">
        {search.visible.map((team) => <TeamRow key={team.id} team={team} canManage={canManage} confirming={pendingDeleteId === team.id} deleting={deletingId === team.id}
          error={pendingDeleteId === team.id ? deleteError : null}
          onOpen={() => open(team, !canManage)} onRequestDelete={() => { setDeleteError(null); setPendingDeleteId(team.id); }}
          onCancelDelete={() => setPendingDeleteId(null)} onDelete={() => void remove(team)} />)}
      </ul>}
      </>}
    {editing ? <TeamDialog key={editing.team?.id ?? "new"} open team={editing.team} members={members} readOnly={editing.readOnly}
      busy={saving} error={saveError} onClose={() => setEditing(null)} onSave={(input) => void save(input)} /> : null}
  </section>;
}

function TeamRow({ team, canManage, confirming, deleting, error, onOpen, onRequestDelete, onCancelDelete, onDelete }: {
  team: Team; canManage: boolean; confirming: boolean; deleting: boolean; error: string | null;
  onOpen(): void; onRequestDelete(): void; onCancelDelete(): void; onDelete(): void;
}) {
  const active = team.members.filter((member) => member.active);
  const extra = active.length - STACK_SIZE;
  return <li className="team-row" data-confirming={confirming || undefined}>
    <span className="team-row-icon" aria-hidden="true"><Users /></span>
    <span className="team-row-identity">
      <b>{team.name}</b>
      <small>{team.description || plural(team.member_count, "member")}{team.meeting_count ? ` · used by ${plural(team.meeting_count, "meeting")}` : ""}</small>
    </span>
    <span className="avatar-stack" aria-label={`${plural(team.member_count, "member")}`} role="img">
      {active.slice(0, STACK_SIZE).map((member) => <Avatar key={`${member.user_id ?? ""}:${member.email}`} name={member.display_name ?? member.email} photoUrl={member.photo_url} size="sm" />)}
      {extra > 0 ? <span className="avatar sm avatar-more">+{extra}</span> : null}
    </span>
    <span className="team-row-actions">
      {confirming ? <>
        <span className="team-row-confirm" role="status">{team.meeting_count ? `${plural(team.meeting_count, "meeting")} will stop sending to it.` : "Delete this team?"}</span>
        <button type="button" className="button danger sm" disabled={deleting} onClick={onDelete}>{deleting ? "Deleting…" : "Confirm delete"}</button>
        <button type="button" className="button ghost sm" disabled={deleting} onClick={onCancelDelete}>Cancel</button>
      </> : <>
        <button type="button" className="button ghost sm" onClick={onOpen} aria-label={`${canManage ? "Edit" : "View"} ${team.name}`}>{canManage ? "Edit" : "View"}</button>
        {canManage ? <button type="button" className="text-button destructive" onClick={onRequestDelete} aria-label={`Delete ${team.name}`}>Delete</button> : null}
      </>}
    </span>
    {error ? <p className="form-error team-row-error" role="alert">{error}</p> : null}
  </li>;
}
