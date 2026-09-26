"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, CalendarDays, Clock, Sparkles, Users } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import { useUiPreference } from "@/lib/ui-preferences";
import type { CachedCalendarEvent, CalendarSnapshot, KnowledgeTextProfile, PrepReport } from "@/lib/types";
import { CalendarBrandIcon } from "./brand-icons";
import { calendarProviderNames, platformLabel } from "./calendar-providers";
import { PrepReportView } from "./meeting-prep-report";
import { PageHeader } from "./ui/page-header";
import { EmptyState, LoadingRow, Skeleton } from "./ui/feedback";
import { SwitchField } from "./ui/switch";
import { UiSelect } from "./ui-select";

function dateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

const listDate: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

export function MeetingPrepWorkspace({ identity, initialEvent, onOpenCalendar, onOpenOrganization }: {
  identity: string;
  initialEvent?: CachedCalendarEvent | null;
  onOpenCalendar(): void;
  onOpenOrganization(): void;
}) {
  const [snapshot, setSnapshot] = useState<CalendarSnapshot>({ events: [], syncs: [] });
  const [selectedId, setSelectedId] = useUiPreference(`meetings-ai:prep-event:${identity}`, initialEvent?.id ?? "", (value): value is string => typeof value === "string");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range] = useState(() => {
    const first = new Date();
    const last = new Date(first); last.setDate(first.getDate() + 89);
    return { first: dateKey(first), last: dateKey(last), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
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
          <div><h2>Upcoming meetings</h2><p>{loading ? "Next 90 days" : `${events.length} saved · next 90 days`}</p></div>
        </div>
        {loading ? <LoadingRow>Loading saved meetings…</LoadingRow> : <ul className="prep-event-list">
          {events.map((event) => <li key={event.id}>
            <button type="button" className={selectedId === event.id ? "meeting-prep-event selected" : "meeting-prep-event"} aria-current={selectedId === event.id ? "true" : undefined} onClick={() => setSelectedId(event.id)}>
              <CalendarBrandIcon provider={event.provider} size="sm" />
              <span className="prep-event-copy"><b>{event.title}</b><small>{new Date(event.starts_at).toLocaleString(undefined, listDate)}</small></span>
            </button>
          </li>)}
        </ul>}
      </aside>
      <div className="prep-main">
        {selectedEvent ? <>
          <EventSummary event={selectedEvent} />
          <MeetingPrepPanel key={selectedEvent.id} event={selectedEvent} />
        </> : loading ? <div className="card card-body"><Skeleton lines={4} /></div> : <div className="card"><EmptyState plain icon={<Sparkles />} title="Select a meeting">Its details and saved briefing appear here.</EmptyState></div>}
      </div>
    </div>}
  </section>;
}

function EventSummary({ event }: { event: CachedCalendarEvent }) {
  const starts = new Date(event.starts_at);
  const invitees = event.invitees?.length ?? 0;
  return <header className="card prep-summary-card">
    <div className="prep-summary-source"><CalendarBrandIcon provider={event.provider} size="sm" />{calendarProviderNames[event.provider]} · {platformLabel(event.platform)}</div>
    <h2>{event.title}</h2>
    <ul className="prep-summary-facts">
      <li><Clock aria-hidden="true" />{starts.toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}</li>
      <li><Users aria-hidden="true" />{invitees} invited {invitees === 1 ? "person" : "people"}</li>
    </ul>
    {event.agenda ? <p className="prep-summary-agenda"><b>Agenda</b>{event.agenda}</p> : null}
  </header>;
}

export function MeetingPrepPanel({ event }: { event: CachedCalendarEvent }) {
  const [report, setReport] = useState<PrepReport | null>(null);
  const [targetCompany, setTargetCompany] = useState("");
  const [context, setContext] = useState("");
  const [profileUrls, setProfileUrls] = useState("");
  const [researchEnabled, setResearchEnabled] = useState(true);
  const [textProfiles, setTextProfiles] = useState<KnowledgeTextProfile[]>([]);
  const [textProfileId, setTextProfileId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void meetingsService.getMeetingPrep(event.id).then(setReport)
      .catch(() => setError("A previous briefing could not be loaded. You can generate a new one."));
    void meetingsService.listKnowledgeTextProfiles().then(setTextProfiles).catch(() => undefined);
  }, [event.id]);

  async function generate() {
    setBusy(true); setError(null);
    try {
      setReport(await meetingsService.generateMeetingPrep(event.id, {
        context, target_company: targetCompany.trim() || null,
        profile_urls: profileUrls.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean),
        text_profile_id: textProfileId || null, research_enabled: researchEnabled,
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Meeting prep failed."); }
    finally { setBusy(false); }
  }

  return <>
    {report ? <PrepReportView report={report} /> : null}
    <section className="card meeting-prep-panel" aria-label="Meeting preparation">
      <div className="card-header">
        <div><h2>{report ? "Refresh your briefing" : "Build your briefing"}</h2><p>Uses your private company profile and, if you allow it, cited public research.</p></div>
      </div>
      <div className="card-body form-stack">
        <div className="field-row">
          <div className="field">
            <label htmlFor="prep-company">Target company</label>
            <input id="prep-company" value={targetCompany} onChange={(change) => setTargetCompany(change.target.value)} placeholder="Inferred from invitee domains if blank" />
          </div>
          <UiSelect id="prep-model" label="Analysis provider" value={textProfileId} onChange={setTextProfileId} options={[{ value: "", label: "Workspace default" }, ...textProfiles.map((item) => ({ value: item.id, label: item.name }))]} />
        </div>
        <div className="field">
          <label htmlFor="prep-context">What you already know or want to learn</label>
          <textarea id="prep-context" rows={3} value={context} onChange={(change) => setContext(change.target.value)} placeholder="Relationship history, meeting goal, specific questions…" />
        </div>
        <div className="field">
          <label htmlFor="prep-profiles">Public profile or company URLs <span className="optional">one per line</span></label>
          <textarea id="prep-profiles" rows={2} value={profileUrls} onChange={(change) => setProfileUrls(change.target.value)} placeholder="https://www.linkedin.com/in/…" />
        </div>
        <div className="inset-panel">
          <SwitchField id="prep-research" label="Research the public web" description="Needs a configured OpenAI provider and may incur tool charges. Searches use the company, profile URLs and attendee names only — never titles, agendas, emails or private documents." checked={researchEnabled} onChange={setResearchEnabled} />
        </div>
        {error ? <p role="alert" className="form-error">{error}</p> : null}
        <div className="button-group">
          <button type="button" className="button primary" disabled={busy} onClick={() => void generate()}>{busy ? "Researching and preparing…" : report ? "Refresh briefing" : "Generate briefing"}</button>
        </div>
      </div>
    </section>
  </>;
}
