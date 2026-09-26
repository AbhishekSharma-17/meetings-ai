"use client";

import { useCallback, useEffect, useState } from "react";
import { Database, HardDrive, Video } from "lucide-react";
import { storageService } from "@/lib/meetings-service";
import type { CaptureStorage, StorageCategory, StorageCategoryKey, StoragePurgeResult, StorageSummary } from "@/lib/types";
import { Alert, Badge, LoadingRow, type Tone } from "./ui/feedback";
import { StorageManageSheet } from "./storage-manage-sheet";
import { PurgeResultAlert } from "./storage-result";
import { formatBytes, formatWhen } from "./usage-labels";

const CHART_COLORS = 8;

const captureState: Record<CaptureStorage["status"], [Tone, string]> = {
  not_requested: ["neutral", "Not measured yet"],
  measured: ["success", "Measured"],
  partial: ["warning", "Partly measured"],
  unavailable: ["danger", "Capture service unavailable"],
  not_configured: ["neutral", "Not available"],
};

export function StoragePanel({ refreshKey }: { refreshKey: number }) {
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [capture, setCapture] = useState<CaptureStorage | null>(null);
  const [loading, setLoading] = useState(true);
  const [measuring, setMeasuring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState<StorageCategory | null>(null);
  const [result, setResult] = useState<StoragePurgeResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setSummary(await storageService.summary()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not measure workspace storage."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load, refreshKey]);

  const measure = async () => {
    setMeasuring(true); setError(null);
    try { const next = await storageService.summary(true); setSummary(next); setCapture(next.capture); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not reach the capture service."); }
    finally { setMeasuring(false); }
  };

  const purged = (next: StoragePurgeResult) => { setResult(next); void load(); };

  if (!summary) {
    return error ? <Alert tone="danger" title="Storage could not be measured">{error}</Alert>
      : <div className="card"><div className="card-body"><LoadingRow>Measuring workspace storage…</LoadingRow></div></div>;
  }
  const categories = [...summary.categories].sort((a, b) => b.bytes - a.bytes);
  const shownCapture = capture ?? summary.capture;
  const [captureTone, captureText] = captureState[shownCapture.status];
  return <div className="storage-panel">
    {error ? <p className="form-error obs-error" role="alert">{error}</p> : null}
    {result ? <PurgeResultAlert result={result} onDismiss={() => setResult(null)} /> : null}
    <section className="card storage-overview" aria-labelledby="storage-total-title">
      <div className="card-header">
        <div><h2 id="storage-total-title">Data stored for this workspace</h2><p>Measured {formatWhen(summary.measured_at)} · {summary.total_rows.toLocaleString()} records</p></div>
        <strong className="storage-total" aria-label={`Total ${formatBytes(summary.total_bytes)}`}>{formatBytes(summary.total_bytes)}</strong>
      </div>
      <div className="card-body stack">
        <div className="storage-stack" role="img" aria-label="Share of storage by category">
          {categories.filter((item) => item.bytes > 0).map((item, index) => <i key={item.key} title={`${item.label}: ${formatBytes(item.bytes)}`}
            style={{ flexGrow: item.bytes, background: `var(--chart-${(index % CHART_COLORS) + 1})` }} />)}
        </div>
        <div className="storage-context">
          <div className="inset-panel">
            <span className="storage-context-label"><HardDrive aria-hidden="true" />Whole database</span>
            <b>{formatBytes(summary.database.size_bytes)}</b>
            <small>{summary.database.note}</small>
          </div>
          <div className="inset-panel">
            <span className="storage-context-label"><Video aria-hidden="true" />Recordings in the capture service <Badge tone={captureTone} dot>{captureText}</Badge></span>
            <b>{shownCapture.recording_bytes === null ? "—" : formatBytes(shownCapture.recording_bytes)}</b>
            <small>{shownCapture.status === "not_requested" ? "Recordings live outside this database; measuring asks the capture service." : `${shownCapture.recordings} recordings across ${shownCapture.meetings_checked} captures checked. Vexa's own transcript copies are not measured.`}</small>
            <button type="button" className="button secondary sm" onClick={() => void measure()} disabled={measuring}>{measuring ? "Measuring…" : shownCapture.status === "not_requested" ? "Measure recordings" : "Measure again"}</button>
          </div>
        </div>
        <p className="field-hint text-tertiary">{summary.method}</p>
      </div>
    </section>
    <ul className="storage-grid" aria-label="Storage by category">
      {categories.map((item, index) => <li key={item.key} className="card storage-category">
        <div className="storage-category-head">
          <span className="storage-swatch" aria-hidden="true" style={{ background: `var(--chart-${(index % CHART_COLORS) + 1})` }} />
          <h3>{item.label}</h3>
          <strong>{formatBytes(item.bytes)}</strong>
        </div>
        <p>{item.description}</p>
        <div className="storage-share" aria-hidden="true"><i style={{ width: `${summary.total_bytes ? Math.max((item.bytes / summary.total_bytes) * 100, item.bytes ? 1 : 0) : 0}%`, background: `var(--chart-${(index % CHART_COLORS) + 1})` }} /></div>
        <div className="storage-category-foot">
          <small>{item.rows.toLocaleString()} records · {summary.total_bytes ? Math.round((item.bytes / summary.total_bytes) * 100) : 0}%</small>
          {item.purgeable && item.key !== "workspace"
            ? <button type="button" className="button ghost sm" onClick={() => setManaging(item)} aria-label={`Manage ${item.label}`}><Database aria-hidden="true" />Manage</button>
            : <small className="text-tertiary">Not deletable here</small>}
        </div>
      </li>)}
    </ul>
    <StorageManageSheet category={managing && managing.key !== "workspace" ? { ...managing, key: managing.key as StorageCategoryKey } : null}
      onClose={() => setManaging(null)} onPurged={purged} result={result} />
  </div>;
}
