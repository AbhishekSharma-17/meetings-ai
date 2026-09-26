"use client";

import { FormEvent, useState } from "react";
import { Check, Copy, UserPlus } from "lucide-react";
import { initials } from "@/lib/meeting-status";
import type { CurrentAccount, InviteResult, WorkspaceMember } from "@/lib/types";
import { UiSelect } from "./ui-select";
import { Alert, Badge, type Tone } from "./ui/feedback";

export type InviteRole = "admin" | "member" | "viewer";

export const roleLabel: Record<WorkspaceMember["role"], string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };

function statusTone(status: string): Tone {
  if (status === "active") return "success";
  if (status === "invited") return "info";
  return "neutral";
}
const statusLabel = (status: string) => status ? `${status[0].toUpperCase()}${status.slice(1)}` : "Unknown";

const ownerRoleOptions = [{ value: "owner", label: "Owner" }, { value: "admin", label: "Admin" }, { value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }];
const adminRoleOptions = [{ value: "member", label: "Member" }, { value: "viewer", label: "Viewer" }];
const ownerInviteOptions = [{ value: "member", label: "Member · shared knowledge" }, { value: "admin", label: "Admin · workspace management" }, { value: "viewer", label: "Viewer · shared knowledge" }];
const adminInviteOptions = [{ value: "member", label: "Member · shared knowledge" }, { value: "viewer", label: "Viewer · shared knowledge" }];

export function WorkspacePeople({ members, account, canManage, memberBusy, pendingRemovalId, inviteResult, inviting, onChangeRole, onReset, onRequestRemoval, onCancelRemoval, onRemove, onInvite, onCopyFailed }: {
  members: WorkspaceMember[];
  account: CurrentAccount | null;
  canManage: boolean;
  memberBusy: string | null;
  pendingRemovalId: string | null;
  inviteResult: InviteResult | null;
  inviting: boolean;
  onChangeRole(userId: string, role: WorkspaceMember["role"]): void;
  onReset(userId: string): void;
  onRequestRemoval(userId: string): void;
  onCancelRemoval(): void;
  onRemove(userId: string): void;
  onInvite(email: string, name: string, role: InviteRole): Promise<boolean>;
  onCopyFailed(): void;
}) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("member");
  const ownerCount = members.filter((member) => member.role === "owner").length;
  const isOwner = account?.role === "owner";

  async function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const invited = await onInvite(inviteEmail.trim(), inviteName.trim(), inviteRole);
    if (invited) { setInviteEmail(""); setInviteName(""); }
  }

  return <section className="card settings-section" id="settings-people" aria-labelledby="workspace-members-title">
    <div className="card-header">
      <div><h2 id="workspace-members-title">People & access</h2><p>Who can open this workspace and what they can change.</p></div>
      <span className="section-count">{members.length} {members.length === 1 ? "person" : "people"}</span>
    </div>
    <ul className="member-list">
      {members.map((member) => {
        const isSelf = account?.user_id === member.user_id;
        const canEdit = canManage && !isSelf && (isOwner || member.role === "member" || member.role === "viewer");
        const ownerProtected = member.role === "owner" && ownerCount <= 1;
        const busy = memberBusy === member.user_id;
        return <li key={member.user_id} className="member-row">
          <span className="avatar" aria-hidden="true">{initials(member.display_name)}</span>
          <span className="member-identity">
            <span className="member-name"><b>{member.display_name}</b>{isSelf ? <span className="tag">You</span> : null}</span>
            <small>{member.email ?? "Local password sign-in"}</small>
          </span>
          <span className="member-role">
            {canEdit && !ownerProtected
              ? <UiSelect id={`role-${member.user_id}`} label={`Role for ${member.display_name}`} hideLabel size="sm" value={member.role} disabled={busy} onChange={(role) => onChangeRole(member.user_id, role as WorkspaceMember["role"])} options={isOwner ? ownerRoleOptions : adminRoleOptions} />
              : <span className="member-role-text">{roleLabel[member.role]}</span>}
          </span>
          <span className="member-status"><Badge tone={statusTone(member.status)} dot>{statusLabel(member.status)}</Badge></span>
          <span className="member-actions">
            {canEdit && !ownerProtected ? pendingRemovalId === member.user_id
              ? <>
                <button className="button danger sm" type="button" disabled={busy} onClick={() => onRemove(member.user_id)}>Confirm remove</button>
                <button className="button ghost sm" type="button" onClick={onCancelRemoval}>Cancel</button>
              </>
              : <>
                {member.role !== "owner" ? <button className="button ghost sm" type="button" disabled={busy} onClick={() => onReset(member.user_id)}>Reset access</button> : null}
                <button className="text-button destructive" type="button" onClick={() => onRequestRemoval(member.user_id)}>Remove</button>
              </> : null}
          </span>
        </li>;
      })}
    </ul>
    {canManage ? <div className="invite-panel">
      <form className="form-stack" onSubmit={(event) => void submitInvite(event)}>
        <div className="invite-heading"><span className="settings-icon" aria-hidden="true"><UserPlus /></span><div><h3>Invite a teammate</h3><p className="field-hint">They get a temporary password and must change it on first sign-in.</p></div></div>
        <div className="field-row three">
          <div className="field"><label htmlFor="invite-name">Name</label><input id="invite-name" value={inviteName} onChange={(event) => setInviteName(event.target.value)} minLength={2} maxLength={120} required /></div>
          <div className="field"><label htmlFor="invite-email">Work email</label><input id="invite-email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} required /></div>
          <UiSelect id="invite-role" label="Role" value={inviteRole} onChange={(role) => setInviteRole(role as InviteRole)} options={isOwner ? ownerInviteOptions : adminInviteOptions} />
        </div>
        <div className="button-group end"><button className="button primary" disabled={inviting}>{inviting ? "Sending invitation…" : "Send invitation"}</button></div>
      </form>
      {inviteResult ? <InviteOutcome result={inviteResult} onCopyFailed={onCopyFailed} /> : null}
    </div> : null}
  </section>;
}

function InviteOutcome({ result, onCopyFailed }: { result: InviteResult; onCopyFailed(): void }) {
  const [copied, setCopied] = useState(false);
  const showPassword = Boolean(result.temporary_password) && !result.email_sent;
  function copy() {
    void navigator.clipboard.writeText(result.temporary_password ?? "").then(() => setCopied(true)).catch(onCopyFailed);
  }
  return <Alert tone={result.email_sent ? "success" : "warning"} title={result.email_sent ? "Invitation email sent" : "Teammate added — email not sent"}>
    <p>{result.note}</p>
    <dl className="invite-secret">
      <div><dt>Account</dt><dd><code>{result.account.email}</code></dd></div>
      {showPassword ? <div><dt>Temporary password · shown once</dt><dd><code>{result.temporary_password}</code><button type="button" className="button secondary sm" onClick={copy} aria-label="Copy temporary password">{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? "Copied" : "Copy"}</button></dd></div> : null}
    </dl>
  </Alert>;
}
