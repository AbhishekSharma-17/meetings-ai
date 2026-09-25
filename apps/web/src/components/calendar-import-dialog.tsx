"use client";

import { useEffect, useId, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CalendarDays, CheckCircle2, X } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { CalendarConnection, CalendarEvent, CalendarPeriod, CalendarSchedule } from "@/lib/types";
import { UiSelect } from "./ui-select";

export type CalendarSelection = { event: CalendarEvent; period: CalendarPeriod; timezone: string; willSchedule: boolean };

const periods: { value: CalendarPeriod; label: string }[] = [
  { value: "today", label: "Today" }, { value: "tomorrow", label: "Tomorrow" },
  { value: "this_week", label: "This week" }, { value: "next_week", label: "Next week" },
];

export function CalendarImportDialog({ open, preferredConnectionId, onClose, onChoose }: { open: boolean; preferredConnectionId?: string | null; onClose(): void; onChoose(selection: CalendarSelection): void }) {
  const titleId = useId();
  const [connections, setConnections] = useState<CalendarConnection[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [schedules, setSchedules] = useState<CalendarSchedule[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [period, setPeriod] = useState<CalendarPeriod>("today");
  const [timezone] = useState(() => {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return browserZone === "Asia/Calcutta" ? "Asia/Kolkata" : browserZone;
  });
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
        setConnectionId((current) => {
          if (preferredConnectionId && nextConnections.some((item) => item.id === preferredConnectionId && item.status === "ACTIVE")) return preferredConnectionId;
          return nextConnections.some((item) => item.id === current && item.status === "ACTIVE") ? current : nextConnections.find((item) => item.status === "ACTIVE")?.id || "";
        });
        setLoadingConnections(false);
      })
      .catch((cause) => { if (alive) { setError(cause instanceof Error ? cause.message : "Could not load calendar connections."); setLoadingConnections(false); } });
    return () => { alive = false; };
  }, [open, preferredConnectionId]);

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
  const activeConnections = connections.filter((item) => item.status === "ACTIVE");
  const googleCount = activeConnections.filter((item) => item.provider === "googlecalendar").length;
  const outlookCount = activeConnections.filter((item) => item.provider === "outlook").length;
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal><Dialog.Backdrop className="dialog-backdrop" /><Dialog.Popup className="dialog calendar-dialog" aria-labelledby={titleId}>
      <Dialog.Close className="close-button" aria-label="Close"><X /></Dialog.Close>
      <p className="eyebrow"><CalendarDays size={16} /> CALENDAR</p>
      <Dialog.Title id={titleId}>Your calendar meetings</Dialog.Title>
      <Dialog.Description className="dialog-intro">Connect one or more calendars, then choose the account and time range to review before sending or scheduling an assistant.</Dialog.Description>
      <div className="calendar-provider-grid" aria-label="Calendar connections">
        <div className={googleCount ? "calendar-provider-card connected" : "calendar-provider-card"}><CalendarBrandIcon provider="googlecalendar" /><div><b>Google Calendar</b><small>{googleCount ? `${googleCount} connected account${googleCount === 1 ? "" : "s"}` : "Connect a Google account"}</small></div><div className="calendar-provider-actions">{googleCount ? <span className="calendar-connection-badge"><CheckCircle2 /> Connected</span> : null}<button className="button secondary" type="button" disabled={busy || loadingConnections} onClick={() => void connect("googlecalendar")}>{googleCount ? "Add another" : "Connect account"}</button></div></div>
        <div className={outlookCount ? "calendar-provider-card connected" : "calendar-provider-card"}><CalendarBrandIcon provider="outlook" /><div><b>Outlook Calendar</b><small>{outlookCount ? `${outlookCount} connected account${outlookCount === 1 ? "" : "s"}` : "Connect a Microsoft account"}</small></div><div className="calendar-provider-actions">{outlookCount ? <span className="calendar-connection-badge"><CheckCircle2 /> Connected</span> : null}<button className="button secondary" type="button" disabled={busy || loadingConnections} onClick={() => void connect("outlook")}>{outlookCount ? "Add another" : "Connect account"}</button></div></div>
      </div>
      {activeConnections.length ? <div className="calendar-account-list"><h3>Connected accounts</h3>{activeConnections.map((item) => <div className="calendar-account-row" key={item.id}><CalendarBrandIcon provider={item.provider} /><span><b>{item.label}</b><small>{item.provider === "googlecalendar" ? "Google Calendar" : "Outlook Calendar"}</small></span><span className="calendar-connection-badge"><CheckCircle2 /> Connected</span></div>)}</div> : null}
      <div className="calendar-search-controls">
        <UiSelect id="calendar-account" label="Scan calendar account" value={connectionId} onChange={(value) => { setConnectionId(value); setScanned(false); }} options={activeConnections.length ? activeConnections.map((item) => ({ value: item.id, label: `${item.provider === "googlecalendar" ? "Google" : "Outlook"} · ${item.label}` })) : [{ value: "", label: loadingConnections ? "Loading calendars…" : "Connect a calendar first" }]} disabled={!activeConnections.length || busy} />
        <UiSelect id="calendar-period" label="When" value={period} onChange={(value) => { setPeriod(value as CalendarPeriod); setScanned(false); }} options={periods} disabled={busy} />
      </div>
      {connections.length > 0 && !activeConnections.length ? <p className="calendar-note">A connection is pending or expired. Complete the provider consent screen or connect again.</p> : null}
      <p className="calendar-note">Times shown in {timezone}. We show upcoming events with a Google Meet, Zoom, Teams, or Jitsi link.</p>
      <button className="button primary" type="button" disabled={!connectionId || busy} onClick={() => void scan()}>{busy ? "Checking calendar…" : "Show meetings"}</button>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {scanned ? <div className="calendar-results" aria-live="polite">
        <h3>{events.length ? `${events.length} upcoming meeting${events.length === 1 ? "" : "s"}` : "No upcoming supported meetings in this range"}</h3>
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

function CalendarBrandIcon({ provider }: { provider: CalendarConnection["provider"] }) {
  if (provider === "googlecalendar") return <svg className="calendar-brand-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="7" width="38" height="36" rx="5" fill="#fff" /><path d="M5 13a6 6 0 0 1 6-6h10v8H5z" fill="#4285F4" /><path d="M21 7h16a6 6 0 0 1 6 6v2H21z" fill="#34A853" /><path d="M43 15v22a6 6 0 0 1-6 6h-2V15z" fill="#FBBC04" /><path d="M35 43H11a6 6 0 0 1-6-6v-2h30z" fill="#EA4335" /><path d="M5 15h8v20H5z" fill="#4285F4" /><path d="M20 24h4c2 0 3 1 3 3 0 1-.5 2-1.6 2.5 1.4.5 2 1.5 2 3 0 2.5-2 4-5 4-2 0-3.4-.4-4.8-1.3l1.2-2.5c1 .6 2 .9 3.2.9 1.1 0 1.7-.4 1.7-1.2 0-.8-.6-1.2-1.8-1.2h-1.7v-2.5h1.6c1.1 0 1.6-.4 1.6-1.1 0-.7-.5-1.1-1.4-1.1-1 0-2 .3-2.9.9l-1.2-2.5c1.4-.9 2.8-1.3 4.5-1.3Zm10 0h3v13h-3z" fill="#4285F4" /></svg>;
  return <svg className="calendar-brand-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="13" y="7" width="30" height="34" rx="4" fill="#0078D4" /><path d="M15 17h26v20H15z" fill="#29A7F0" /><path d="M15 18 28 28l13-10v3L28 31 15 21z" fill="#fff" /><path d="M15 41 27 31l2 1 12 9z" fill="#0078D4" /><rect x="4" y="12" width="24" height="29" rx="3" fill="#005A9E" /><path d="M16 20c-4 0-6.4 2.8-6.4 6.8s2.4 6.8 6.4 6.8 6.4-2.8 6.4-6.8S20 20 16 20Zm0 3c2 0 3.2 1.5 3.2 3.8S18 30.6 16 30.6s-3.2-1.5-3.2-3.8S14 23 16 23Z" fill="#fff" /></svg>;
}
