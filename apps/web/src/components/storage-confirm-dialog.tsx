"use client";

import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { TriangleAlert, X } from "lucide-react";
import { storageService } from "@/lib/meetings-service";
import type { StorageCategory, StorageCategoryKey, StoragePurgeRequest, StoragePurgeResult } from "@/lib/types";
import { storageCopy } from "./storage-copy";
import { formatBytes } from "./usage-labels";

export type PurgePlan =
  | { mode: "selected"; ids: string[]; bytes: number; labels: string[] }
  | { mode: "older"; days: number }
  | { mode: "all"; bytes: number };

const CONFIRMATION = "DELETE";
const LABELS_SHOWN = 5;

function scopeText(category: StorageCategory, plan: PurgePlan, nouns: string): string {
  if (plan.mode === "selected") return `${plan.ids.length} selected ${plan.ids.length === 1 ? "item" : "items"} (${formatBytes(plan.bytes)})`;
  if (plan.mode === "older") return `${nouns} older than ${plan.days} days`;
  return `everything in ${category.label} (${formatBytes(plan.bytes)})`;
}

/** Typed confirmation for a permanent purge; shows exactly what goes and what can't be undone. */
export function StorageConfirmDialog({ category, plan, reindex, onCancel, onDone }: {
  category: StorageCategory & { key: StorageCategoryKey }; plan: PurgePlan | null; reindex: boolean;
  onCancel(): void; onDone(result: StoragePurgeResult): void;
}) {
  const copy = storageCopy[category.key];
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (busy) return; setTyped(""); setError(null); onCancel(); };

  const submit = async () => {
    if (!plan || typed !== CONFIRMATION) return;
    const request: StoragePurgeRequest = { category: category.key, confirm: CONFIRMATION, reindex };
    if (plan.mode === "selected") request.ids = plan.ids;
    if (plan.mode === "older") request.older_than_days = plan.days;
    setBusy(true); setError(null);
    try {
      const result = await storageService.purge(request);
      setTyped("");
      onDone(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The deletion failed. Nothing was confirmed as removed."); }
    finally { setBusy(false); }
  };

  return <Dialog.Root open={plan !== null} onOpenChange={(open) => { if (!open) close(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog storage-confirm" role="alertdialog">
        {plan ? <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <Dialog.Close className="close-button" aria-label="Cancel" disabled={busy}><X /></Dialog.Close>
          <Dialog.Title className="dialog-title">Permanently delete {scopeText(category, plan, copy.nouns)}?</Dialog.Title>
          <Dialog.Description className="dialog-intro">This can&apos;t be undone.</Dialog.Description>
          <div className="dialog-body">
            {plan.mode === "selected" ? <ul className="storage-confirm-items" aria-label="Selected items">
              {plan.labels.slice(0, LABELS_SHOWN).map((label, index) => <li key={`${label}-${index}`}>{label}</li>)}
              {plan.labels.length > LABELS_SHOWN ? <li className="text-tertiary">and {plan.labels.length - LABELS_SHOWN} more</li> : null}
            </ul> : null}
            <div>
              <h3 className="storage-confirm-heading">What is removed</h3>
              <ul className="storage-confirm-list">{copy.removes.map((line) => <li key={line}>{line}</li>)}</ul>
            </div>
            <div className="alert" data-tone="warning" role="note">
              <TriangleAlert aria-hidden="true" />
              <ul className="storage-confirm-list">{copy.notes.map((line) => <li key={line}>{line}</li>)}
                {copy.rebuild ? <li>{reindex ? "AI search data will be prepared again automatically." : "AI search data will not be prepared again until you choose Update search."}</li> : null}</ul>
            </div>
            <div className="field">
              <label htmlFor="storage-confirm-input">Type {CONFIRMATION} to confirm</label>
              <input id="storage-confirm-input" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="characters" disabled={busy} />
            </div>
            {error ? <p className="form-error" role="alert">{error}</p> : null}
          </div>
          <div className="dialog-footer">
            <button type="button" className="button secondary" onClick={close} disabled={busy}>Cancel</button>
            <button type="submit" className="button danger" disabled={typed !== CONFIRMATION || busy}>{busy ? "Deleting…" : "Delete permanently"}</button>
          </div>
        </form> : null}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
