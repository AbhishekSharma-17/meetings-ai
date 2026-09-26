"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Activity, CircleAlert, Coins, Info, RefreshCw, Video } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import { initials, meetingStatusLabel } from "@/lib/meeting-status";
import type { Meeting, UsageSummary, WorkspaceCalendarConnection, WorkspaceMember, WorkspaceOperations } from "@/lib/types";
import { PageHeader } from "./ui/page-header";
import { Badge, type Tone } from "./ui/feedback";

const money = (value: number) => `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
const label = (value: string) => value.replaceAll("_", " ");
const capitalize = (value: string) => value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
const CHART_COLORS = 8;
type UsageRow = UsageSummary["by_purpose"][number];

export function ObservabilityScreen() {
  const [operations, setOperations] = useState<WorkspaceOperations | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [people, setPeople] = useState<WorkspaceMember[]>([]);
  const [accounts, setAccounts] = useState<WorkspaceCalendarConnection[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [nextOperations, nextUsage] = await Promise.all([meetingsService.getWorkspaceOperations(), meetingsService.getWorkspaceUsage()]);
      setOperations(nextOperations); setUsage(nextUsage);
      const [nextPeople, nextAccounts, nextMeetings] = await Promise.allSettled([meetingsService.listWorkspaceMembers(), meetingsService.listWorkspaceCalendarConnections(), meetingsService.listMeetings()]);
      if (nextPeople.status === "fulfilled") setPeople(nextPeople.value);
      if (nextAccounts.status === "fulfilled") { setAccounts(nextAccounts.value); setAccountsError(null); }
      else setAccountsError("Connected accounts could not be loaded. Check the Composio connection and refresh.");
      if (nextMeetings.status === "fulfilled") setMeetings(nextMeetings.value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load observability data."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { queueMicrotask(() => { void refresh(); }); }, [refresh]);

  const failures = operations ? operations.failed_captures + operations.failed_mom_jobs + operations.failed_index_jobs + operations.failed_email_deliveries : 0;
  const dash = "—";
  return <section className="page wide observability-page" aria-labelledby="observability-title">
    <PageHeader titleId="observability-title" title="Observability" description="Captures, processing jobs, model calls and estimated AI spend across this workspace."
      actions={<button className="button secondary" type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw aria-hidden="true" className={loading ? "obs-spin" : undefined} /> {loading ? "Refreshing…" : "Refresh"}</button>} />
    {error ? <p className="form-error obs-error" role="alert">{error}</p> : null}
    <div className="stat-grid obs-stats" aria-label="Workspace summary">
      <Kpi icon={<Video />} title="Meetings captured" value={operations?.meetings_captured ?? dash} hint={`${operations?.active_captures ?? dash} live · ${operations?.completed_meetings ?? dash} completed`} />
      <Kpi icon={<Activity />} title="AI model requests" value={usage?.total_requests ?? dash} hint={`${usage?.input_tokens.toLocaleString() ?? dash} in · ${usage?.output_tokens.toLocaleString() ?? dash} out tokens`} />
      <Kpi icon={<Coins />} title="Estimated model spend" value={usage ? money(usage.estimated_usd) : dash} hint={`${usage?.unpriced_requests ?? dash} unpriced calls excluded`} />
      <Kpi icon={<CircleAlert />} title="Failures needing review" value={operations ? failures : dash} hint="Capture, MOM, index and email" tone={failures > 0 ? "danger" : undefined} />
    </div>
    <div className="alert obs-note" data-tone="neutral" role="note">
      <Info aria-hidden="true" />
      <p>Estimates use provider list prices for MOM generation, Ask AI and embeddings — not an invoice. Unpriced calls, transcription (Vexa), email, database and hosting are <b>not included</b>, so a zero estimate does not mean zero operating cost.</p>
    </div>
    <div className="obs-grid">
      <UsageTable title="Cost by process" description="All recorded calls, grouped by operation." firstColumn="Process" rows={usage?.by_purpose ?? []} format={label} empty="No model usage recorded yet." />
      <UsageTable title="Cost by provider" description="Usage across connected model providers." firstColumn="Provider" rows={usage?.by_provider ?? []} format={(value) => value} empty="No provider usage recorded yet." />
    </div>
    <HealthCard operations={operations} />
    <div className="obs-grid">
      <section className="card" aria-labelledby="obs-people-title">
        <div className="card-header"><div><h2 id="obs-people-title">People in this workspace</h2><p>Member roles and access status.</p></div><span className="section-count">{people.length}</span></div>
        <div className="obs-table"><table className="data-table">
          <thead><tr><th>Person</th><th>Role</th><th>Status</th></tr></thead>
          <tbody>{people.length ? people.map((person) => <tr key={person.user_id}>
            <td><span className="obs-person"><span className="avatar sm" aria-hidden="true">{initials(person.display_name)}</span><span className="obs-cell"><span>{person.display_name}</span><small>{person.email || "No email"}</small></span></span></td>
            <td>{capitalize(person.role)}</td>
            <td><Badge tone={person.status === "active" ? "success" : person.status === "invited" ? "info" : "neutral"} dot>{capitalize(person.status)}</Badge></td>
          </tr>) : <EmptyRow span={3}>No members available.</EmptyRow>}</tbody>
        </table></div>
      </section>
      <section className="card" aria-labelledby="obs-accounts-title">
        <div className="card-header"><div><h2 id="obs-accounts-title">Connected meeting accounts</h2><p>Calendar and meeting-source connections for members.</p></div></div>
        {accountsError ? <div className="card-body obs-card-alert"><p className="form-error" role="alert">{accountsError}</p></div> : null}
        <div className="obs-table"><table className="data-table">
          <thead><tr><th>Account</th><th>Source</th><th>Status</th></tr></thead>
          <tbody>{accounts.length ? accounts.map((account) => <tr key={account.id}>
            <td><span className="obs-cell"><span>{account.user_name}</span><small>{account.user_email || account.label}</small></span></td>
            <td><span className="obs-cell"><span>{capitalize(label(account.provider))}</span><small>{account.label}</small></span></td>
            <td><Badge tone={account.status.toLowerCase() === "active" ? "success" : "warning"} dot>{capitalize(account.status.toLowerCase())}</Badge></td>
          </tr>) : <EmptyRow span={3}>{accountsError ? "Connections unavailable." : "No connected accounts found."}</EmptyRow>}</tbody>
        </table></div>
      </section>
    </div>
    <section className="card obs-section" aria-labelledby="obs-meetings-title">
      <div className="card-header"><div><h2 id="obs-meetings-title">Meeting activity and AI use</h2><p>Every meeting record with its recorded model spend. Unpriced and transcription costs are excluded.</p></div><span className="section-count">{meetings.length}</span></div>
      <div className="obs-table"><table className="data-table">
        <thead><tr><th>Meeting</th><th>Capture</th><th className="num">AI calls</th><th className="num">Tokens in / out</th><th className="num">Estimated cost</th></tr></thead>
        <tbody>{meetings.length ? meetings.map((meeting) => { const entry = usage?.by_meeting.find((item) => item.meeting_id === meeting.id); return <tr key={meeting.id}>
          <td><span className="obs-cell"><span>{meeting.title}</span><small>{meeting.platform} · {meeting.startsAt}</small></span></td>
          <td><span className={`status ${meeting.status}`}>{meetingStatusLabel[meeting.status] ?? label(meeting.status)}</span></td>
          <td className="num"><span className="obs-cell"><span>{entry?.requests ?? 0}</span>{entry?.unpriced_requests ? <small>{entry.unpriced_requests} unpriced</small> : null}</span></td>
          <td className="num">{entry ? `${entry.input_tokens.toLocaleString()} / ${entry.output_tokens.toLocaleString()}` : <span className="text-tertiary">—</span>}</td>
          <td className="num">{entry ? money(entry.estimated_usd) : <span className="text-tertiary">—</span>}</td>
        </tr>; }) : <EmptyRow span={5}>No meeting records found.</EmptyRow>}</tbody>
      </table></div>
    </section>
    <section className="card obs-section" aria-labelledby="obs-calls-title">
      <div className="card-header"><div><h2 id="obs-calls-title">Recent model calls</h2><p>Provider-reported tokens and per-call estimates for the latest 100 calls. Totals above cover all calls.</p></div></div>
      <div className="obs-table"><table className="data-table">
        <thead><tr><th>Process</th><th>Provider / model</th><th className="num">Tokens in / out</th><th className="num">Estimate</th><th className="num">When</th></tr></thead>
        <tbody>{usage?.recent.length ? usage.recent.map((event) => <tr key={event.id}>
          <td><span className="obs-cell"><span>{label(event.purpose)}</span><small>{event.meeting_id ? `Meeting ${event.meeting_id.slice(0, 8)}` : event.knowledge_base_id ? `Knowledge ${event.knowledge_base_id.slice(0, 8)}` : "Workspace"}</small></span></td>
          <td><span className="obs-cell"><span>{event.provider}</span><small>{event.model}</small></span></td>
          <td className="num">{event.input_tokens ?? "—"} / {event.output_tokens ?? "—"}</td>
          <td className="num">{event.estimated_usd === null ? <Badge tone="warning">Unpriced</Badge> : money(event.estimated_usd)}</td>
          <td className="num obs-when"><time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time></td>
        </tr>) : <EmptyRow span={5}>No calls recorded yet.</EmptyRow>}</tbody>
      </table></div>
    </section>
  </section>;
}

function Kpi({ icon, title, value, hint, tone }: { icon: ReactNode; title: string; value: number | string; hint: string; tone?: Tone }) {
  return <article className="stat" data-tone={tone}><span className="stat-label">{icon}{title}</span><strong className="stat-value">{value}</strong><span className="stat-hint">{hint}</span></article>;
}

function EmptyRow({ span, children }: { span: number; children: ReactNode }) {
  return <tr className="obs-empty-row"><td colSpan={span}>{children}</td></tr>;
}

function UsageTable({ title, description, firstColumn, rows, format, empty }: { title: string; description: string; firstColumn: string; rows: UsageRow[]; format(value: string): string; empty: string }) {
  const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0);
  return <section className="card" aria-labelledby={`obs-${firstColumn.toLowerCase()}-title`}>
    <div className="card-header"><div><h2 id={`obs-${firstColumn.toLowerCase()}-title`}>{title}</h2><p>{description}</p></div></div>
    <div className="obs-table"><table className="data-table">
      <thead><tr><th>{firstColumn}</th><th className="num">Calls</th><th className="num">Tokens in / out</th><th className="num">Estimate</th></tr></thead>
      <tbody>{rows.length ? rows.map((row, index) => {
        const share = totalRequests ? Math.round((row.requests / totalRequests) * 100) : 0;
        return <tr key={row.name}>
          <td><span className="obs-cell"><span>{format(row.name)}</span><span className="obs-share" title={`${share}% of calls`}><span className="obs-bar" aria-hidden="true"><i style={{ width: `${share}%`, background: `var(--chart-${(index % CHART_COLORS) + 1})` }} /></span><small>{share}% of calls{row.unpriced_requests ? ` · ${row.unpriced_requests} unpriced` : ""}</small></span></span></td>
          <td className="num">{row.requests}</td>
          <td className="num">{row.input_tokens.toLocaleString()} / {row.output_tokens.toLocaleString()}</td>
          <td className="num">{money(row.estimated_usd)}</td>
        </tr>;
      }) : <EmptyRow span={4}>{empty}</EmptyRow>}</tbody>
    </table></div>
  </section>;
}

function HealthCard({ operations }: { operations: WorkspaceOperations | null }) {
  const items: Array<{ name: string; value: number | undefined; kind: "failure" | "active" }> = [
    { name: "Active captures", value: operations?.active_captures, kind: "active" },
    { name: "Capture failures", value: operations?.failed_captures, kind: "failure" },
    { name: "MOM job failures", value: operations?.failed_mom_jobs, kind: "failure" },
    { name: "Index jobs pending", value: operations?.pending_index_jobs, kind: "active" },
    { name: "Index job failures", value: operations?.failed_index_jobs, kind: "failure" },
    { name: "Email delivery failures", value: operations?.failed_email_deliveries, kind: "failure" },
  ];
  return <section className="card obs-section" aria-labelledby="obs-health-title">
    <div className="card-header"><div><h2 id="obs-health-title">Pipeline status</h2><p>Current jobs and delivery failures across the workspace.</p></div></div>
    <ul className="obs-health">{items.map((item) => {
      const [tone, text] = healthState(item.value, item.kind);
      return <li key={item.name}><span className="obs-health-name">{item.name}</span><strong className="obs-health-value">{item.value ?? "—"}</strong><Badge tone={tone} dot>{text}</Badge></li>;
    })}</ul>
  </section>;
}

function healthState(value: number | undefined, kind: "failure" | "active"): [Tone, string] {
  if (value === undefined) return ["neutral", "Unknown"];
  if (kind === "failure") return value > 0 ? ["danger", "Needs review"] : ["success", "Healthy"];
  return value > 0 ? ["info", "In progress"] : ["neutral", "Idle"];
}
