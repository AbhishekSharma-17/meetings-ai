"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, CheckCircle2, ExternalLink, Sparkles } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import { useUiPreference } from "@/lib/ui-preferences";
import type { CachedCalendarEvent, CalendarConnection, CalendarSnapshot, KnowledgeTextProfile, PrepReport } from "@/lib/types";
import { CalendarBrandIcon } from "./calendar-import-dialog";
import { UiSelect } from "./ui-select";

const sourceNames: Record<CalendarConnection["provider"], string> = {
  googlecalendar: "Google Calendar", outlook: "Outlook Calendar", calendly: "Calendly", zoom: "Zoom",
};

function dateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

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

  return <section className="page meeting-prep-workspace" aria-labelledby="meeting-prep-title">
    <div className="meeting-prep-heading"><div><p className="eyebrow">BEFORE THE CONVERSATION</p><h1 id="meeting-prep-title">Meeting prep</h1><p className="intro">Turn a scheduled conversation into a useful, source-backed briefing. Review every claim before your call.</p></div><button type="button" className="button secondary" onClick={onOpenOrganization}>Company profile</button></div>
    <div className="meeting-prep-note"><Sparkles size={17} /><span>Showing saved events for the next 90 days. Sync more events in Calendar; nothing is researched until you ask.</span><button type="button" onClick={onOpenCalendar}>Open calendar</button></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="meeting-prep-layout">
      <aside className="meeting-prep-list" aria-label="Meetings to prepare"><div className="meeting-prep-list-heading"><h2>Upcoming meetings</h2><small>{events.length} saved</small></div>
        {loading ? <p className="meeting-prep-empty">Loading saved meetings…</p> : events.length ? events.map((event) => <button type="button" key={event.id} className={selectedId === event.id ? "meeting-prep-event selected" : "meeting-prep-event"} aria-current={selectedId === event.id ? "true" : undefined} onClick={() => setSelectedId(event.id)}><CalendarBrandIcon provider={event.provider} /><span><b>{event.title}</b><small>{new Date(event.starts_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small><small>{sourceNames[event.provider]}</small></span></button>) : <div className="meeting-prep-empty"><CalendarDays /><b>No saved upcoming meetings</b><p>Connect and sync a meeting source in Calendar, then come back to prepare.</p><button type="button" className="button secondary" onClick={onOpenCalendar}>Go to Calendar</button></div>}
      </aside>
      <div className="meeting-prep-main">{selectedEvent ? <><header className="meeting-prep-event-heading"><div className="calendar-event-source"><CalendarBrandIcon provider={selectedEvent.provider} /><span>{sourceNames[selectedEvent.provider]} · {selectedEvent.platform.replaceAll("_", " ")}</span></div><h2>{selectedEvent.title}</h2><p>{new Date(selectedEvent.starts_at).toLocaleString()} · {selectedEvent.invitees?.length ?? 0} invited people</p>{selectedEvent.agenda ? <p className="meeting-prep-agenda"><b>Agenda</b> {selectedEvent.agenda}</p> : null}</header><MeetingPrepPanel key={selectedEvent.id} event={selectedEvent} /></> : <div className="meeting-prep-placeholder"><Sparkles /><h2>Select a meeting</h2><p>Its details and saved briefing will appear here.</p></div>}</div>
    </div>
  </section>;
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

  return <section className="calendar-prep meeting-prep-panel" aria-label="Meeting preparation"><div className="section-heading"><div><p className="eyebrow">PRE-MEETING RECON</p><h2>Build your briefing</h2><p>Use your private company profile and, optionally, cited public research.</p></div></div><div className="calendar-prep-inputs"><div><label htmlFor="prep-company">Target company</label><input id="prep-company" value={targetCompany} onChange={(change) => setTargetCompany(change.target.value)} placeholder="Optional; inferred from invitee domains if blank" /></div><div><label htmlFor="prep-profiles">Public profile or company URLs · one per line</label><textarea id="prep-profiles" rows={3} value={profileUrls} onChange={(change) => setProfileUrls(change.target.value)} placeholder="https://www.linkedin.com/in/…" /></div><div className="full"><label htmlFor="prep-context">What you already know or want to learn</label><textarea id="prep-context" rows={3} value={context} onChange={(change) => setContext(change.target.value)} placeholder="Relationship history, meeting objective, specific questions…" /></div><UiSelect id="prep-model" label="Analysis provider" value={textProfileId} onChange={setTextProfileId} options={[{ value: "", label: "Workspace text-generation default" }, ...textProfiles.map((item) => ({ value: item.id, label: item.name }))]} /><label className="calendar-research-toggle"><input type="checkbox" checked={researchEnabled} onChange={(change) => setResearchEnabled(change.target.checked)} /> Research public web with a configured OpenAI provider</label></div><p className="field-hint">Public searches use the company, public profile URLs and attendee names—not meeting titles, agendas, emails or private company documents. Final analysis uses the selected text provider. Public web research may incur tool charges.</p><button type="button" className="button primary" disabled={busy} onClick={() => void generate()}>{busy ? "Researching and preparing…" : report ? "Refresh briefing" : "Generate briefing"}</button>{error ? <p role="alert" className="form-error">{error}</p> : null}{report ? <PrepReportView report={report} /> : null}</section>;
}

function PrepReportView({ report }: { report: PrepReport }) {
  const sourceMap = new Map(report.sources.map((source) => [source.id, source]));
  return <article className="prep-report"><div className="prep-report-header"><span className="calendar-connection-badge"><CheckCircle2 /> Saved briefing</span><small>{new Date(report.generated_at).toLocaleString()} · {report.provider} / {report.model}</small></div><h3>{report.target_company ? `Briefing: ${report.target_company}` : "Meeting briefing"}</h3><p className="prep-summary">{report.executive_brief}</p>{!report.public_research_performed ? <p className="calendar-note">Context-only: no public web research was run.</p> : null}{report.findings.length ? <section><h4>Public findings</h4><ul>{report.findings.map((finding, index) => <li key={index}>{finding.statement}<span className="prep-citations">{finding.source_ids.map((id) => { const source = sourceMap.get(id); return source ? <a key={id} href={source.url} target="_blank" rel="noreferrer noopener">{id} <ExternalLink size={12} /><span className="sr-only">{source.title}</span></a> : null; })}</span></li>)}</ul></section> : null}<div className="prep-report-columns">{([["Relevant offerings", report.relevant_offerings], ["Talking points", report.talking_points], ["Questions to ask", report.questions_to_ask], ["People & roles to verify", report.people_notes], ["Watchouts", report.watchouts]] as [string, string[]][]).map(([title, items]) => items.length ? <section key={title}><h4>{title}</h4><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></section> : null)}</div>{report.sources.length ? <details className="prep-sources"><summary>{report.sources.length} public source{report.sources.length === 1 ? "" : "s"}</summary>{report.sources.map((source) => <a key={source.id} href={source.url} target="_blank" rel="noreferrer noopener">{source.id} · {source.title} <ExternalLink size={12} /></a>)}</details> : null}</article>;
}
