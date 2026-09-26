"use client";

import { CalendarDays, ChevronRight, Clock, Sparkles } from "lucide-react";
import type { CachedCalendarEvent } from "@/lib/types";
import { initials } from "@/lib/meeting-status";
import { CalendarBrandIcon } from "./brand-icons";
import { calendarProviderNames, platformLabel } from "./calendar-providers";
import { Badge, EmptyState } from "./ui/feedback";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CHIPS_PER_DAY = 2;
const timeFormat: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

export function dayKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export function eventDay(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function eventTime(event: CachedCalendarEvent): string {
  return new Date(event.starts_at).toLocaleTimeString([], timeFormat);
}

/** Six-week month grid. Each day is a button named "<date>, N meetings". */
export function MonthGrid({ month, days, selectedDay, eventsByDay, onSelectDay }: {
  month: Date;
  days: Date[];
  selectedDay: string;
  eventsByDay: Map<string, CachedCalendarEvent[]>;
  onSelectDay(key: string): void;
}) {
  const today = dayKey(new Date());
  return <div className="card calendar-month" role="group" aria-label="Month view">
    <div className="calendar-weekdays" aria-hidden="true">{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div>
    <div className="calendar-days">
      {days.map((day) => {
        const key = dayKey(day);
        const matches = eventsByDay.get(key) ?? [];
        const classes = ["calendar-day", day.getMonth() !== month.getMonth() ? "outside" : "", key === selectedDay ? "selected" : "", key === today ? "today" : ""].filter(Boolean).join(" ");
        return <button type="button" key={key} className={classes} aria-label={`${day.toDateString()}, ${matches.length} meetings`} aria-pressed={key === selectedDay} aria-current={key === today ? "date" : undefined} onClick={() => onSelectDay(key)}>
          <span className="calendar-day-number">{day.getDate()}</span>
          {matches.length ? <span className="calendar-day-events" aria-hidden="true">
            {matches.slice(0, CHIPS_PER_DAY).map((event) => <span key={event.id} className="calendar-chip">{event.title}</span>)}
            {matches.length > CHIPS_PER_DAY ? <span className="calendar-chip-more">+{matches.length - CHIPS_PER_DAY} more</span> : null}
          </span> : null}
          {matches.length ? <span className="calendar-day-dot" aria-hidden="true">{matches.length}</span> : null}
        </button>;
      })}
    </div>
  </div>;
}

/** Meetings on the selected day, with a jump list when the day itself is empty. */
export function DayAgenda({ selectedDay, dayEvents, rangeEvents, selectedEventId, hasAccounts, timezone, onSelectEvent, onJumpToEvent }: {
  selectedDay: string;
  dayEvents: CachedCalendarEvent[];
  rangeEvents: CachedCalendarEvent[];
  selectedEventId: string | null;
  hasAccounts: boolean;
  timezone: string;
  onSelectEvent(event: CachedCalendarEvent): void;
  onJumpToEvent(event: CachedCalendarEvent, day: string): void;
}) {
  const title = new Date(`${selectedDay}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  return <section className="card calendar-agenda" aria-labelledby="calendar-agenda-title">
    <div className="card-header">
      <div><h2 id="calendar-agenda-title">{title}</h2><p>{dayEvents.length} meeting{dayEvents.length === 1 ? "" : "s"} · {rangeEvents.length} in range</p></div>
    </div>
    {dayEvents.length ? <ul className="calendar-agenda-list">
      {dayEvents.map((event) => <li key={event.id}>
        <button type="button" className={selectedEventId === event.id ? "calendar-agenda-event selected" : "calendar-agenda-event"} aria-pressed={selectedEventId === event.id} onClick={() => onSelectEvent(event)}>
          <time className="calendar-agenda-time" dateTime={event.starts_at}>{eventTime(event)}</time>
          <span className="calendar-agenda-copy"><b>{event.title}</b><small>{calendarProviderNames[event.provider]} · {platformLabel(event.platform)}</small></span>
          <ChevronRight className="row-arrow" aria-hidden="true" />
        </button>
      </li>)}
    </ul> : <div className="card-body">
      <EmptyState plain icon={<CalendarDays />} title="No meetings on this day">{hasAccounts ? "Sync your accounts or choose another day." : "Connect an account in Integrations, then sync."}</EmptyState>
    </div>}
    {rangeEvents.length && !dayEvents.length ? <div className="calendar-other-events">
      <h3>Other meetings in range</h3>
      <ul>{rangeEvents.slice(0, 10).map((event) => <li key={event.id}>
        <button type="button" onClick={() => onJumpToEvent(event, eventDay(event.starts_at, timezone))}>
          <span className="calendar-other-date">{new Date(event.starts_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
          <span className="calendar-other-title">{event.title}</span>
          <span className="calendar-other-source">{calendarProviderNames[event.provider]}</span>
        </button>
      </li>)}</ul>
    </div> : null}
  </section>;
}

/** Everything known about one calendar event, plus the next step. */
export function EventDetail({ event, canSchedule, alreadyScheduled, onSchedule, onPrepare }: {
  event: CachedCalendarEvent | null;
  canSchedule: boolean;
  alreadyScheduled: boolean;
  onSchedule(): void;
  onPrepare(): void;
}) {
  if (!event) return <aside className="card calendar-event-detail empty" aria-label="Meeting details">
    <EmptyState plain icon={<CalendarDays />} title="Select a meeting">Its source, agenda and invitees appear here.</EmptyState>
  </aside>;
  const starts = new Date(event.starts_at);
  const invitees = event.invitees ?? [];
  return <aside className="card calendar-event-detail" aria-label="Meeting details">
    <div className="calendar-detail-head">
      <span className="calendar-detail-source"><CalendarBrandIcon provider={event.provider} size="sm" />{calendarProviderNames[event.provider]}</span>
      <Badge>{platformLabel(event.platform)}</Badge>
    </div>
    <h2>{event.title}</h2>
    <p className="calendar-detail-time"><Clock aria-hidden="true" />{starts.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, {starts.toLocaleTimeString([], timeFormat)} – {new Date(event.ends_at).toLocaleTimeString([], timeFormat)}</p>
    {event.organizer ? <dl className="calendar-detail-meta"><dt>Organizer</dt><dd>{event.organizer}</dd></dl> : null}
    {event.agenda ? <div className="calendar-detail-block"><h3>Agenda</h3><p className="calendar-detail-agenda">{event.agenda}</p></div> : null}
    <div className="calendar-detail-block">
      <h3>Invited <span className="section-count">{invitees.length}</span></h3>
      <p className="field-hint">Invitees are not verified attendees or speakers.</p>
      {invitees.length ? <ul className="calendar-invitees">
        {invitees.map((person, index) => <li key={`${person.email ?? person.name}-${index}`}>
          <span className="avatar sm" aria-hidden="true">{initials(person.name || person.email)}</span>
          <span><b>{person.name}</b>{person.email ? <small>{person.email}</small> : null}</span>
        </li>)}
      </ul> : null}
    </div>
    <div className="calendar-detail-actions">
      {canSchedule ? alreadyScheduled
        ? <Badge tone="success" dot>Assistant already scheduled</Badge>
        : <button type="button" className="button secondary" onClick={onSchedule}>Set up assistant</button> : null}
      <button type="button" className="button primary" onClick={onPrepare}><Sparkles aria-hidden="true" /> Prepare for meeting</button>
    </div>
    <small className="calendar-sync-meta">Last synced {new Date(event.synced_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small>
  </aside>;
}
