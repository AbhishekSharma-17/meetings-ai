"use client";

import { useState } from "react";
import { matchesQuery, shouldOfferSearch, type SearchField } from "@/lib/search";

export type ListSearch<T> = {
  query: string;
  setQuery(value: string): void;
  clear(): void;
  /** Whether the list is long enough (or a query is active) to show its search box. */
  offered: boolean;
  /** Items matching the query (all items when the query is blank). */
  visible: T[];
  /** True when a query hides every item of a non-empty list: show `NoMatches`, not the "nothing yet" state. */
  noMatches: boolean;
};

/** Client-side search state for one list, using the shared matcher and "offer search above 5 items" rule. */
export function useListSearch<T>(items: readonly T[], fields: (item: T) => SearchField[]): ListSearch<T> {
  const [query, setQuery] = useState("");
  const visible = query.trim() ? items.filter((item) => matchesQuery(query, fields(item))) : [...items];
  return {
    query, setQuery, clear: () => setQuery(""),
    offered: shouldOfferSearch(items.length, query),
    visible,
    noMatches: items.length > 0 && visible.length === 0,
  };
}
