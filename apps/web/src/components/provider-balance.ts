/**
 * Wording and tone for provider credit balances (shared by the AI providers key list and the
 * Observability "Provider credits" card). Pure helpers, no React.
 */

import type { BalanceProvider, BalanceState, BillingKeyType, ProviderBalance } from "@/lib/types";
import type { Tone } from "./ui/feedback";

export const balanceProviderName: Record<BalanceProvider, string> = { openrouter: "OpenRouter", openai: "OpenAI", exa: "Exa" };

export const balanceTone: Record<BalanceState, Tone> = {
  ok: "success", low: "warning", exhausted: "danger", invalid_key: "danger", error: "warning", unknown: "neutral",
};

/** Whole dollars and cents ("$4.20", "$1,204.00"); tiny non-zero amounts read "<$0.01". */
export function formatDollars(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "$12.40 spent this month", shown beside the chip (null when the provider reports no spend). */
export function balanceSpendText(balance: ProviderBalance): string | null {
  if (balance.spent_usd === null) return null;
  const period = balance.spent_period === "all_time" ? "in total" : "this month";
  return `${formatDollars(balance.spent_usd)} spent ${period}`;
}

/** The short chip text: "$4.20 left of $20.00 limit", "Out of credits", "Balance not shared by OpenAI". */
export function balanceChipText(balance: ProviderBalance): string {
  const name = balanceProviderName[balance.provider];
  if (balance.status === "invalid_key") return "Invalid key";
  if (balance.status === "error") return "Couldn’t check";
  if (balance.status === "exhausted") return balance.provider === "exa" && balance.limit_usd !== null ? "Over budget" : "Out of credits";
  if (balance.remaining_usd !== null) {
    const left = `${formatDollars(balance.remaining_usd)} left`;
    return balance.limit_usd !== null ? `${left} of ${formatDollars(balance.limit_usd)} limit` : left;
  }
  return balance.provider === "openrouter" ? "No key limit" : `Balance not shared by ${name}`;
}

/** Screen-reader and tooltip summary: provider, key, chip text and the plain-language note. */
export function balanceSummary(balance: ProviderBalance): string {
  const spend = balanceSpendText(balance);
  return `${balanceProviderName[balance.provider]} key ${balance.label}: ${balanceChipText(balance)}${spend ? `, ${spend}` : ""}. ${balance.note}`;
}

/** Remaining first (least left at the top); keys without a known balance follow, by status severity then name. */
const STATE_ORDER: Record<BalanceState, number> = { exhausted: 0, invalid_key: 1, low: 2, error: 3, ok: 4, unknown: 5 };

export function sortByRemaining(items: readonly ProviderBalance[], direction: "asc" | "desc" = "asc"): ProviderBalance[] {
  return [...items].sort((a, b) => {
    const known = Number(a.remaining_usd === null) - Number(b.remaining_usd === null);
    if (known) return known;
    if (a.remaining_usd !== null && b.remaining_usd !== null && a.remaining_usd !== b.remaining_usd) {
      return direction === "asc" ? a.remaining_usd - b.remaining_usd : b.remaining_usd - a.remaining_usd;
    }
    return STATE_ORDER[a.status] - STATE_ORDER[b.status] || a.label.localeCompare(b.label);
  });
}

export const billingKeyInfo: Record<BillingKeyType, { provider: BalanceProvider; title: string; unlocks: string; where: string; placeholder: string }> = {
  openrouter_management: {
    provider: "openrouter", title: "OpenRouter management key",
    unlocks: "Shows your OpenRouter account balance (credits bought minus used), not just each key’s limit.",
    where: "OpenRouter → Settings → Management keys", placeholder: "sk-or-v1-…",
  },
  openai_admin: {
    provider: "openai", title: "OpenAI admin key",
    unlocks: "Shows official OpenAI spend this month. OpenAI never shares the remaining prepaid balance.",
    where: "OpenAI platform → Organization settings → Admin keys", placeholder: "sk-admin-…",
  },
  exa_service: {
    provider: "exa", title: "Exa service key",
    unlocks: "Shows official Exa spend and key budgets. Exa never shares the remaining balance.",
    where: "Exa dashboard → Team → Service keys (team management API)", placeholder: "Paste the service key",
  },
};

export const billingKeyTypes = Object.keys(billingKeyInfo) as BillingKeyType[];
