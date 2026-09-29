"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, CalendarDays, Clock, NotebookPen, Users } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import { useUiPreference } from "@/lib/ui-preferences";
import type { CachedCalendarEvent, CalendarSnapshot } from "@/lib/types";
import { CalendarBrandIcon } from "./brand-icons";
import { CalendlyPill, PlatformMark, PlatformPill, SourceStack } from "./calendar-event-marks";
import { entryMatches, findEntry, mergeCalendarEvents, viaCalendly, type CalendarEntry } from "./calendar-events";
import { calendarProviderNames } from "./calendar-providers";
import { MeetingPrepPanel } from "./prep-panel";
import { EventChangeHistory, MovedFrom, RescheduledBadge } from "./calendar-change-history";
import { PageHeader } from "./ui/page-header";
import { EmptyState, LoadingRow, Skeleton } from "./ui/feedback";
import { FilterInput, NoMatches } from "./scroll-panel";
import { currentTimeSettings, formatDateTime, todayKey } from "@/lib/time-preferences";
import { addDaysToKey } from "@/lib/time-format";

export { MeetingPrepPanel } from "./prep-panel";

const listDate: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

export function MeetingPrepWorkspace({ identity, initialEvent, onOpenCalendar, onOpenOrganization, onOpenProviders }: {
  identity: string;
  initialEvent?: CachedCalendarEvent | null;
  onOpenCalendar(): void;
  onOpenOrganization(): void;
  /** Opens AI providers from setup errors (e.g. no Exa key). Pass only for owners and admins. */
  onOpenProviders?(): void;
}) {
  const [snapshot, setSnapshot] = useState<CalendarSnapshot>({ events: [], syncs: [] });
  const [selectedId, setSelectedId] = useUiPreference(`meetings-ai:prep-event:${identity}`, initialEvent?.id ?? "", (value): value is string => typeof value === "string");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [range] = useState(() => {
    // The next 90 days in the person's effective time zone.
    const first = todayKey();
    return { first, last: addDaysToKey(first, 89), timezone: currentTimeSettings().timeZone };
  });

  useEffect(() => { if (initialEvent) setSelectedId(initialEvent.id); }, [initialEvent, setSelectedId]);

  useEffect(() => {
    void meetingsService.getSyncedCalendar(range.first, range.last, range.timezone)
      .then((next) => {
        setSnapshot(next);
        setSelectedId((current) => next.events.some((event) => event.id === current) ? current : initialEvent?.id || next.events[0]?.id || "");
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load saved meetings."))
      .finally(() => setLoading(false));
  }, [range, initialEvent, setSelectedId]);

  const events = useMemo(() => {
    const items = initialEvent && !snapshot.events.some((event) => event.id === initialEvent.id)
      ? [initialEvent, ...snapshot.events] : snapshot.events;
    return [...items].sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  }, [initialEvent, snapshot.events]);
  const selectedEvent = events.find((event) => event.id === selectedId) ?? null;
  // The same meeting synced from two accounts is listed once, with both sources.
  const entries = useMemo(() => mergeCalendarEvents(events), [events]);
  const searching = Boolean(query.trim());
  const visibleEntries = searching ? entries.filter((entry) => entryMatches(entry, query, formatDateTime(entry.event.starts_at, listDate))) : entries;
  const selectedEntry = findEntry(entries, selectedId);
  const countLabel = loading ? "Next 90 days" : searching ? `${visibleEntries.length} of ${entries.length} · next 90 days` : `${entries.length} saved · next 90 days`;

  return <section className="page wide meeting-prep-workspace" aria-labelledby="meeting-prep-title">
    <PageHeader
      titleId="meeting-prep-title"
      title="Meeting prep"
      description="Build a source-backed briefing for an upcoming meeting. Nothing is researched until you ask."
      actions={<>
        <button type="button" className="button ghost" onClick={onOpenCalendar}><CalendarDays aria-hidden="true" /> Open calendar</button>
        <button type="button" className="button secondary" onClick={onOpenOrganization}><Building2 aria-hidden="true" /> Company profile</button>
      </>}
    />
    {error ? <p className="form-error prep-error" role="alert">{error}</p> : null}
    {!loading && !events.length ? <EmptyState icon={<CalendarDays />} title="No saved upcoming meetings" action={<button type="button" className="button secondary" onClick={onOpenCalendar}>Go to Calendar</button>}>Connect and sync a meeting source in Calendar, then come back to prepare.</EmptyState> : <div className="prep-layout">
      <aside className="card prep-list" aria-label="Meetings to prepare">
        <div className="card-header">
          <div><h2>Upcoming meetings</h2><p>{countLabel}</p></div>
        </div>
        <div className="prep-search">
          <FilterInput id="prep-search" label="Search upcoming meetings" value={query} onChange={setQuery} placeholder="Search title, person, email or company" />
        </div>
        {loading ? <LoadingRow>Loading saved meetings…</LoadingRow> : visibleEntries.length ? <ul className="prep-event-list">
          {visibleEntries.map((entry) => <li key={entry.id}>
            <PrepEventRow entry={entry} selected={entry.sources.some((source) => source.id === selectedId)} onSelect={() => { if (!entry.sources.some((source) => source.id === selectedId)) setSelectedId(entry.event.id); }} />
          </li>)}
        </ul> : <NoMatches query={query} noun="upcoming meetings" onClear={() => setQuery("")} />}
      </aside>
      <div className="prep-main">
        {selectedEvent ? <>
          <EventSummary entry={selectedEntry ?? { id: selectedEvent.id, event: selectedEvent, sources: [selectedEvent] }} />
          <MeetingPrepPanel key={selectedEvent.id} event={selectedEvent} onOpenProviders={onOpenProviders} onOpenOrganization={onOpenOrganization} />
        </> : loading ? <div className="card card-body"><Skeleton lines={4} /></div> : <div className="card"><EmptyState plain icon={<NotebookPen />} title="Select a meeting">Its details and saved briefing appear here.</EmptyState></div>}
      </div>
    </div>}
  </section>;
}

function PrepEventRow({ entry, selected, onSelect }: { entry: CalendarEntry; selected: boolean; onSelect(): void }) {
  return <button type="button" className={selected ? "meeting-prep-event selected" : "meeting-prep-event"} aria-current={selected ? "true" : undefined} onClick={onSelect}>
    <SourceStack sources={entry.sources} connections={[]} size="sm" />
    <span className="prep-event-copy">
      <b>{entry.event.title}</b>
      <small><time dateTime={entry.event.starts_at}>{formatDateTime(entry.event.starts_at, listDate)}</time><PlatformMark event={entry.event} /></small>
    </span>
  </button>;
}

function EventSummary({ entry }: { entry: CalendarEntry }) {
  const { event } = entry;
  const starts = new Date(event.starts_at);
  const invitees = event.invitees?.length ?? 0;
  // A Calendly-only booking is named by its "Scheduled via Calendly" pill instead.
  const providers = entry.sources.map((source) => source.provider).filter((provider, index, all) => provider !== "calendly" && all.indexOf(provider) === index);
  return <header className="card prep-summary-card">
    <div className="prep-summary-source">
      {providers.length ? <span className="prep-summary-providers">{providers.map((provider) => <span key={provider}><CalendarBrandIcon provider={provider} size="xs" />{calendarProviderNames[provider]}</span>)}</span> : null}
      <PlatformPill event={event} />
      {viaCalendly(entry) ? <CalendlyPill /> : null}
      <RescheduledBadge from={event.rescheduled_from} />
    </div>
    <h2>{event.title}</h2>
    <ul className="prep-summary-facts">
      <li><Clock aria-hidden="true" />{formatDateTime(starts, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}{event.rescheduled_from ? <MovedFrom from={event.rescheduled_from} /> : null}</li>
      <li><Users aria-hidden="true" />{invitees} invited {invitees === 1 ? "person" : "people"}</li>
    </ul>
    {event.agenda ? <p className="prep-summary-agenda"><b>Agenda</b>{event.agenda}</p> : null}
    {event.rescheduled_from ? <EventChangeHistory key={event.id} eventId={event.id} /> : null}
  </header>;
}
