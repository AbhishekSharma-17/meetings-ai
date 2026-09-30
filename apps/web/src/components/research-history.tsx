"use client";

import { ArrowUpRight, FileText, History, NotebookPen, Quote, Video } from "lucide-react";
import { formatDate } from "@/lib/time-preferences";
import type { CompanyHistory, PersonHistory, ProfileHistory } from "@/lib/research-types";
import { formatOffset } from "./knowledge-sources";
import { Alert, EmptyState, Skeleton } from "./ui/feedback";

export type HistoryLinks = {
  onOpenMeeting(id: string, segmentId?: string): void;
  onOpenPrep(eventId: string): void;
  onOpenKnowledge(baseId: string): void;
};

const isCompany = (history: ProfileHistory): history is CompanyHistory => "briefings" in history;

/** "Our history" with a company or person — only meetings, briefings and documents the viewer can already open. */
export function ResearchHistory({ history, error, links }: { history: ProfileHistory | null; error: string | null; links: HistoryLinks }) {
  return <section className="card rx-history" aria-labelledby="rx-history-title">
    <div className="card-header"><div><h2 id="rx-history-title"><History aria-hidden="true" /> Our history</h2><p>Meetings, briefings and knowledge you can already open.</p></div></div>
    <div className="card-body">
      {error ? <Alert tone="danger">{error}</Alert> : !history ? <Skeleton lines={3} /> : isCompany(history) ? <CompanyHistoryView history={history} links={links} /> : <PersonHistoryView history={history} links={links} />}
    </div>
  </section>;
}

function CompanyHistoryView({ history, links }: { history: CompanyHistory; links: HistoryLinks }) {
  if (history.our_company) return <p className="field-hint">This is your own company, so it isn’t matched against your meetings.</p>;
  if (!history.meetings.length && !history.briefings.length && !history.documents.length) {
    return <EmptyState plain icon={<History />} title="Nothing yet">No meetings, briefings or knowledge you can open mention this company.</EmptyState>;
  }
  return <div className="rx-history-groups">
    {history.meetings.length ? <div><h3>Meetings</h3><ul className="rx-history-list">{history.meetings.map((meeting) => <li key={meeting.meeting_id}>
      <Video aria-hidden="true" />
      <span><button type="button" className="text-button" onClick={() => links.onOpenMeeting(meeting.meeting_id)}>{meeting.title}</button><small>{formatDate(meeting.date)} · {meeting.reasons.join(" · ")}</small></span>
    </li>)}</ul></div> : null}
    {history.briefings.length ? <div><h3>Your meeting prep</h3><ul className="rx-history-list">{history.briefings.map((briefing) => <li key={briefing.calendar_event_id}>
      <NotebookPen aria-hidden="true" />
      <span><button type="button" className="text-button" onClick={() => links.onOpenPrep(briefing.calendar_event_id)}>{briefing.title}</button>
        <small>{formatDate(briefing.starts_at)} · {briefing.briefing_at ? `briefing from ${formatDate(briefing.briefing_at)}` : briefing.reasons.join(" · ")}</small>
        {briefing.executive_brief ? <em className="rx-history-snippet">{briefing.executive_brief}</em> : null}</span>
    </li>)}</ul></div> : null}
    {history.documents.length ? <div><h3>Knowledge</h3><ul className="rx-history-list">{history.documents.map((document) => <li key={document.document_id}>
      <FileText aria-hidden="true" />
      <span><button type="button" className="text-button" onClick={() => links.onOpenKnowledge(document.knowledge_base_id)}>{document.filename}</button><small>In {document.knowledge_base_name}</small></span>
    </li>)}</ul></div> : null}
  </div>;
}

function PersonHistoryView({ history, links }: { history: PersonHistory; links: HistoryLinks }) {
  if (!history.meetings.length) return <EmptyState plain icon={<History />} title="No meetings yet">This person isn’t in any meeting you can open.</EmptyState>;
  return <ul className="rx-history-list">{history.meetings.map((meeting) => <li key={meeting.meeting_id}>
    <Video aria-hidden="true" />
    <span>
      <button type="button" className="text-button" onClick={() => links.onOpenMeeting(meeting.meeting_id)}>{meeting.title}</button>
      <small>{formatDate(meeting.date)} · {meeting.reasons.join(" · ")}</small>
      {meeting.quotes.length ? <span className="rx-quotes" aria-label="What they said">{meeting.quotes.map((quote, index) => <button key={index} type="button" className="rx-quote" onClick={() => links.onOpenMeeting(meeting.meeting_id, quote.segment_id ?? undefined)}>
        <Quote aria-hidden="true" /><span>{quote.text}</span><small>{formatOffset(quote.start_seconds)} <ArrowUpRight aria-hidden="true" /></small>
      </button>)}</span> : meeting.reasons.includes("Invited") && !meeting.speaker ? <small className="field-hint">Their speaker label hasn’t been confirmed, so nothing is quoted.</small> : null}
    </span>
  </li>)}</ul>;
}
