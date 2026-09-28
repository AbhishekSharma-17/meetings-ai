"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { formatFullDateTime } from "@/lib/time-preferences";
import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Download, Maximize2, MessageSquareText, X } from "lucide-react";
import { Avatar, DEFAULT_ASSISTANT_NAME, isAssistantName } from "./ui/avatar";
import type { TranscriptSegment } from "@/lib/types";
import { EmptyState } from "./ui/feedback";
import { FilterInput, Highlight, NoMatches, SearchToolbar } from "./scroll-panel";
import { matchesQuery, shouldOfferSearch } from "@/lib/search";

export const UNIDENTIFIED_SPEAKER = "Unidentified speaker";

export function transcriptSeconds(value: string | number | null): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed / 1000 : 0;
  }
  return 0;
}

export function relativeTime(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(seconds / 60);
  return `${minutes.toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

/** A turn matches by speaker, capture label or what was said. */
export function turnMatches(segment: TranscriptSegment, query: string): boolean {
  return matchesQuery(query, segment.speaker, segment.rawSpeaker, segment.text);
}

export function namedSpeakersOf(segments: TranscriptSegment[]): string[] {
  return [...new Set(segments.filter((segment) => segment.isFinal && segment.speaker !== UNIDENTIFIED_SPEAKER).map((segment) => segment.speaker))];
}

/** One transcript turn: avatar, speaker, timestamp and text. Shared by the meeting record and the evidence view. */
export function TranscriptTurn({ id, segment, time, timeTitle, focused, flags, actions, children, highlight = "", assistantName = DEFAULT_ASSISTANT_NAME }: {
  id: string;
  /** Active transcript search; matching words are marked in the speaker and text. */
  highlight?: string;
  segment: TranscriptSegment;
  time: string;
  timeTitle?: string;
  focused: boolean;
  flags?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  /** The meeting's bot name; its own turns show the Meetings AI logo. */
  assistantName?: string;
}) {
  const unidentified = segment.speaker === UNIDENTIFIED_SPEAKER;
  const assistant = !unidentified && isAssistantName(segment.speaker, assistantName);
  return <li id={id} className={focused ? "turn focused-source" : "turn"}>
    <Avatar name={segment.speaker} kind={assistant ? "assistant" : "person"} fallback={unidentified ? "?" : undefined} className={unidentified ? "turn-avatar unknown" : "turn-avatar"} />
    <div className="turn-body">
      <div className="turn-head">
        <b className="turn-speaker"><Highlight text={segment.speaker} query={highlight} /></b>
        <span className="turn-time tabular" title={timeTitle}>{time}</span>
        {flags}
        {actions ? <span className="turn-actions">{actions}</span> : null}
      </div>
      <p className="turn-text"><Highlight text={segment.text} query={highlight} /></p>
      {children}
    </div>
  </li>;
}

export function MeetingTranscript({ meetingTitle, assistantName, segments, focusSegmentId, isPolling, isLive, saving, onSaveSpeaker, onDownload }: {
  meetingTitle: string;
  assistantName?: string;
  isLive: boolean;
  segments: TranscriptSegment[];
  focusSegmentId?: string | null;
  isPolling: boolean;
  saving: boolean;
  onSaveSpeaker(segment: TranscriptSegment, name: string, applyToSameLabel: boolean): Promise<boolean>;
  onDownload(): void;
}) {
  const [editingSpeakerId, setEditingSpeakerId] = useState<string | null>(null);
  const [speakerName, setSpeakerName] = useState("");
  const [applyToSameLabel, setApplyToSameLabel] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");

  const finalized = segments.filter((segment) => segment.isFinal);
  const namedSpeakers = namedSpeakersOf(segments);
  const unattributedCount = finalized.filter((segment) => segment.speaker === UNIDENTIFIED_SPEAKER).length;
  const reviewedCount = finalized.filter((segment) => segment.speakerReviewed).length;
  const namedCoverage = finalized.length ? Math.round((finalized.length - unattributedCount) * 100 / finalized.length) : 0;
  const newestFirst = useMemo(
    () => [...segments].sort((left, right) => transcriptSeconds(right.startedAt) - transcriptSeconds(left.startedAt)),
    [segments],
  );
  // Long meetings have thousands of turns: filter on a deferred copy so typing stays responsive.
  const searchQuery = useDeferredValue(query);
  const oldest = newestFirst[newestFirst.length - 1];
  const firstSegmentAt = oldest ? transcriptSeconds(oldest.startedAt) : 0;
  const searchable = shouldOfferSearch(segments.length, query);
  const shown = useMemo(
    () => searchQuery.trim() ? newestFirst.filter((segment) => turnMatches(segment, searchQuery)) : newestFirst,
    [newestFirst, searchQuery],
  );
  const matchCount = searchQuery.trim() ? `${shown.length} of ${segments.length} turns match` : null;
  const noMatches = <NoMatches query={searchQuery} noun="turns" onClear={() => setQuery("")} />;

  async function save(segment: TranscriptSegment) {
    if (await onSaveSpeaker(segment, speakerName, applyToSameLabel)) setEditingSpeakerId(null);
  }

  const renderSegment = (segment: TranscriptSegment) => {
    const at = transcriptSeconds(segment.startedAt);
    const flags = <>
      {!segment.isFinal ? <span className="turn-flag">Provisional</span> : null}
      {segment.speakerReviewed ? <span className="turn-flag reviewed">Reviewed</span> : segment.attributionSource ? <span className="turn-flag">{segment.attributionSource}</span> : null}
      {segment.rawSpeaker && segment.rawSpeaker !== segment.speaker && segment.speaker === UNIDENTIFIED_SPEAKER ? <span className="turn-flag">Capture label: {segment.rawSpeaker}</span> : null}
    </>;
    const review = <button className="text-button neutral" type="button" onClick={() => { setEditingSpeakerId(segment.segmentId); setSpeakerName(segment.speaker === UNIDENTIFIED_SPEAKER ? "" : segment.speaker); setApplyToSameLabel(false); }}>Review speaker</button>;
    return <TranscriptTurn key={segment.id} id={`transcript-${encodeURIComponent(segment.segmentId)}`} segment={segment} focused={focusSegmentId === segment.segmentId} assistantName={assistantName}
      time={relativeTime(at - firstSegmentAt)} timeTitle={at > 1_000_000_000 ? formatFullDateTime(at * 1000) : "Elapsed from first captured turn"} flags={flags} actions={review} highlight={searchQuery}>
      {editingSpeakerId === segment.segmentId ? <div className="turn-review-form">
        {segment.rawSpeaker ? <p className="field-hint">Capture label: {segment.rawSpeaker}</p> : null}
        <label className="field">Correct speaker name<input value={speakerName} onChange={(event) => setSpeakerName(event.target.value)} placeholder="Leave blank to mark unidentified" autoFocus /></label>
        <label className="check-label"><input type="checkbox" checked={applyToSameLabel} onChange={(event) => setApplyToSameLabel(event.target.checked)} disabled={!segment.rawSpeaker} /> Apply to all turns labelled “{segment.rawSpeaker || "none"}”</label>
        <div className="button-group end">
          <button type="button" className="button ghost sm" onClick={() => setEditingSpeakerId(null)}>Cancel</button>
          <button type="button" className="button primary sm" onClick={() => void save(segment)} disabled={saving}>{saving ? "Saving…" : "Save speaker"}</button>
        </div>
      </div> : null}
    </TranscriptTurn>;
  };

  return <section className="card transcript-card" aria-labelledby="transcript-title">
    <div className="card-header">
      <div>
        <h2 id="transcript-title">Speaker-attributed transcript</h2>
        <p>{isPolling ? <span className="transcript-live"><span className="transcript-live-dot" aria-hidden="true" />Updates every 5 seconds</span> : "Capture complete"} · Newest first</p>
      </div>
      {segments.length ? <div className="button-group">
        <button className="button ghost sm" type="button" onClick={onDownload}><Download aria-hidden="true" /> Download .md</button>
        <button className="button secondary sm" type="button" onClick={() => setExpanded(true)}><Maximize2 aria-hidden="true" /> Open full transcript</button>
      </div> : null}
    </div>
    {searchable ? <SearchToolbar id="transcript-search" label="Search transcript" value={query} onChange={setQuery} placeholder="Search what was said or who said it" /> : null}
    <div className="card-body transcript-body">
      {segments.length ? <>
        <div className="transcript-summary">
          <p><b>Speakers heard:</b> {namedSpeakers.length ? namedSpeakers.join(", ") : "none identified"}{unattributedCount ? ` · ${unattributedCount} unidentified turn${unattributedCount === 1 ? "" : "s"}` : ""} · {namedCoverage}% of finalized turns named · {reviewedCount} reviewed</p>
          <p className="field-hint">Coverage is not identity accuracy, and speakers are not an attendance roster.</p>
        </div>
        {matchCount ? <p className="field-hint" role="status">{matchCount}</p> : null}
        {expanded ? null : shown.length ? <ol className="transcript-list transcript-list-compact" aria-label="Recent transcript turns, newest first">{shown.map(renderSegment)}</ol> : noMatches}
      </> : <EmptyState plain icon={<MessageSquareText />} title="No transcript yet">{isLive ? "The assistant is live. The first finalized turn appears here shortly." : "Turns appear here once the assistant captures them."}</EmptyState>}
    </div>
    <Dialog.Root open={expanded} onOpenChange={setExpanded}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog xl transcript-dialog">
          <Dialog.Close className="close-button" aria-label="Close transcript"><X /></Dialog.Close>
          <Dialog.Title className="dialog-title">Full transcript</Dialog.Title>
          <Dialog.Description className="dialog-intro">{meetingTitle} · {segments.length} turns · newest first</Dialog.Description>
          {searchable ? <div className="list-search-inline"><FilterInput id="transcript-search-full" label="Search full transcript" value={query} onChange={setQuery} placeholder="Search what was said or who said it" />{matchCount ? <span className="list-search-count" role="status">{matchCount}</span> : null}</div> : null}
          {shown.length ? <ol className="transcript-list transcript-list-full">{shown.map(renderSegment)}</ol> : noMatches}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </section>;
}
