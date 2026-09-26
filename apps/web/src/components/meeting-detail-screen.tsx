"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ExternalLink, LogIn, RefreshCw, Square } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import { meetingStatusLabel } from "@/lib/meeting-status";
import type { CalendarEvent, CalendarSchedule, MeetingDetail, MeetingParticipants, SpeakerIdentity, TranscriptSegment, TranscriptionRoute } from "@/lib/types";
import { MinutesPanel } from "./minutes-panel";
import { MeetingTranscript, namedSpeakersOf, relativeTime, transcriptSeconds } from "./meeting-transcript";
import { MeetingPeopleCard } from "./meeting-people-card";
import { MeetingKnowledgeSettings } from "./meeting-knowledge-settings";
import { MeetingDetailsCard, MeetingDangerZone, MeetingSourceCard, formatTimestamp } from "./meeting-record-cards";
import { PageHeader } from "./ui/page-header";
import { Alert, LoadingRow, Skeleton } from "./ui/feedback";

const pollableStatuses = new Set<MeetingDetail["status"]>(["created", "joining", "waiting_room", "live", "stopping", "processing"]);
const inCallStatuses = new Set<MeetingDetail["status"]>(["joining", "waiting_room", "live", "needs_attention", "stopping"]);
const stoppableStatuses = new Set<MeetingDetail["status"]>(["joining", "waiting_room", "live", "needs_attention", "processing", "stopping"]);
const deletableStatuses = new Set<MeetingDetail["status"]>(["created", "ready", "failed"]);
const lifecycleDetail: Record<MeetingDetail["status"], string> = {
  created: "The meeting record exists and is ready to dispatch.",
  joining: "The assistant is being sent to the meeting.",
  waiting_room: "The assistant is waiting for a host to admit it.",
  live: "The assistant is in the meeting and transcript updates will appear below.",
  needs_attention: "The meeting platform needs a person to help the assistant continue.",
  stopping: "A stop request is in progress. This action is safe to repeat.",
  processing: "Capture has ended; transcript and MOM processing are underway.",
  ready: "The capture workflow has completed.",
  stopped: "The assistant has been stopped.",
  failed: "The assistant could not complete the requested action.",
};

export function MeetingDetailScreen({ meetingId, focusSegmentId, backLabel = "All meetings", onBack, onMeetingChange, onDeleted }: { meetingId: string; focusSegmentId?: string | null; backLabel?: string; onBack(): void; onMeetingChange(meeting: MeetingDetail): void; onDeleted(id: string): void }) {
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [schedule, setSchedule] = useState<CalendarSchedule | null>(null);
  const [source, setSource] = useState<CalendarEvent | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [participants, setParticipants] = useState<MeetingParticipants | null>(null);
  const [transcriptionRoute, setTranscriptionRoute] = useState<TranscriptionRoute | null>(null);
  const [speakerIdentities, setSpeakerIdentities] = useState<SpeakerIdentity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<"join" | "stop" | "refresh" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [savingSpeaker, setSavingSpeaker] = useState(false);
  const [speakerRevision, setSpeakerRevision] = useState(0);
  const lastFocused = useRef<string | null>(null);

  const acceptMeeting = useCallback((next: MeetingDetail) => {
    setMeeting(next);
    onMeetingChange(next);
  }, [onMeetingChange]);

  useEffect(() => {
    let current = true;
    void meetingsService.getMeetingSource(meetingId).then((value) => { if (current) setSource(value); }).catch(() => undefined);
    return () => { current = false; };
  }, [meetingId]);

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const nextMeeting = await meetingsService.getMeeting(meetingId);
        const nextSegments = await meetingsService.getTranscript(meetingId).catch(() => []);
        const nextRoute = await meetingsService.getTranscriptionRoute(meetingId).catch(() => null);
        const nextSchedule = await meetingsService.getCalendarSchedule(meetingId).catch(() => null);
        if (!current) return;
        acceptMeeting(nextMeeting);
        setSegments(nextSegments);
        setTranscriptionRoute(nextRoute);
        setSchedule(nextSchedule);
        setError(null);
      } catch (requestError) {
        if (current) setError(requestError instanceof Error ? requestError.message : "Unable to load this meeting.");
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => { current = false; window.clearInterval(interval); };
  }, [acceptMeeting, meetingId]);

  useEffect(() => {
    let current = true;
    const load = () => void meetingsService.getParticipants(meetingId).then((value) => {
      if (current) setParticipants(value);
    }).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 20_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [meetingId, speakerRevision]);

  useEffect(() => {
    if (!focusSegmentId || !segments.some((segment) => segment.segmentId === focusSegmentId)) return;
    const key = `${meetingId}:${focusSegmentId}`;
    if (lastFocused.current === key) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`transcript-${encodeURIComponent(focusSegmentId)}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      lastFocused.current = key;
    });
    return () => cancelAnimationFrame(frame);
  }, [focusSegmentId, meetingId, segments]);

  useEffect(() => {
    let current = true;
    void meetingsService.getSpeakerIdentities(meetingId).then((items) => {
      if (current) setSpeakerIdentities(items);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [meetingId, speakerRevision]);

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

  async function saveSpeaker(segment: TranscriptSegment, name: string, applyToSameLabel: boolean): Promise<boolean> {
    setSavingSpeaker(true); setError(null);
    try {
      const corrected = await meetingsService.correctSpeaker(meetingId, segment.segmentId, name.trim() || null, applyToSameLabel);
      setSegments(corrected);
      setSpeakerRevision((current) => current + 1);
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not save speaker correction.");
      return false;
    } finally { setSavingSpeaker(false); }
  }

  async function saveIdentity(speaker: string, email: string): Promise<boolean> {
    setError(null);
    try {
      setSpeakerIdentities(await meetingsService.saveSpeakerIdentity(meetingId, speaker, email.trim() || null));
      return true;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not confirm speaker email.");
      return false;
    }
  }

  function downloadTranscript() {
    setError(null);
    try {
      const ordered = [...segments].sort((a, b) => transcriptSeconds(a.startedAt) - transcriptSeconds(b.startedAt));
      const first = ordered.length ? transcriptSeconds(ordered[0].startedAt) : 0;
      const markdown = [`# Transcript — ${meeting?.title || "Meeting"}`, "", "Timestamps are relative to the first captured turn. Speaker names may need review.", "", ...ordered.filter((segment) => segment.isFinal).flatMap((segment) => [`**[${relativeTime(transcriptSeconds(segment.startedAt) - first)}] ${segment.speaker}:** ${segment.text}`, ""])].join("\n");
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `meetings-ai-transcript-${meetingId}.md`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not export transcript.");
    }
  }

  async function deleteMeeting() {
    setDeleting(true); setError(null);
    try {
      await meetingsService.deleteMeeting(meetingId);
      onDeleted(meetingId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the meeting.");
      setDeleting(false);
    }
  }

  function cancelSchedule() {
    void meetingsService.cancelCalendarSchedule(meetingId).then(setSchedule).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not cancel the scheduled join."));
  }

  const back = { label: backLabel, onClick: onBack };
  if (!meeting) return <section className="page wide meeting-record" aria-busy={!error}>
    <PageHeader back={back} title={<span className="skeleton record-title-skeleton" aria-hidden="true" />} />
    {error ? <p className="form-error" role="alert">{error}</p> : <LoadingRow>Loading meeting…</LoadingRow>}
    {!error ? <div className="record-layout" aria-hidden="true"><div className="card card-body"><Skeleton lines={6} /></div><div className="card card-body"><Skeleton lines={4} /></div></div> : null}
  </section>;

  const scheduled = schedule?.status === "pending";
  const canJoin = (meeting.status === "created" || meeting.status === "failed") && schedule?.status !== "pending" && schedule?.status !== "joining";
  const canStop = stoppableStatuses.has(meeting.status);
  const finalizedCount = segments.filter((segment) => segment.isFinal).length;
  const namedSpeakers = namedSpeakersOf(segments);
  const failing = meeting.status === "failed" || meeting.status === "needs_attention";

  return <section className="page wide meeting-record" aria-labelledby="meeting-record-title">
    <PageHeader
      back={back}
      titleId="meeting-record-title"
      title={meeting.title}
      badge={<span className={`status ${scheduled ? "scheduled" : meeting.status}`}>{scheduled ? "Scheduled" : meetingStatusLabel[meeting.status]}</span>}
      description={<span className="record-meta">
        <span>{meeting.platform}</span>
        {meeting.meetingUrl ? <span><a className="record-link" href={meeting.meetingUrl} target="_blank" rel="noopener noreferrer"><span>{meeting.meetingUrl}</span><ExternalLink aria-hidden="true" /></a></span> : <span>No meeting link recorded</span>}
        <span>Created {formatTimestamp(meeting.createdAt)}</span>
      </span>}
      actions={<>
        <button className="button ghost" onClick={() => void runAction("refresh")} disabled={action !== null}><RefreshCw aria-hidden="true" className={action === "refresh" ? "record-spin" : undefined} />{action === "refresh" ? "Refreshing…" : "Refresh"}</button>
        {canStop ? <button className="button danger-outline" onClick={() => void runAction("stop")} disabled={action !== null}><Square aria-hidden="true" />{action === "stop" ? "Stopping…" : "Stop assistant"}</button> : null}
        {canJoin ? <button className="button primary" onClick={() => void runAction("join")} disabled={action !== null}><LogIn aria-hidden="true" />{action === "join" ? "Joining…" : meeting.status === "failed" ? "Retry join" : "Join meeting"}</button> : null}
      </>}
    />

    <div className="record-alerts">
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {schedule ? <Alert tone={scheduled ? "info" : schedule.status === "failed" || schedule.status === "missed" ? "warning" : "neutral"} title={`${schedule.provider === "manual" ? "Scheduled assistant" : "Calendar assistant"} · ${schedule.status}`}
        actions={scheduled ? <button className="button secondary sm" type="button" onClick={cancelSchedule}>Cancel auto-join</button> : undefined}>
        Starts {formatTimestamp(schedule.starts_at)}. {scheduled ? "The assistant joins at the start time. Cancelling keeps this meeting." : schedule.last_error || "Review this meeting for capture updates."}
      </Alert> : null}
      {failing ? <Alert tone="danger" title={lifecycleDetail[meeting.status]}>{meeting.errorMessage ?? undefined}</Alert>
        : meeting.errorMessage ? <Alert tone="warning" title="Adapter message">{meeting.errorMessage}</Alert> : null}
      {meeting.status === "processing" || (meeting.status === "created" && !schedule) ? <Alert tone="info">{lifecycleDetail[meeting.status]}</Alert> : null}
    </div>

    <div className="record-layout">
      <div className={inCallStatuses.has(meeting.status) ? "record-main capturing" : "record-main"}>
        {inCallStatuses.has(meeting.status) ? <section className="card record-call" aria-label="Assistant call status">
          <Image src="/brand/meetings-ai-avatar-1024.png" alt="Meetings AI assistant artwork" width={56} height={56} className="record-call-art" />
          <div className="record-call-copy">
            <p className="eyebrow">Assistant in call</p>
            <h2>{meeting.botName}</h2>
            <p>{meeting.status === "waiting_room" ? `Ask the host to admit “${meeting.botName}” from the waiting room.` : meeting.status === "live" ? `${finalizedCount} finalized transcript turn${finalizedCount === 1 ? "" : "s"} · ${namedSpeakers.length} named speaker${namedSpeakers.length === 1 ? "" : "s"}` : lifecycleDetail[meeting.status]}</p>
            <p className="field-hint">Tell the host: “Meetings AI has joined and will record and transcribe this conversation.”</p>
          </div>
        </section> : null}
        <MinutesPanel key={`${meeting.id}:${speakerRevision}`} meeting={meeting} transcriptCount={finalizedCount} segments={segments} />
        <MeetingTranscript meetingTitle={meeting.title} segments={segments} focusSegmentId={focusSegmentId} isPolling={pollableStatuses.has(meeting.status)} isLive={meeting.status === "live"} saving={savingSpeaker} onSaveSpeaker={saveSpeaker} onDownload={downloadTranscript} />
      </div>
      <aside className="record-side" aria-label="Meeting information">
        <MeetingDetailsCard meeting={meeting} route={transcriptionRoute} />
        <MeetingPeopleCard participants={participants} namedSpeakers={namedSpeakers} speakerIdentities={speakerIdentities} source={source} onSaveIdentity={saveIdentity} />
        {source ? <MeetingSourceCard source={source} /> : null}
        <MeetingKnowledgeSettings key={meeting.id} meeting={meeting} onSaved={acceptMeeting} />
        {deletableStatuses.has(meeting.status) ? <MeetingDangerZone deleting={deleting} onDelete={() => void deleteMeeting()} /> : null}
      </aside>
    </div>
  </section>;
}
