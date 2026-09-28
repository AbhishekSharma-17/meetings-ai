"use client";

import { useEffect, useState, type ReactNode } from "react";
import { BookOpenCheck, CalendarCheck, Coins, Cpu, Search } from "lucide-react";
import { usageService } from "@/lib/meetings-service";
import type { UsageEvent, UsageRange, UsageSummaryDetail } from "@/lib/types";
import { Badge, EmptyState, LoadingRow } from "./ui/feedback";
import { NoMatches, ScrollPanel, SearchToolbar } from "./scroll-panel";
import { shouldOfferSearch } from "@/lib/search";
import { UsageEventSheet } from "./observability-event-sheet";
import { EventCost } from "./observability-ledger";
import { UsageProviderName } from "./provider-brand-icons";
import { usageEndpointHost } from "./provider-brand";
import { formatCompact, formatDuration, formatUsd, formatWhen, statusLabel } from "./usage-labels";

const RUNS = 25;
const SEARCH_DEBOUNCE_MS = 300;

export function PrepUsagePanel({ range, usage, refreshKey }: { range: UsageRange; usage: UsageSummaryDetail | null; refreshKey: number }) {
  const [runs, setRuns] = useState<UsageEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<UsageEvent | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const prep = usage?.prep;

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) { setLoading(true); setError(null); } });
    usageService.events({ ...range, purpose: "meeting_prep", q: search || undefined }, null, RUNS)
      .then((page) => { if (active) { setRuns(page.items); setTotal(page.total); } })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load prep runs."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [range, refreshKey, search]);

  const dash = "—";
  return <>
    <div className="stat-grid obs-stats" aria-label="Meeting prep usage">
      <Stat icon={<BookOpenCheck />} title="Prep sessions" value={prep?.sessions ?? dash} hint={prep ? `${prep.events_prepared} meetings prepared` : "Not reported by this server"} />
      <Stat icon={<CalendarCheck />} title="Briefings saved" value={prep?.briefings_generated ?? dash} hint="Reports kept for the team" />
      <Stat icon={<Search />} title="Web searches" value={prep?.searches ?? dash} hint="Public research requests" />
      <Stat icon={<Cpu />} title="Prep tokens" value={prep ? formatCompact(prep.input_tokens + prep.output_tokens) : dash} hint={prep ? `${formatCompact(prep.input_tokens)} in · ${formatCompact(prep.output_tokens)} out` : dash} />
      <Stat icon={<Coins />} title="Prep spend estimate" value={prep ? formatUsd(prep.estimated_usd) : dash} hint={prep ? `${prep.requests} calls · ${prep.unpriced_requests} unpriced` : dash} />
    </div>
    <section className="card obs-card" aria-labelledby="obs-prep-runs-title">
      <div className="card-header"><div><h2 id="obs-prep-runs-title">Recent briefing runs</h2><p>Each run plans research, searches the web and writes a briefing; its search and reading calls are in the usage ledger.</p></div>
        {total ? <span className="section-count">{total}</span> : null}</div>
      {shouldOfferSearch(total, query) ? <SearchToolbar id="obs-prep-search" label="Search briefing runs" value={query} onChange={setQuery} placeholder="Search meeting, person or model" /> : null}
      {error ? <div className="card-body obs-card-alert"><p className="form-error" role="alert">{error}</p></div> : null}
      {loading && !runs.length ? <div className="card-body"><LoadingRow>Loading prep runs…</LoadingRow></div>
        : !runs.length && search ? <NoMatches query={search} noun="briefing runs" onClear={() => setQuery("")} />
        : !runs.length ? <EmptyState plain icon={<BookOpenCheck />} title="No briefings generated in this period">Generate a prep from the calendar to see its cost here.</EmptyState>
        : <ScrollPanel label="Recent briefing runs" className="obs-table"><table className="data-table">
          <thead><tr><th>When</th><th>Meeting</th><th>Model</th><th className="num">Tokens in / out</th><th className="num">Cost</th><th className="num">Duration</th><th>Status</th></tr></thead>
          <tbody>{runs.map((run) => <tr key={run.id} className="obs-ledger-row" onClick={() => setSelected(run)}>
            <td className="obs-when"><time dateTime={run.created_at}>{formatWhen(run.created_at)}</time></td>
            <td><span className="obs-cell">
              <button type="button" className="obs-row-button" onClick={(event) => { event.stopPropagation(); setSelected(run); }}>{run.prep_event_title ?? "Removed calendar event"}</button>
              <small>{run.actor_display_name ?? "Automatic"}</small></span></td>
            <td><span className="obs-cell"><UsageProviderName provider={run.provider} endpointHost={usageEndpointHost(run.details)} /><small className="obs-model">{run.model}</small></span></td>
            <td className="num">{run.input_tokens?.toLocaleString() ?? "—"} / {run.output_tokens?.toLocaleString() ?? "—"}</td>
            <td className="num"><EventCost event={run} /></td>
            <td className="num">{formatDuration(run.duration_ms)}</td>
            <td><Badge tone={run.status === "succeeded" ? "success" : "danger"} dot>{statusLabel(run.status)}</Badge></td>
          </tr>)}</tbody>
        </table></ScrollPanel>}
    </section>
    <UsageEventSheet event={selected} onClose={() => setSelected(null)} />
  </>;
}

function Stat({ icon, title, value, hint }: { icon: ReactNode; title: string; value: number | string; hint: string }) {
  return <article className="stat"><span className="stat-label">{icon}{title}</span><strong className="stat-value">{value}</strong><span className="stat-hint">{hint}</span></article>;
}
