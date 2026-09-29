"use client";

import { FormEvent, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { KeyRound, X } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { BillingKeyType, CredentialTestResult, VaultCredential } from "@/lib/types";
import { Alert } from "./ui/feedback";
import { ProviderBrandIcon } from "./provider-brand-icons";
import { billingKeyInfo, billingKeyTypes } from "./provider-balance";
import { testTone } from "./provider-key-dialog";

/** Owner-only: save an optional billing key (read-only balance access) and check it straight away. */
export function BillingKeyDialog({ open, configured, onClose, onSaved }: {
  open: boolean;
  /** Billing key types already saved; they can still be added again but are marked. */
  configured: ReadonlySet<BillingKeyType>;
  onClose(): void;
  onSaved(credential: VaultCredential, message: string): void;
}) {
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog provider-key-dialog billing-key-dialog">
        {open ? <BillingKeyForm configured={configured} onClose={onClose} onSaved={onSaved} /> : null}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function BillingKeyForm({ configured, onClose, onSaved }: { configured: ReadonlySet<BillingKeyType>; onClose(): void; onSaved(credential: VaultCredential, message: string): void }) {
  const [type, setType] = useState<BillingKeyType>(billingKeyTypes.find((item) => !configured.has(item)) ?? "openrouter_management");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ credential: VaultCredential; test: CredentialTestResult } | null>(null);
  const info = billingKeyInfo[type];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const saved = await meetingsService.createCredential({ label: (label.trim() || info.title).slice(0, 100), provider_type: type, secret, base_url: null });
      setSecret("");
      let test: CredentialTestResult;
      try { test = await meetingsService.testCredential(saved.id); }
      catch (cause) { test = { credential_id: saved.id, status: "unverified", network_call_performed: false, message: cause instanceof Error ? cause.message : "The key could not be checked." }; }
      setResult({ credential: saved, test });
      onSaved(saved, `${saved.label} saved. It only reads balances and spend.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The billing key could not be saved.");
    } finally { setBusy(false); }
  }

  if (result) return <>
    <Dialog.Close className="close-button" aria-label="Close"><X /></Dialog.Close>
    <Dialog.Title>Billing key saved</Dialog.Title>
    <div className="dialog-body provider-key-saved">
      <div className="provider-key-summary">
        <ProviderBrandIcon brand={billingKeyInfo[result.credential.provider_type as BillingKeyType]?.provider ?? null} />
        <span><b>{result.credential.label}</b><small>{billingKeyInfo[result.credential.provider_type as BillingKeyType]?.title} · {result.credential.hint}</small></span>
      </div>
      <Alert tone={testTone[result.test.status]} title={result.test.status === "valid" ? "Key works" : result.test.status === "invalid" ? "Key rejected" : "Not verified"}>{result.test.message}</Alert>
    </div>
    <div className="dialog-footer"><button type="button" className="button primary" onClick={onClose}>Done</button></div>
  </>;

  return <form onSubmit={submit}>
    <Dialog.Close className="close-button" aria-label="Close"><X /></Dialog.Close>
    <Dialog.Title>Add billing key</Dialog.Title>
    <Dialog.Description className="dialog-intro">Optional. A billing key only reads balances and spend. It is never used for AI calls or research, and it is checked with the provider when you save it.</Dialog.Description>
    <div className="dialog-body form-stack">
      <fieldset className="billing-key-choices">
        <legend className="field-label">Which key</legend>
        {billingKeyTypes.map((item) => <label key={item} className="choice-card">
          <input type="radio" name="billing-key-type" value={item} checked={type === item} onChange={() => setType(item)} />
          <ProviderBrandIcon brand={billingKeyInfo[item].provider} size="sm" />
          <span><b>{billingKeyInfo[item].title}{configured.has(item) ? <em className="billing-key-added"> · already added</em> : null}</b><small>{billingKeyInfo[item].unlocks}</small></span>
        </label>)}
      </fieldset>
      <div className="field">
        <label htmlFor="billing-key-label">Key name <span className="optional">optional</span></label>
        <input id="billing-key-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={info.title} maxLength={100} autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor="billing-key-secret">{info.title}</label>
        <div className="input-with-icon"><KeyRound aria-hidden="true" /><input id="billing-key-secret" type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={info.placeholder} autoComplete="new-password" spellCheck={false} required /></div>
        <p className="field-hint">Create it in {info.where}. Stored encrypted and write-only.</p>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
    <div className="dialog-footer">
      <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
      <button type="submit" className="button primary" disabled={busy}>{busy ? "Saving and checking…" : "Save and check"}</button>
    </div>
  </form>;
}
