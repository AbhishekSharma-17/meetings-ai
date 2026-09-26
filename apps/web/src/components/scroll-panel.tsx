"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search, SearchX, X } from "lucide-react";
import { EmptyState } from "./ui/feedback";

/**
 * Card body that scrolls on its own instead of growing the page. Edge shadows appear only when
 * there is more content above or below; table headers inside stay sticky (see settings.css).
 */
export function ScrollPanel({ label, children, className = "", size = "md" }: { label: string; children: ReactNode; className?: string; size?: "md" | "sm" }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ above: false, below: false });

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => {
      const above = element.scrollTop > 1;
      const below = element.scrollTop + element.clientHeight < element.scrollHeight - 1;
      setEdges((current) => current.above === above && current.below === below ? current : { above, below });
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => { element.removeEventListener("scroll", update); observer.disconnect(); };
  }, [children]);

  return <div className={`scroll-panel ${className}`.trim()} data-size={size} data-above={edges.above || undefined} data-below={edges.below || undefined}>
    <div ref={viewport} className="scroll-panel-viewport" role="region" aria-label={label} tabIndex={0}>{children}</div>
  </div>;
}

/** Compact search box for card headers. */
export function FilterInput({ id, label, value, onChange, placeholder }: { id: string; label: string; value: string; onChange(value: string): void; placeholder: string }) {
  return <div className="input-with-icon filter-input">
    <Search aria-hidden="true" />
    <input id={id} type="search" aria-label={label} value={value} placeholder={placeholder} autoComplete="off" spellCheck={false}
      onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape" && value) { event.preventDefault(); onChange(""); } }} />
    {value ? <button type="button" className="filter-input-clear" aria-label="Clear search" onClick={() => onChange("")}><X aria-hidden="true" /></button> : null}
  </div>;
}

/** Shared "nothing matches" state for filtered lists and tables. */
export function NoMatches({ query, noun, onClear }: { query: string; noun: string; onClear(): void }) {
  return <EmptyState plain className="no-matches" icon={<SearchX />} title={query.trim() ? `No ${noun} match “${query.trim()}”` : `No ${noun} match these filters`}
    action={<button type="button" className="button secondary sm" onClick={onClear}>Clear filters</button>}>
    Try a different name, word or category.
  </EmptyState>;
}

/** Case-insensitive match of every word in the query against any of the given fields. */
export function matchesQuery(query: string, fields: Array<string | null | undefined>): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}
