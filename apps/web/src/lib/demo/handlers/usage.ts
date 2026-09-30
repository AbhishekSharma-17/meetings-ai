import type { StorageCategoryKey, StoragePurgeResult } from "../../types";
import { storageSummary } from "../fixtures/storage";
import { filterLedger, summarize } from "../fixtures/usage";
import { json, problem, str, strList, wait } from "../http";
import type { DemoRouter } from "../router";
import { type DemoStore, storageItems } from "../store";
import { refreshBaseCounts } from "./meetings";

const CATEGORIES: StorageCategoryKey[] = ["meetings", "meeting_preps", "documents", "search_index", "knowledge_bases", "ai_chats", "calendar_cache", "logs"];
const BUSY = new Set(["live", "waiting_room", "joining"]);

function filtersFrom(query: URLSearchParams) {
  return {
    since: query.get("since"), until: query.get("until"), kind: query.get("kind") ?? undefined, purpose: query.get("purpose") ?? undefined, provider: query.get("provider") ?? undefined,
    model: query.get("model") ?? undefined, status: query.get("status") ?? undefined, meeting_id: query.get("meeting_id") ?? undefined, q: query.get("q") ?? undefined,
  };
}

function totalBytes(store: DemoStore): number {
  return Object.values(storageItems(store)).flat().reduce((sum, item) => sum + item.bytes, 0);
}

/** Applies a purge to the in-memory sample data and reports what changed. */
function purge(store: DemoStore, category: StorageCategoryKey, ids: string[] | null, olderThanDays: number | null): StoragePurgeResult {
  const before = totalBytes(store);
  const cutoff = olderThanDays ? Date.now() - olderThanDays * 86_400_000 : null;
  const items = storageItems(store)[category];
  const chosen = items.filter((item) => (ids ? ids.includes(item.id) : cutoff !== null && item.created_at !== null && new Date(item.created_at).getTime() < cutoff));
  const skipped: StoragePurgeResult["skipped"] = [];
  const removable = chosen.filter((item) => {
    const seed = category === "meetings" ? store.seeds.find((entry) => entry.meeting.id === item.id) : undefined;
    if (seed && BUSY.has(seed.meeting.status)) { skipped.push({ id: item.id, reason: "stop the assistant and wait for capture to finish before deleting this meeting" }); return false; }
    return true;
  });
  const gone = new Set(removable.map((item) => item.id));
  if (category === "meetings") { store.seeds = store.seeds.filter((seed) => !gone.has(seed.meeting.id)); refreshBaseCounts(store); }
  else if (category === "ai_chats") store.conversations = store.conversations.filter((item) => !gone.has(item.id));
  else if (category === "meeting_preps") store.reports = Object.fromEntries(Object.entries(store.reports).map(([key, list]) => [key, list.filter((report) => !gone.has(report.id))]));
  else if (category === "documents") store.briefDocuments = store.briefDocuments.filter((doc) => !gone.has(doc.id));
  else if (category === "knowledge_bases") { store.bases = store.bases.filter((base) => !gone.has(base.id)); store.conversations = store.conversations.filter((item) => !gone.has(item.knowledge_base_id)); }
  else store.purged = { ...store.purged, [category]: [...(store.purged[category] ?? []), ...gone] };
  const after = totalBytes(store);
  const rows = removable.reduce((sum, item) => sum + item.rows, 0);
  return {
    category, deleted: rows ? { [category]: removable.length, rows } : {}, skipped, remaining: storageItems(store)[category].length,
    reindex_queued: category === "search_index" ? removable.length : 0, kept: {}, bytes_before: before, bytes_after: after, bytes_freed_estimate: Math.max(0, before - after),
  };
}

export function registerUsage(router: DemoRouter): void {
  router
    .on("GET", "/v1/assistants/capacity", ({ store }) => {
      const inUse = Math.min(store.seeds.filter((seed) => ["live", "joining", "waiting_room"].includes(seed.meeting.status)).length, 3);
      return json({ limit: 3, in_use: inUse, available: 3 - inUse, waiting: 0, tested_capacity: null, checked_at: new Date().toISOString(), error: null });
    })
    .on("GET", "/v1/workspace/usage", ({ store, query }) => {
      const filters = filtersFrom(query);
      return json(summarize(filterLedger(store.usage, filters), filters.since, filters.until));
    })
    .on("GET", "/v1/workspace/usage/events", ({ store, query }) => {
      const rows = filterLedger(store.usage, filtersFrom(query));
      const start = Number(query.get("cursor") ?? 0) || 0;
      const limit = Math.min(200, Number(query.get("limit") ?? 50) || 50);
      return json({ items: rows.slice(start, start + limit), next_cursor: start + limit < rows.length ? String(start + limit) : null, total: rows.length });
    })
    .on("GET", "/v1/workspace/storage", async ({ store, query }) => {
      const capture = query.get("include_capture") === "true";
      if (capture) await wait(900);
      return json(storageSummary(store.clock, store.orgId, storageItems(store), capture, store.seeds.filter((seed) => seed.segments.length).length));
    })
    .on("GET", "/v1/workspace/storage/items", ({ store, query }) => {
      const category = CATEGORIES.find((item) => item === query.get("category"));
      if (!category) return problem(422, "Unknown storage category.");
      const q = (query.get("q") ?? "").trim().toLowerCase();
      const items = storageItems(store)[category].filter((item) => !q || `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(q));
      return json({ category, items: items.slice(0, Number(query.get("limit") ?? 200) || 200) });
    })
    .on("POST", "/v1/workspace/storage/purge", async ({ store, body }) => {
      const category = CATEGORIES.find((item) => item === str(body.category));
      if (!category || str(body.confirm) !== "DELETE") return problem(422, "Choose a category and confirm with DELETE.");
      await wait(700);
      const ids = Array.isArray(body.ids) ? strList(body.ids) : null;
      const days = typeof body.older_than_days === "number" ? body.older_than_days : null;
      return json(purge(store, category, ids, days));
    });
}
