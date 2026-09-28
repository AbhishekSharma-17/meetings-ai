"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Tabs } from "@base-ui/react/tabs";
import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, Plug, Plus, RefreshCw } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { CachedCalendarEvent, CalendarConnection, CalendarSchedule, CalendarSnapshot } from "@/lib/types";
import type { CalendarSelection } from "./calendar-import-dialog";
import { CalendarIntegrations } from "./calendar-integrations";
import { CalendarConnectWaiting } from "./calendar-connect-waiting";
import { SettingsToast, type SettingsNotice } from "./settings-toast";
import { useCalendarConnect } from "./use-calendar-connect";
import { findEntry, mergeCalendarEvents, type CalendarEntry } from "./calendar-events";
import { DayAgenda, EventDetail, MonthGrid, dayKey, eventDay } from "./calendar-month";
import { calendarProviderNames } from "./calendar-providers";
import { formatDateTime, formatDayHeading, todayKey, useTimePreferences } from "@/lib/time-preferences";
import { Alert } from "./ui/feedback";
import { PageHeader } from "./ui/page-header";
import { UiSelect } from "./ui-select";

const AUTO_REFRESH_AFTER_MS = 5 * 60_000;
const shortDate: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

type CalendarPreferences = {
  startDate: string; endDate: string; selectedDay: string; month: string;
  accountFilter: string; tab: "calendar" | "integrations"; selectedEventId: string | null;
};

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function initialPreferences(storageKey: string): CalendarPreferences {
  const first = currentMonth();
  const fallback: CalendarPreferences = {
    startDate: dayKey(first), endDate: dayKey(new Date(first.getFullYear(), first.getMonth() + 1, 0)),
    selectedDay: todayKey(), month: dayKey(first), accountFilter: "all", tab: "calendar", selectedEventId: null,
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
      selectedEventId: typeof saved.selectedEventId === "string" ? saved.selectedEventId : null,
    };
  } catch { return fallback; }
}

function coveredBySync(startDate: string, endDate: string, timezone: string, rangeStart: string, rangeEnd: string): boolean {
  const first = eventDay(rangeStart, timezone);
  const last = eventDay(new Date(new Date(rangeEnd).getTime() - 1).toISOString(), timezone);
  return startDate >= first && endDate <= last;
}

/** The first of this month, in the person's time zone (as a civil date). */
function currentMonth(): Date { const [year, month] = todayKey().split("-").map(Number); return new Date(year, month - 1, 1); }

function formatDay(key: string): string {
  return validDate(key) ? formatDayHeading(key, shortDate) : "—";
}

export function CalendarWorkspace({ calendarIdentity, preferredConnectionId, onPreferredConnectionApplied, canSchedule = true, onChoose, onPrepare, onNewMeeting }: {
  calendarIdentity: string;
  preferredConnectionId?: string | null;
  onPreferredConnectionApplied?(): void;
  canSchedule?: boolean;
  onChoose(selection: CalendarSelection): void;
  onPrepare(event: CachedCalendarEvent): void;
  /** Optional: shows a "New meeting" action in the header for people who can schedule. */
  onNewMeeting?(): void;
}) {
  const storageKey = `meetings-ai:calendar-view:${calendarIdentity}`;
  const [initial] = useState(() => initialPreferences(storageKey));
  const [tab, setTab] = useState<"calendar" | "integrations">(initial.tab);
  const [month, setMonth] = useState(() => new Date(`${initial.month}T12:00:00`));
  const [startDate, setStartDate] = useState(initial.startDate);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [selectedDay, setSelectedDay] = useState(initial.selectedDay);
  // Windows, "today" and day placement follow the person's effective zone (manual choice, else browser).
  const { timeZone: timezone } = useTimePreferences();
  const [connections, setConnections] = useState<CalendarConnection[]>([]);
  const [schedules, setSchedules] = useState<CalendarSchedule[]>([]);
  const [snapshot, setSnapshot] = useState<CalendarSnapshot>({ events: [], syncs: [] });
  const [accountFilter, setAccountFilter] = useState(preferredConnectionId ?? initial.accountFilter);
  const [selectedEvent, setSelectedEvent] = useState<CachedCalendarEvent | null>(null);
  const restoredEventId = useRef(initial.selectedEventId);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncingIds, setSyncingIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<SettingsNotice | null>(null);
  const autoRefreshKey = useRef<string | null>(null);
  const rangeDays = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 + 1;
  const rangeValid = Number.isFinite(rangeDays) && rangeDays >= 1 && rangeDays <= 90;

  useEffect(() => {
    if (preferredConnectionId) onPreferredConnectionApplied?.();
  }, [preferredConnectionId, onPreferredConnectionApplied]);

  useLayoutEffect(() => {
    if (!loaded) return;
    const preferences: CalendarPreferences = {
      startDate, endDate, selectedDay, month: dayKey(month), accountFilter, tab, selectedEventId: selectedEvent?.id ?? null,
    };
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* Browsing still works without local storage. */ }
  }, [accountFilter, endDate, loaded, month, selectedDay, selectedEvent, startDate, storageKey, tab]);

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
      const restoreId = restoredEventId.current;
      setSelectedEvent((current) => nextSnapshot.events.find((item) => item.id === (current?.id ?? restoreId)) ?? null);
      restoredEventId.current = null;
      setLoaded(true);
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
  // Copies of one meeting from several accounts collapse into one entry per day.
  const visibleEntries = useMemo(() => mergeCalendarEvents(visibleEvents), [visibleEvents]);
  const entriesByDay = useMemo(() => {
    const groups = new Map<string, CalendarEntry[]>();
    for (const entry of visibleEntries) {
      const key = eventDay(entry.event.starts_at, timezone);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    return groups;
  }, [visibleEntries, timezone]);
  const dayEntries = entriesByDay.get(selectedDay) ?? [];
  const selectedEntry = findEntry(visibleEntries, selectedEvent?.id) ?? (selectedEvent ? { id: selectedEvent.id, event: selectedEvent, sources: [selectedEvent] } : null);
  const syncing = busy || syncingIds.length > 0;
  const monthDays = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const gridStart = new Date(first); gridStart.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, index) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index));
  }, [month]);
  const lastSynced = snapshot.syncs
    .filter((item) => accountFilter === "all" || item.connection_id === accountFilter)
    .reduce<string | null>((latest, item) => !latest || item.last_synced_at > latest ? item.last_synced_at : latest, null);
  const selectedScheduled = selectedEntry ? selectedEntry.sources.some((source) => schedules.some((item) => item.connection_id === source.connection_id && item.event_id === source.event_id && new Date(item.starts_at).getTime() === new Date(source.starts_at).getTime())) : false;

  function changeMonth(offset: number) {
    const next = new Date(month.getFullYear(), month.getMonth() + offset, 1);
    setMonth(next); setStartDate(dayKey(next));
    setEndDate(dayKey(new Date(next.getFullYear(), next.getMonth() + 1, 0)));
    setSelectedDay(dayKey(next)); setSelectedEvent(null);
  }

  function goToToday() {
    const next = currentMonth();
    setMonth(next); setStartDate(dayKey(next));
    setEndDate(dayKey(new Date(next.getFullYear(), next.getMonth() + 1, 0)));
    setSelectedDay(todayKey()); setSelectedEvent(null);
  }

  function applySync(next: CalendarSnapshot) {
    setSnapshot(next);
    if (next.errors && Object.keys(next.errors).length) setError(Object.entries(next.errors).map(([id, message]) => `${connections.find((item) => item.id === id)?.label ?? id}: ${message}`).join(" · "));
    setSelectedEvent((current) => current ? next.events.find((item) => item.id === current.id) ?? null : null);
  }

  // An empty connection list asks the API to sync every active account of this
  // user in one request ("All connected accounts"); one id syncs that account only.
  async function sync() {
    setBusy(true); setError(null);
    try { applySync(await meetingsService.syncCalendar(startDate, endDate, timezone, accountFilter === "all" ? [] : [accountFilter])); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Calendar sync failed."); }
    finally { setBusy(false); }
  }

  async function syncAccount(connectionId: string) {
    if (!rangeValid) { setError("Choose a valid date range of 1 to 90 days."); return; }
    setSyncingIds((current) => [...current, connectionId]); setError(null);
    try { applySync(await meetingsService.syncCalendar(startDate, endDate, timezone, [connectionId])); }
    catch (cause) { setError(`${connections.find((item) => item.id === connectionId)?.label ?? "Account"}: ${cause instanceof Error ? cause.message : "Calendar sync failed."}`); }
    finally { setSyncingIds((current) => current.filter((id) => id !== connectionId)); }
  }

  const connectFlow = useCalendarConnect({
    onConnected: (next, connectionId, provider) => {
      setConnections(next);
      const added = next.find((item) => item.id === connectionId);
      setNotice({ tone: "success", text: added ? `${calendarProviderNames[provider]} connected: ${added.label}. Loading its meetings…` : `${calendarProviderNames[provider]} connected.` });
      if (added?.status === "ACTIVE") {
        // Same outcome as returning from the provider in this tab: the new account is selected.
        setAccountFilter(added.id);
        void syncAccount(added.id);
      }
    },
    onError: (message) => { setBusy(false); setError(message); },
    onRedirect: () => setBusy(true),
  });

  /** Called from the alias dialog's submit, so the new tab opens inside the user's gesture. */
  function connect(provider: CalendarConnection["provider"], alias: string) {
    setError(null); setNotice(null);
    connectFlow.start(provider, alias, connections.map((item) => item.id));
  }

  async function rename(connectionId: string, alias: string): Promise<boolean> {
    setBusy(true); setError(null);
    try {
      const updated = await meetingsService.renameCalendarConnection(connectionId, alias);
      setConnections((current) => current.map((item) => item.id === connectionId ? updated : item));
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not rename this account."); return false; }
    finally { setBusy(false); }
  }

  async function disconnect(connectionId: string): Promise<boolean> {
    setBusy(true); setError(null);
    try {
      await meetingsService.disconnectCalendar(connectionId);
      // The server forgets this account's meetings; drop them here too so nothing lingers until the next sync.
      setSnapshot((current) => ({ ...current, events: current.events.filter((event) => event.connection_id !== connectionId), syncs: current.syncs.filter((state) => state.connection_id !== connectionId) }));
      setConnections(await meetingsService.listCalendarConnections());
      setAccountFilter((current) => current === connectionId ? "all" : current);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not disconnect this account."); return false; }
    finally { setBusy(false); }
  }

  function scheduleSelected(event: CachedCalendarEvent) {
    onChoose({ event, period: "this_week", timezone, eventDate: eventDay(event.starts_at, timezone), willSchedule: new Date(event.starts_at).getTime() > Date.now() + 60_000 });
  }

  const syncScope = accountFilter === "all" ? `all ${active.length} connected account${active.length === 1 ? "" : "s"}` : connections.find((item) => item.id === accountFilter)?.label ?? "this account";
  const accountOptions = [{ value: "all", label: "All connected accounts" }, ...active.map((item) => ({ value: item.id, label: `${calendarProviderNames[item.provider]} · ${item.label}` }))];
  return <section className="page wide calendar-workspace" aria-labelledby="calendar-workspace-title">
    <PageHeader
      titleId="calendar-workspace-title"
      title="Calendar"
      description="Meetings from your connected calendars, saved between visits."
      actions={<>
        <button type="button" className="button secondary" title={`Sync ${syncScope}`} disabled={syncing || !active.length || !rangeValid} onClick={() => void sync()}><RefreshCw aria-hidden="true" className={busy ? "calendar-spin" : undefined} /> {busy ? "Syncing…" : "Sync now"}</button>
        {onNewMeeting && canSchedule ? <button type="button" className="button primary" onClick={onNewMeeting}><Plus aria-hidden="true" /> New meeting</button> : null}
      </>}
    />
    <Tabs.Root value={tab} onValueChange={(value) => setTab(value === "integrations" ? "integrations" : "calendar")}>
      <Tabs.List className="tabs-list" aria-label="Calendar sections">
        <Tabs.Tab value="calendar"><CalendarDays aria-hidden="true" />Calendar</Tabs.Tab>
        <Tabs.Tab value="integrations"><Plug aria-hidden="true" />Integrations <span className="count">{active.length}</span></Tabs.Tab>
      </Tabs.List>
      {error ? <p className="form-error calendar-error" role="alert">{error}</p> : null}
      <CalendarConnectWaiting wait={connectFlow.wait} onReopen={connectFlow.reopen} onRecheck={connectFlow.recheck} onCancel={connectFlow.cancel} />

      <Tabs.Panel value="calendar" className="calendar-panel">
        <div className="calendar-toolbar">
          <div className="calendar-month-nav">
            <button type="button" className="button secondary icon sm" aria-label="Previous month" onClick={() => changeMonth(-1)}><ChevronLeft aria-hidden="true" /></button>
            <button type="button" className="button secondary icon sm" aria-label="Next month" onClick={() => changeMonth(1)}><ChevronRight aria-hidden="true" /></button>
            <h2>{formatDayHeading(dayKey(month), { month: "long", year: "numeric" })}</h2>
            <button type="button" className="button ghost sm" onClick={goToToday}>Today</button>
          </div>
          <div className="calendar-toolbar-end">
            {lastSynced ? <span className="calendar-sync-status">{accountFilter === "all" && active.length > 1 ? `${active.length} accounts · ` : ""}Synced {formatDateTime(lastSynced)}</span> : null}
            <RangePicker startDate={startDate} endDate={endDate} timezone={timezone} onStartChange={(value) => { setStartDate(value); setSelectedEvent(null); }} onEndChange={(value) => { setEndDate(value); setSelectedEvent(null); }} />
            <UiSelect id="calendar-account-filter" label="Account" hideLabel size="sm" className="calendar-account-select" value={accountFilter} onChange={setAccountFilter} options={accountOptions} disabled={!active.length} />
          </div>
        </div>
        {loaded && !active.length ? <Alert tone="brand" className="calendar-connect-hint" actions={<button type="button" className="button secondary sm" onClick={() => setTab("integrations")}>Connect a calendar</button>}>No calendars connected yet. Connect one to see your meetings here.</Alert> : null}
        {!rangeValid ? <p className="form-error" role="alert">Choose a valid date range of 1 to 90 days.</p> : null}
        <div className="calendar-layout">
          <MonthGrid month={month} days={monthDays} selectedDay={selectedDay} entriesByDay={entriesByDay} connections={connections} onSelectDay={(key) => { setSelectedDay(key); setSelectedEvent(null); }} />
          <div className="calendar-side">
            <DayAgenda selectedDay={selectedDay} dayEntries={dayEntries} rangeEntries={visibleEntries} selectedEventId={selectedEvent?.id ?? null} hasAccounts={active.length > 0} connections={connections} onSelectEntry={(entry) => setSelectedEvent(entry.event)} onJumpToEntry={(entry) => { setSelectedDay(eventDay(entry.event.starts_at, timezone)); setSelectedEvent(entry.event); }} />
            <EventDetail entry={selectedEntry} connections={connections} canSchedule={canSchedule} alreadyScheduled={selectedScheduled} onSchedule={() => { if (selectedEvent) scheduleSelected(selectedEvent); }} onPrepare={() => { if (selectedEvent) onPrepare(selectedEvent); }} />
          </div>
        </div>
      </Tabs.Panel>

      <Tabs.Panel value="integrations">
        <CalendarIntegrations connections={connections} syncs={snapshot.syncs} busy={busy} connecting={connectFlow.wait !== null} syncingIds={syncingIds} canSync={rangeValid} onSync={(connectionId) => void syncAccount(connectionId)} onConnect={connect} onRename={rename} onDisconnect={disconnect} />
      </Tabs.Panel>
    </Tabs.Root>
    <SettingsToast notice={notice} onDismiss={() => setNotice(null)} />
  </section>;
}

function RangePicker({ startDate, endDate, timezone, onStartChange, onEndChange }: {
  startDate: string;
  endDate: string;
  timezone: string;
  onStartChange(value: string): void;
  onEndChange(value: string): void;
}) {
  const label = `${formatDay(startDate)} – ${formatDay(endDate)}`;
  return <Popover.Root>
    <Popover.Trigger className="button secondary sm calendar-range-trigger" aria-label={`Date range, ${label}`}><CalendarRange aria-hidden="true" />{label}</Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="end" sideOffset={6} className="ui-select-positioner">
        <Popover.Popup className="popover calendar-range-popover">
          <Popover.Title className="calendar-range-title">Date range</Popover.Title>
          <div className="field-row">
            <div className="field"><label htmlFor="calendar-from">From</label><input id="calendar-from" type="date" value={startDate} onChange={(event) => onStartChange(event.target.value)} /></div>
            <div className="field"><label htmlFor="calendar-to">Through</label><input id="calendar-to" type="date" value={endDate} onChange={(event) => onEndChange(event.target.value)} /></div>
          </div>
          <p className="field-hint">Up to 90 days. Times shown in {timezone}.</p>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
