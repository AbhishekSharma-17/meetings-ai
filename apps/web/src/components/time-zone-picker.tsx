"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Search } from "lucide-react";
import { filterTimeZones, timeZoneOptions, type TimeZoneOption } from "@/lib/time-zones";

/** Rows rendered at once; typing narrows the rest. */
const RESULT_LIMIT = 80;

/**
 * Searchable, keyboard-driven time zone list (ARIA combobox with an inline listbox).
 * Type a city, country region, abbreviation ("IST"), long name ("Eastern") or offset ("+5:30").
 */
export function TimeZonePicker({ value, onChange, disabled = false, label = "Search time zones", autoFocus = false }: {
  value: string;
  onChange(zone: string): void;
  disabled?: boolean;
  label?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const all = useMemo(() => timeZoneOptions([value]), [value]);
  const found = useMemo(() => filterTimeZones(all, query), [all, query]);
  const shown = useMemo(() => orderWithCurrentFirst(found, value, query).slice(0, RESULT_LIMIT), [found, value, query]);
  const activeIndex = Math.min(active, Math.max(0, shown.length - 1));
  const activeOption = shown[activeIndex];

  function move(next: number) {
    const index = Math.max(0, Math.min(shown.length - 1, next));
    setActive(index);
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 };
    if (event.key in steps) { event.preventDefault(); move(activeIndex + steps[event.key]); return; }
    if (event.key === "Home" && event.ctrlKey) { event.preventDefault(); move(0); return; }
    if (event.key === "End" && event.ctrlKey) { event.preventDefault(); move(shown.length - 1); return; }
    if (event.key === "Enter" && activeOption) { event.preventDefault(); onChange(activeOption.id); }
  }

  const hidden = found.length - shown.length;
  return <div className="tz-picker">
    <div className="input-with-icon tz-picker-search">
      <Search aria-hidden="true" />
      <input id={`${id}-input`} type="search" role="combobox" aria-label={label} aria-expanded="true" aria-controls={listId}
        aria-autocomplete="list" aria-activedescendant={activeOption ? `${id}-${activeOption.id}` : undefined}
        placeholder="City, region, IST, +5:30…" value={query} disabled={disabled} autoComplete="off" spellCheck={false} autoFocus={autoFocus}
        onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKeyDown} />
    </div>
    <ul ref={listRef} id={listId} role="listbox" aria-label="Time zones" className="tz-picker-list">
      {shown.map((option, index) => <li key={option.id} id={`${id}-${option.id}`} role="option" aria-selected={option.id === value} data-index={index}
        data-active={index === activeIndex || undefined} className="tz-picker-option" aria-disabled={disabled || undefined}
        onMouseMove={() => { if (index !== activeIndex) setActive(index); }} onMouseDown={(event) => event.preventDefault()}
        onClick={() => { if (!disabled) onChange(option.id); }}>
        <ZoneRow option={option} selected={option.id === value} />
      </li>)}
    </ul>
    <p className="tz-picker-status" role="status">
      {!shown.length ? `No time zone matches “${query.trim()}”.` : hidden > 0 ? `Showing ${shown.length} of ${found.length}. Type to narrow.` : ""}
    </p>
  </div>;
}

function ZoneRow({ option, selected }: { option: TimeZoneOption; selected: boolean }) {
  return <>
    <span className="tz-picker-offset">{option.offsetLabel}</span>
    <span className="tz-picker-copy"><b>{option.city}</b><small>{option.longName || option.region} · {option.abbreviation}</small></span>
    {selected ? <Check className="tz-picker-check" aria-hidden="true" /> : null}
  </>;
}

function orderWithCurrentFirst(options: TimeZoneOption[], value: string, query: string): TimeZoneOption[] {
  if (query.trim()) return options;
  const current = options.find((option) => option.id === value);
  return current ? [current, ...options.filter((option) => option !== current)] : options;
}
