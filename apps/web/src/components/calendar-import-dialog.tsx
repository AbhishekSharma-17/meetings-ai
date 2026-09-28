"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CalendarSearch, X } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { CalendarConnection, CalendarEvent, CalendarPeriod, CalendarSchedule } from "@/lib/types";
import { AccountRow, CalendarAliasDialog, ProviderGrid } from "./calendar-connections";
import { CalendarConnectWaiting } from "./calendar-connect-waiting";
import { useCalendarConnect } from "./use-calendar-connect";
import { browserTimeZone, calendarProviderNames, platformLabel } from "./calendar-providers";
import { PageHeader } from "./ui/page-header";
import { Alert, Badge, EmptyState } from "./ui/feedback";
import { UiSelect } from "./ui-select";

export { CalendarBrandIcon } from "./brand-icons";

export type CalendarSelection = { event: CalendarEvent; period: CalendarPeriod; timezone: string; willSchedule: boolean; eventDate?: string };

const periods: { value: CalendarPeriod; label: string }[] = [
  { value: "today", label: "Today" }, { value: "tomorrow", label: "Tomorrow" },
  { value: "this_week", label: "This week" }, { value: "next_week", label: "Next week" },
];

export function CalendarImportDialog({ open, preferredConnectionId, onClose, onChoose, embedded = false }: { open: boolean; preferredConnectionId?: string | null; onClose(): void; onChoose(selection: CalendarSelection): void; embedded?: boolean }) {
  const titleId = useId();
  const [connections, setConnections] = useState<CalendarConnection[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [schedules, setSchedules] = useState<CalendarSchedule[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [period, setPeriod] = useState<CalendarPeriod>("today");
  const [timezone] = useState(browserTimeZone);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [connectProvider, setConnectProvider] = useState<CalendarConnection["provider"] | null>(null);
  const [connectedNotice, setConnectedNotice] = useState<string | null>(null);
  const connectFlow = useCalendarConnect({
    onConnected: (next, newId, provider) => {
      setConnections(next);
      const added = next.find((item) => item.id === newId && item.status === "ACTIVE");
      if (added) { setConnectionId(added.id); setScanned(false); }
      setConnectedNotice(`${calendarProviderNames[provider]} connected${added ? `: ${added.label}` : ""}. Choose when to look for meetings.`);
    },
    onError: (message) => { setBusy(false); setError(message); },
    onRedirect: () => setBusy(true),
  });

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

  /** Runs inside the alias dialog's submit so the provider tab opens from the user's gesture. */
  function connect(provider: CalendarConnection["provider"], alias: string) {
    setError(null); setConnectedNotice(null);
    connectFlow.start(provider, alias, connections.map((item) => item.id));
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
  const accountOptions = activeConnections.length
    ? activeConnections.map((item) => ({ value: item.id, label: `${calendarProviderNames[item.provider]} · ${item.label}` }))
    : [{ value: "", label: loadingConnections ? "Loading sources…" : "Connect a source first" }];
  const intro = "Connect one or more accounts, then pick an upcoming meeting to set up the assistant.";

  const body = <div className="calendar-import">
    <ProviderGrid activeConnections={activeConnections} disabled={busy || loadingConnections || connectFlow.wait !== null} onConnect={setConnectProvider} />
    <CalendarAliasDialog provider={connectProvider} busy={busy} onCancel={() => setConnectProvider(null)} onSubmit={(alias) => { if (connectProvider) { connect(connectProvider, alias); setConnectProvider(null); } }} />
    <CalendarConnectWaiting wait={connectFlow.wait} onReopen={connectFlow.reopen} onRecheck={connectFlow.recheck} onCancel={connectFlow.cancel} />
    {connectedNotice ? <Alert tone="success" className="calendar-connect-done">{connectedNotice}</Alert> : null}
    {connections.length > 0 && !activeConnections.length ? <Alert tone="warning">A connection is pending or expired. Finish the provider’s consent screen or connect again.</Alert> : null}
    {activeConnections.length ? <section className="card calendar-accounts" aria-labelledby={`${titleId}-accounts`}>
      <div className="card-header"><div><h3 id={`${titleId}-accounts`}>Connected accounts</h3></div><span className="section-count">{activeConnections.length}</span></div>
      <ul className="calendar-account-list">{activeConnections.map((item) => <AccountRow key={item.id} connection={item} meta={<Badge tone="success" dot>Connected</Badge>} />)}</ul>
    </section> : null}

    <section className="calendar-import-find" aria-labelledby={`${titleId}-find`}>
      <h3 id={`${titleId}-find`}>Find a meeting</h3>
      <div className="calendar-import-controls">
        <UiSelect id="calendar-account" label="Scan connected account" value={connectionId} onChange={(value) => { setConnectionId(value); setScanned(false); }} options={accountOptions} disabled={!activeConnections.length || busy} />
        <UiSelect id="calendar-period" label="When" value={period} onChange={(value) => { setPeriod(value as CalendarPeriod); setScanned(false); }} options={periods} disabled={busy} />
        <button className="button primary" type="button" disabled={!connectionId || busy} onClick={() => void scan()}>{busy ? "Checking calendar…" : "Show meetings"}</button>
      </div>
      <p className="field-hint">Times in {timezone}. Only meetings with a Google Meet, Zoom, Teams or Jitsi link appear. Invitees are not verified attendees.</p>
    </section>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {scanned ? <section className="calendar-import-results" aria-live="polite" aria-labelledby={`${titleId}-results`}>
      <h3 id={`${titleId}-results`}>{events.length ? `${events.length} upcoming meeting${events.length === 1 ? "" : "s"}` : "No upcoming meetings"}</h3>
      {events.length ? <ul className="list-card">{events.map((event) => {
        const scheduled = schedules.find((item) => item.connection_id === event.connection_id && item.event_id === event.event_id && new Date(item.starts_at).getTime() === new Date(event.starts_at).getTime());
        return <li className="list-row calendar-import-event" key={`${event.connection_id}:${event.event_id}:${event.starts_at}`}>
          <div className="calendar-import-event-copy">
            <b>{event.title}</b>
            <small>{new Date(event.starts_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {platformLabel(event.platform)} · {event.invitees?.length ?? 0} invited</small>
            {event.agenda ? <small className="calendar-import-agenda">{event.agenda}</small> : null}
          </div>
          {scheduled
            ? <Badge tone={scheduled.status === "cancelled" ? "neutral" : "success"}>{scheduled.status === "cancelled" ? "Previously cancelled · delete the old record to re-import" : scheduled.status.charAt(0).toUpperCase() + scheduled.status.slice(1)}</Badge>
            : <button className="button secondary sm" type="button" onClick={() => onChoose({ event, period, timezone, willSchedule: new Date(event.starts_at).getTime() > Date.now() + 60_000 })}>Review setup</button>}
        </li>;
      })}</ul> : <EmptyState icon={<CalendarSearch />} title="Nothing in this range">Try another account or time range.</EmptyState>}
    </section> : null}
  </div>;

  if (embedded) return <section className="page narrow calendar-page"><PageHeader title="Meeting sources" description={intro} />{body}</section>;
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog lg calendar-dialog" aria-labelledby={titleId}>
        <DialogHeading titleId={titleId} intro={intro} onClose={onClose}>Meeting sources</DialogHeading>
        <div className="dialog-body">{body}</div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function DialogHeading({ titleId, intro, onClose, children }: { titleId: string; intro: string; onClose(): void; children: ReactNode }) {
  return <>
    <button type="button" className="close-button" aria-label="Close" onClick={onClose}><X aria-hidden="true" /></button>
    <Dialog.Title id={titleId}>{children}</Dialog.Title>
    <Dialog.Description className="dialog-intro">{intro}</Dialog.Description>
  </>;
}
