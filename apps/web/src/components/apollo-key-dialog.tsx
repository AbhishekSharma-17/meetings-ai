"use client";

import { FormEvent, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { KeyRound, X } from "lucide-react";
import { apolloService } from "@/lib/meetings-service";
import type { ApolloIntegration } from "@/lib/types";

/** Connect or replace the workspace's Apollo key. The key is sent once, tested, and never shown again. */
export function ApolloKeyDialog({ mode, onClose, onSaved }: {
  mode: "connect" | "replace" | null;
  onClose(): void;
  onSaved(view: ApolloIntegration): void;
}) {
  return <Dialog.Root open={mode !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog provider-key-dialog">
        {mode ? <ApolloKeyForm key={mode} mode={mode} onClose={onClose} onSaved={onSaved} /> : null}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function ApolloKeyForm({ mode, onClose, onSaved }: { mode: "connect" | "replace"; onClose(): void; onSaved(view: ApolloIntegration): void }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const view = await apolloService.connect(secret.trim());
      setSecret("");
      onSaved(view);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Apollo could not be connected.");
    } finally { setBusy(false); }
  }

  return <form onSubmit={submit}>
    <Dialog.Close className="close-button" aria-label="Close"><X /></Dialog.Close>
    <Dialog.Title>{mode === "connect" ? "Connect Apollo" : "Replace Apollo key"}</Dialog.Title>
    <Dialog.Description className="dialog-intro">
      Meetings AI registers the key with Composio as this workspace’s Apollo connection, checks it with a free credit-usage call and never shows it again. Members’ briefings use it without seeing it.
    </Dialog.Description>
    <div className="dialog-body form-stack">
      <div className="field">
        <label htmlFor="apollo-key">Apollo API key</label>
        <div className="input-with-icon"><KeyRound aria-hidden="true" /><input id="apollo-key" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Paste the key" autoComplete="new-password" spellCheck={false} required minLength={8} /></div>
        <p className="field-hint">In Apollo: Settings → Integrations → API → API keys. A master key works for every lookup; restricted keys may skip some.</p>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
    <div className="dialog-footer">
      <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
      <button type="submit" className="button primary" disabled={busy || secret.trim().length < 8}>{busy ? "Checking with Apollo…" : mode === "connect" ? "Connect" : "Replace key"}</button>
    </div>
  </form>;
}
