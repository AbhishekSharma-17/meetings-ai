"use client";

import { History } from "lucide-react";
import { formatDateTime } from "@/lib/time-preferences";
import type { PrepHistory } from "@/lib/types";
import { Badge, EmptyState } from "./ui/feedback";
import { briefingTime, formatTokens, formatUsd } from "./prep-shared";
import { NoMatches, SearchToolbar } from "./scroll-panel";
import { useListSearch } from "./use-list-search";
import { ProviderName, UsageProviderName } from "./provider-brand-icons";

/** Words the Research column shows, for search. */
function researchText(item: PrepHistory["items"][number]): string {
  if (!item.public_research_performed) return "Context only";
  return item.report_version === 2 ? `${item.usage.exa_calls} Exa searches` : "Public research";
}

/** Earlier briefings for this meeting with their model, token and estimated-cost totals. */
export function PrepHistoryList({ history, currentId }: { history: PrepHistory; currentId: string | null }) {
  const search = useListSearch(history.items, (item) => [formatDateTime(item.generated_at, briefingTime), item.provider, item.model, item.id === currentId ? "Current" : null, researchText(item)]);
  if (!history.items.length) return <EmptyState plain icon={<History />} title="No briefings yet">Generated briefings for this meeting are listed here.</EmptyState>;
  const { totals } = history;
  return <section className="card prep-history" aria-labelledby="prep-history-title">
    <div className="card-header">
      <div>
        <h2 id="prep-history-title">Briefing history</h2>
        <p>{history.items.length} {history.items.length === 1 ? "briefing" : "briefings"} · {formatTokens(totals.input_tokens, totals.output_tokens)} · est. {formatUsd(totals.estimated_usd)}{totals.unpriced_calls ? ` (${totals.unpriced_calls} unpriced)` : ""}</p>
      </div>
    </div>
    {search.offered ? <SearchToolbar id="prep-history-search" label="Search briefing history" value={search.query} onChange={search.setQuery} placeholder="Search date, model or research" /> : null}
    {search.noMatches ? <NoMatches query={search.query} noun="briefings" onClear={search.clear} /> : <div className="table-wrap">
      <table className="data-table prep-history-table">
        <thead><tr><th scope="col">Generated</th><th scope="col">Model</th><th scope="col">Research</th><th scope="col" className="num">Tokens</th><th scope="col" className="num">Est. cost</th></tr></thead>
        <tbody>
          {search.visible.map((item) => <tr key={item.id}>
            <td data-label="Generated">
              <time dateTime={item.generated_at}>{formatDateTime(item.generated_at, briefingTime)}</time>
              {item.id === currentId ? <> <Badge tone="brand">Current</Badge></> : null}
            </td>
            <td className="prep-history-model" data-label="Model"><UsageProviderName provider={item.provider} /> / {item.model}</td>
            <td data-label="Research">{!item.public_research_performed ? "Context only" : item.report_version === 2 ? <ProviderName brand={item.usage.exa_calls ? "exa" : null} label={item.usage.exa_calls ? `${item.usage.exa_calls} Exa ${item.usage.exa_calls === 1 ? "search" : "searches"}` : "0 searches"} /> : "Public research"}</td>
            <td className="num" data-label="Tokens">{item.report_version === 2 ? (item.usage.input_tokens + item.usage.output_tokens).toLocaleString() : "—"}</td>
            <td className="num" data-label="Est. cost">{item.report_version === 2 ? formatUsd(item.usage.estimated_usd) : "—"}</td>
          </tr>)}
        </tbody>
      </table>
    </div>}
    <p className="prep-history-note field-hint">Costs are estimates from provider list prices, not invoices.</p>
  </section>;
}
