import { History } from "lucide-react";
import type { PrepHistory } from "@/lib/types";
import { Badge, EmptyState } from "./ui/feedback";
import { briefingTime, formatTokens, formatUsd } from "./prep-shared";

/** Earlier briefings for this meeting with their model, token and estimated-cost totals. */
export function PrepHistoryList({ history, currentId }: { history: PrepHistory; currentId: string | null }) {
  if (!history.items.length) return <EmptyState plain icon={<History />} title="No briefings yet">Generated briefings for this meeting are listed here.</EmptyState>;
  const { totals } = history;
  return <section className="card prep-history" aria-labelledby="prep-history-title">
    <div className="card-header">
      <div>
        <h2 id="prep-history-title">Briefing history</h2>
        <p>{history.items.length} {history.items.length === 1 ? "briefing" : "briefings"} · {formatTokens(totals.input_tokens, totals.output_tokens)} · est. {formatUsd(totals.estimated_usd)}{totals.unpriced_calls ? ` (${totals.unpriced_calls} unpriced)` : ""}</p>
      </div>
    </div>
    <div className="table-wrap">
      <table className="data-table prep-history-table">
        <thead><tr><th scope="col">Generated</th><th scope="col">Model</th><th scope="col">Research</th><th scope="col" className="num">Tokens</th><th scope="col" className="num">Est. cost</th></tr></thead>
        <tbody>
          {history.items.map((item) => <tr key={item.id}>
            <td>
              <time dateTime={item.generated_at}>{new Date(item.generated_at).toLocaleString(undefined, briefingTime)}</time>
              {item.id === currentId ? <> <Badge tone="brand">Current</Badge></> : null}
            </td>
            <td className="prep-history-model">{item.provider} / {item.model}</td>
            <td>{!item.public_research_performed ? "Context only" : item.report_version === 2 ? `${item.usage.exa_calls} searches` : "Public research"}</td>
            <td className="num">{item.report_version === 2 ? (item.usage.input_tokens + item.usage.output_tokens).toLocaleString() : "—"}</td>
            <td className="num">{item.report_version === 2 ? formatUsd(item.usage.estimated_usd) : "—"}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
    <p className="prep-history-note field-hint">Costs are estimates from provider list prices, not invoices.</p>
  </section>;
}
