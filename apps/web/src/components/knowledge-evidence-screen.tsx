"use client";

import { useEffect, useState } from "react";
import { formatFullDateTime } from "@/lib/time-preferences";
import { MessageSquareText } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { MeetingDetail, TranscriptSegment } from "@/lib/types";
import { PageHeader } from "./ui/page-header";
import { EmptyState, LoadingRow } from "./ui/feedback";
import { TranscriptTurn, turnMatches } from "./meeting-transcript";
import { NoMatches, SearchToolbar } from "./scroll-panel";
import { shouldOfferSearch } from "@/lib/search";

function elapsedLabel(value: TranscriptSegment["startedAt"]): string {
  if (typeof value === "number") return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
  return value ?? "Time unavailable";
}

/** Read-only, finalized transcript view for teammates following an AI knowledge citation. */
export function KnowledgeEvidenceScreen({ meetingId, focusSegmentId, onBack }: {
  meetingId: string; focusSegmentId: string | null; onBack(): void;
}) {
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([meetingsService.getMeeting(meetingId), meetingsService.getTranscript(meetingId)])
      .then(([item, turns]) => { if (active) { setMeeting(item); setSegments(turns.filter((turn) => turn.isFinal)); } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Source unavailable."); });
    return () => { active = false; };
  }, [meetingId]);

  useEffect(() => {
    if (!focusSegmentId || !segments.some((turn) => turn.segmentId === focusSegmentId)) return;
    requestAnimationFrame(() => document.getElementById(`evidence-${encodeURIComponent(focusSegmentId)}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, [focusSegmentId, segments]);

  const back = { label: "AI knowledge", onClick: onBack };
  const shown = query.trim() ? segments.filter((turn) => turnMatches(turn, query)) : segments;
  return <section className="page narrow evidence-page" aria-labelledby="evidence-title">
    <PageHeader
      back={back}
      eyebrow="Shared knowledge source"
      titleId="evidence-title"
      title={meeting?.title ?? (error ? "Source unavailable" : <span className="skeleton record-title-skeleton" aria-hidden="true" />)}
      description={meeting ? `${meeting.joinedAt ? formatFullDateTime(meeting.joinedAt) : "Meeting time unavailable"} · Finalized transcript only` : undefined}
    />
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {meeting ? <section className="card transcript-card" aria-labelledby="evidence-transcript-title">
      <div className="card-header">
        <div><h2 id="evidence-transcript-title">Transcript evidence</h2><p>Speaker labels are best effort and may need review by the meeting owner.</p></div>
        <span className="section-count">{segments.length} turn{segments.length === 1 ? "" : "s"}</span>
      </div>
      {shouldOfferSearch(segments.length, query) ? <SearchToolbar id="evidence-search" label="Search transcript" value={query} onChange={setQuery} placeholder="Search what was said or who said it" /> : null}
      <div className="card-body transcript-body">
        {segments.length && !shown.length ? <NoMatches query={query} noun="turns" onClear={() => setQuery("")} />
        : segments.length ? <ol className="transcript-list">
          {shown.map((turn) => <TranscriptTurn key={turn.id} id={`evidence-${encodeURIComponent(turn.segmentId)}`} segment={turn} focused={focusSegmentId === turn.segmentId} assistantName={meeting.botName}
            time={elapsedLabel(turn.startedAt)} timeTitle="Elapsed time into the meeting" highlight={query} />)}
        </ol> : <EmptyState plain icon={<MessageSquareText />} title="No finalized turns">This meeting has no finalized transcript to show.</EmptyState>}
      </div>
    </section> : !error ? <LoadingRow>Loading cited transcript…</LoadingRow> : null}
  </section>;
}
