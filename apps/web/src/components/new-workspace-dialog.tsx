"use client";

import { FormEvent, useId, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";

const NAME_MAX = 120;

/** Create a workspace; on success the app reloads into it, so the dialog only handles errors. */
export function NewWorkspaceDialog({ open, onClose, onCreate }: {
  open: boolean;
  onClose(): void;
  onCreate(name: string): Promise<void>;
}) {
  const titleId = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const clean = name.trim().replace(/\s+/g, " ");
    if (clean.length < 2) { setError("Give the workspace a name (at least two characters)."); return; }
    setBusy(true); setError(null);
    try { await onCreate(clean); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the workspace.");
      setBusy(false);
    }
  }

  const close = () => { if (!busy) { setName(""); setError(null); onClose(); } };
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) close(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog people-dialog" aria-labelledby={titleId}>
        <Dialog.Close className="close-button" aria-label="Close" disabled={busy}><X aria-hidden="true" /></Dialog.Close>
        <Dialog.Title id={titleId}>New workspace</Dialog.Title>
        <Dialog.Description className="dialog-intro">A separate space with its own meetings, people, providers and knowledge. You’ll be its owner and switch to it right away.</Dialog.Description>
        <form className="dialog-body" onSubmit={(event) => void submit(event)} noValidate>
          <div className="field">
            <label htmlFor="new-workspace-name">Workspace name</label>
            <input id="new-workspace-name" value={name} maxLength={NAME_MAX} autoComplete="off" autoFocus disabled={busy} placeholder="e.g. Novaala" onChange={(event) => setName(event.target.value)} />
          </div>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="dialog-footer">
            <button type="button" className="button secondary" onClick={close} disabled={busy}>Cancel</button>
            <button type="submit" className="button primary" disabled={busy}>{busy ? "Creating…" : "Create workspace"}</button>
          </div>
        </form>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
