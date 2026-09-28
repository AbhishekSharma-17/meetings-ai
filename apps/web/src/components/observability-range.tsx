"use client";

import type { UsageRange } from "@/lib/types";
import { UiSelect } from "./ui-select";
import { currentTimeSettings, todayKey } from "@/lib/time-store";
import { addDaysToKey, wallTimeToDate } from "@/lib/time-format";

const startOfDay = (key: string): Date | null => wallTimeToDate(`${key}T00:00`, currentTimeSettings().timeZone);

export type RangePreset = "7" | "30" | "90" | "all" | "custom";
export type RangeChoice = { preset: RangePreset; from: string; to: string };

const presets: Array<{ value: RangePreset; label: string }> = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
  { value: "custom", label: "Custom range" },
];

/** Converts the picker choice to the API's half-open [since, until) window in UTC. */
export function rangeFor(choice: RangeChoice): UsageRange {
  if (choice.preset === "all") return { since: null, until: null };
  if (choice.preset === "custom") {
    // Dates are whole days in the person's time zone; "to" includes that whole day.
    const since = choice.from ? startOfDay(choice.from) : null;
    const until = choice.to ? startOfDay(addDaysToKey(choice.to, 1)) : null;
    if (since && until && since >= until) return { since: since.toISOString(), until: null };
    return { since: since?.toISOString() ?? null, until: until?.toISOString() ?? null };
  }
  const since = startOfDay(addDaysToKey(todayKey(), 1 - Number(choice.preset)));
  return { since: since?.toISOString() ?? null, until: null };
}

export function RangePicker({ value, onChange }: { value: RangeChoice; onChange(value: RangeChoice): void }) {
  return <div className="obs-range">
    <UiSelect id="obs-range" label="Period" hideLabel size="sm" value={value.preset} options={presets}
      onChange={(preset) => onChange({ ...value, preset: preset as RangePreset })} />
    {value.preset === "custom" ? <div className="obs-range-dates">
      <label className="sr-only" htmlFor="obs-range-from">From date</label>
      <input id="obs-range-from" type="date" value={value.from} max={value.to || undefined} onChange={(event) => onChange({ ...value, from: event.target.value })} />
      <span aria-hidden="true">–</span>
      <label className="sr-only" htmlFor="obs-range-to">To date</label>
      <input id="obs-range-to" type="date" value={value.to} min={value.from || undefined} onChange={(event) => onChange({ ...value, to: event.target.value })} />
    </div> : null}
  </div>;
}
