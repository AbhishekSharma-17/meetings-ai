"use client";

import { useEffect, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { RetentionPolicy } from "@/lib/types";
import { UiSelect } from "./ui-select";
import { Badge, LoadingRow } from "./ui/feedback";

const retentionOptions = [
  { value: "forever", label: "Keep until manually deleted" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "730", label: "2 years" },
];
const retentionValue = (days: number | null) => String(days ?? "forever");
const retentionDays = (value: string) => value === "forever" ? null : Number(value);

export function RetentionCard({ onSaved }: { onSaved(message: string): void }) {
  const [retention, setRetention] = useState<RetentionPolicy | null>(null);
  const [retentionBusy, setRetentionBusy] = useState(false);
  const [retentionError, setRetentionError] = useState<string | null>(null);

  useEffect(() => {
    void meetingsService.getRetentionPolicy().then(setRetention).catch(() => {
      setRetentionError("Could not load data retention policy.");
    });
  }, []);

  async function saveRetention() {
    if (!retention) return;
    setRetentionBusy(true); setRetentionError(null);
    try {
      setRetention(await meetingsService.saveRetentionPolicy(retention));
      onSaved(retention.enabled ? "Automatic retention policy saved. Eligible older data can be deleted by the background worker." : "Automatic retention is off. Records remain until manually deleted.");
    } catch (cause) {
      setRetentionError(cause instanceof Error ? cause.message : "Could not save retention policy.");
    } finally { setRetentionBusy(false); }
  }

  const nothingSelected = retention ? retention.enabled && !retention.meeting_days && !retention.chat_days && !retention.audit_days : false;
  return <section className="card settings-section" id="settings-retention" aria-labelledby="workspace-retention-title">
    <div className="card-header"><div><h2 id="workspace-retention-title">Data retention</h2><p>Automatic deletion is off until you turn it on.</p></div></div>
    <div className="card-body form-stack">
      {retentionError ? <p className="form-error" role="alert">{retentionError}</p> : null}
      {retention ? <>
        <div className="field-row three">
          <UiSelect id="retention-meetings" label="Meetings, transcripts & MOMs" value={retentionValue(retention.meeting_days)} onChange={(value) => setRetention({ ...retention, meeting_days: retentionDays(value) })} options={retentionOptions} />
          <UiSelect id="retention-chats" label="Saved AI chats" value={retentionValue(retention.chat_days)} onChange={(value) => setRetention({ ...retention, chat_days: retentionDays(value) })} options={retentionOptions} />
          <UiSelect id="retention-audit" label="Workspace audit events" value={retentionValue(retention.audit_days)} onChange={(value) => setRetention({ ...retention, audit_days: retentionDays(value) })} options={retentionOptions} />
        </div>
        <label className="choice-card">
          <input type="checkbox" checked={retention.enabled} onChange={(event) => setRetention({ ...retention, enabled: event.target.checked })} />
          <span><b>Enable scheduled deletion for the selected periods</b><small>Deleting a meeting also asks Vexa to erase its transcript and recordings. Sent emails and external backups can’t be recalled.</small></span>
        </label>
      </> : !retentionError ? <LoadingRow>Loading retention policy…</LoadingRow> : null}
    </div>
    {retention ? <div className="card-footer">
      {nothingSelected ? <span className="field-hint retention-footer-hint">Choose at least one period to enable deletion.</span> : null}
      <button type="button" className="button primary" disabled={retentionBusy || nothingSelected} onClick={() => void saveRetention()}>{retentionBusy ? "Saving…" : "Save retention policy"}</button>
    </div> : null}
  </section>;
}
