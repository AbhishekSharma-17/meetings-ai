"use client";

import { ArrowUpRight, CircleCheck, FileText, GitBranch, ListChecks, Quote, ShieldCheck } from "lucide-react";
import type { KnowledgeMap, KnowledgeSource, KnowledgeWikiOverview } from "@/lib/types";
import { initials } from "@/lib/meeting-status";
import { EmptyState } from "./ui/feedback";

export type OpenSource = (meetingId: string, segmentId: string) => void;

export function formatOffset(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}

function sourceDate(source: KnowledgeSource): string {
  const value = source.meeting_joined_at ?? source.meeting_created_at;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
}

/** One cited piece of evidence: what was said, by whom, when, and a link to the exact turn. */
export function SourceCard({ source, onOpenSource, index, highlighted = false }: {
  source: KnowledgeSource;
  onOpenSource: OpenSource;
  index?: number;
  highlighted?: boolean;
}) {
  const speaker = source.speaker ?? "Unidentified";
  return <article className={highlighted ? "knowledge-source highlighted" : "knowledge-source"} id={index ? `citation-${source.source_id}` : undefined}>
    <header className="knowledge-source-head">
      {index ? <span className="citation-index" aria-label={`Source ${index}`}>{index}</span> : null}
      <span className="knowledge-source-kind">{source.kind === "transcript" ? <Quote aria-hidden="true" /> : <FileText aria-hidden="true" />}{source.kind === "transcript" ? "Transcript" : "Minutes"}</span>
      <b className="knowledge-source-title">{source.meeting_title}</b>
      <time>{sourceDate(source)}</time>
    </header>
    <p className="knowledge-source-text">{source.text}</p>
    <footer className="knowledge-source-foot">
      <span className="knowledge-source-speaker"><span className="avatar sm" aria-hidden="true">{initials(speaker)}</span><span>{source.kind === "transcript" ? "Speaker" : "Evidence speaker"}: {speaker}</span></span>
      <span className="knowledge-source-time">{formatOffset(source.start_seconds)} into transcript</span>
      {source.tags.length ? <span className="tag-list">{source.tags.map((tag) => <span className="tag" key={tag}>#{tag}</span>)}</span> : null}
      <button className="text-button knowledge-source-open" type="button" onClick={() => onOpenSource(source.meeting_id, source.segment_id)}>Open cited transcript <ArrowUpRight /></button>
    </footer>
  </article>;
}

export function WikiOverview({ overview, onOpenMeeting }: { overview: KnowledgeWikiOverview; onOpenMeeting(id: string): void }) {
  return <section className="wiki-section" aria-labelledby="wiki-meetings-title">
    <div className="section-heading"><div><h2 id="wiki-meetings-title"><GitBranch aria-hidden="true" /> Connected meetings</h2><p>{overview.meetings.length} completed meeting{overview.meetings.length === 1 ? "" : "s"}. Summaries come from approved minutes.</p></div></div>
    {overview.meetings.length ? <div className="wiki-meeting-grid">{overview.meetings.map((meeting) => <article className="card wiki-meeting" key={meeting.id}>
      <div className="wiki-meeting-body">
        <time className="wiki-meeting-date">{new Date(meeting.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time>
        <h3>{meeting.title}</h3>
        {meeting.summary ? <p className="wiki-summary">{meeting.summary}</p> : <p className="wiki-summary muted-copy">Approved minutes are not available yet.</p>}
        {meeting.decisions.length ? <div className="wiki-facts"><b><CircleCheck aria-hidden="true" /> Decisions</b><ul>{meeting.decisions.slice(0, 3).map((decision, index) => <li key={index}>{decision}</li>)}</ul></div> : null}
        {meeting.action_items.length ? <div className="wiki-facts"><b><ListChecks aria-hidden="true" /> Actions</b><ul>{meeting.action_items.slice(0, 3).map((action, index) => <li key={index}>{action}</li>)}</ul></div> : null}
        {meeting.tags.length ? <div className="tag-list">{meeting.tags.map((tag) => <span className="tag" key={tag}>#{tag}</span>)}</div> : null}
        {meeting.related_meetings?.length ? <div className="wiki-related"><b>Related meetings</b>{meeting.related_meetings.map((link) => <button type="button" key={link.meeting_id} onClick={() => onOpenMeeting(link.meeting_id)}><span>{link.title}</span><small>{link.reasons.join(" · ")}</small></button>)}</div> : null}
      </div>
      <div className="card-footer split"><span className="field-hint">Meeting record</span><button type="button" className="text-button" onClick={() => onOpenMeeting(meeting.id)}>Open meeting record <ArrowUpRight /></button></div>
    </article>)}</div> : <EmptyState icon={<GitBranch />} title="No connected meetings yet">Add a completed meeting to this knowledge base to build its wiki.</EmptyState>}
  </section>;
}

export function EvidenceMap({ map, onOpenSource }: { map: KnowledgeMap; onOpenSource: OpenSource }) {
  const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;
  return <section className="wiki-section" aria-labelledby="wiki-map-title">
    <div className="section-heading"><div><h2 id="wiki-map-title">People & topics</h2><p>Tags and speaker labels linked to timestamped source turns.</p></div></div>
    <p className="field-hint wiki-map-note"><ShieldCheck aria-hidden="true" /> Speaker labels are not verified identities unless an email was explicitly confirmed. {map.truncated_meeting_scope ? "This map covers the newest 200 eligible meetings." : ""}</p>
    <div className="wiki-map-columns">
      <div className="card"><div className="card-header"><div><h3>Topics</h3></div><span className="section-count">{map.topics.length}</span></div><div className="card-body tight">{map.topics.length ? map.topics.map((item) => <details key={item.key} className="knowledge-map-entry"><summary><span className="map-entry-mark" aria-hidden="true">#</span><span><b>{item.label}</b><small>{count(item.meeting_count, "meeting")} · {count(item.source_count, "source")}</small></span></summary><div className="knowledge-map-sources">{item.sources.map((source) => <SourceCard key={source.source_id} source={source} onOpenSource={onOpenSource} />)}</div></details>) : <p className="field-hint wiki-empty">No tags on eligible meetings yet.</p>}</div></div>
      <div className="card"><div className="card-header"><div><h3>Speaker labels</h3></div><span className="section-count">{map.speaker_labels.length}</span></div><div className="card-body tight">{map.speaker_labels.length ? map.speaker_labels.map((item) => <details key={item.key} className="knowledge-map-entry"><summary><span className="avatar sm" aria-hidden="true">{initials(item.label)}</span><span><b>{item.label}</b><small>{item.verified_identity ? `Confirmed email · ${item.email}` : "Unverified label"} · {count(item.meeting_count, "meeting")}</small></span></summary><div className="knowledge-map-sources">{item.sources.map((source) => <SourceCard key={source.source_id} source={source} onOpenSource={onOpenSource} />)}</div></details>) : <p className="field-hint wiki-empty">No named speaker turns yet.</p>}</div></div>
    </div>
  </section>;
}
