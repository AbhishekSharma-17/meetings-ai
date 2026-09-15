"use client";

import { useCallback, useEffect, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { MeetingDetail, TranscriptSegment } from "@/lib/types";
import { MinutesPanel } from "./minutes-panel";

const pollableStatuses = new Set<MeetingDetail["status"]>(["created", "joining", "waiting_room", "live", "stopping", "processing"]);
const lifecycleCopy: Record<MeetingDetail["status"], { label: string; detail: string }> = {
  created: { label: "Created", detail: "The meeting record exists and is ready to dispatch." },
  joining: { label: "Joining", detail: "The assistant is being sent to the meeting." },
  waiting_room: { label: "Waiting in lobby", detail: "The assistant is waiting for a host to admit it." },
  live: { label: "Capturing live", detail: "The assistant is in the meeting and transcript updates will appear below." },
  needs_attention: { label: "Needs attention", detail: "The meeting platform needs a person to help the assistant continue." },
  stopping: { label: "Stopping", detail: "A stop request is in progress. This action is safe to repeat." },
  processing: { label: "Processing", detail: "Capture has ended; transcript and MOM processing are underway." },
  ready: { label: "Ready", detail: "The capture workflow has completed." },
  stopped: { label: "Stopped", detail: "The assistant has been stopped." },
  failed: { label: "Needs attention", detail: "The assistant could not complete the requested action." },
};

export function MeetingDetailScreen({ meetingId, onBack, onMeetingChange }: { meetingId: string; onBack(): void; onMeetingChange(meeting: MeetingDetail): void }) {
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<"join" | "stop" | "refresh" | null>(null);

  const acceptMeeting = useCallback((next: MeetingDetail) => {
    setMeeting(next);
    onMeetingChange(next);
  }, [onMeetingChange]);

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const nextMeeting = await meetingsService.getMeeting(meetingId);
        const nextSegments = await meetingsService.getTranscript(meetingId).catch(() => []);
        if (!current) return;
        acceptMeeting(nextMeeting);
        setSegments(nextSegments);
        setError(null);
      } catch (requestError) {
        if (current) setError(requestError instanceof Error ? requestError.message : "Unable to load this meeting.");
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => { current = false; window.clearInterval(interval); };
  }, [acceptMeeting, meetingId]);

  async function runAction(nextAction: "join" | "stop" | "refresh") {
    setAction(nextAction);
    setError(null);
    if (nextAction === "stop" && meeting) acceptMeeting({ ...meeting, status: "stopping" });
    try {
      const updated = nextAction === "join" ? await meetingsService.joinMeeting(meetingId)
        : nextAction === "stop" ? await meetingsService.stopMeeting(meetingId)
          : await meetingsService.refreshMeeting(meetingId);
      acceptMeeting(updated);
      const transcript = await meetingsService.getTranscript(meetingId).catch(() => []);
      setSegments(transcript);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The meeting action could not be completed.");
      const reloaded = await meetingsService.getMeeting(meetingId).catch(() => null);
      if (reloaded) acceptMeeting(reloaded);
    } finally {
      setAction(null);
    }
  }

  if (!meeting) return <section className="page detail-page"><button className="back-button" onClick={onBack}>← All meetings</button><div className="detail-loading" role="status">Loading meeting lifecycle…</div>{error ? <p className="form-error" role="alert">{error}</p> : null}</section>;

  const lifecycle = lifecycleCopy[meeting.status];
  const canJoin = meeting.status === "created" || meeting.status === "failed";
  const canStop = ["joining", "waiting_room", "live", "needs_attention", "processing", "stopping"].includes(meeting.status);
  return <section className="page detail-page">
    <button className="back-button" onClick={onBack}>← All meetings</button>
    <div className="detail-hero">
      <div><p className="eyebrow">MEETING LIFECYCLE</p><h1>{meeting.title}</h1><a className="meeting-url" href={meeting.meetingUrl} target="_blank" rel="noreferrer">{meeting.meetingUrl || "No meeting link recorded"}<span aria-hidden="true">↗</span></a></div>
      <div className="detail-actions"><button className="button secondary" onClick={() => void runAction("refresh")} disabled={action !== null}>{action === "refresh" ? "Refreshing…" : "Refresh"}</button>{canJoin ? <button className="button primary" onClick={() => void runAction("join")} disabled={action !== null}>{action === "join" ? "Joining…" : meeting.status === "failed" ? "Retry join" : "Join meeting"}</button> : null}{canStop ? <button className="button danger" onClick={() => void runAction("stop")} disabled={action !== null}>{action === "stop" ? "Stopping…" : "Stop assistant"}</button> : null}</div>
    </div>
    {error ? <p className="form-error detail-error" role="alert">{error}</p> : null}

    <div className="lifecycle-banner" role="status"><span className={`status ${meeting.status}`}>{lifecycle.label}</span><div><b>{lifecycle.detail}</b><p>Controls operate on this product meeting record; the persisted capture identifier is resolved by the API.</p></div></div>

    <div className="detail-grid">
      <section className="detail-card" aria-labelledby="meeting-details-title"><h2 id="meeting-details-title">Meeting details</h2><dl className="metadata-list"><Metadata label="Platform" value={meeting.platform} /><Metadata label="Assistant" value={meeting.botName} /><Metadata label="Created" value={formatTimestamp(meeting.createdAt)} /><Metadata label="Last update" value={formatTimestamp(meeting.updatedAt)} /><Metadata label="Joined" value={formatTimestamp(meeting.joinedAt)} /><Metadata label="Stopped" value={formatTimestamp(meeting.stoppedAt)} /></dl></section>
      <section className="detail-card" aria-labelledby="capture-title"><h2 id="capture-title">Capture state</h2><p className="muted-copy">{meeting.participants ? `${meeting.participants} participant${meeting.participants === 1 ? "" : "s"} detected` : "Participant count is not available yet."}</p><p className="muted-copy">Duration: {meeting.duration}</p>{meeting.errorMessage ? <p className="inline-error"><b>Adapter message:</b> {meeting.errorMessage}</p> : null}</section>
    </div>

    <section className="transcript-panel" aria-labelledby="transcript-title"><div className="section-heading"><div><h2 id="transcript-title">Live transcript</h2><p>Speaker attribution and timestamps come from the capture pipeline.</p></div><span className="polling-indicator">{pollableStatuses.has(meeting.status) ? "Updates every 5 seconds" : "Capture complete"}</span></div>{segments.length ? <ol className="transcript-list">{segments.map((segment) => <li key={segment.id}><div className="segment-meta"><b>{segment.speaker}</b><span>{formatTimestamp(segment.startedAt)}{segment.isFinal ? "" : " · provisional"}</span></div><p>{segment.text}</p></li>)}</ol> : <div className="empty-state"><b>No transcript segments yet.</b><p>{meeting.status === "live" ? "The assistant is live; the first finalized segment will appear here when the API returns it." : "Transcript segments will appear after the capture adapter produces them."}</p></div>}</section>
    <MinutesPanel meeting={meeting} transcriptCount={segments.filter((segment) => segment.isFinal).length} />
  </section>;
}

function Metadata({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }

function formatTimestamp(value: string | number | null): string {
  if (value === null || value === "") return "—";
  if (typeof value === "number") {
    const minutes = Math.floor(value / 60);
    return `${minutes}:${Math.floor(value % 60).toString().padStart(2, "0")}`;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
