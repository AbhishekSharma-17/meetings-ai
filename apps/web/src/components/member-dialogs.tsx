"use client";

import { FormEvent, useId, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { InviteResult, WorkspaceMember } from "@/lib/types";
import { AccessLinkResult } from "./access-link-result";
import { UiSelect } from "./ui-select";
import { ROLE_HINT, type MemberRole, type Option } from "./member-access";

function SmallDialog({ title, description, busy, onClose, children }: {
  title: string; description: ReactNode; busy: boolean; onClose(): void; children: ReactNode;
}) {
  const titleId = useId();
  return <Dialog.Root open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog people-dialog" aria-labelledby={titleId}>
        <Dialog.Close className="close-button" aria-label="Close" disabled={busy}><X aria-hidden="true" /></Dialog.Close>
        <Dialog.Title id={titleId}>{title}</Dialog.Title>
        <Dialog.Description className="dialog-intro">{description}</Dialog.Description>
        {children}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function MemberRoleDialog({ member, options, busy, error, onSave, onClose }: {
  member: WorkspaceMember; options: Option[]; busy: boolean; error: string | null;
  onSave(role: MemberRole): void; onClose(): void;
}) {
  const [role, setRole] = useState<MemberRole>(member.role);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (role === member.role) { onClose(); return; }
    onSave(role);
  }
  return <SmallDialog title={`Change role for ${member.display_name}`} description={member.email ?? "Local account"} busy={busy} onClose={onClose}>
    <form className="dialog-body" onSubmit={submit}>
      <div className="field">
        <UiSelect id={`role-${member.user_id}`} label="Role" value={role} disabled={busy} onChange={(value) => setRole(value as MemberRole)} options={options} />
        <p className="field-hint">{ROLE_HINT} The change applies to their open sessions right away.</p>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="dialog-footer">
        <button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="button primary" disabled={busy}>{busy ? "Saving…" : "Save role"}</button>
      </div>
    </form>
  </SmallDialog>;
}

export function ConfirmMemberDialog({ title, description, confirmLabel, busyLabel, busy, error, onConfirm, onClose }: {
  title: string; description: ReactNode; confirmLabel: string; busyLabel: string; busy: boolean; error: string | null;
  onConfirm(): void; onClose(): void;
}) {
  return <SmallDialog title={title} description={description} busy={busy} onClose={onClose}>
    <div className="dialog-body">
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="dialog-footer">
        <button type="button" className="button secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="button danger" onClick={onConfirm} disabled={busy}>{busy ? busyLabel : confirmLabel}</button>
      </div>
    </div>
  </SmallDialog>;
}

export function AccessResultDialog({ title, sentTitle, result, onClose }: {
  title: string; sentTitle: string; result: InviteResult; onClose(): void;
}) {
  return <SmallDialog title={title} description={`${result.account.display_name} · ${result.account.email ?? ""}`} busy={false} onClose={onClose}>
    <div className="dialog-body">
      <AccessLinkResult result={result} sentTitle={sentTitle} />
      <div className="dialog-footer"><button type="button" className="button primary" onClick={onClose}>Done</button></div>
    </div>
  </SmallDialog>;
}
