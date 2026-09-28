"use client";

import { FormEvent, useId, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { InviteResult } from "@/lib/types";
import { AccessLinkResult } from "./access-link-result";
import { UiSelect } from "./ui-select";
import { inviteRoleOptions, LINK_MINUTES, ROLE_HINT, type InviteRole } from "./member-access";

const NAME_MAX = 120;
const EMAIL_MAX = 320;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Invite one person: name, work email and role, then show what was sent (or the one-time link). */
export function AddPeopleDialog({ open, isOwner, workspaceName, onClose, onInvite }: {
  open: boolean;
  isOwner: boolean;
  workspaceName: string;
  onClose(): void;
  /** Resolves with the API result; rejects with a user-facing Error. */
  onInvite(email: string, name: string, role: InviteRole): Promise<InviteResult>;
}) {
  const titleId = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);

  function reset() { setName(""); setEmail(""); setRole("member"); setError(null); setResult(null); }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = name.trim().replace(/\s+/g, " ");
    const cleanEmail = email.trim().toLowerCase();
    if (cleanName.length < 2) { setError("Enter their name (at least two characters)."); return; }
    if (!EMAIL_PATTERN.test(cleanEmail)) { setError("Enter a valid work email address."); return; }
    setBusy(true); setError(null);
    try { setResult(await onInvite(cleanEmail, cleanName, role)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not send the invitation."); }
    finally { setBusy(false); }
  }

  const close = () => { if (!busy) { reset(); onClose(); } };
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) close(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog people-dialog" aria-labelledby={titleId}>
        <Dialog.Close className="close-button" aria-label="Close" disabled={busy}><X aria-hidden="true" /></Dialog.Close>
        <Dialog.Title id={titleId}>{result ? "Invitation created" : "Add people"}</Dialog.Title>
        <Dialog.Description className="dialog-intro">
          {result ? `${result.account.display_name} · ${result.account.email ?? ""}` : `They’ll get an email to join ${workspaceName} and choose their own password. The link works once and expires in ${LINK_MINUTES} minutes.`}
        </Dialog.Description>
        {result ? <div className="dialog-body">
          <AccessLinkResult result={result} sentTitle="Invitation sent" />
          <div className="dialog-footer">
            <button type="button" className="button secondary" onClick={reset}>Add another</button>
            <button type="button" className="button primary" onClick={close}>Done</button>
          </div>
        </div> : <form className="dialog-body" onSubmit={(event) => void submit(event)} noValidate>
          <div className="field">
            <label htmlFor="invite-name">Name</label>
            <input id="invite-name" value={name} maxLength={NAME_MAX} autoComplete="off" autoFocus disabled={busy} placeholder="e.g. Priya Shah" onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="invite-email">Work email</label>
            <input id="invite-email" type="email" value={email} maxLength={EMAIL_MAX} autoComplete="off" disabled={busy} placeholder="name@company.com" onChange={(event) => setEmail(event.target.value)} />
          </div>
          <div className="field">
            <UiSelect id="invite-role" label="Role" value={role} disabled={busy} onChange={(value) => setRole(value as InviteRole)} options={inviteRoleOptions(isOwner)} />
            <p className="field-hint">{ROLE_HINT}</p>
          </div>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="dialog-footer">
            <button type="button" className="button secondary" onClick={close} disabled={busy}>Cancel</button>
            <button type="submit" className="button primary" disabled={busy}>{busy ? "Sending…" : "Send invitation"}</button>
          </div>
        </form>}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
