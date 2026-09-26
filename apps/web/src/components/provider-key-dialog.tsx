"use client";

import { FormEvent, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { KeyRound, X } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { CredentialTestResult, VaultCredential, VaultProviderType } from "@/lib/types";
import { UiSelect } from "./ui-select";
import { Alert } from "./ui/feedback";
import { vaultProviderLabel, vaultProviderOptions } from "./provider-profile-info";
import { ProviderBrandIcon } from "./provider-brand-icons";

export type KeyDialogMode = { kind: "create" } | { kind: "rename"; credential: VaultCredential } | { kind: "rotate"; credential: VaultCredential };

const TITLES = { create: "Add API key", rename: "Rename key", rotate: "Replace key" } as const;

export const testTone = { valid: "success", invalid: "danger", unverified: "neutral" } as const;

/** Create, rename or rotate a saved key. Secrets are sent once and never shown again. */
export function KeyDialog({ mode, onClose, onSaved }: {
  mode: KeyDialogMode | null;
  onClose(): void;
  onSaved(credential: VaultCredential, message: string): void;
}) {
  return <Dialog.Root open={mode !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog provider-key-dialog">
        {mode ? <KeyDialogBody key={mode.kind === "create" ? "create" : `${mode.kind}-${mode.credential.id}`} mode={mode} onClose={onClose} onSaved={onSaved} /> : null}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function KeyDialogBody({ mode, onClose, onSaved }: { mode: KeyDialogMode; onClose(): void; onSaved(credential: VaultCredential, message: string): void }) {
  const existing = mode.kind === "create" ? null : mode.credential;
  const [providerType, setProviderType] = useState<VaultProviderType>("openrouter");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<VaultCredential | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<CredentialTestResult | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      if (mode.kind === "create") {
        const saved = await meetingsService.createCredential({ label: label.trim(), provider_type: providerType, secret, base_url: providerType === "openai_compatible" ? baseUrl.trim() : null });
        setSecret(""); setCreated(saved);
        onSaved(saved, `${saved.label} saved. The key is encrypted and write-only.`);
      } else if (mode.kind === "rename") {
        const saved = await meetingsService.updateCredential(mode.credential.id, { label: label.trim() });
        onSaved(saved, `Renamed to ${saved.label}.`); onClose();
      } else {
        const saved = await meetingsService.updateCredential(mode.credential.id, { secret });
        setSecret("");
        onSaved(saved, `${saved.label} now uses the new key ${saved.hint}. Linked profiles use it right away.`); onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The key could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function runTest(credential: VaultCredential) {
    setTesting(true); setTest(null);
    try { setTest(await meetingsService.testCredential(credential.id)); }
    catch (cause) { setTest({ credential_id: credential.id, status: "unverified", network_call_performed: false, message: cause instanceof Error ? cause.message : "The key could not be tested." }); }
    finally { setTesting(false); }
  }

  if (created) return <>
    <Dialog.Close className="close-button" aria-label="Close"><X /></Dialog.Close>
    <Dialog.Title>Key saved</Dialog.Title>
    <div className="dialog-body provider-key-saved">
      <div className="provider-key-summary">
        <ProviderBrandIcon provider={created.provider_type} />
        <span><b>{created.label}</b><small>{vaultProviderLabel[created.provider_type]} · {created.hint}</small></span>
      </div>
      {test ? <Alert tone={testTone[test.status]} title={test.status === "valid" ? "Key works" : test.status === "invalid" ? "Key rejected" : "Not verified"}>{test.message}</Alert>
        : <p className="field-hint">Check it with the provider now, or later from the key list.{created.provider_type === "exa" ? " A test runs one small, billed search." : ""}</p>}
    </div>
    <div className="dialog-footer">
      <button type="button" className="button secondary" disabled={testing} onClick={() => void runTest(created)}>{testing ? "Testing…" : "Test key"}</button>
      <button type="button" className="button primary" onClick={onClose}>Done</button>
    </div>
  </>;

  return <form onSubmit={submit}>
    <Dialog.Close className="close-button" aria-label="Close"><X /></Dialog.Close>
    <Dialog.Title>{TITLES[mode.kind]}</Dialog.Title>
    <Dialog.Description className="dialog-intro">
      {mode.kind === "create" ? "Stored encrypted on the server. Anyone with profile access can use it, but nobody can read it back."
        : mode.kind === "rename" ? `${vaultProviderLabel[mode.credential.provider_type]} · ${mode.credential.hint}`
          : `Profiles linked to ${mode.credential.label} switch to the new key as soon as you save.`}
    </Dialog.Description>
    <div className="dialog-body form-stack">
      {mode.kind === "create" ? <UiSelect id="key-provider" label="Provider" value={providerType} onChange={(value) => setProviderType(value as VaultProviderType)} options={vaultProviderOptions} /> : null}
      {mode.kind !== "rotate" ? <div className="field">
        <label htmlFor="key-label">Key name</label>
        <input id="key-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. OpenRouter team" maxLength={100} required autoComplete="off" />
      </div> : null}
      {mode.kind === "create" && providerType === "openai_compatible" ? <div className="field">
        <label htmlFor="key-base-url">Base URL</label>
        <input id="key-base-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://models.example.com/v1" required />
        <p className="field-hint">This key is only ever sent to this endpoint.</p>
      </div> : null}
      {mode.kind !== "rename" ? <div className="field">
        <label htmlFor="key-secret">{mode.kind === "rotate" ? "New API key" : "API key"}</label>
        <div className="input-with-icon"><KeyRound aria-hidden="true" /><input id="key-secret" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Paste the key" autoComplete="new-password" spellCheck={false} required /></div>
      </div> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
    <div className="dialog-footer">
      <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
      <button type="submit" className="button primary" disabled={busy}>{busy ? "Saving…" : mode.kind === "create" ? "Save key" : mode.kind === "rename" ? "Rename" : "Replace key"}</button>
    </div>
  </form>;
}
