"use client";

import { useEffect, useState } from "react";
import { CalendarClock, CalendarX2, History, Link2 } from "lucide-react";
import { calendarChangeService } from "@/lib/meetings-service";
import { formatDateTime } from "@/lib/time-preferences";
import { formatRelative } from "@/lib/time-format";
import type { CalendarChangeHistory, CalendarEventChange } from "@/lib/types";
import { calendarProviderNames, type CalendarProvider } from "./calendar-providers";
import { FilterInput, NoMatches } from "./scroll-panel";
import { useListSearch } from "./use-list-search";
import { Badge, EmptyState, LoadingRow } from "./ui/feedback";

const WEEK_MS = 6 * 86_400_000;
const withDay: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
const dayOnly: Intl.DateTimeFormatOptions = { weekday: "short", hour: "numeric", minute: "2-digit" };

export function providerLabel(provider: string | null | undefined): string {
  return calendarProviderNames[provider as CalendarProvider] ?? "the calendar";
}

/** "Mon 3:00 PM" within a week of now, otherwise "Mon, Sep 22, 3:00 PM" (the person's zone and clock). */
export function shortMoment(value: string): string {
  const near = Math.abs(new Date(value).getTime() - Date.now()) < WEEK_MS;
  return formatDateTime(value, near ? dayOnly : withDay);
}

/** Subtle marker that the calendar moved this event since it was scheduled or synced. */
export function RescheduledBadge({ from }: { from: string | null | undefined }) {
  if (!from) return null;
  return <Badge tone="warning" className="rescheduled-badge"><CalendarClock aria-hidden="true" />Rescheduled</Badge>;
}

export function MovedFrom({ from }: { from: string | null | undefined }) {
  if (!from) return null;
  return <span className="moved-from">Moved from <time dateTime={from}>{shortMoment(from)}</time></span>;
}

/** "Last checked with Google Calendar 2 min ago" for a calendar-backed scheduled join. */
export function LastChecked({ provider, at }: { provider: string | null | undefined; at: string | null | undefined }) {
  if (!provider || provider === "manual") return null;
  return <span className="last-checked">{at ? <>Last checked with {providerLabel(provider)} <time dateTime={at}>{formatRelative(at)}</time></> : `Watching ${providerLabel(provider)} for changes`}</span>;
}

function linkLabel(url: string | null): string {
  if (!url) return "no link";
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch { return url; }
}

function describe(change: CalendarEventChange): { icon: typeof History; title: string; detail: string } {
  const provider = providerLabel(change.provider);
  if (change.kind === "moved") {
    return { icon: CalendarClock, title: `Moved to ${change.new_starts_at ? shortMoment(change.new_starts_at) : "a new time"}`,
      detail: change.old_starts_at ? `Was ${shortMoment(change.old_starts_at)}` : `Changed in ${provider}` };
  }
  if (change.kind === "cancelled") {
    return { icon: CalendarX2, title: `Cancelled in ${provider}`, detail: change.old_starts_at ? `Was ${shortMoment(change.old_starts_at)}` : "The assistant won't join" };
  }
  if (change.kind === "link_changed") {
    return { icon: Link2, title: "Meeting link changed", detail: `Now ${linkLabel(change.new_meeting_url)}` };
  }
  return { icon: History, title: "Restored", detail: `Back on ${provider}` };
}

function searchFields(change: CalendarEventChange): string[] {
  const { title, detail } = describe(change);
  return [title, detail, change.source === "sync" ? "sync" : "automatic check", providerLabel(change.provider)];
}

function ChangeRow({ change }: { change: CalendarEventChange }) {
  const { icon: Icon, title, detail } = describe(change);
  return <li className="change-row">
    <span className="change-icon" data-kind={change.kind} aria-hidden="true"><Icon /></span>
    <span className="change-copy">
      <b>{title}</b>
      <small>{detail} · noticed <time dateTime={change.detected_at} title={formatDateTime(change.detected_at, withDay)}>{formatRelative(change.detected_at)}</time>{change.source === "sync" ? " during a sync" : ""}</small>
    </span>
  </li>;
}

/** Compact, searchable (above five entries) list of detected calendar changes. */
export function ChangeHistoryList({ items, idPrefix }: { items: CalendarEventChange[]; idPrefix: string }) {
  const search = useListSearch(items, searchFields);
  return <div className="change-history">
    {search.offered ? <FilterInput id={`${idPrefix}-change-search`} label="Search calendar changes" value={search.query} onChange={search.setQuery} placeholder="Search changes" className="change-search" /> : null}
    {search.noMatches ? <NoMatches query={search.query} noun="changes" onClear={search.clear} />
      : <ol className="change-list">{search.visible.map((change) => <ChangeRow key={change.id} change={change} />)}</ol>}
  </div>;
}

type LoadState = { history: CalendarChangeHistory | null; error: string | null; loading: boolean };

/** Loads a history; `reloadKey` changes when the data can have changed (e.g. the schedule moved). */
function useChangeHistory(scope: "meeting" | "event", id: string, reloadKey: string): LoadState {
  const [state, setState] = useState<LoadState>({ history: null, error: null, loading: true });
  useEffect(() => {
    let current = true;
    const request = scope === "meeting" ? calendarChangeService.forMeeting(id) : calendarChangeService.forCalendarEvent(id);
    void request.then((history) => { if (current) setState({ history, error: null, loading: false }); })
      .catch(() => { if (current) setState((previous) => ({ history: previous.history, error: "Calendar changes could not be loaded.", loading: false })); });
    return () => { current = false; };
  }, [scope, id, reloadKey]);
  return state;
}

/** Side card on a scheduled meeting: when the calendar was last checked and what changed. */
export function ScheduleChangesCard({ meetingId, provider, reloadKey }: { meetingId: string; provider: string | null | undefined; reloadKey: string }) {
  const { history, error, loading } = useChangeHistory("meeting", meetingId, reloadKey);
  const items = history?.items ?? [];
  return <section className="card schedule-changes" aria-labelledby="schedule-changes-title">
    <div className="card-header">
      <div><h2 id="schedule-changes-title">Calendar changes {items.length ? <span className="section-count">{items.length}</span> : null}</h2>
        <p>The assistant follows moves and cancellations in {providerLabel(provider)}.</p></div>
    </div>
    <div className="card-body">
      {loading && !history ? <LoadingRow>Loading calendar changes…</LoadingRow>
        : error && !history ? <p className="form-error" role="alert">{error}</p>
        : items.length ? <ChangeHistoryList items={items} idPrefix="schedule" />
        : <EmptyState plain icon={<History />} title="No changes detected">If the event moves or is cancelled, it shows up here and in your notifications.</EmptyState>}
    </div>
  </section>;
}

/** Block in a synced event's detail: shown only when the calendar has changed this event. */
export function EventChangeHistory({ eventId }: { eventId: string }) {
  const { history, error } = useChangeHistory("event", eventId, eventId);
  if (error && !history) return <p className="field-hint" role="status">{error}</p>;
  if (!history?.items.length) return null;
  return <div className="calendar-detail-block event-changes">
    <h3>Calendar changes <span className="section-count">{history.items.length}</span></h3>
    <ChangeHistoryList items={history.items} idPrefix={`event-${eventId.slice(0, 8)}`} />
  </div>;
}
