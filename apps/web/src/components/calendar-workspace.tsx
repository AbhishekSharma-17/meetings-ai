"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, CheckCircle2, Plus, RefreshCw, Sparkles } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { CachedCalendarEvent, CalendarConnection, CalendarSchedule, CalendarSnapshot } from "@/lib/types";
import { CalendarBrandIcon, type CalendarSelection } from "./calendar-import-dialog";
import { UiSelect } from "./ui-select";

const providerNames: Record<CalendarConnection["provider"], string> = {
  googlecalendar: "Google Calendar", outlook: "Outlook Calendar", calendly: "Calendly", zoom: "Zoom",
};
const AUTO_REFRESH_AFTER_MS = 5 * 60_000;

type CalendarPreferences = {
  startDate: string; endDate: string; selectedDay: string; month: string;
  accountFilter: string; tab: "calendar" | "integrations";
};

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function initialPreferences(storageKey: string): CalendarPreferences {
  const first = currentMonth();
  const fallback: CalendarPreferences = {
    startDate: dayKey(first), endDate: dayKey(new Date(first.getFullYear(), first.getMonth() + 1, 0)),
    selectedDay: dayKey(new Date()), month: dayKey(first), accountFilter: "all", tab: "calendar",
  };
  if (typeof window === "undefined") return fallback;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<CalendarPreferences> | null;
    if (!saved || !validDate(saved.startDate) || !validDate(saved.endDate)) return fallback;
    const days = (Date.parse(`${saved.endDate}T00:00:00Z`) - Date.parse(`${saved.startDate}T00:00:00Z`)) / 86_400_000 + 1;
    if (days < 1 || days > 90) return fallback;
    return {
      startDate: saved.startDate, endDate: saved.endDate,
      selectedDay: validDate(saved.selectedDay) ? saved.selectedDay : fallback.selectedDay,
      month: validDate(saved.month) ? saved.month : fallback.month,
      accountFilter: typeof saved.accountFilter === "string" ? saved.accountFilter : "all",
      tab: saved.tab === "integrations" ? "integrations" : "calendar",
    };
  } catch { return fallback; }
}

function coveredBySync(startDate: string, endDate: string, timezone: string, rangeStart: string, rangeEnd: string): boolean {
  const first = eventDay(rangeStart, timezone);
  const last = eventDay(new Date(new Date(rangeEnd).getTime() - 1).toISOString(), timezone);
  return startDate >= first && endDate <= last;
}

function dayKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function eventDay(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function currentMonth(): Date { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); }

export function CalendarWorkspace({ calendarIdentity, preferredConnectionId, canSchedule = true, onChoose, onPrepare }: {
  calendarIdentity: string;
  preferredConnectionId?: string | null;
  canSchedule?: boolean;
  onChoose(selection: CalendarSelection): void;
  onPrepare(event: CachedCalendarEvent): void;
}) {
  const storageKey = `meetings-ai:calendar-view:${calendarIdentity}`;
  const [initial] = useState(() => initialPreferences(storageKey));
  const [tab, setTab] = useState<"calendar" | "integrations">(initial.tab);
  const [month, setMonth] = useState(() => new Date(`${initial.month}T12:00:00`));
  const [startDate, setStartDate] = useState(initial.startDate);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [selectedDay, setSelectedDay] = useState(initial.selectedDay);
  const [timezone] = useState(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return zone === "Asia/Calcutta" ? "Asia/Kolkata" : zone;
  });
  const [connections, setConnections] = useState<CalendarConnection[]>([]);
  const [schedules, setSchedules] = useState<CalendarSchedule[]>([]);
  const [snapshot, setSnapshot] = useState<CalendarSnapshot>({ events: [], syncs: [] });
  const [accountFilter, setAccountFilter] = useState(preferredConnectionId ?? initial.accountFilter);
  const [selectedEvent, setSelectedEvent] = useState<CachedCalendarEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoRefreshKey = useRef<string | null>(null);
  const rangeDays = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 + 1;
  const rangeValid = Number.isFinite(rangeDays) && rangeDays >= 1 && rangeDays <= 90;

  useEffect(() => {
    const preferences: CalendarPreferences = {
      startDate, endDate, selectedDay, month: dayKey(month), accountFilter, tab,
    };
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Browsing still works without local storage. */ }
  }, [accountFilter, endDate, month, selectedDay, startDate, storageKey, tab]);

  const load = useCallback(() => {
    return Promise.all([
      meetingsService.listCalendarConnections(), canSchedule ? meetingsService.listCalendarSchedules() : Promise.resolve([] as CalendarSchedule[]),
      meetingsService.getSyncedCalendar(startDate, endDate, timezone),
    ]);
  }, [canSchedule, startDate, endDate, timezone]);

  useEffect(() => {
    if (!rangeValid) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) setBusy(false); });
    void load().then(async ([nextConnections, nextSchedules, nextSnapshot]) => {
      if (cancelled) return;
      setConnections(nextConnections); setSchedules(nextSchedules); setSnapshot(nextSnapshot);
      setSelectedEvent((current) => current ? nextSnapshot.events.find((item) => item.id === current.id) ?? null : null);
      setAccountFilter((current) => current === "all" || nextConnections.some((item) => item.id === current && item.status === "ACTIVE") ? current : "all");

      // Show the saved snapshot first. Refresh only previously synced accounts
      // whose snapshot is old or did not cover the restored date range.
      const staleIds = nextConnections.filter((connection) => {
        if (connection.status !== "ACTIVE") return false;
        const state = nextSnapshot.syncs.find((item) => item.connection_id === connection.id);
        return state && (Date.now() - new Date(state.last_synced_at).getTime() >= AUTO_REFRESH_AFTER_MS
          || !coveredBySync(startDate, endDate, timezone, state.range_start, state.range_end));
      }).map((connection) => connection.id);
      const key = `${calendarIdentity}:${startDate}:${endDate}:${timezone}`;
      if (!staleIds.length || autoRefreshKey.current === key) return;
      autoRefreshKey.current = key;
      setBusy(true);
      try {
        const refreshed = await meetingsService.syncCalendar(startDate, endDate, timezone, staleIds);
        if (cancelled) return;
        setSnapshot(refreshed);
        setSelectedEvent((current) => current ? refreshed.events.find((item) => item.id === current.id) ?? null : null);
        if (refreshed.errors && Object.keys(refreshed.errors).length) {
          setError(`Saved meetings are still available. Refresh failed: ${Object.values(refreshed.errors).join(" · ")}`);
        }
      } catch (cause) {
        if (!cancelled) setError(`Saved meetings are still available. Refresh failed: ${cause instanceof Error ? cause.message : "Unknown error"}`);
      } finally { if (!cancelled) setBusy(false); }
    }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load saved calendar events."); });
    return () => { cancelled = true; };
  }, [calendarIdentity, endDate, load, rangeValid, startDate, timezone]);

  const active = connections.filter((item) => item.status === "ACTIVE");
  const visibleEvents = useMemo(() => snapshot.events.filter((item) => accountFilter === "all" || item.connection_id === accountFilter), [snapshot.events, accountFilter]);
  const dayEvents = visibleEvents.filter((item) => eventDay(item.starts_at, timezone) === selectedDay);
  const monthDays = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const gridStart = new Date(first); gridStart.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, index) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index));
  }, [month]);

  function changeMonth(offset: number) {
    const next = new Date(month.getFullYear(), month.getMonth() + offset, 1);
    setMonth(next); setStartDate(dayKey(next));
    setEndDate(dayKey(new Date(next.getFullYear(), next.getMonth() + 1, 0)));
    setSelectedDay(dayKey(next)); setSelectedEvent(null);
  }

  async function sync() {
    setBusy(true); setError(null);
    try {
      const next = await meetingsService.syncCalendar(startDate, endDate, timezone, accountFilter === "all" ? [] : [accountFilter]);
      setSnapshot(next);
      if (next.errors && Object.keys(next.errors).length) setError(Object.entries(next.errors).map(([id, message]) => `${connections.find((item) => item.id === id)?.label ?? id}: ${message}`).join(" · "));
      setSelectedEvent((current) => current ? next.events.find((item) => item.id === current.id) ?? null : null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Calendar sync failed."); }
    finally { setBusy(false); }
  }

  async function connect(provider: CalendarConnection["provider"]) {
    setBusy(true); setError(null);
    try { window.location.assign(await meetingsService.connectCalendar(provider)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not connect this account."); setBusy(false); }
  }

  const calendarSources: CalendarConnection["provider"][] = ["googlecalendar", "outlook", "calendly", "zoom"];
  return <section className="page calendar-workspace" aria-labelledby="calendar-workspace-title">
    <div className="calendar-workspace-heading"><div><p className="eyebrow">YOUR SCHEDULE</p><h1 id="calendar-workspace-title">Calendar</h1><p className="intro">Your last synced meetings stay saved across reloads. Older snapshots refresh automatically; use Sync now for an immediate update.</p></div><button type="button" className="button secondary" disabled={busy || !active.length || !rangeValid} onClick={() => void sync()}><RefreshCw size={16} /> {busy ? "Syncing…" : "Sync now"}</button></div>
    <div className="calendar-tabs" role="tablist" aria-label="Calendar sections"><button type="button" role="tab" aria-selected={tab === "calendar"} onClick={() => setTab("calendar")}><CalendarDays size={16} /> Calendar</button><button type="button" role="tab" aria-selected={tab === "integrations"} onClick={() => setTab("integrations")}>Integrations <span>{active.length}</span></button></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {tab === "integrations" ? <div className="calendar-integrations"><div className="section-heading"><div><h2>Connected meeting sources</h2><p>Connect multiple accounts. Each event keeps its original source and account identity.</p></div></div><div className="calendar-provider-grid">{calendarSources.map((provider) => {
      const count = active.filter((item) => item.provider === provider).length;
      return <div key={provider} className={count ? "calendar-provider-card connected" : "calendar-provider-card"}><CalendarBrandIcon provider={provider} /><div><b>{providerNames[provider]}</b><small>{count ? `${count} connected account${count === 1 ? "" : "s"}` : provider === "outlook" ? "Includes Microsoft Teams calendar meetings" : "Not connected"}</small></div>{count ? <button type="button" className="calendar-card-add" aria-label={`Add another ${providerNames[provider]} account`} onClick={() => void connect(provider)}><Plus size={16} /></button> : null}<div className="calendar-provider-actions">{count ? <span className="calendar-connection-badge"><CheckCircle2 /> Connected</span> : <button type="button" className="button secondary" onClick={() => void connect(provider)}>Connect account</button>}</div></div>;
    })}</div><div className="calendar-account-list"><h3>Accounts</h3>{connections.length ? connections.map((item) => <div key={item.id} className="calendar-account-row"><CalendarBrandIcon provider={item.provider} /><span><b>{item.label}</b><small>{providerNames[item.provider]} · {item.status === "ACTIVE" ? "Connected" : item.status}</small></span><small>{snapshot.syncs.find((sync) => sync.connection_id === item.id) ? `Last sync ${new Date(snapshot.syncs.find((sync) => sync.connection_id === item.id)!.last_synced_at).toLocaleString()}` : "Not synced yet"}</small></div>) : <p className="calendar-note">No accounts yet. Connect a source above to import meetings.</p>}</div><p className="calendar-note">Microsoft Teams meetings already appear from Outlook Calendar when the event contains a Teams join link. A separate Teams connection is not required for those events.</p></div> : null}
    {tab === "calendar" ? <><div className="calendar-toolbar"><div className="calendar-month-nav"><button type="button" aria-label="Previous month" onClick={() => changeMonth(-1)}><ChevronLeft /></button><h2>{month.toLocaleString(undefined, { month: "long", year: "numeric" })}</h2><button type="button" aria-label="Next month" onClick={() => changeMonth(1)}><ChevronRight /></button></div><UiSelect id="calendar-account-filter" label="Account" value={accountFilter} onChange={setAccountFilter} options={[{ value: "all", label: "All connected accounts" }, ...active.map((item) => ({ value: item.id, label: `${providerNames[item.provider]} · ${item.label}` }))]} disabled={!active.length} /></div>
      <div className="calendar-range"><div><label htmlFor="calendar-from">From</label><input id="calendar-from" type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); setSelectedEvent(null); }} /></div><div><label htmlFor="calendar-to">Through</label><input id="calendar-to" type="date" value={endDate} onChange={(event) => { setEndDate(event.target.value); setSelectedEvent(null); }} /></div><p>Choose up to 90 days, then sync any or all accounts. Times shown in {timezone}.</p></div>
      {!rangeValid ? <p className="form-error" role="alert">Choose a valid date range of 1 to 90 days.</p> : null}
      <div className="calendar-month-grid" role="grid" aria-label="Month view"><div className="calendar-weekdays">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <b key={day}>{day}</b>)}</div><div className="calendar-days">{monthDays.map((day) => {
        const key = dayKey(day); const matches = visibleEvents.filter((event) => eventDay(event.starts_at, timezone) === key);
        return <button type="button" key={key} className={["calendar-day", day.getMonth() !== month.getMonth() ? "outside" : "", key === selectedDay ? "selected" : ""].join(" ")} aria-label={`${day.toDateString()}, ${matches.length} meetings`} onClick={() => { setSelectedDay(key); setSelectedEvent(null); }}><span>{day.getDate()}</span><small>{matches.slice(0, 2).map((event) => <i key={event.id} className={`source-${event.provider}`}>{event.title}</i>)}{matches.length > 2 ? `+${matches.length - 2} more` : null}</small></button>;
      })}</div></div>
      <div className="calendar-content-grid"><section className="calendar-agenda"><div className="section-heading"><div><h2>Meetings on {new Date(`${selectedDay}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</h2><p>{dayEvents.length} saved event{dayEvents.length === 1 ? "" : "s"} · {visibleEvents.length} in the selected range</p></div></div>{dayEvents.length ? dayEvents.map((event) => <button type="button" key={event.id} className={selectedEvent?.id === event.id ? "calendar-agenda-event selected" : "calendar-agenda-event"} onClick={() => setSelectedEvent(event)}><span className={`calendar-source-dot source-${event.provider}`} /><span><b>{event.title}</b><small>{new Date(event.starts_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {providerNames[event.provider]} · {event.platform.replaceAll("_", " ")}</small></span><ChevronRight size={16} /></button>) : <div className="empty-state"><b>No saved meetings on this day.</b><p>{active.length ? "Sync your accounts or choose another date." : "Connect an account in Integrations, then sync."}</p></div>}{visibleEvents.length && !dayEvents.length ? <div className="calendar-other-events"><h3>Other events in range</h3>{visibleEvents.slice(0, 10).map((event) => <button key={event.id} type="button" onClick={() => { setSelectedDay(eventDay(event.starts_at, timezone)); setSelectedEvent(event); }}>{new Date(event.starts_at).toLocaleDateString()} · {event.title} · {providerNames[event.provider]}</button>)}</div> : null}</section>
      <aside className="calendar-event-detail" aria-label="Meeting details">{selectedEvent ? <><div className="calendar-event-source"><CalendarBrandIcon provider={selectedEvent.provider} /><span>{providerNames[selectedEvent.provider]} · {selectedEvent.platform.replaceAll("_", " ")}</span></div><h2>{selectedEvent.title}</h2><p>{new Date(selectedEvent.starts_at).toLocaleString()} – {new Date(selectedEvent.ends_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p>{selectedEvent.organizer ? <p><b>Organizer</b> {selectedEvent.organizer}</p> : null}{selectedEvent.agenda ? <div className="calendar-event-agenda"><b>Agenda</b><p>{selectedEvent.agenda}</p></div> : null}<div className="calendar-invitees"><b>Invited people · {selectedEvent.invitees?.length ?? 0}</b><p className="field-hint">Invitees are not verified attendees or speakers.</p>{selectedEvent.invitees?.map((person, index) => <p key={`${person.email ?? person.name}-${index}`}>{person.name}{person.email ? <small>{person.email}</small> : null}</p>)}</div><div className="calendar-event-actions">{canSchedule ? schedules.some((item) => item.connection_id === selectedEvent.connection_id && item.event_id === selectedEvent.event_id && new Date(item.starts_at).getTime() === new Date(selectedEvent.starts_at).getTime()) ? <span className="calendar-scheduled">Assistant already scheduled</span> : <button type="button" className="button secondary" onClick={() => onChoose({ event: selectedEvent, period: "this_week", timezone, eventDate: eventDay(selectedEvent.starts_at, timezone), willSchedule: new Date(selectedEvent.starts_at).getTime() > Date.now() + 60_000 })}>Set up assistant</button> : null}<button type="button" className="button primary" onClick={() => onPrepare(selectedEvent)}><Sparkles size={16} /> Prepare for meeting</button></div><small className="calendar-sync-meta">Last synced {new Date(selectedEvent.synced_at).toLocaleString()}</small></> : <div className="calendar-detail-empty"><CalendarDays /><h2>Select a meeting</h2><p>See the source, agenda, invitees and your research brief here.</p></div>}</aside></div>
    </> : null}
  </section>;
}
