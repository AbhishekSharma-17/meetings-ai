"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { AudioLines, BookOpenCheck, CircleAlert, Coins, Cpu, Database, Gauge, Info, ListTree, RefreshCw, TriangleAlert } from "lucide-react";
import { meetingsService, usageService } from "@/lib/meetings-service";
import type { Meeting, UsageRange, UsageSummaryDetail, WorkspaceCalendarConnection, WorkspaceMember, WorkspaceOperations } from "@/lib/types";
import { PageHeader } from "./ui/page-header";
import { Badge, type Tone } from "./ui/feedback";
import { AccountsTable, MeetingUsageTable, PeopleTable, UsageTable } from "./observability-tables";
import { SpendByKind, SpendByModel } from "./observability-spend";
import { UsageLedger } from "./observability-ledger";
import { PrepUsagePanel } from "./observability-prep";
import { StoragePanel } from "./storage-panel";
import { RangePicker, rangeFor, type RangeChoice } from "./observability-range";
import { formatCompact, formatDuration, formatUsd, providerLabel, purposeLabel } from "./usage-labels";
import { UsageProviderName } from "./provider-brand-icons";
import { ProviderCreditsCard } from "./observability-credits";

type Tab = "overview" | "ledger" | "prep" | "storage";
const tabs: Tab[] = ["overview", "ledger", "prep", "storage"];

export function ObservabilityScreen() {
  const [tab, setTab] = useState<Tab>("overview");
  const [choice, setChoice] = useState<RangeChoice>({ preset: "30", from: "", to: "" });
  const range: UsageRange = useMemo(() => rangeFor(choice), [choice]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [operations, setOperations] = useState<WorkspaceOperations | null>(null);
  const [usage, setUsage] = useState<UsageSummaryDetail | null>(null);
  const [people, setPeople] = useState<WorkspaceMember[]>([]);
  const [accounts, setAccounts] = useState<WorkspaceCalendarConnection[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [nextOperations, nextUsage] = await Promise.all([meetingsService.getWorkspaceOperations(), usageService.summary(range)]);
      setOperations(nextOperations); setUsage(nextUsage);
      const [nextPeople, nextAccounts, nextMeetings] = await Promise.allSettled([meetingsService.listWorkspaceMembers(), meetingsService.listWorkspaceCalendarConnections(), meetingsService.listMeetings()]);
      if (nextPeople.status === "fulfilled") setPeople(nextPeople.value);
      if (nextAccounts.status === "fulfilled") { setAccounts(nextAccounts.value); setAccountsError(null); }
      else setAccountsError("Connected accounts could not be loaded. Refresh to try again.");
      if (nextMeetings.status === "fulfilled") setMeetings(nextMeetings.value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load observability data."); }
    finally { setLoading(false); }
  }, [range]);
  useEffect(() => { queueMicrotask(() => { void refresh(); }); }, [refresh, refreshKey]);

  return <section className="page wide observability-page" aria-labelledby="observability-title">
    <PageHeader titleId="observability-title" title="Observability" description="Captures, processing jobs, every metered AI call, estimated spend and stored data for this workspace."
      actions={<div className="obs-header-actions">
        <RangePicker value={choice} onChange={setChoice} />
        <button className="button secondary" type="button" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading}><RefreshCw aria-hidden="true" className={loading ? "obs-spin" : undefined} /> {loading ? "Refreshing…" : "Refresh"}</button>
      </div>} />
    {error ? <p className="form-error obs-error" role="alert">{error}</p> : null}
    <Tabs.Root value={tab} onValueChange={(value) => setTab(tabs.includes(value as Tab) ? value as Tab : "overview")}>
      <Tabs.List className="tabs-list obs-tabs" aria-label="Observability sections">
        <Tabs.Tab value="overview"><Gauge aria-hidden="true" />Overview</Tabs.Tab>
        <Tabs.Tab value="ledger"><ListTree aria-hidden="true" />Usage ledger{usage ? <span className="count">{formatCompact(usage.total_requests)}</span> : null}</Tabs.Tab>
        <Tabs.Tab value="prep"><BookOpenCheck aria-hidden="true" />Meeting prep</Tabs.Tab>
        <Tabs.Tab value="storage"><Database aria-hidden="true" />Data &amp; storage</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="overview"><Overview usage={usage} operations={operations} people={people} accounts={accounts} accountsError={accountsError} meetings={meetings} refreshKey={refreshKey} /></Tabs.Panel>
      <Tabs.Panel value="ledger"><UsageLedger range={range} usage={usage} refreshKey={refreshKey} /></Tabs.Panel>
      <Tabs.Panel value="prep"><PrepUsagePanel range={range} usage={usage} refreshKey={refreshKey} /></Tabs.Panel>
      <Tabs.Panel value="storage"><StoragePanel refreshKey={refreshKey} /></Tabs.Panel>
    </Tabs.Root>
  </section>;
}

function Overview({ usage, operations, people, accounts, accountsError, meetings, refreshKey }: {
  usage: UsageSummaryDetail | null; operations: WorkspaceOperations | null; people: WorkspaceMember[];
  accounts: WorkspaceCalendarConnection[]; accountsError: string | null; meetings: Meeting[]; refreshKey: number;
}) {
  const failures = operations ? operations.failed_captures + operations.failed_mom_jobs + operations.failed_index_jobs + operations.failed_email_deliveries : 0;
  const dash = "—";
  const transcription = usage?.transcription;
  const prep = usage?.prep;
  const failedCalls = usage?.failed_requests;
  return <>
    <div className="stat-grid obs-stats six" aria-label="Workspace summary">
      <Kpi icon={<Coins />} title="Estimated AI spend" value={usage ? formatUsd(usage.estimated_usd) : dash} hint={`${usage?.unpriced_requests ?? dash} unpriced calls excluded`} />
      <Kpi icon={<Cpu />} title="AI requests" value={usage?.total_requests ?? dash} hint={usage ? `${formatCompact(usage.input_tokens)} in · ${formatCompact(usage.output_tokens)} out tokens` : dash} />
      <Kpi icon={<TriangleAlert />} title="Failed AI calls" value={failedCalls ?? dash} hint="Provider errors and timeouts" tone={failedCalls ? "warning" : undefined} />
      <Kpi icon={<AudioLines />} title="Transcription" value={transcription ? formatDuration(transcription.audio_seconds * 1000) : dash}
        hint={transcription ? `${transcription.meetings} meetings · ${transcription.unpriced ? `${transcription.unpriced} unpriced` : formatUsd(transcription.estimated_usd)}` : "Not reported by this server"} />
      <Kpi icon={<BookOpenCheck />} title="Meeting prep sessions" value={prep?.sessions ?? dash} hint={prep ? `${prep.briefings_generated} briefings · ${formatUsd(prep.estimated_usd)}` : "Not reported by this server"} />
      <Kpi icon={<CircleAlert />} title="Failures needing review" value={operations ? failures : dash} hint={`${operations?.meetings_captured ?? dash} meetings captured`} tone={failures > 0 ? "danger" : undefined} />
    </div>
    <div className="alert obs-note" data-tone="neutral" role="note">
      <Info aria-hidden="true" />
      <p>Estimates use published list prices and provider-reported usage — not an invoice. Unpriced calls, email, database and hosting are <b>not included</b>, so a zero estimate does not mean zero operating cost.</p>
    </div>
    <ProviderCreditsCard refreshKey={refreshKey} />
    <div className="obs-grid">
      <SpendByKind rows={usage?.by_kind ?? []} />
      <UsageTable id="obs-provider" title="Cost by provider" description="Usage across connected providers." firstColumn="Provider" rows={usage?.by_provider ?? []} format={providerLabel} renderName={(name) => <UsageProviderName provider={name} />} empty="No provider usage recorded yet." />
    </div>
    <div className="obs-grid">
      <UsageTable id="obs-process" title="Cost by process" description="Recorded calls, grouped by what they were for." firstColumn="Process" rows={usage?.by_purpose ?? []} format={purposeLabel} empty="No model usage recorded yet." />
      <SpendByModel rows={usage?.by_model ?? []} />
    </div>
    <HealthCard operations={operations} />
    <div className="obs-grid">
      <PeopleTable people={people} />
      <AccountsTable accounts={accounts} error={accountsError} />
    </div>
    <MeetingUsageTable meetings={meetings} usage={usage} />
  </>;
}

function Kpi({ icon, title, value, hint, tone }: { icon: ReactNode; title: string; value: number | string; hint: string; tone?: Tone }) {
  return <article className="stat" data-tone={tone}><span className="stat-label">{icon}{title}</span><strong className="stat-value">{value}</strong><span className="stat-hint">{hint}</span></article>;
}

function HealthCard({ operations }: { operations: WorkspaceOperations | null }) {
  const items: Array<{ name: string; value: number | undefined; kind: "failure" | "active" }> = [
    { name: "Active captures", value: operations?.active_captures, kind: "active" },
    { name: "Capture failures", value: operations?.failed_captures, kind: "failure" },
    { name: "Minutes drafting failures", value: operations?.failed_mom_jobs, kind: "failure" },
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
