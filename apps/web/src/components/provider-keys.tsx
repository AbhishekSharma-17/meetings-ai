"use client";

import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { KeyRound, MoreHorizontal, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { CredentialInUseError, meetingsService } from "@/lib/meetings-service";
import type { CredentialTestResult, VaultCredential } from "@/lib/types";
import { Alert, Badge, EmptyState, LoadingRow } from "./ui/feedback";
import type { SettingsNotice } from "./settings-toast";
import { KeyDialog, testTone, type KeyDialogMode } from "./provider-key-dialog";
import { ProviderBrandIcon } from "./provider-brand-icons";
import { lastUsedText, usageText, vaultProviderLabel } from "./provider-profile-info";

const TEST_BADGE = { valid: "Key works", invalid: "Rejected", unverified: "Not verified" } as const;

/** Saved workspace API keys. Owners manage them; admins see the list read-only. */
export function ApiKeysCard({ credentials, loading, error, canManage, onRefresh, onNotice }: {
  credentials: VaultCredential[];
  loading: boolean;
  error: string | null;
  canManage: boolean;
  onRefresh(): Promise<void>;
  onNotice(notice: SettingsNotice): void;
}) {
  const [dialog, setDialog] = useState<KeyDialogMode | null>(null);
  const addButton = canManage ? <button type="button" className="button secondary sm" onClick={() => setDialog({ kind: "create" })}><Plus aria-hidden="true" /> Add key</button> : null;

  return <section className="card provider-keys" aria-labelledby="api-keys-title">
    <div className="card-header provider-group-header">
      <span className="settings-icon" aria-hidden="true"><KeyRound /></span>
      <div><h2 id="api-keys-title">API keys</h2><p>Save a key once, then pick it in any profile or workspace setting.</p></div>
      {addButton}
    </div>
    {loading ? <div className="provider-keys-state"><LoadingRow>Loading saved keys…</LoadingRow></div>
      : error ? <div className="provider-keys-state"><Alert tone="warning" title="Saved keys are unavailable" actions={<button type="button" className="button secondary sm" onClick={() => void onRefresh()}>Retry</button>}>{error}</Alert></div>
        : credentials.length === 0 ? <EmptyState plain className="provider-keys-empty" icon={<ShieldCheck />} title="No saved keys yet">{canManage ? "Add an OpenAI, OpenRouter or Exa key to reuse it everywhere." : "The workspace owner can add reusable keys here."}</EmptyState>
          : <ul className="provider-key-list">{credentials.map((credential) => <KeyRow key={credential.id} credential={credential} canManage={canManage} onEdit={setDialog} onRefresh={onRefresh} onNotice={onNotice} />)}</ul>}
    {!canManage && !loading && !error ? <p className="provider-keys-note field-hint">Only the workspace owner can add, replace or delete keys.</p> : null}
    <KeyDialog mode={dialog} onClose={() => setDialog(null)} onSaved={(_saved, message) => { void onRefresh(); onNotice({ tone: "success", text: message }); }} />
  </section>;
}

function KeyRow({ credential, canManage, onEdit, onRefresh, onNotice }: {
  credential: VaultCredential;
  canManage: boolean;
  onEdit(mode: KeyDialogMode): void;
  onRefresh(): Promise<void>;
  onNotice(notice: SettingsNotice): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [usedBy, setUsedBy] = useState<string[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<CredentialTestResult | null>(null);
  const host = credential.provider_type === "openai_compatible" && credential.base_url ? hostOf(credential.base_url) : null;

  async function runTest() {
    setTesting(true);
    try {
      const result = await meetingsService.testCredential(credential.id);
      setTest(result);
      onNotice({ tone: testTone[result.status] === "neutral" ? "info" : testTone[result.status], text: `${credential.label}: ${result.message}` });
      void onRefresh();
    } catch (cause) {
      onNotice({ tone: "danger", text: cause instanceof Error ? cause.message : "The key could not be tested." });
    } finally { setTesting(false); }
  }

  async function remove() {
    setDeleting(true);
    try {
      await meetingsService.deleteCredential(credential.id);
      onNotice({ tone: "success", text: `${credential.label} deleted.` });
      await onRefresh();
    } catch (cause) {
      if (cause instanceof CredentialInUseError) setUsedBy(cause.usedBy);
      else onNotice({ tone: "danger", text: cause instanceof Error ? cause.message : "The key could not be deleted." });
      setDeleting(false);
    }
  }

  const cancel = () => { setConfirming(false); setUsedBy(null); };

  return <li className="provider-key">
    <div className="provider-key-row">
      <ProviderBrandIcon provider={credential.provider_type} />
      <span className="provider-key-main">
        <b>{credential.label}</b>
        <small>{vaultProviderLabel[credential.provider_type]}{host ? ` · ${host}` : ""}</small>
      </span>
      <code className="provider-key-hint" aria-label={`Key ending ${credential.hint.replace(/•/g, "")}`}>{credential.hint}</code>
      <span className="provider-key-meta">
        <span>{usageText(credential)}</span>
        <span>{lastUsedText(credential.last_used_at)}</span>
      </span>
      {test ? <Badge tone={testTone[test.status]} dot className="provider-key-test">{TEST_BADGE[test.status]}</Badge> : null}
      {canManage ? <Menu.Root>
        <Menu.Trigger className="icon-button" aria-label={`Actions for ${credential.label}`}><MoreHorizontal aria-hidden="true" /></Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={4} align="end">
            <Menu.Popup className="popover">
              <Menu.Item className="menu-item" disabled={testing} onClick={() => void runTest()}><ShieldCheck /> {testing ? "Testing…" : "Test key"}</Menu.Item>
              <Menu.Item className="menu-item" onClick={() => onEdit({ kind: "rename", credential })}><Pencil /> Rename</Menu.Item>
              <Menu.Item className="menu-item" onClick={() => onEdit({ kind: "rotate", credential })}><RefreshCw /> Replace key</Menu.Item>
              <Menu.Separator className="menu-separator" />
              <Menu.Item className="menu-item destructive" onClick={() => setConfirming(true)}><Trash2 /> Delete</Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root> : null}
    </div>
    {confirming ? usedBy ? <Alert tone="warning" className="provider-key-confirm" title={`${credential.label} is still in use`} actions={<button type="button" className="button secondary sm" onClick={cancel}>Close</button>}>
      <p>Switch these to another key first:</p>
      <ul className="provider-key-usages">{usedBy.map((item) => <li key={item}>{item}</li>)}</ul>
    </Alert> : <Alert tone="danger" className="provider-key-confirm" title={`Delete ${credential.label}?`} actions={<>
      <button type="button" className="button danger sm" disabled={deleting} onClick={() => void remove()}>{deleting ? "Deleting…" : "Delete key"}</button>
      <button type="button" className="button secondary sm" onClick={cancel}>Cancel</button>
    </>}>The encrypted key is removed from this workspace.</Alert> : null}
  </li>;
}

function hostOf(value: string): string {
  try { return new URL(value).host; } catch { return value; }
}
