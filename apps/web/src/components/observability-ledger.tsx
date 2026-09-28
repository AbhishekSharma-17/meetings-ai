"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ListTree } from "lucide-react";
import { usageService } from "@/lib/meetings-service";
import type { UsageEvent, UsageEventFilters, UsageRange, UsageSummaryDetail } from "@/lib/types";
import { Badge, EmptyState, LoadingRow } from "./ui/feedback";
import { FilterInput, NoMatches, ScrollPanel } from "./scroll-panel";
import { UiSelect } from "./ui-select";
import { UsageEventSheet } from "./observability-event-sheet";
import { providerOptionIcon, UsageProviderName } from "./provider-brand-icons";
import { providerBrand, usageEndpointHost } from "./provider-brand";
import { formatCompact, formatDuration, formatUsd, formatWhen, kindLabel, kindTone, providerLabel, purposeLabel, statusLabel, unitsLabel } from "./usage-labels";

const ALL = "all";
const knownKinds = ["llm", "embedding", "vision", "transcription", "search", "contents"];
const PAGE = 50;

/** Where a call came from: a meeting, a prep, a knowledge base or the workspace, plus who ran it. */
export function eventContext(event: UsageEvent): string {
  const place = event.meeting_title ?? (event.meeting_id ? "Deleted meeting" : null)
    ?? (event.prep_event_title ? `Prep: ${event.prep_event_title}` : event.prep_event_id ? "Meeting prep" : null)
    ?? (event.knowledge_base_name ? `Knowledge: ${event.knowledge_base_name}` : event.knowledge_base_id ? "AI knowledge" : null)
    ?? "Workspace";
  return event.actor_display_name ? `${place} · ${event.actor_display_name}` : place;
}

export function EventCost({ event }: { event: UsageEvent }) {
  if (event.estimated_usd !== null) return <span title={event.price_source ? `Estimate from ${event.price_source.replaceAll("_", " ")}` : undefined}>{formatUsd(event.estimated_usd)}</span>;
  return <span title={event.status === "failed" ? "Failed calls are not priced" : "No published price is known for this model or route"}><Badge tone="warning">Unpriced</Badge></span>;
}

/** Tokens for model calls; units (audio time, results, pages) for everything else. */
export function EventVolume({ event }: { event: UsageEvent }) {
  if (event.unit_type && event.unit_type !== "tokens") return <>{unitsLabel(event.units, event.unit_type)}</>;
  if (event.input_tokens === null && event.output_tokens === null) return <>—</>;
  return <span title="Input / output tokens">{event.input_tokens === null ? "—" : formatCompact(event.input_tokens)} in · {event.output_tokens === null ? "—" : formatCompact(event.output_tokens)} out</span>;
}

export function UsageLedger({ range, usage, refreshKey }: { range: UsageRange; usage: UsageSummaryDetail | null; refreshKey: number }) {
  const [kind, setKind] = useState(ALL);
  const [provider, setProvider] = useState(ALL);
  const [model, setModel] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<UsageEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<UsageEvent | null>(null);
  const request = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const filters: UsageEventFilters = useMemo(() => ({
    ...range, kind: kind === ALL ? undefined : kind, provider: provider === ALL ? undefined : provider,
    model: model === ALL ? undefined : model, status: status === ALL ? undefined : status, q: search || undefined,
  }), [range, kind, provider, model, status, search]);

  useEffect(() => {
    const id = ++request.current;
    queueMicrotask(() => { setLoading(true); setError(null); });
    usageService.events(filters, null, PAGE)
      .then((page) => { if (id === request.current) { setItems(page.items); setCursor(page.next_cursor); setTotal(page.total); } })
      .catch((cause: unknown) => { if (id === request.current) { setItems([]); setCursor(null); setTotal(0); setError(cause instanceof Error ? cause.message : "Could not load the usage ledger."); } })
      .finally(() => { if (id === request.current) setLoading(false); });
  }, [filters, refreshKey]);

  const loadMore = async () => {
    if (!cursor) return;
    const id = ++request.current;
    setLoading(true);
    try {
      const page = await usageService.events(filters, cursor, PAGE);
      if (id === request.current) { setItems((current) => [...current, ...page.items]); setCursor(page.next_cursor); setTotal(page.total); }
    } catch (cause) { if (id === request.current) setError(cause instanceof Error ? cause.message : "Could not load more calls."); }
    finally { if (id === request.current) setLoading(false); }
  };

  const kindOptions = useMemo(() => {
    const names = Array.from(new Set([...knownKinds, ...(usage?.by_kind ?? []).map((row) => row.name)]));
    return [{ value: ALL, label: "All kinds" }, ...names.map((name) => ({ value: name, label: kindLabel(name) }))];
  }, [usage]);
  const providerOptions = useMemo(() => [{ value: ALL, label: "All providers" },
    ...(usage?.by_provider ?? []).map((row) => ({ value: row.name, label: providerLabel(row.name), icon: providerOptionIcon(providerBrand(row.name)) }))], [usage]);
  const modelOptions = useMemo(() => {
    const names = Array.from(new Set((usage?.by_model ?? [])
      .filter((row) => (kind === ALL || row.kind === kind) && (provider === ALL || row.provider === provider)).map((row) => row.model)));
    return [{ value: ALL, label: "All models" }, ...names.map((name) => ({ value: name, label: name }))];
  }, [usage, kind, provider]);
  const statusOptions = [{ value: ALL, label: "Any status" }, { value: "succeeded", label: "Succeeded" }, { value: "failed", label: "Failed" }];
  const filtered = kind !== ALL || provider !== ALL || model !== ALL || status !== ALL || Boolean(search);
  const clear = () => { setKind(ALL); setProvider(ALL); setModel(ALL); setStatus(ALL); setQuery(""); setSearch(""); };

  return <section className="card obs-card obs-ledger" aria-labelledby="obs-ledger-title">
    <div className="card-header">
      <div><h2 id="obs-ledger-title">Usage ledger</h2><p>Every metered call: model, tokens, units, estimated cost, timing and who or what triggered it.</p></div>
      <a className="button secondary sm" href={usageService.exportUrl(filters)} download><Download aria-hidden="true" />Export CSV</a>
    </div>
    <div className="card-toolbar obs-ledger-filters">
      <FilterInput id="obs-ledger-search" label="Search usage" value={query} onChange={setQuery} placeholder="Search process, model or meeting" />
      <UiSelect id="obs-ledger-kind" label="Kind" hideLabel size="sm" value={kind} options={kindOptions} onChange={(value) => { setKind(value); setModel(ALL); }} />
      <UiSelect id="obs-ledger-provider" label="Provider" hideLabel size="sm" value={provider} options={providerOptions} onChange={(value) => { setProvider(value); setModel(ALL); }} />
      <UiSelect id="obs-ledger-model" label="Model" hideLabel size="sm" value={model} options={modelOptions} onChange={setModel} />
      <UiSelect id="obs-ledger-status" label="Status" hideLabel size="sm" value={status} options={statusOptions} onChange={setStatus} />
    </div>
    {error ? <div className="card-body obs-card-alert"><p className="form-error" role="alert">{error}</p></div> : null}
    {!items.length && loading ? <div className="card-body"><LoadingRow>Loading usage…</LoadingRow></div>
      : !items.length && filtered ? <NoMatches query={search} noun="calls" onClear={clear} />
      : !items.length ? <EmptyState plain icon={<ListTree />} title="No metered calls in this period">Calls appear here as soon as the workspace uses AI.</EmptyState>
      : <ScrollPanel label="Usage ledger" className="obs-table obs-ledger-table"><table className="data-table">
        <thead><tr><th>Time</th><th>Kind</th><th>Process</th><th>Provider / model</th><th className="num">Volume</th><th className="num">Cost</th><th className="num">Duration</th><th>Status</th></tr></thead>
        <tbody>{items.map((event) => <tr key={event.id} className="obs-ledger-row" onClick={() => setSelected(event)}>
          <td className="obs-when"><time dateTime={event.created_at}>{formatWhen(event.created_at)}</time></td>
          <td><Badge tone={kindTone(event.kind)}>{kindLabel(event.kind)}</Badge></td>
          <td><span className="obs-cell">
            <button type="button" className="obs-row-button" onClick={(clickEvent) => { clickEvent.stopPropagation(); setSelected(event); }} aria-label={`Details for ${purposeLabel(event.purpose)} at ${formatWhen(event.created_at)}`}>{purposeLabel(event.purpose)}</button>
            <small>{eventContext(event)}</small></span></td>
          <td><span className="obs-cell"><UsageProviderName provider={event.provider} endpointHost={usageEndpointHost(event.details)} /><small className="obs-model">{event.model}</small></span></td>
          <td className="num"><EventVolume event={event} /></td>
          <td className="num"><EventCost event={event} /></td>
          <td className="num">{formatDuration(event.duration_ms)}</td>
          <td><Badge tone={event.status === "succeeded" ? "success" : "danger"} dot>{statusLabel(event.status)}</Badge></td>
        </tr>)}</tbody>
      </table></ScrollPanel>}
    {items.length ? <div className="card-footer split obs-ledger-footer">
      <span className="section-count" role="status">Showing {items.length.toLocaleString()} of {total.toLocaleString()} calls</span>
      {cursor ? <button type="button" className="button secondary sm" onClick={() => void loadMore()} disabled={loading}>{loading ? "Loading…" : "Load more"}</button> : null}
    </div> : null}
    <UsageEventSheet event={selected} onClose={() => setSelected(null)} />
  </section>;
}
