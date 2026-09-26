"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { AuditEvent, RetentionPolicy, UsageSummary, WorkspaceMember, WorkspaceOperations } from "@/lib/types";
import { UiSelect } from "./ui-select";
import { EmptyState, LoadingRow } from "./ui/feedback";

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

const money = (value: number, digits: number) => `$${value.toFixed(digits)}`;

export function OperationsCard() {
  const [operations, setOperations] = useState<WorkspaceOperations | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [operationsError, setOperationsError] = useState<string | null>(null);

  useEffect(() => {
    void meetingsService.getWorkspaceOperations().then(setOperations).catch(() => {
      setOperationsError("Could not load operations status.");
    });
    void meetingsService.getWorkspaceUsage().then(setUsage).catch(() => setOperationsError("Could not load usage records."));
  }, []);

  async function refreshOperations() {
    setOperationsError(null);
    try { const [nextOperations, nextUsage] = await Promise.all([meetingsService.getWorkspaceOperations(), meetingsService.getWorkspaceUsage()]); setOperations(nextOperations); setUsage(nextUsage); }
    catch { setOperationsError("Could not load operations status."); }
  }

  const workload = operations ? [["People", operations.people], ["Meetings captured", operations.meetings_captured], ["Completed meetings", operations.completed_meetings], ["Saved AI chats", operations.saved_chats], ["Active captures", operations.active_captures]] as const : [];
  const review = operations ? [["Capture failures", operations.failed_captures], ["MOM jobs with errors", operations.failed_mom_jobs], ["Knowledge jobs pending", operations.pending_index_jobs], ["Knowledge jobs failed", operations.failed_index_jobs], ["Email delivery failures", operations.failed_email_deliveries]] as const : [];

  return <section className="card settings-section" id="settings-operations" aria-labelledby="workspace-operations-title">
    <div className="card-header">
      <div><h2 id="workspace-operations-title">Operations</h2><p>Live workload, jobs needing review and AI usage in this workspace.</p></div>
      <button type="button" className="button ghost sm" onClick={() => void refreshOperations()}><RefreshCw aria-hidden="true" /> Refresh</button>
    </div>
    <div className="card-body stack-lg">
      {operationsError ? <p className="form-error" role="alert">{operationsError}</p> : null}
      {operations ? <div className="ops-groups">
        <MiniStats title="Workload" items={workload} />
        <MiniStats title="Needs review" items={review} alertOnPositive={(label) => !label.includes("pending")} />
      </div> : !operationsError ? <LoadingRow>Loading operations status…</LoadingRow> : null}
      {usage ? <div className="stack">
        <h3>AI model usage</h3>
        <MiniStats items={[["Model requests", usage.total_requests], ["Input tokens", usage.input_tokens.toLocaleString()], ["Output tokens", usage.output_tokens.toLocaleString()], ["Estimated model spend", money(usage.estimated_usd, 4)]]} />
        <p className="field-hint">{usage.unpriced_requests} request{usage.unpriced_requests === 1 ? "" : "s"} have no verified price. Spend is an estimate from published model rates, not a provider invoice; Vexa transcription is not reported here yet.</p>
        {usage.by_meeting.length ? <div className="table-wrap"><table className="data-table" aria-label="AI usage by meeting">
          <thead><tr><th>Meeting record</th><th className="num">Requests</th><th className="num">Tokens in / out</th><th className="num">Estimated cost</th></tr></thead>
          <tbody>{usage.by_meeting.map((item) => <tr key={item.meeting_id}><td><span className="cell-stack"><code>{item.meeting_id.slice(0, 8)}…</code><small>{item.unpriced_requests ? `${item.unpriced_requests} unpriced request(s)` : "All calls priced"}</small></span></td><td className="num">{item.requests}</td><td className="num">{item.input_tokens.toLocaleString()} / {item.output_tokens.toLocaleString()}</td><td className="num">{money(item.estimated_usd, 5)}</td></tr>)}</tbody>
        </table></div> : null}
        <h3>Recent model calls</h3>
        {usage.recent.length ? <div className="table-wrap"><table className="data-table" aria-label="Recent AI usage">
          <thead><tr><th>Operation</th><th>Model</th><th className="num">Tokens in / out</th><th className="num">Estimated cost</th></tr></thead>
          <tbody>{usage.recent.map((event) => <tr key={event.id}>
            <td><span className="cell-stack"><span>{event.purpose.replaceAll("_", " ")}</span><small>{new Date(event.created_at).toLocaleString()}{event.meeting_id ? ` · meeting ${event.meeting_id.slice(0, 8)}` : event.knowledge_base_id ? ` · knowledge ${event.knowledge_base_id.slice(0, 8)}` : ""}</small></span></td>
            <td><span className="cell-stack"><span>{event.model}</span><small>{event.provider}</small></span></td>
            <td className="num">{event.input_tokens ?? "—"} / {event.output_tokens ?? "—"}</td>
            <td className="num">{event.estimated_usd === null ? "Unpriced" : money(event.estimated_usd, 5)}</td>
          </tr>)}</tbody>
        </table></div> : <p className="field-hint">No model calls recorded yet. New MOM and Ask AI requests appear here.</p>}
      </div> : null}
    </div>
    <div className="card-footer"><span className="field-hint">Workspace-scoped counts. This does not replace infrastructure logs or alerts.</span></div>
  </section>;
}

function MiniStats({ title, items, alertOnPositive }: { title?: string; items: ReadonlyArray<readonly [string, number | string]>; alertOnPositive?(label: string): boolean }) {
  return <div className="mini-stats-group">
    {title ? <p className="mini-stats-title">{title}</p> : null}
    <dl className="mini-stats">{items.map(([label, value]) => <div key={label} data-alert={alertOnPositive?.(label) && typeof value === "number" && value > 0 ? "true" : undefined}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </div>;
}

function actionLabel(action: string): string {
  if (action === "auth.login.succeeded") return "Signed in";
  const words = action.replaceAll(/[._]/g, " ");
  return `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}

export function AuditCard({ members }: { members: WorkspaceMember[] }) {
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void meetingsService.listWorkspaceAudit().then(setAuditEvents).catch(() => {
      setAuditError("Could not load recent activity.");
    }).finally(() => setLoaded(true));
  }, []);

  async function refreshAudit() {
    setAuditError(null);
    try { setAuditEvents(await meetingsService.listWorkspaceAudit()); }
    catch { setAuditError("Could not load recent activity."); }
  }

  return <section className="card settings-section" id="settings-activity" aria-labelledby="workspace-audit-title">
    <div className="card-header">
      <div><h2 id="workspace-audit-title">Recent activity</h2><p>Workspace changes and sign-ins. Request bodies and credentials are never shown.</p></div>
      <button type="button" className="button ghost sm" onClick={() => void refreshAudit()}><RefreshCw aria-hidden="true" /> Refresh</button>
    </div>
    {auditError ? <div className="card-body"><p className="form-error" role="alert">{auditError}</p></div> : null}
    {auditEvents.length ? <div className="audit-table"><table className="data-table">
      <thead><tr><th>Event</th><th>By</th><th>Record</th><th className="num">When</th></tr></thead>
      <tbody>{auditEvents.map((event) => <tr key={event.id}>
        <td title={event.action}>{actionLabel(event.action)}</td>
        <td>{members.find((member) => member.user_id === event.actor_user_id)?.display_name ?? "Workspace account"}</td>
        <td>{event.resource_id ? <code>{event.resource_id.slice(0, 8)}…</code> : <span className="text-tertiary">—</span>}</td>
        <td className="num"><time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time></td>
      </tr>)}</tbody>
    </table></div> : loaded && !auditError ? <div className="card-body"><EmptyState plain title="No workspace activity recorded yet" /></div> : !auditError ? <LoadingRow>Loading recent activity…</LoadingRow> : null}
  </section>;
}
