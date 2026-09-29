import type { BalanceOverview, BillingKeyInfo, BillingKeyType, ProviderBalance, VaultCredential } from "../../types";
import { KEY_EXA, KEY_OPENAI, KEY_OPENROUTER, OPENROUTER_URL } from "../fixtures/providers";
import { json, wait } from "../http";
import type { DemoRouter } from "../router";
import type { DemoStore } from "../store";

/*
 * Sample provider credit for the demo workspace: the OpenRouter key is low, OpenAI does not share
 * its balance, and Exa shows this month's spend. Nothing is sent to any provider.
 */

const DASHBOARDS = {
  openrouter: "https://openrouter.ai/settings/credits",
  openai: "https://platform.openai.com/settings/organization/billing",
  exa: "https://dashboard.exa.ai/billing",
} as const;

const UNLOCKS: Record<BillingKeyType, [ProviderBalance["provider"], string]> = {
  openrouter_management: ["openrouter", "Shows your OpenRouter account balance (credits bought minus used)."],
  openai_admin: ["openai", "Shows official OpenAI spend this month. OpenAI never shares the remaining balance."],
  exa_service: ["exa", "Shows official Exa spend and key budgets. Exa never shares the remaining balance."],
};

/** Per-tab "last checked" times; a refresh stamps them with now. */
const checkedAt = new WeakMap<DemoStore, Map<string, string>>();

function stamp(store: DemoStore, id: string, fresh: boolean): string {
  const times = checkedAt.get(store) ?? new Map<string, string>();
  checkedAt.set(store, times);
  if (fresh || !times.has(id)) times.set(id, new Date(Date.now() - (fresh ? 0 : 4 * 60_000)).toISOString());
  return times.get(id) as string;
}

function providerOf(item: VaultCredential): ProviderBalance["provider"] | null {
  if (item.provider_type === "openai" || item.provider_type === "openrouter" || item.provider_type === "exa") return item.provider_type;
  return item.provider_type === "openai_compatible" && item.base_url === OPENROUTER_URL ? "openrouter" : null;
}

function balanceFor(item: VaultCredential, provider: ProviderBalance["provider"], billing: Set<string>, checked: string): ProviderBalance {
  const base = { credential_id: item.id, provider, label: item.label, hint: item.hint, checked_at: checked, dashboard_url: DASHBOARDS[provider], balance_usd: null, limit_usd: null, remaining_usd: null, spent_usd: null, spent_period: "this_month" as const, our_tracked_spend_usd: 0 };
  if (provider === "openrouter") {
    const sample = item.id === KEY_OPENROUTER ? { remaining: 4.2, limit: 20, spent: 15.8, ours: 11.36 } : { remaining: 18.5, limit: 25, spent: 6.5, ours: 0 };
    const account = billing.has("openrouter_management") ? 61.3 : null;
    const remaining = account === null ? sample.remaining : Math.min(sample.remaining, account);
    return { ...base, balance_usd: account, limit_usd: sample.limit, remaining_usd: remaining, spent_usd: sample.spent, our_tracked_spend_usd: sample.ours,
      status: remaining <= 5 || remaining <= sample.limit * 0.1 ? "low" : "ok", source: account === null ? "provider_api" : "admin_key",
      note: `Key limit from OpenRouter. ${account === null ? "Add an OpenRouter management key to see the account balance." : "Account balance from your management key."}` };
  }
  const ours = item.id === KEY_OPENAI ? 12.4 : item.id === KEY_EXA ? 3.42 : 0;
  const name = provider === "openai" ? "OpenAI" : "Exa";
  const billingType = provider === "openai" ? "openai_admin" : "exa_service";
  if (billing.has(billingType)) {
    return { ...base, spent_usd: provider === "openai" ? 14.85 : 3.5, limit_usd: provider === "exa" ? 50 : null, our_tracked_spend_usd: ours, status: "unknown", source: "admin_key",
      note: `${name} doesn't share your remaining balance — check billing. ${provider === "openai" ? "Spend is for the whole OpenAI organization this month." : "Budget set in Exa."}` };
  }
  return { ...base, spent_usd: ours, our_tracked_spend_usd: ours, status: "unknown", source: "our_ledger",
    note: `${name} doesn't share your remaining balance — check billing. Showing spend this app tracked. Add ${provider === "openai" ? "an OpenAI admin key" : "an Exa service key"} to see official spend.` };
}

function overview(store: DemoStore, fresh: string | "all" | null): BalanceOverview {
  const billingKeys = store.credentials.filter((item) => item.provider_type in UNLOCKS);
  const billing = new Set<string>(billingKeys.map((item) => item.provider_type));
  const items = store.credentials.flatMap((item) => {
    const provider = providerOf(item);
    return provider ? [balanceFor(item, provider, billing, stamp(store, item.id, fresh === "all" || fresh === item.id))] : [];
  });
  const info: BillingKeyInfo[] = (Object.keys(UNLOCKS) as BillingKeyType[]).map((type) => {
    const key = billingKeys.find((item) => item.provider_type === type);
    return { provider_type: type, provider: UNLOCKS[type][0], configured: Boolean(key), credential_id: key?.id ?? null, label: key?.label ?? null, hint: key?.hint ?? null, unlocks: UNLOCKS[type][1] };
  });
  const latest = items.map((item) => item.checked_at).sort().at(-1) ?? null;
  return { items, billing_keys: info, low_balance_threshold_usd: 5, checked_at: latest };
}

export function registerBalances(router: DemoRouter): void {
  router
    .on("GET", "/v1/provider-balances", ({ store }) => json(overview(store, null)))
    .on("POST", "/v1/provider-balances/refresh", async ({ store, query }) => {
      await wait(500);
      return json(overview(store, query.get("credential_id") ?? "all"));
    });
}
