"use client";

import type { ReactNode } from "react";
import { CalendarDays, ChevronRight, Clock, Mic, NotebookPen } from "lucide-react";
import type { CalendarConnection, CalendarInvitee } from "@/lib/types";
import { dayKeyIn } from "@/lib/time-format";
import { Avatar } from "./ui/avatar";
import { CalendarBrandIcon } from "./brand-icons";
import { CalendlyPill, PlatformMark, PlatformPill, SourceStack, entryOrigin, uniqueByAccount } from "./calendar-event-marks";
import { meetingPlatform, viaCalendly, type CalendarEntry } from "./calendar-events";
import { calendarProviderNames, platformLabel } from "./calendar-providers";
import { Badge, EmptyState } from "./ui/feedback";
import { FilterInput, NoMatches } from "./scroll-panel";
import { useListSearch } from "./use-list-search";
import { EventChangeHistory, MovedFrom, RescheduledBadge } from "./calendar-change-history";
import { formatDate, formatDateTime, formatDayHeading, formatTime, todayKey } from "@/lib/time-preferences";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CHIPS_PER_DAY = 2;

export function dayKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

/** The day ("YYYY-MM-DD") an event starts on in the given zone. */
export function eventDay(value: string, timezone: string): string {
  return dayKeyIn(value, timezone);
}

const eventTime = (value: string): string => formatTime(value);

function dayLabel(day: Date, entries: CalendarEntry[]): string {
  const accounts = uniqueByAccount(entries.flatMap((entry) => entry.sources)).length;
  return `${day.toDateString()}, ${entries.length} meetings${accounts > 1 ? `, from ${accounts} accounts` : ""}`;
}

/** Six-week month grid. Each day is a button named "<date>, N meetings[, from N accounts]". */
export function MonthGrid({ month, days, selectedDay, entriesByDay, connections, onSelectDay }: {
  month: Date;
  days: Date[];
  selectedDay: string;
  entriesByDay: Map<string, CalendarEntry[]>;
  connections: CalendarConnection[];
  onSelectDay(key: string): void;
}) {
  // "Today" is the date in the person's chosen zone, not the machine's.
  const today = todayKey();
  return <div className="card calendar-month" role="group" aria-label="Month view">
    <div className="calendar-weekdays" aria-hidden="true">{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div>
    <div className="calendar-days">
      {days.map((day) => {
        const key = dayKey(day);
        const matches = entriesByDay.get(key) ?? [];
        const hidden = matches.slice(CHIPS_PER_DAY);
        const classes = ["calendar-day", day.getMonth() !== month.getMonth() ? "outside" : "", key === selectedDay ? "selected" : "", key === today ? "today" : ""].filter(Boolean).join(" ");
        return <button type="button" key={key} className={classes} aria-label={dayLabel(day, matches)} aria-pressed={key === selectedDay} aria-current={key === today ? "date" : undefined} onClick={() => onSelectDay(key)}>
          <span className="calendar-day-head">
            <span className="calendar-day-number">{day.getDate()}</span>
            {key === today ? <span className="calendar-today-label">Today</span> : null}
            {matches.length ? <span className="calendar-day-sources" aria-hidden="true"><SourceStack sources={matches.flatMap((entry) => entry.sources)} connections={connections} decorative /></span> : null}
          </span>
          {matches.length ? <span className="calendar-day-events" aria-hidden="true">
            {matches.slice(0, CHIPS_PER_DAY).map((entry) => <span key={entry.id} className="calendar-chip" title={`${eventTime(entry.event.starts_at)} · ${entry.event.title}`}>
              <SourceStack sources={entry.sources} connections={connections} />
              <span className="calendar-chip-title">{entry.event.title}</span>
            </span>)}
            {hidden.length ? <span className="calendar-chip-more">
              +{hidden.length} more
              <SourceStack sources={hidden.flatMap((entry) => entry.sources)} connections={connections} />
            </span> : null}
          </span> : null}
        </button>;
      })}
    </div>
  </div>;
}

/** Meetings on the selected day, with a jump list when the day itself is empty. */
export function DayAgenda({ selectedDay, dayEntries, rangeEntries, selectedEventId, hasAccounts, connections, query = "", searchedCount = 0, onClearQuery, onSelectEntry, onJumpToEntry, markFor }: {
  selectedDay: string;
  /** Optional extra mark per row (call coordination: "Asha's assistant"). */
  markFor?(entry: CalendarEntry): ReactNode;
  /** Active calendar search; entries arrive already filtered by it. */
  query?: string;
  /** How many meetings the search ran over; "no matches" only makes sense when there were some. */
  searchedCount?: number;
  onClearQuery?(): void;
  dayEntries: CalendarEntry[];
  rangeEntries: CalendarEntry[];
  selectedEventId: string | null;
  hasAccounts: boolean;
  connections: CalendarConnection[];
  onSelectEntry(entry: CalendarEntry): void;
  onJumpToEntry(entry: CalendarEntry): void;
}) {
  const title = formatDayHeading(selectedDay);
  const isSelected = (entry: CalendarEntry) => entry.sources.some((source) => source.id === selectedEventId);
  const searching = Boolean(query.trim()) && searchedCount > 0;
  return <section className="card calendar-agenda" aria-labelledby="calendar-agenda-title">
    <div className="card-header">
      <div><h2 id="calendar-agenda-title">{title}</h2><p>{dayEntries.length} meeting{dayEntries.length === 1 ? "" : "s"} · {rangeEntries.length} in range</p></div>
    </div>
    {dayEntries.length ? <ul className="calendar-agenda-list">
      {dayEntries.map((entry) => {
        const platform = meetingPlatform(entry.event);
        return <li key={entry.id}>
          <button type="button" className={isSelected(entry) ? "calendar-agenda-event selected" : "calendar-agenda-event"} aria-pressed={isSelected(entry)} onClick={() => onSelectEntry(entry)}>
            <time className="calendar-agenda-time" dateTime={entry.event.starts_at}>{eventTime(entry.event.starts_at)}</time>
            <span className="calendar-agenda-copy">
              <b>{entry.event.title}</b>
              <small className="calendar-event-meta">
                <SourceStack sources={entry.sources} connections={connections} />
                <span className="calendar-event-origin">{entryOrigin(entry, connections)}</span>
                <span className="calendar-meta-sep" aria-hidden="true">·</span>
                <PlatformMark event={entry.event} decorative />
                <span>{platform ? platformLabel(platform) : "No video link"}</span>
                {entry.event.rescheduled_from ? <><span className="calendar-meta-sep" aria-hidden="true">·</span><span className="calendar-event-moved">Rescheduled</span></> : null}
                {markFor?.(entry)}
              </small>
            </span>
            <ChevronRight className="row-arrow" aria-hidden="true" />
          </button>
        </li>;
      })}
    </ul> : searching && !rangeEntries.length && onClearQuery ? <NoMatches query={query} noun="meetings in this range" onClear={onClearQuery} /> : <div className="card-body">
      <EmptyState plain icon={<CalendarDays />} title={searching ? "No matching meetings on this day" : "No meetings on this day"}>{searching ? "Choose one of the matches below, or another day." : hasAccounts ? "Sync your accounts or choose another day." : "Connect an account in Integrations, then sync."}</EmptyState>
    </div>}
    {rangeEntries.length && !dayEntries.length ? <div className="calendar-other-events">
      <h3>{searching ? "Matching meetings in range" : "Other meetings in range"}</h3>
      <ul>{rangeEntries.slice(0, 10).map((entry) => <li key={entry.id}>
        <button type="button" onClick={() => onJumpToEntry(entry)}>
          <span className="calendar-other-date">{formatDate(entry.event.starts_at, { month: "short", day: "numeric" })}</span>
          <span className="calendar-other-title">{entry.event.title}</span>
          <span className="calendar-other-source"><SourceStack sources={entry.sources} connections={connections} /><PlatformMark event={entry.event} /></span>
        </button>
      </li>)}</ul>
    </div> : null}
  </section>;
}

/** Everything known about one meeting, every account it came from, plus the next step. */
export function EventDetail({ entry, connections, canSchedule, alreadyScheduled, onSchedule, onPrepare, onRecordInPerson, coordination }: {
  entry: CalendarEntry | null;
  /** Records this meeting in person from this device (title, invitees and the event link carry over). */
  onRecordInPerson?(): void;
  /** Optional block about teammates' assistants for this call (call coordination). */
  coordination?: ReactNode;
  connections: CalendarConnection[];
  canSchedule: boolean;
  alreadyScheduled: boolean;
  onSchedule(): void;
  onPrepare(): void;
}) {
  if (!entry) return <aside className="card calendar-event-detail empty" aria-label="Meeting details">
    <EmptyState plain icon={<CalendarDays />} title="Select a meeting">Its source, agenda and invitees appear here.</EmptyState>
  </aside>;
  const { event } = entry;
  const starts = new Date(event.starts_at);
  const invitees = event.invitees ?? [];
  const accounts = uniqueByAccount(entry.sources);
  const lastSynced = entry.sources.reduce((latest, source) => source.synced_at > latest ? source.synced_at : latest, event.synced_at);
  return <aside className="card calendar-event-detail" aria-label="Meeting details">
    <div className="calendar-detail-head">
      <PlatformPill event={event} />
      {viaCalendly(entry) ? <CalendlyPill /> : null}
      <RescheduledBadge from={event.rescheduled_from} />
    </div>
    <h2>{event.title}</h2>
    <p className="calendar-detail-time"><Clock aria-hidden="true" />{formatDate(starts, { weekday: "short", month: "short", day: "numeric" })}, {formatTime(starts)} – {eventTime(event.ends_at)}</p>
    {event.rescheduled_from ? <p className="calendar-detail-moved"><MovedFrom from={event.rescheduled_from} /></p> : null}
    <dl className="calendar-detail-meta">
      <dt>{accounts.length > 1 ? "Calendars" : "Calendar"}</dt>
      <dd><ul className="calendar-detail-sources">{accounts.map((source) => {
        const account = connections.find((item) => item.id === source.connection_id)?.label;
        return <li key={source.connection_id}>
          <CalendarBrandIcon provider={source.provider} size="xs" />
          <span>{calendarProviderNames[source.provider]}{account && account !== calendarProviderNames[source.provider] ? <small> · {account}</small> : null}</span>
        </li>;
      })}</ul></dd>
      {event.organizer ? <><dt>Organizer</dt><dd>{event.organizer}</dd></> : null}
    </dl>
    <EventChangeHistory key={event.id} eventId={event.id} />
    {event.agenda ? <div className="calendar-detail-block"><h3>Agenda</h3><p className="calendar-detail-agenda">{event.agenda}</p></div> : null}
    <div className="calendar-detail-block">
      <h3>Invited <span className="section-count">{invitees.length}</span></h3>
      <p className="field-hint">Invitees are not verified attendees or speakers.</p>
      <InviteeList key={event.id} invitees={invitees} />
    </div>
    {coordination}
    <div className="calendar-detail-actions">
      {canSchedule ? alreadyScheduled
        ? <Badge tone="success" dot>Assistant already scheduled</Badge>
        : <button type="button" className="button secondary" onClick={onSchedule}>Set up assistant</button> : null}
      {onRecordInPerson ? <button type="button" className="button secondary" onClick={onRecordInPerson}><Mic aria-hidden="true" /> Record in person</button> : null}
      <button type="button" className="button primary" onClick={onPrepare}><NotebookPen aria-hidden="true" /> Prepare for meeting</button>
    </div>
    <small className="calendar-sync-meta">Last synced {formatDateTime(lastSynced)}</small>
  </aside>;
}

/** Invitees of one meeting; searchable when the invite is large. */
function InviteeList({ invitees }: { invitees: CalendarInvitee[] }) {
  const search = useListSearch(invitees, (person) => [person.name, person.email, person.email?.split("@")[1]]);
  if (!invitees.length) return null;
  return <>
    {search.offered ? <div className="list-search-inline calendar-invitee-search"><FilterInput id="calendar-invitee-search" label="Search invitees" value={search.query} onChange={search.setQuery} placeholder="Search name, email or company" /></div> : null}
    {search.noMatches ? <NoMatches query={search.query} noun="invitees" onClear={search.clear} /> : <ul className="calendar-invitees">
      {search.visible.map((person, index) => <li key={`${person.email ?? person.name}-${index}`}>
        <Avatar name={person.name || person.email} size="sm" />
        <span><b>{person.name}</b>{person.email ? <small>{person.email}</small> : null}</span>
      </li>)}
    </ul>}
  </>;
}
