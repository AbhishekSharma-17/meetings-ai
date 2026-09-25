"use client";

import { useEffect, useId, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CalendarDays, X } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { CalendarConnection, CalendarEvent, CalendarPeriod, CalendarSchedule } from "@/lib/types";

export type CalendarSelection = { event: CalendarEvent; period: CalendarPeriod; timezone: string; willSchedule: boolean };

const periods: { value: CalendarPeriod; label: string }[] = [
  { value: "today", label: "Today" }, { value: "tomorrow", label: "Tomorrow" },
  { value: "this_week", label: "This week" }, { value: "next_week", label: "Next week" },
];

export function CalendarImportDialog({ open, onClose, onChoose }: { open: boolean; onClose(): void; onChoose(selection: CalendarSelection): void }) {
  const titleId = useId();
  const [connections, setConnections] = useState<CalendarConnection[]>([]);
  const [schedules, setSchedules] = useState<CalendarSchedule[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [period, setPeriod] = useState<CalendarPeriod>("today");
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void Promise.all([meetingsService.listCalendarConnections(), meetingsService.listCalendarSchedules()])
      .then(([nextConnections, nextSchedules]) => {
        if (!alive) return;
        setConnections(nextConnections);
        setSchedules(nextSchedules);
        setConnectionId((current) => current || nextConnections.find((item) => item.status === "ACTIVE")?.id || "");
      })
      .catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : "Could not load calendar connections."); });
    return () => { alive = false; };
  }, [open]);

  async function connect(provider: CalendarConnection["provider"]) {
    setBusy(true); setError(null);
    try { window.location.assign(await meetingsService.connectCalendar(provider)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start calendar connection."); setBusy(false); }
  }

  async function scan() {
    if (!connectionId) return;
    setBusy(true); setError(null); setScanned(false);
    try { setEvents(await meetingsService.scanCalendar(connectionId, period, timezone)); setScanned(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not scan this calendar."); }
    finally { setBusy(false); }
  }

  if (!open) return null;
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal><Dialog.Backdrop className="dialog-backdrop" /><Dialog.Popup className="dialog calendar-dialog" aria-labelledby={titleId}>
      <Dialog.Close className="close-button" aria-label="Close"><X /></Dialog.Close>
      <p className="eyebrow"><CalendarDays size={16} /> CALENDAR DISCOVERY</p>
      <Dialog.Title id={titleId}>Find meetings to capture</Dialog.Title>
      <Dialog.Description className="dialog-intro">Connect your own Google or Outlook calendar. We only list events with a supported meeting link; nothing is joined until you choose it.</Dialog.Description>
      <div className="calendar-connect-actions">
        <button className="button secondary" type="button" disabled={busy} onClick={() => void connect("googlecalendar")}>Connect Google Calendar</button>
        <button className="button secondary" type="button" disabled={busy} onClick={() => void connect("outlook")}>Connect Outlook Calendar</button>
      </div>
      <label htmlFor="calendar-account">Connected account</label>
      <select id="calendar-account" value={connectionId} onChange={(event) => { setConnectionId(event.target.value); setScanned(false); }}>
        <option value="">Choose an active connection</option>
        {connections.filter((item) => item.status === "ACTIVE").map((item) => <option key={item.id} value={item.id}>{item.label} · {item.provider === "googlecalendar" ? "Google" : "Outlook"}</option>)}
      </select>
      {connections.length > 0 && !connections.some((item) => item.status === "ACTIVE") ? <p className="calendar-note">Connection pending. Complete the provider consent screen, then reopen this dialog.</p> : null}
      <label htmlFor="calendar-period">When</label>
      <select id="calendar-period" value={period} onChange={(event) => { setPeriod(event.target.value as CalendarPeriod); setScanned(false); }}>{periods.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select>
      <p className="calendar-note">Times use your time zone: {timezone}. Results omit events without a Google Meet, Zoom, Teams, or Jitsi link.</p>
      <button className="button primary" type="button" disabled={!connectionId || busy} onClick={() => void scan()}>{busy ? "Checking calendar…" : "Find meetings"}</button>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {scanned ? <div className="calendar-results" aria-live="polite">
        <h3>{events.length ? `${events.length} meeting${events.length === 1 ? "" : "s"} found` : "No supported meetings found"}</h3>
        {events.map((event) => {
          const scheduled = schedules.find((item) => item.connection_id === event.connection_id && item.event_id === event.event_id && new Date(item.starts_at).getTime() === new Date(event.starts_at).getTime());
          return <article className="calendar-event" key={`${event.connection_id}:${event.event_id}:${event.starts_at}`}>
            <div><b>{event.title}</b><small>{new Date(event.starts_at).toLocaleString()} · {event.platform}</small></div>
            {scheduled ? <span className="calendar-scheduled">{scheduled.status === "cancelled" ? "Previously cancelled · delete old record to re-import" : scheduled.status}</span> : <button className="button secondary" type="button" onClick={() => onChoose({ event, period, timezone, willSchedule: new Date(event.starts_at).getTime() > Date.now() + 60_000 })}>Review setup</button>}
          </article>;
        })}
      </div> : null}
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}
