"use client";

import { useCallback, useRef, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { ModelCatalog, ModelCatalogQuery } from "@/lib/types";

/** One catalog request. `key` identifies it (never contains the pasted API key itself). */
export type CatalogRequest = { key: string; query: ModelCatalogQuery; apiKey?: string };

export type CatalogStatus = "idle" | "loading" | "ready" | "error";

export type CatalogState = {
  status: CatalogStatus;
  catalog: ModelCatalog | null;
  error: string | null;
  /** Load on first use (focus/open); no-op while loading or once loaded for the same request. */
  load(): void;
  retry(): void;
};

type Snapshot = { key: string; status: CatalogStatus; catalog: ModelCatalog | null; error: string | null };
const IDLE: Snapshot = { key: "", status: "idle", catalog: null, error: null };

/** Lazily loads a live model list; changing the request resets it until the next `load()`. */
export function useModelCatalog(request: CatalogRequest | null): CatalogState {
  const [snapshot, setSnapshot] = useState<Snapshot>(IDLE);
  const latest = useRef<string>("");
  const current = request && snapshot.key === request.key ? snapshot : IDLE;

  const fetchCatalog = useCallback((force: boolean) => {
    if (!request) return;
    if (!force && snapshot.key === request.key && (snapshot.status === "loading" || snapshot.status === "ready")) return;
    latest.current = request.key;
    setSnapshot({ key: request.key, status: "loading", catalog: null, error: null });
    meetingsService.browseModelCatalog(request.query, request.apiKey)
      .then((catalog) => { if (latest.current === request.key) setSnapshot({ key: request.key, status: "ready", catalog, error: null }); })
      .catch((cause: unknown) => {
        if (latest.current !== request.key) return;
        setSnapshot({ key: request.key, status: "error", catalog: null, error: cause instanceof Error ? cause.message : "Models could not be loaded." });
      });
  }, [request, snapshot.key, snapshot.status]);

  return {
    status: current.status,
    catalog: current.catalog,
    error: current.error,
    load: () => fetchCatalog(false),
    retry: () => fetchCatalog(true),
  };
}
