"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, CircleAlert, Coins, DatabaseZap, RefreshCw, Video } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { Meeting, UsageSummary, WorkspaceCalendarConnection, WorkspaceMember, WorkspaceOperations } from "@/lib/types";

const money = (value: number) => `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
const label = (value: string) => value.replaceAll("_", " ");

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
  return <section className="page observability-page" aria-labelledby="observability-title">
    <header className="observability-heading"><div><p className="eyebrow">WORKSPACE HEALTH</p><h1 id="observability-title">Observability</h1><p className="intro">A clear view of captures, processing jobs, model calls, and estimated AI spend.</p></div><button className="button secondary" type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} /> {loading ? "Refreshing…" : "Refresh"}</button></header>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="observability-metrics">
      <article><Video /><span>Meetings captured</span><strong>{operations?.meetings_captured ?? "—"}</strong><small>{operations?.active_captures ?? "—"} live · {operations?.completed_meetings ?? "—"} completed</small></article>
      <article><Activity /><span>AI model requests</span><strong>{usage?.total_requests ?? "—"}</strong><small>{usage?.input_tokens.toLocaleString() ?? "—"} input · {usage?.output_tokens.toLocaleString() ?? "—"} output tokens</small></article>
      <article><Coins /><span>Estimated model spend</span><strong>{usage ? money(usage.estimated_usd) : "—"}</strong><small>{usage?.unpriced_requests ?? "—"} unpriced calls excluded</small></article>
      <article><CircleAlert /><span>Failures needing review</span><strong>{operations ? failures : "—"}</strong><small>Capture, MOM, index and email</small></article>
    </div>
    <div className="observability-note" role="note"><DatabaseZap /><p><b>What this total includes:</b> model calls recorded by Meetings AI for MOM generation, Ask AI and embeddings, priced from known provider list rates. It is an estimate, not an invoice. Unpriced calls, transcription infrastructure/Vexa, Resend, database, and hosting are <b>not included</b>. A zero estimate does not mean zero operating cost.</p></div>
    <div className="observability-columns">
      <section className="observability-card"><h2>Cost by process</h2><p>All recorded calls in this workspace, grouped by operation.</p><div className="observability-table-wrap"><table><thead><tr><th>Process</th><th>Calls</th><th>Tokens in / out</th><th>Estimate</th></tr></thead><tbody>{usage?.by_purpose.length ? usage.by_purpose.map((row) => <tr key={row.name}><td>{label(row.name)}{row.unpriced_requests ? <small>{row.unpriced_requests} unpriced</small> : null}</td><td>{row.requests}</td><td>{row.input_tokens.toLocaleString()} / {row.output_tokens.toLocaleString()}</td><td>{money(row.estimated_usd)}</td></tr>) : <tr><td colSpan={4}>No model usage recorded yet.</td></tr>}</tbody></table></div></section>
      <section className="observability-card"><h2>Cost by provider</h2><p>Compare usage across connected model providers.</p><div className="observability-table-wrap"><table><thead><tr><th>Provider</th><th>Calls</th><th>Tokens in / out</th><th>Estimate</th></tr></thead><tbody>{usage?.by_provider.length ? usage.by_provider.map((row) => <tr key={row.name}><td>{row.name}{row.unpriced_requests ? <small>{row.unpriced_requests} unpriced</small> : null}</td><td>{row.requests}</td><td>{row.input_tokens.toLocaleString()} / {row.output_tokens.toLocaleString()}</td><td>{money(row.estimated_usd)}</td></tr>) : <tr><td colSpan={4}>No provider usage recorded yet.</td></tr>}</tbody></table></div></section>
    </div>
    <section className="observability-card"><h2>Pipeline status</h2><p>Current jobs and delivery failures. Counts are workspace-wide.</p><div className="observability-pipeline"><span>Active captures <b>{operations?.active_captures ?? "—"}</b></span><span>Capture failures <b>{operations?.failed_captures ?? "—"}</b></span><span>MOM failures <b>{operations?.failed_mom_jobs ?? "—"}</b></span><span>Index pending <b>{operations?.pending_index_jobs ?? "—"}</b></span><span>Index failures <b>{operations?.failed_index_jobs ?? "—"}</b></span><span>Email failures <b>{operations?.failed_email_deliveries ?? "—"}</b></span></div></section>
    <div className="observability-columns"><section className="observability-card"><h2>People in this workspace</h2><p>Owners and admins can review all member roles and access status.</p><div className="observability-table-wrap"><table><thead><tr><th>Person</th><th>Role</th><th>Status</th></tr></thead><tbody>{people.length ? people.map((person) => <tr key={person.user_id}><td>{person.display_name}<small>{person.email || "No email"}</small></td><td>{person.role}</td><td>{person.status}</td></tr>) : <tr><td colSpan={3}>No members available.</td></tr>}</tbody></table></div></section><section className="observability-card"><h2>Connected meeting accounts</h2><p>Calendar and meeting-source connections for workspace members.</p>{accountsError ? <p className="form-error" role="alert">{accountsError}</p> : null}<div className="observability-table-wrap"><table><thead><tr><th>Account</th><th>Source</th><th>Status</th></tr></thead><tbody>{accounts.length ? accounts.map((account) => <tr key={account.id}><td>{account.user_name}<small>{account.user_email || account.label}</small></td><td>{label(account.provider)}<small>{account.label}</small></td><td>{account.status.toLowerCase()}</td></tr>) : <tr><td colSpan={3}>{accountsError ? "Connections unavailable." : "No connected accounts found."}</td></tr>}</tbody></table></div></section></div>
    <section className="observability-card"><h2>Meeting activity and AI use cases</h2><p>All meeting records in this workspace, with recorded model spend where available. Unpriced and transcription costs are excluded.</p><div className="observability-table-wrap"><table><thead><tr><th>Meeting</th><th>Capture</th><th>AI calls</th><th>Estimated cost</th></tr></thead><tbody>{meetings.length ? meetings.map((meeting) => { const entry = usage?.by_meeting.find((item) => item.meeting_id === meeting.id); return <tr key={meeting.id}><td>{meeting.title}<small>{meeting.platform} · {meeting.startsAt}</small></td><td>{meeting.status.replaceAll("_", " ")}</td><td>{entry?.requests ?? 0}<small>{entry ? `${entry.input_tokens.toLocaleString()} in · ${entry.output_tokens.toLocaleString()} out${entry.unpriced_requests ? ` · ${entry.unpriced_requests} unpriced` : ""}` : "No recorded model calls"}</small></td><td>{entry ? money(entry.estimated_usd) : "—"}</td></tr>; }) : <tr><td colSpan={4}>No meeting records found.</td></tr>}</tbody></table></div></section>
    <section className="observability-card"><h2>Recent model calls</h2><p>Provider-reported token counts and per-call estimates. These are the latest 100 calls; totals above cover all calls.</p><div className="observability-table-wrap"><table><thead><tr><th>When / process</th><th>Provider / model</th><th>Tokens</th><th>Estimate</th></tr></thead><tbody>{usage?.recent.length ? usage.recent.map((event) => <tr key={event.id}><td>{label(event.purpose)}<small>{new Date(event.created_at).toLocaleString()}{event.meeting_id ? ` · meeting ${event.meeting_id.slice(0, 8)}` : event.knowledge_base_id ? ` · knowledge ${event.knowledge_base_id.slice(0, 8)}` : ""}</small></td><td>{event.provider}<small>{event.model}</small></td><td><ArrowDownRight size={13} /> {event.input_tokens ?? "—"} <ArrowUpRight size={13} /> {event.output_tokens ?? "—"}</td><td>{event.estimated_usd === null ? "Unpriced" : money(event.estimated_usd)}</td></tr>) : <tr><td colSpan={4}>No calls recorded yet.</td></tr>}</tbody></table></div></section>
  </section>;
}
