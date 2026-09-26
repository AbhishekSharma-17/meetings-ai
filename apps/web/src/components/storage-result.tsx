"use client";

import type { StoragePurgeResult } from "@/lib/types";
import { Alert } from "./ui/feedback";
import { storageCopy } from "./storage-copy";
import { countLabel, formatBytes } from "./usage-labels";

/** Outcome of one purge: what was removed, what was skipped and why, and the space freed. */
export function PurgeResultAlert({ result, onDismiss }: { result: StoragePurgeResult; onDismiss?(): void }) {
  const counts = Object.entries(result.deleted).filter(([, count]) => count > 0);
  const kept = Object.entries(result.kept ?? {}).filter(([, count]) => count > 0);
  const nothing = !counts.length && !result.skipped.length;
  return <Alert tone={result.skipped.length ? "warning" : "success"} className="storage-result"
    title={nothing ? `Nothing to delete in ${storageCopy[result.category].nouns}` : `Deleted from ${storageCopy[result.category].nouns}`}
    actions={onDismiss ? <button type="button" className="button ghost sm" onClick={onDismiss}>Dismiss</button> : undefined}>
    {counts.length ? <p>{counts.map(([key, count]) => countLabel(key, count)).join(" · ")}. About {formatBytes(result.bytes_freed_estimate)} freed.</p> : null}
    {result.reindex_queued ? <p>Rebuild queued for {result.reindex_queued} {result.reindex_queued === 1 ? "item" : "items"}.</p> : null}
    {kept.length ? <p>Kept {kept.map(([key, count]) => `${count} ${key === "events_with_preps" ? "events that have a meeting prep" : key.replaceAll("_", " ")}`).join(", ")}.</p> : null}
    {result.remaining ? <p>{result.remaining} more remain; run the deletion again to continue.</p> : null}
    {result.skipped.length ? <ul className="storage-skipped">{result.skipped.map((item) => <li key={item.id}><b>Skipped</b> {item.reason}</li>)}</ul> : null}
  </Alert>;
}
