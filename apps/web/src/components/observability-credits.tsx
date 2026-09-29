"use client";

import { useState } from "react";
import { RefreshCw, Wallet } from "lucide-react";
import type { ProviderBalance } from "@/lib/types";
import { Alert, EmptyState, LoadingRow } from "./ui/feedback";
import { NoMatches, SearchToolbar } from "./scroll-panel";
import { UiSelect } from "./ui-select";
import { useListSearch } from "./use-list-search";
import { BalanceChip, CheckedAt, useProviderBalances } from "./provider-balance-chip";
import { balanceChipText, balanceProviderName, billingKeyInfo, creditLineText, formatDollars, sortByRemaining } from "./provider-balance";
import { ProviderBrandIcon } from "./provider-brand-icons";

type SortChoice = "least" | "most" | "name";
const SORT_OPTIONS: { value: SortChoice; label: string }[] = [
  { value: "least", label: "Least credit left first" },
  { value: "most", label: "Most credit left first" },
  { value: "name", label: "Key name" },
];

function sorted(items: readonly ProviderBalance[], choice: SortChoice): ProviderBalance[] {
  if (choice === "name") return [...items].sort((a, b) => a.label.localeCompare(b.label));
  return sortByRemaining(items, choice === "least" ? "asc" : "desc");
}

const amount = (value: number | null) => value === null ? "—" : formatDollars(value);

/** Apollo's per-type credits for the billing cycle; a line at or under 10% of its limit is flagged. */
function CreditLines({ item }: { item: ProviderBalance }) {
  const lines = item.credits ?? [];
  if (!lines.length) return <p className="provider-credit-lines-empty field-hint">No credit balances reported.</p>;
  return <dl className="provider-credit-figures provider-credit-lines">
    {lines.map((line) => {
      const state = line.limit && line.remaining !== null ? line.remaining <= 0 ? "exhausted" : line.remaining <= line.limit * 0.1 ? "low" : "ok" : "ok";
      return <div key={line.credit_type} data-state={state}><dt>{line.label}</dt><dd>{creditLineText(line)}</dd></div>;
    })}
  </dl>;
}

/** Observability: remaining credit and spend for every saved OpenRouter, OpenAI and Exa key, plus Apollo credits. */
export function ProviderCreditsCard({ refreshKey }: { refreshKey: number }) {
  const balances = useProviderBalances(true, refreshKey);
  const [sort, setSort] = useState<SortChoice>("least");
  const [problem, setProblem] = useState<string | null>(null);
  const overview = balances.overview;
  const items = sorted(overview?.items ?? [], sort);
  const search = useListSearch(items, (item) => [item.label, item.hint, balanceProviderName[item.provider], balanceChipText(item)]);
  const attention = items.filter((item) => item.status === "low" || item.status === "exhausted" || item.status === "invalid_key").length;
  const missing = (overview?.billing_keys ?? []).filter((item) => !item.configured);
  const refreshAll = async () => setProblem(await balances.refresh());

  return <section className="card obs-section provider-credits" aria-labelledby="obs-credits-title">
    <div className="card-header">
      <div><h2 id="obs-credits-title">Provider credits</h2>
        <p>What’s left on each saved key{attention ? ` · ${attention} need${attention === 1 ? "s" : ""} attention` : ""}. Low means {formatDollars(overview?.low_balance_threshold_usd ?? 5)} or less, or under 10% of a key limit.</p></div>
      <div className="provider-credits-actions">
        {items.length ? <UiSelect id="obs-credits-sort" label="Sort keys" hideLabel size="sm" value={sort} onChange={(value) => setSort(value as SortChoice)} options={SORT_OPTIONS} className="provider-credits-sort" /> : null}
        <button type="button" className="button secondary sm" onClick={() => void refreshAll()} disabled={balances.refreshing !== null || balances.loading}>
          <RefreshCw aria-hidden="true" className={balances.refreshing ? "obs-spin" : undefined} /> {balances.refreshing ? "Checking…" : "Check now"}
        </button>
      </div>
    </div>
    {problem ? <p className="form-error provider-credits-problem" role="alert">{problem}</p> : null}
    {balances.loading && !overview ? <div className="provider-credits-state"><LoadingRow>Checking provider credit…</LoadingRow></div>
      : balances.error && !overview ? <div className="provider-credits-state"><Alert tone="warning" title="Provider credit is unavailable">{balances.error}</Alert></div>
        : !items.length ? <EmptyState plain className="provider-credits-state" icon={<Wallet />} title="No provider keys saved">Save OpenRouter, OpenAI or Exa keys under AI providers to see their credit here.</EmptyState>
          : <>
            {search.offered ? <SearchToolbar id="obs-credits-search" label="Search provider keys" value={search.query} onChange={search.setQuery} placeholder="Search key or provider" /> : null}
            {search.noMatches ? <NoMatches query={search.query} noun="keys" onClear={search.clear} />
              : <ul className="provider-credits-list">{search.visible.map((item) => <CreditRow key={item.credential_id} item={item} />)}</ul>}
          </>}
    {missing.length && items.length ? <p className="provider-credits-footnote field-hint">
      More detail: add {missing.map((item) => billingKeyInfo[item.provider_type].title).join(", ").replace(/, ([^,]*)$/, " or $1")} under AI providers → API keys → Billing keys.
    </p> : null}
  </section>;
}

function CreditRow({ item }: { item: ProviderBalance }) {
  const spentLabel = item.spent_period === "all_time" ? "Spent in total" : "Spent this month";
  return <li className="provider-credit" data-state={item.status}>
    <span className="provider-credit-key">
      <ProviderBrandIcon brand={item.provider} size="sm" />
      <span><b>{item.label}</b><small>{balanceProviderName[item.provider]} · {item.hint}</small></span>
    </span>
    <span className="provider-credit-status"><BalanceChip balance={item} /><small>{item.note}</small></span>
    {item.provider === "apollo" ? <CreditLines item={item} /> : <dl className="provider-credit-figures">
      <div><dt>Left</dt><dd>{amount(item.remaining_usd)}</dd></div>
      <div><dt>{spentLabel}</dt><dd>{amount(item.spent_usd)}</dd></div>
      <div><dt>Tracked here</dt><dd>{formatDollars(item.our_tracked_spend_usd)}</dd></div>
    </dl>}
    <span className="provider-credit-checked"><CheckedAt value={item.checked_at} /><a className="text-button" href={item.dashboard_url} target="_blank" rel="noreferrer">Billing</a></span>
  </li>;
}
