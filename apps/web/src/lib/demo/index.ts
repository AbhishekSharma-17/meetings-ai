import { isDemoActive } from "../demo-mode";
import { filterLedger, ledgerCsv } from "./fixtures/usage";
import { registerActivity } from "./handlers/activity";
import { registerCalendar } from "./handlers/calendar";
import { registerKnowledge } from "./handlers/knowledge";
import { registerMeetings } from "./handlers/meetings";
import { registerMinutes } from "./handlers/minutes";
import { registerPrep } from "./handlers/prep";
import { registerProviders } from "./handlers/providers";
import { registerTeams } from "./handlers/teams";
import { registerSpeakers } from "./handlers/speakers";
import { registerUsage } from "./handlers/usage";
import { registerWorkspace } from "./handlers/workspace";
import { notify, wait } from "./http";
import { DemoRouter } from "./router";
import { FEATURED_CONVERSATION } from "./fixtures/knowledge";
import { OWNER_ID } from "./fixtures/people";
import { createStore, type DemoStore } from "./store";

/**
 * The in-browser sample API. While demo mode is on, every same-origin `/v1/*`
 * request is answered here from in-memory sample data; nothing reaches the
 * network and nothing is persisted beyond this tab.
 */
const RESPONSE_LATENCY_MS = 90;
let installed = false;

function buildRouter(): DemoRouter {
  const router = new DemoRouter();
  // Teams first: its delivery-settings and send-configured routes understand internal_group_ids.
  for (const register of [registerTeams, registerWorkspace, registerMeetings, registerMinutes, registerSpeakers, registerCalendar, registerPrep, registerKnowledge, registerProviders, registerUsage, registerActivity]) register(router);
  return router;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

function apiUrl(input: RequestInfo | URL): URL | null {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, window.location.href);
  const ours = url.origin === window.location.origin || (API_BASE && url.href.startsWith(API_BASE));
  return ours && url.pathname.startsWith("/v1/") ? url : null;
}

/** The ledger CSV download is a plain link; answer it from sample data instead of the network. */
function interceptDownloads(store: DemoStore) {
  document.addEventListener("click", (event) => {
    if (!isDemoActive()) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    const url = anchor ? apiUrl(anchor.getAttribute("href") ?? "") : null;
    if (!url) return;
    event.preventDefault();
    if (!url.pathname.endsWith("/usage/export.csv")) return;
    const params = url.searchParams;
    const rows = filterLedger(store.usage, { since: params.get("since"), until: params.get("until"), kind: params.get("kind") ?? undefined, provider: params.get("provider") ?? undefined, model: params.get("model") ?? undefined, status: params.get("status") ?? undefined, q: params.get("q") ?? undefined });
    const href = URL.createObjectURL(new Blob([ledgerCsv(rows)], { type: "text/csv" }));
    const link = Object.assign(document.createElement("a"), { href, download: "northwind-labs-usage-sample.csv" });
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
    notify(`Demo: downloaded ${rows.length} sample ledger rows.`);
  }, true);
}

/** First visit: open a saved AI chat and a prepared meeting so those pages start populated. */
function seedPreferences(store: DemoStore) {
  const identity = `${store.orgId}:${OWNER_ID}`;
  const prepared = store.events.find((event) => event.title === "Initech — pilot scoping workshop" && store.reports[event.id]?.length);
  const seeds: Array<[string, unknown]> = [
    [`meetings-ai:knowledge-conversation:${identity}`, store.conversations.some((item) => item.id === FEATURED_CONVERSATION) ? FEATURED_CONVERSATION : null],
    [`meetings-ai:prep-event:${identity}`, prepared?.id ?? null],
  ];
  try {
    for (const [key, value] of seeds) if (value && window.localStorage.getItem(key) === null) window.localStorage.setItem(key, JSON.stringify(value));
  } catch { /* Pages still work without the preselection. */ }
}

export function installDemo(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const store = createStore();
  const router = buildRouter();
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = isDemoActive() ? apiUrl(input) : null;
    if (!url) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = init?.body ?? (input instanceof Request && method !== "GET" ? await input.clone().text() : null);
    await wait(RESPONSE_LATENCY_MS);
    return router.handle(store, method, url, { body, headers: init?.headers });
  };
  interceptDownloads(store);
  seedPreferences(store);
}
