"use client";

import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { AssistantCapacity } from "@/lib/types";
import { formatDateTime } from "@/lib/time-preferences";

const POLL_MS = 30_000;

/** The assistant server's capacity, refreshed every 30 s while shown; null until the first answer. */
export function useAssistantCapacity(): AssistantCapacity | null {
  const [capacity, setCapacity] = useState<AssistantCapacity | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => void meetingsService.getAssistantCapacity().then((next) => { if (active) setCapacity(next); }).catch(() => undefined);
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return capacity;
}

function summary(capacity: AssistantCapacity): string {
  if (capacity.error || capacity.limit === null) return "Couldn't reach the assistant service";
  const free = capacity.available ?? 0;
  const parts = [free ? `${free} free` : "All in calls"];
  if (capacity.waiting) parts.push(`${capacity.waiting} waiting`);
  return parts.join(" · ");
}

/** Overview tile: "2 / 3 assistants in calls · 1 free". */
export function AssistantCapacityStat() {
  const capacity = useAssistantCapacity();
  const value = capacity && capacity.limit !== null && capacity.in_use !== null ? `${capacity.in_use} / ${capacity.limit}` : "—";
  const full = capacity?.available === 0;
  return <article className={full ? "stat capacity-stat full" : "stat capacity-stat"}>
    <span className="stat-label"><Bot aria-hidden="true" />Assistants in calls</span>
    <strong className="stat-value">{value}</strong>
    <span className="stat-hint">{capacity ? summary(capacity) : "Checking…"}</span>
  </article>;
}

/** Observability: the limit, what's in use, what waits, and what the server was tested to hold. */
export function AssistantCapacityCard() {
  const capacity = useAssistantCapacity();
  const limit = capacity?.limit ?? null;
  const inUse = capacity?.in_use ?? null;
  const share = limit && inUse !== null ? Math.min(inUse / limit, 1) : 0;
  return <section className="card capacity-card" aria-labelledby="capacity-title">
    <div className="card-header">
      <div><h2 id="capacity-title">Meeting assistants</h2><p>How many assistants can be in calls at the same time. The limit is shared by every workspace.</p></div>
      {capacity ? <span className="section-count">Checked {formatDateTime(capacity.checked_at)}</span> : null}
    </div>
    <div className="card-body capacity-body">
      {!capacity ? <p className="field-hint">Checking the assistant service…</p>
        : capacity.error ? <p className="inline-error" role="alert">{capacity.error}</p>
        : <>
          <div className="capacity-meter" role="meter" aria-label="Assistants in calls" aria-valuemin={0} aria-valuemax={limit ?? 0} aria-valuenow={inUse ?? 0}>
            <span style={{ transform: `scaleX(${share})` }} />
          </div>
          <dl className="capacity-facts">
            <div><dt>In calls now</dt><dd>{inUse} of {limit}</dd></div>
            <div><dt>Free</dt><dd>{capacity.available}</dd></div>
            <div><dt>Waiting for an assistant</dt><dd>{capacity.waiting}</dd></div>
            <div><dt>Server tested to hold</dt><dd>{capacity.tested_capacity ?? "Not load-tested yet"}</dd></div>
          </dl>
          <p className="field-hint">When every assistant is busy, a new join waits and goes in as soon as one is free, for up to 10 minutes after its start. Going beyond one server is planned in the scaling design.</p>
        </>}
    </div>
  </section>;
}
