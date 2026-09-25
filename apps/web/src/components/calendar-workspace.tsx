"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, CheckCircle2, Plus, RefreshCw, Sparkles, ExternalLink } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { CachedCalendarEvent, CalendarConnection, CalendarSchedule, CalendarSnapshot, KnowledgeTextProfile, PrepReport } from "@/lib/types";
import { CalendarBrandIcon, type CalendarSelection } from "./calendar-import-dialog";
import { UiSelect } from "./ui-select";

const providerNames: Record<CalendarConnection["provider"], string> = {
  googlecalendar: "Google Calendar", outlook: "Outlook Calendar", calendly: "Calendly", zoom: "Zoom",
};

function dayKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function eventDay(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const get = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function currentMonth(): Date { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); }

export function CalendarWorkspace({ preferredConnectionId, onChoose }: {
  preferredConnectionId?: string | null;
  onChoose(selection: CalendarSelection): void;
}) {
  const [tab, setTab] = useState<"calendar" | "integrations">("calendar");
  const [month, setMonth] = useState(currentMonth);
  const [startDate, setStartDate] = useState(() => dayKey(currentMonth()));
  const [endDate, setEndDate] = useState(() => dayKey(new Date(currentMonth().getFullYear(), currentMonth().getMonth() + 1, 0)));
  const [selectedDay, setSelectedDay] = useState(() => dayKey(new Date()));
  const [timezone] = useState(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return zone === "Asia/Calcutta" ? "Asia/Kolkata" : zone;
  });
  const [connections, setConnections] = useState<CalendarConnection[]>([]);
  const [schedules, setSchedules] = useState<CalendarSchedule[]>([]);
  const [snapshot, setSnapshot] = useState<CalendarSnapshot>({ events: [], syncs: [] });
  const [accountFilter, setAccountFilter] = useState(preferredConnectionId ?? "all");
  const [selectedEvent, setSelectedEvent] = useState<CachedCalendarEvent | null>(null);
  const [prep, setPrep] = useState<PrepReport | null>(null);
  const [prepOpen, setPrepOpen] = useState(false);
  const [targetCompany, setTargetCompany] = useState("");
  const [context, setContext] = useState("");
  const [profileUrls, setProfileUrls] = useState("");
  const [researchEnabled, setResearchEnabled] = useState(true);
  const [textProfiles, setTextProfiles] = useState<KnowledgeTextProfile[]>([]);
  const [textProfileId, setTextProfileId] = useState("");
  const [busy, setBusy] = useState(false);
  const [prepBusy, setPrepBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prepError, setPrepError] = useState<string | null>(null);
  const rangeDays = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 + 1;
  const rangeValid = Number.isFinite(rangeDays) && rangeDays >= 1 && rangeDays <= 90;

  const load = useCallback(() => {
    return Promise.all([
      meetingsService.listCalendarConnections(), meetingsService.listCalendarSchedules(),
      meetingsService.getSyncedCalendar(startDate, endDate, timezone),
    ]);
  }, [startDate, endDate, timezone]);

  useEffect(() => { if (!rangeValid) return; void load().then(([nextConnections, nextSchedules, nextSnapshot]) => {
    setConnections(nextConnections); setSchedules(nextSchedules); setSnapshot(nextSnapshot);
  }).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load saved calendar events.")); }, [load, rangeValid]);
  useEffect(() => { void meetingsService.listKnowledgeTextProfiles().then(setTextProfiles).catch(() => undefined); }, []);

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
    setSelectedDay(dayKey(next)); setSelectedEvent(null); setPrep(null);
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

  async function chooseEvent(event: CachedCalendarEvent) {
    setSelectedEvent(event); setPrep(null); setPrepError(null); setPrepOpen(false);
    setTargetCompany(""); setContext(""); setProfileUrls("");
    try { setPrep(await meetingsService.getMeetingPrep(event.id)); }
    catch { setPrepError("A previous brief could not be loaded. You can generate a new one."); }
  }

  async function generatePrep() {
    if (!selectedEvent) return;
    setPrepBusy(true); setPrepError(null);
    try {
      setPrep(await meetingsService.generateMeetingPrep(selectedEvent.id, {
        context, target_company: targetCompany.trim() || null,
        profile_urls: profileUrls.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean),
        text_profile_id: textProfileId || null, research_enabled: researchEnabled,
      }));
    } catch (cause) { setPrepError(cause instanceof Error ? cause.message : "Meeting prep failed."); }
    finally { setPrepBusy(false); }
  }

  const calendarSources: CalendarConnection["provider"][] = ["googlecalendar", "outlook", "calendly", "zoom"];
  return <section className="page calendar-workspace" aria-labelledby="calendar-workspace-title">
    <div className="calendar-workspace-heading"><div><p className="eyebrow">YOUR SCHEDULE</p><h1 id="calendar-workspace-title">Calendar</h1><p className="intro">One place for sourced meetings across connected accounts. Events remain here after the last sync.</p></div><button type="button" className="button secondary" disabled={busy || !active.length || !rangeValid} onClick={() => void sync()}><RefreshCw size={16} /> {busy ? "Syncing…" : "Sync now"}</button></div>
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
        return <button type="button" key={key} className={["calendar-day", day.getMonth() !== month.getMonth() ? "outside" : "", key === selectedDay ? "selected" : ""].join(" ")} aria-label={`${day.toDateString()}, ${matches.length} meetings`} onClick={() => { setSelectedDay(key); setSelectedEvent(null); setPrep(null); }}><span>{day.getDate()}</span><small>{matches.slice(0, 2).map((event) => <i key={event.id} className={`source-${event.provider}`}>{event.title}</i>)}{matches.length > 2 ? `+${matches.length - 2} more` : null}</small></button>;
      })}</div></div>
      <div className="calendar-content-grid"><section className="calendar-agenda"><div className="section-heading"><div><h2>Meetings on {new Date(`${selectedDay}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}</h2><p>{dayEvents.length} saved event{dayEvents.length === 1 ? "" : "s"} · {visibleEvents.length} in the selected range</p></div></div>{dayEvents.length ? dayEvents.map((event) => <button type="button" key={event.id} className={selectedEvent?.id === event.id ? "calendar-agenda-event selected" : "calendar-agenda-event"} onClick={() => void chooseEvent(event)}><span className={`calendar-source-dot source-${event.provider}`} /><span><b>{event.title}</b><small>{new Date(event.starts_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {providerNames[event.provider]} · {event.platform.replaceAll("_", " ")}</small></span><ChevronRight size={16} /></button>) : <div className="empty-state"><b>No saved meetings on this day.</b><p>{active.length ? "Sync your accounts or choose another date." : "Connect an account in Integrations, then sync."}</p></div>}{visibleEvents.length && !dayEvents.length ? <div className="calendar-other-events"><h3>Other events in range</h3>{visibleEvents.slice(0, 10).map((event) => <button key={event.id} type="button" onClick={() => { setSelectedDay(eventDay(event.starts_at, timezone)); void chooseEvent(event); }}>{new Date(event.starts_at).toLocaleDateString()} · {event.title} · {providerNames[event.provider]}</button>)}</div> : null}</section>
      <aside className="calendar-event-detail" aria-label="Meeting details">{selectedEvent ? <><div className="calendar-event-source"><CalendarBrandIcon provider={selectedEvent.provider} /><span>{providerNames[selectedEvent.provider]} · {selectedEvent.platform.replaceAll("_", " ")}</span></div><h2>{selectedEvent.title}</h2><p>{new Date(selectedEvent.starts_at).toLocaleString()} – {new Date(selectedEvent.ends_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p>{selectedEvent.organizer ? <p><b>Organizer</b> {selectedEvent.organizer}</p> : null}{selectedEvent.agenda ? <div className="calendar-event-agenda"><b>Agenda</b><p>{selectedEvent.agenda}</p></div> : null}<div className="calendar-invitees"><b>Invited people · {selectedEvent.invitees?.length ?? 0}</b><p className="field-hint">Invitees are not verified attendees or speakers.</p>{selectedEvent.invitees?.map((person, index) => <p key={`${person.email ?? person.name}-${index}`}>{person.name}{person.email ? <small>{person.email}</small> : null}</p>)}</div><div className="calendar-event-actions">{schedules.some((item) => item.connection_id === selectedEvent.connection_id && item.event_id === selectedEvent.event_id && new Date(item.starts_at).getTime() === new Date(selectedEvent.starts_at).getTime()) ? <span className="calendar-scheduled">Assistant already scheduled</span> : <button type="button" className="button secondary" onClick={() => onChoose({ event: selectedEvent, period: "this_week", timezone, eventDate: eventDay(selectedEvent.starts_at, timezone), willSchedule: new Date(selectedEvent.starts_at).getTime() > Date.now() + 60_000 })}>Set up assistant</button>}<button type="button" className="button primary" onClick={() => setPrepOpen(true)}><Sparkles size={16} /> Prepare for meeting</button></div><small className="calendar-sync-meta">Last synced {new Date(selectedEvent.synced_at).toLocaleString()}</small></> : <div className="calendar-detail-empty"><CalendarDays /><h2>Select a meeting</h2><p>See the source, agenda, invitees and your research brief here.</p></div>}</aside></div>
      {selectedEvent && prepOpen ? <section className="calendar-prep" aria-label="Meeting preparation"><div className="section-heading"><div><p className="eyebrow">PRE-MEETING RECON</p><h2>Prepare for {selectedEvent.title}</h2><p>Public research plus your private organization profile. Check sources before relying on a claim.</p></div><button type="button" className="text-button" onClick={() => setPrepOpen(false)}>Close</button></div><div className="calendar-prep-inputs"><div><label htmlFor="prep-company">Target company</label><input id="prep-company" value={targetCompany} onChange={(event) => setTargetCompany(event.target.value)} placeholder="Optional; inferred from invitee domains if blank" /></div><div><label htmlFor="prep-profiles">Public profile or company URLs · one per line</label><textarea id="prep-profiles" rows={3} value={profileUrls} onChange={(event) => setProfileUrls(event.target.value)} placeholder="https://www.linkedin.com/in/…" /></div><div className="full"><label htmlFor="prep-context">What you already know or want to learn</label><textarea id="prep-context" rows={3} value={context} onChange={(event) => setContext(event.target.value)} placeholder="Relationship history, meeting objective, specific questions…" /></div><UiSelect id="prep-model" label="Analysis provider" value={textProfileId} onChange={setTextProfileId} options={[{ value: "", label: "Workspace text-generation default" }, ...textProfiles.map((item) => ({ value: item.id, label: item.name }))]} /><label className="calendar-research-toggle"><input type="checkbox" checked={researchEnabled} onChange={(event) => setResearchEnabled(event.target.checked)} /> Research public web with a configured OpenAI provider</label></div><p className="field-hint">Public searches use the title, company, public profile URLs and attendee names—not your private company documents. The final analysis uses the selected text provider. Public web research may incur tool charges.</p><button type="button" className="button primary" disabled={prepBusy} onClick={() => void generatePrep()}>{prepBusy ? "Researching and preparing…" : prep ? "Refresh briefing" : "Generate briefing"}</button>{prepError ? <p role="alert" className="form-error">{prepError}</p> : null}{prep ? <PrepReportView report={prep} /> : null}</section> : null}
    </> : null}
  </section>;
}

function PrepReportView({ report }: { report: PrepReport }) {
  const sourceMap = new Map(report.sources.map((source) => [source.id, source]));
  return <article className="prep-report"><div className="prep-report-header"><span className="calendar-connection-badge"><CheckCircle2 /> Saved briefing</span><small>{new Date(report.generated_at).toLocaleString()} · {report.provider} / {report.model}</small></div><h3>{report.target_company ? `Briefing: ${report.target_company}` : "Meeting briefing"}</h3><p className="prep-summary">{report.executive_brief}</p>{!report.public_research_performed ? <p className="calendar-note">Context-only: no public web research was run.</p> : null}{report.findings.length ? <section><h4>Public findings</h4><ul>{report.findings.map((finding, index) => <li key={index}>{finding.statement}<span className="prep-citations">{finding.source_ids.map((id) => { const source = sourceMap.get(id); return source ? <a key={id} href={source.url} target="_blank" rel="noreferrer noopener">{id} <ExternalLink size={12} /><span className="sr-only">{source.title}</span></a> : null; })}</span></li>)}</ul></section> : null}<div className="prep-report-columns">{([["Relevant offerings", report.relevant_offerings], ["Talking points", report.talking_points], ["Questions to ask", report.questions_to_ask], ["People & roles to verify", report.people_notes], ["Watchouts", report.watchouts]] as [string, string[]][]).map(([title, items]) => items.length ? <section key={title}><h4>{title}</h4><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></section> : null)}</div>{report.sources.length ? <details className="prep-sources"><summary>{report.sources.length} public source{report.sources.length === 1 ? "" : "s"}</summary>{report.sources.map((source) => <a key={source.id} href={source.url} target="_blank" rel="noreferrer noopener">{source.id} · {source.title} <ExternalLink size={12} /></a>)}</details> : null}</article>;
}
