"use client";

import { useEffect, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { MeetingDetail, TranscriptSegment } from "@/lib/types";

export function KnowledgeEvidenceScreen({ meetingId, focusSegmentId, onBack }: {
  meetingId: string; focusSegmentId: string | null; onBack(): void;
}) {
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  return <section className="page detail-page"><button className="back-button" onClick={onBack}>← AI knowledge</button>{error ? <p className="form-error" role="alert">{error}</p> : null}{meeting ? <><div className="detail-hero"><div><p className="eyebrow">SHARED KNOWLEDGE SOURCE</p><h1>{meeting.title}</h1><p className="intro">{meeting.joinedAt ? new Date(meeting.joinedAt).toLocaleString() : "Meeting time unavailable"} · Finalized transcript only</p></div></div><section className="transcript-panel"><div className="section-heading"><div><h2>Transcript evidence</h2><p>Speaker labels are best effort and may require review by the meeting owner.</p></div></div><ol className="transcript-list">{segments.map((turn) => <li key={turn.id} id={`evidence-${encodeURIComponent(turn.segmentId)}`} className={focusSegmentId === turn.segmentId ? "focused-source" : undefined}><div className="segment-meta"><b>{turn.speaker}</b><span>{typeof turn.startedAt === "number" ? `${Math.floor(turn.startedAt / 60)}:${String(Math.floor(turn.startedAt % 60)).padStart(2, "0")} into meeting` : turn.startedAt ?? "Time unavailable"}</span></div><p>{turn.text}</p></li>)}</ol></section></> : !error ? <p role="status">Loading cited transcript…</p> : null}</section>;
}
