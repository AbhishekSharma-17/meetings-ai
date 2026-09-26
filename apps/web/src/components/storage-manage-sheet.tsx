"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Inbox, Trash2, X } from "lucide-react";
import { storageService } from "@/lib/meetings-service";
import type { StorageCategory, StorageCategoryKey, StorageItem, StoragePurgeResult } from "@/lib/types";
import { EmptyState, LoadingRow } from "./ui/feedback";
import { SwitchField } from "./ui/switch";
import { FilterInput, matchesQuery, NoMatches, ScrollPanel } from "./scroll-panel";
import { storageCopy } from "./storage-copy";
import { StorageConfirmDialog, type PurgePlan } from "./storage-confirm-dialog";
import { PurgeResultAlert } from "./storage-result";
import { formatBytes, formatDate } from "./usage-labels";

export type ManagedCategory = StorageCategory & { key: StorageCategoryKey };

const ageMeaning: Record<StorageCategoryKey, string> = {
  meetings: "created", meeting_preps: "last prepared", documents: "uploaded", search_index: "indexed",
  knowledge_bases: "created", ai_chats: "last used", calendar_cache: "that ended", logs: "recorded",
};

/** Side sheet for one storage category: pick items, delete by age, or clear everything. */
export function StorageManageSheet({ category, onClose, onPurged, result }: {
  category: ManagedCategory | null; onClose(): void; onPurged(result: StoragePurgeResult): void; result: StoragePurgeResult | null;
}) {
  return <Dialog.Root open={category !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="sheet obs-sheet storage-sheet">
        {category ? <ManageBody key={category.key} category={category} onPurged={onPurged}
          result={result?.category === category.key ? result : null} /> : null}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function ManageBody({ category, onPurged, result }: { category: ManagedCategory; onPurged(result: StoragePurgeResult): void; result: StoragePurgeResult | null }) {
  const copy = storageCopy[category.key];
  const [items, setItems] = useState<StorageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [days, setDays] = useState("90");
  const [reindex, setReindex] = useState(true);
  const [plan, setPlan] = useState<PurgePlan | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setItems(await storageService.items(category.key)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not list items."); }
    finally { setLoading(false); }
  }, [category.key]);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const visible = useMemo(() => items.filter((item) => matchesQuery(query, [item.label, item.detail])), [items, query]);
  const chosen = items.filter((item) => selected.has(item.id));
  const allVisibleSelected = visible.length > 0 && visible.every((item) => selected.has(item.id));
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleVisible = () => setSelected((current) => {
    const next = new Set(current);
    for (const item of visible) { if (allVisibleSelected) next.delete(item.id); else next.add(item.id); }
    return next;
  });
  const dayCount = Number(days);
  const validDays = Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= 3650;

  const done = (next: StoragePurgeResult) => { setPlan(null); setSelected(new Set()); onPurged(next); void load(); };

  return <>
    <div className="obs-sheet-header">
      <Dialog.Close className="close-button" aria-label="Close"><X /></Dialog.Close>
      <p className="eyebrow">Data &amp; storage</p>
      <Dialog.Title className="dialog-title">Manage {category.label.toLowerCase()}</Dialog.Title>
      <Dialog.Description className="dialog-intro">{formatBytes(category.bytes)} · {category.rows.toLocaleString()} records. {category.description}</Dialog.Description>
    </div>
    <div className="obs-sheet-body">
      {result ? <PurgeResultAlert result={result} /> : null}
      <section aria-labelledby="storage-items-title" className="storage-items">
        <div className="storage-items-head">
          <h3 id="storage-items-title">Choose what to delete</h3>
          {items.length ? <label className="check-label storage-select-all"><input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} />Select all{query ? " shown" : ""}</label> : null}
        </div>
        {items.length > 6 ? <FilterInput id="storage-item-search" label={`Search ${copy.nouns}`} value={query} onChange={setQuery} placeholder={`Search ${copy.nouns}`} /> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {loading && !items.length ? <LoadingRow>Loading {copy.nouns}…</LoadingRow>
          : !items.length ? <EmptyState plain icon={<Inbox />} title={`No ${copy.nouns} stored`}>There is nothing to delete here.</EmptyState>
          : !visible.length ? <NoMatches query={query} noun={copy.nouns} onClear={() => setQuery("")} />
          : <ScrollPanel label={`${category.label} items`} size="sm" className="storage-item-scroll"><ul className="storage-item-list">
            {visible.map((item) => <li key={item.id}>
              <label className="storage-item">
                <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
                <span className="storage-item-text"><b>{item.label}</b><small>{[item.detail, item.created_at ? formatDate(item.created_at) : null].filter(Boolean).join(" · ")}</small></span>
                <span className="storage-item-size">{formatBytes(item.bytes)}</span>
              </label>
            </li>)}
          </ul></ScrollPanel>}
        <div className="cluster storage-items-actions">
          <button type="button" className="button danger-outline sm" disabled={!chosen.length}
            onClick={() => setPlan({ mode: "selected", ids: chosen.map((item) => item.id), bytes: chosen.reduce((sum, item) => sum + item.bytes, 0), labels: chosen.map((item) => item.label) })}>
            <Trash2 aria-hidden="true" />Delete selected{chosen.length ? ` (${chosen.length})` : ""}
          </button>
          {chosen.length ? <span className="section-count">{formatBytes(chosen.reduce((sum, item) => sum + item.bytes, 0))} selected</span> : null}
        </div>
      </section>
      <section aria-labelledby="storage-age-title" className="inset-panel storage-age">
        <h3 id="storage-age-title">Delete by age</h3>
        <div className="storage-age-row">
          <label htmlFor="storage-age-days">Older than</label>
          <input id="storage-age-days" type="number" min={1} max={3650} inputMode="numeric" value={days} onChange={(event) => setDays(event.target.value)} aria-describedby="storage-age-hint" />
          <span>days</span>
          <button type="button" className="button secondary sm" disabled={!validDays} onClick={() => setPlan({ mode: "older", days: dayCount })}>Delete older</button>
        </div>
        <p id="storage-age-hint" className="field-hint text-tertiary">Removes {copy.nouns} {ageMeaning[category.key]} more than {validDays ? dayCount : "N"} days ago.</p>
      </section>
      {copy.rebuild ? <SwitchField id="storage-rebuild" label="Rebuild after clearing" description="Queue re-indexing of the affected knowledge bases and documents." checked={reindex} onChange={setReindex} /> : null}
      <div className="storage-danger-zone">
        <div><b>Delete everything</b><small>Removes all {copy.nouns} in this workspace ({formatBytes(category.bytes)}).</small></div>
        <button type="button" className="text-button destructive" onClick={() => setPlan({ mode: "all", bytes: category.bytes })}>Delete everything in this category</button>
      </div>
    </div>
    <StorageConfirmDialog category={category} plan={plan} reindex={Boolean(copy.rebuild) && reindex} onCancel={() => setPlan(null)} onDone={done} />
  </>;
}
