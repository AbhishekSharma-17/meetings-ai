"use client";

import { useState } from "react";
import type { UsageGroupTotal, UsageModelTotal } from "@/lib/types";
import { Badge } from "./ui/feedback";
import { FilterInput, matchesQuery, NoMatches, ScrollPanel } from "./scroll-panel";
import { formatCompact, formatUsd, kindLabel, kindTone, providerLabel, unitsLabel } from "./usage-labels";

const CHART_COLORS = 8;

/** Horizontal bars: share of estimated spend per kind of call (share of calls when nothing is priced). */
export function SpendByKind({ rows }: { rows: UsageGroupTotal[] }) {
  const spend = rows.reduce((sum, row) => sum + row.estimated_usd, 0);
  const calls = rows.reduce((sum, row) => sum + row.requests, 0);
  const bySpend = spend > 0;
  const sorted = [...rows].sort((a, b) => bySpend ? b.estimated_usd - a.estimated_usd : b.requests - a.requests);
  return <section className="card obs-card" aria-labelledby="obs-kind-title">
    <div className="card-header"><div><h2 id="obs-kind-title">Spend by kind</h2><p>{bySpend ? "Share of estimated spend." : "Share of calls; nothing in this period is priced."}</p></div></div>
    {sorted.length ? <ul className="obs-bars">{sorted.map((row, index) => {
      const share = bySpend ? row.estimated_usd / spend : calls ? row.requests / calls : 0;
      return <li key={row.name}>
        <span className="obs-bars-name"><i aria-hidden="true" style={{ background: `var(--chart-${(index % CHART_COLORS) + 1})` }} />{kindLabel(row.name)}</span>
        <span className="obs-bars-track" aria-hidden="true"><i style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%`, background: `var(--chart-${(index % CHART_COLORS) + 1})` }} /></span>
        <span className="obs-bars-value"><b>{formatUsd(row.estimated_usd)}</b><small>{row.requests.toLocaleString()} calls{row.unpriced_requests ? ` · ${row.unpriced_requests} unpriced` : ""}</small></span>
      </li>;
    })}</ul> : <p className="obs-card-empty">No usage recorded in this period.</p>}
  </section>;
}

export function SpendByModel({ rows }: { rows: UsageModelTotal[] }) {
  const [query, setQuery] = useState("");
  const visible = rows.filter((row) => matchesQuery(query, [row.model, providerLabel(row.provider), kindLabel(row.kind)]));
  return <section className="card obs-card" aria-labelledby="obs-model-title">
    <div className="card-header"><div><h2 id="obs-model-title">Cost by model</h2><p>Every provider and model used, with units for non-token calls.</p></div>
      {rows.length ? <span className="section-count">{rows.length}</span> : null}</div>
    {rows.length > 6 ? <div className="card-toolbar"><FilterInput id="obs-model-search" label="Search models" value={query} onChange={setQuery} placeholder="Search by model or provider" /></div> : null}
    {rows.length && !visible.length ? <NoMatches query={query} noun="models" onClear={() => setQuery("")} /> : <ScrollPanel label="Cost by model" className="obs-table" size="sm"><table className="data-table">
      <thead><tr><th>Model</th><th className="num">Calls</th><th className="num">Volume</th><th className="num">Estimate</th></tr></thead>
      <tbody>{visible.length ? visible.map((row) => <tr key={`${row.kind}:${row.provider}:${row.model}`}>
        <td><span className="obs-cell"><span className="obs-model">{row.model}</span><small><Badge tone={kindTone(row.kind)}>{kindLabel(row.kind)}</Badge> {providerLabel(row.provider)}</small></span></td>
        <td className="num"><span className="obs-cell"><span>{row.requests.toLocaleString()}</span>{row.failed_requests ? <small>{row.failed_requests} failed</small> : null}</span></td>
        <td className="num">{row.unit_type && row.unit_type !== "tokens" ? unitsLabel(row.units, row.unit_type) : `${formatCompact(row.input_tokens)} / ${formatCompact(row.output_tokens)}`}</td>
        <td className="num">{row.unpriced_requests === row.requests ? <Badge tone="warning">Unpriced</Badge> : formatUsd(row.estimated_usd)}</td>
      </tr>) : <tr className="obs-empty-row"><td colSpan={4}>No models used in this period.</td></tr>}</tbody>
    </table></ScrollPanel>}
  </section>;
}
