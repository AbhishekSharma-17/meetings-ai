"use client";

import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { CurrentAccount, InviteResult, WorkspaceMember } from "@/lib/types";
import { Alert, LoadingRow } from "./ui/feedback";
import { FilterInput, matchesQuery, NoMatches, ScrollPanel } from "./scroll-panel";
import { AddPeopleDialog } from "./add-people-dialog";
import { AccessResultDialog, ConfirmMemberDialog, MemberRoleDialog } from "./member-dialogs";
import { MemberRow, type MemberAction } from "./member-row";
import { memberPermissions, memberState, roleLabel, roleOptions, type InviteRole, type MemberRole } from "./member-access";

export { roleLabel, type InviteRole } from "./member-access";

/** Above this many people the list gets a search box; it always scrolls inside the card. */
const SEARCH_THRESHOLD = 6;
/** Pending/expired invite chips are recomputed on this cadence. */
const CLOCK_TICK_MS = 30_000;

type Dialog =
  | { kind: "add" }
  | { kind: "role" | "reset" | "remove"; member: WorkspaceMember }
  | { kind: "result"; title: string; sentTitle: string; result: InviteResult };

const message = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** People & access: a list of members with a row menu, and "Add people" in a dialog. */
export function WorkspacePeople({ members, loading, loadError, account, canManage, workspaceName, onMembersChange, onNotice, onRetry }: {
  members: WorkspaceMember[];
  loading: boolean;
  loadError: string | null;
  account: CurrentAccount | null;
  canManage: boolean;
  workspaceName: string;
  onMembersChange(members: WorkspaceMember[]): void;
  onNotice(text: string): void;
  onRetry(): void;
}) {
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const now = useNow();
  const ownerCount = members.filter((member) => member.role === "owner").length;
  const isOwner = account?.role === "owner";

  const refresh = () => meetingsService.listWorkspaceMembers().then(onMembersChange).catch(() => undefined);
  const open = (next: Dialog | null) => { setDialogError(null); setDialog(next); };

  async function invite(email: string, name: string, role: InviteRole): Promise<InviteResult> {
    const result = await meetingsService.inviteMember(email, name, role);
    await refresh();
    return result;
  }

  async function runDialog(work: () => Promise<void>, fallback: string) {
    setDialogBusy(true); setDialogError(null);
    try { await work(); }
    catch (cause) { setDialogError(message(cause, fallback)); }
    finally { setDialogBusy(false); }
  }

  const changeRole = (member: WorkspaceMember, role: MemberRole) => runDialog(async () => {
    await meetingsService.changeMemberRole(member.user_id, role);
    await refresh();
    open(null);
    onNotice("Member role updated.");
  }, "Could not change the role.");

  const resetAccess = (member: WorkspaceMember) => runDialog(async () => {
    const result = await meetingsService.resetMemberAccess(member.user_id);
    await refresh();
    open({ kind: "result", title: `Access reset for ${member.display_name}`, sentTitle: "Reset link emailed", result });
  }, "Could not reset access.");

  const remove = (member: WorkspaceMember) => runDialog(async () => {
    await meetingsService.removeMember(member.user_id);
    await refresh();
    open(null);
    onNotice("Member access removed from this workspace.");
  }, "Could not remove this person.");

  async function resend(member: WorkspaceMember) {
    setRowBusy(member.user_id); setRowError(null);
    try {
      const result = await meetingsService.resendInvite(member.user_id);
      await refresh();
      open({ kind: "result", title: `Invitation resent to ${member.display_name}`, sentTitle: "New invitation sent", result });
    } catch (cause) { setRowError(message(cause, "Could not resend the invitation.")); }
    finally { setRowBusy(null); }
  }

  function act(member: WorkspaceMember, action: MemberAction) {
    setRowError(null);
    if (action === "resend") void resend(member);
    else open({ kind: action, member });
  }

  const searchable = members.length > SEARCH_THRESHOLD;
  const visible = searchable ? members.filter((member) => matchesQuery(query, [member.display_name, member.email, roleLabel[member.role], memberState(member, now).label])) : members;
  const pending = members.filter((member) => member.status === "invited").length;

  return <section className="card settings-section" id="settings-people" aria-labelledby="workspace-members-title">
    <div className="card-header">
      <div><h2 id="workspace-members-title">People & access</h2><p>Who can open this workspace and what they can change.</p></div>
      <div className="people-header-actions">
        <span className="section-count">{members.length} {members.length === 1 ? "person" : "people"}{pending ? ` · ${pending} invited` : ""}</span>
        {canManage ? <button type="button" className="button secondary sm" onClick={() => open({ kind: "add" })}><UserPlus aria-hidden="true" /><span>Add people</span></button> : null}
      </div>
    </div>
    {searchable ? <div className="card-toolbar">
      <FilterInput id="member-search" label="Search people" value={query} onChange={setQuery} placeholder="Search by name, email, role or status" />
    </div> : null}
    {rowError ? <div className="card-body people-error"><Alert tone="danger">{rowError}</Alert></div> : null}
    {loadError ? <div className="card-body"><Alert tone="danger" actions={<button type="button" className="button secondary sm" onClick={onRetry}>Retry</button>}>{loadError}</Alert></div>
      : loading && !members.length ? <div className="card-body"><LoadingRow>Loading people…</LoadingRow></div>
      : visible.length ? <ScrollPanel label="Member list" className="member-scroll"><ul className="people-list">
        {visible.map((member) => <MemberRow key={member.user_id} member={member} state={memberState(member, now)}
          isSelf={account?.user_id === member.user_id} permissions={memberPermissions(member, account, ownerCount)}
          busy={rowBusy === member.user_id} onAction={(action) => act(member, action)} />)}
      </ul></ScrollPanel>
      : members.length ? <NoMatches query={query} noun="people" onClear={() => setQuery("")} /> : null}
    <AddPeopleDialog open={dialog?.kind === "add"} isOwner={isOwner} workspaceName={workspaceName} onClose={() => open(null)} onInvite={invite} />
    {dialog?.kind === "role" ? <MemberRoleDialog member={dialog.member} options={roleOptions(isOwner)} busy={dialogBusy} error={dialogError}
      onSave={(role) => void changeRole(dialog.member, role)} onClose={() => open(null)} /> : null}
    {dialog?.kind === "reset" ? <ConfirmMemberDialog title={`Reset access for ${dialog.member.display_name}?`}
      description={<>Their current password and every open session stop working now. We’ll email <b>{dialog.member.email}</b> a link to set a new password; it works once and expires in 10 minutes.</>}
      confirmLabel="Reset access" busyLabel="Resetting…" busy={dialogBusy} error={dialogError}
      onConfirm={() => void resetAccess(dialog.member)} onClose={() => open(null)} /> : null}
    {dialog?.kind === "remove" ? <ConfirmMemberDialog title={`Remove ${dialog.member.display_name}?`}
      description={dialog.member.status === "invited" ? "Their pending invitation stops working and they lose access to this workspace." : "They lose access to this workspace, its meetings and its shared knowledge. Their account and other workspaces are not affected."}
      confirmLabel="Remove" busyLabel="Removing…" busy={dialogBusy} error={dialogError}
      onConfirm={() => void remove(dialog.member)} onClose={() => open(null)} /> : null}
    {dialog?.kind === "result" ? <AccessResultDialog title={dialog.title} sentTitle={dialog.sentTitle} result={dialog.result} onClose={() => open(null)} /> : null}
  </section>;
}
