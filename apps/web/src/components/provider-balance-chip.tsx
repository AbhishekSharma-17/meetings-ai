"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { balanceService } from "@/lib/meetings-service";
import { formatFullDateTime } from "@/lib/time-store";
import type { BalanceOverview, ProviderBalance } from "@/lib/types";
import { Badge } from "./ui/feedback";
import { ProviderBrandIcon } from "./provider-brand-icons";
import { relativeTime } from "./notification-feed";
import { balanceChipText, balanceProviderName, balanceSpendText, balanceTone } from "./provider-balance";

export type ProviderBalances = {
  overview: BalanceOverview | null;
  byKey: Map<string, ProviderBalance>;
  loading: boolean;
  error: string | null;
  /** Id of the key being re-checked, "all" for a full refresh, or null. */
  refreshing: string | null;
  refresh(credentialId?: string): Promise<string | null>;
};

const message = (cause: unknown, fallback: string) => cause instanceof Error && cause.message ? cause.message : fallback;

/** Loads the workspace's key balances (server-cached for 10 min); `reloadKey` changes re-read them. */
export function useProviderBalances(enabled: boolean, reloadKey: unknown = 0): ProviderBalances {
  const [overview, setOverview] = useState<BalanceOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    queueMicrotask(() => { if (active) setLoading(true); });
    balanceService.overview()
      .then((next) => { if (active) { setOverview(next); setError(null); } })
      .catch((cause: unknown) => { if (active) setError(message(cause, "Balances could not be loaded.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [enabled, reloadKey]);

  /** Re-checks with the providers now; resolves to an error message, or null when it worked. */
  const refresh = useCallback(async (credentialId?: string) => {
    setRefreshing(credentialId ?? "all");
    try { setOverview(await balanceService.refresh(credentialId)); setError(null); return null; }
    catch (cause) { return message(cause, "Balances could not be refreshed."); }
    finally { setRefreshing(null); }
  }, []);

  const byKey = new Map((overview?.items ?? []).map((item) => [item.credential_id, item]));
  return { overview, byKey, loading, error, refreshing, refresh };
}

/** Compact credit chip with the provider's mark: "$4.20 left of $20.00 limit", "Out of credits"… */
export function BalanceChip({ balance }: { balance: ProviderBalance }) {
  return <Badge tone={balanceTone[balance.status]} className="balance-chip">
    <ProviderBrandIcon brand={balance.provider} size="xs" />
    <span>{balanceChipText(balance)}</span>
  </Badge>;
}

export function CheckedAt({ value }: { value: string }) {
  return <time dateTime={value} title={formatFullDateTime(value)}>Checked {relativeTime(value).toLowerCase()}</time>;
}

/** The balance line under a saved key: chip, plain-language note, last check, billing link and refresh. */
export function KeyBalanceLine({ balance, loading, refreshing, onRefresh }: {
  balance: ProviderBalance | undefined;
  loading: boolean;
  refreshing: boolean;
  onRefresh(): void;
}) {
  if (!balance) return loading ? <div className="provider-key-balance" aria-live="polite"><span className="provider-key-balance-meta">Checking credit…</span></div> : null;
  const name = balanceProviderName[balance.provider];
  const spend = balanceSpendText(balance);
  return <div className="provider-key-balance" data-state={balance.status}>
    <div className="provider-key-balance-main">
      <BalanceChip balance={balance} />
      <span className="provider-key-balance-meta">
        {spend ? <span className="provider-key-balance-spend">{spend}</span> : null}
        <CheckedAt value={balance.checked_at} />
        <a className="text-button" href={balance.dashboard_url} target="_blank" rel="noreferrer">{name} billing<ExternalLink aria-hidden="true" /></a>
      </span>
      <button type="button" className="icon-button provider-key-balance-refresh" onClick={onRefresh} disabled={refreshing} aria-label={`Refresh credit for ${balance.label}`} title="Check again now">
        <RefreshCw aria-hidden="true" className={refreshing ? "obs-spin" : undefined} />
      </button>
    </div>
    <p className="provider-key-balance-note">{balance.note}</p>
  </div>;
}
