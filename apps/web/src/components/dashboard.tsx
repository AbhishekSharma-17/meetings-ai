import type { Meeting } from "@/lib/types";
import { ArrowRightIcon, MicIcon, PlusIcon, ProvidersIcon, SparkIcon } from "./ui-icons";

const statusLabel: Record<Meeting["status"], string> = {
  created: "Created",
  joining: "Joining",
  waiting_room: "In lobby",
  live: "Live",
  needs_attention: "Needs attention",
  stopping: "Stopping",
  processing: "Processing",
  ready: "Capture ready",
  stopped: "Stopped",
  failed: "Needs attention",
};

export function Dashboard({ meetings, onNewMeeting, onOpenCalendar, onOpenProviders, onOpenMeeting }: { meetings: Meeting[]; onNewMeeting(): void; onOpenCalendar(): void; onOpenProviders(): void; onOpenMeeting(id: string): void }) {
  const readyCount = meetings.filter((meeting) => meeting.status === "ready").length;
  const liveCount = meetings.filter((meeting) => meeting.status === "live").length;
  return (
    <section className="page dashboard">
      <div className="hero-row">
        <div>
          <p className="eyebrow">OVERVIEW <span className="eyebrow-separator">/</span> YOUR WORKSPACE</p>
          <h1>From conversation<br /><span>to clarity.</span></h1>
          <p className="intro">Capture the meeting, review what matters, and move decisions forward.</p>
        </div>
        <div className="dashboard-hero-actions"><button className="button secondary" onClick={onOpenCalendar}>Find in calendar</button><button className="button primary" onClick={onNewMeeting}><PlusIcon /> New meeting</button></div>
      </div>

      <div className="notice" role="status">
        <span className="notice-icon"><SparkIcon /></span>
        <div><b>Your local workspace is ready.</b><span>Launch a capture, then review its transcript and AI-generated minutes before sharing.</span></div>
      </div>

      <div className="stats" aria-label="Meeting summary">
        <article><span>All meetings</span><strong>{meetings.length}</strong><small>Total capture records</small></article>
        <article><span>Live now</span><strong>{liveCount}</strong><small>{liveCount ? "Transcripts are updating" : "No active captures"}</small></article>
        <article><span>Ready to review</span><strong>{readyCount}</strong><small>Completed captures</small></article>
      </div>

      <div className="workflow-strip" aria-label="How Meetings AI works">
        <div><span>01</span><b>Capture</b><small>Assistant joins and transcribes</small></div>
        <div><span>02</span><b>Review</b><small>Check speakers and minutes</small></div>
        <div><span>03</span><b>Share</b><small>Approve before email delivery</small></div>
      </div>

      <div className="section-heading"><div><p className="eyebrow">YOUR ACTIVITY</p><h2>Recent meetings</h2><p>Open a meeting to review the transcript and follow-up.</p></div><span className="section-count">{meetings.length} total</span></div>
      {meetings.length ? <div className="meeting-list">
        {meetings.map((meeting) => <MeetingRow key={meeting.id} meeting={meeting} onOpen={() => onOpenMeeting(meeting.id)} />)}
      </div> : <div className="empty-state"><span className="empty-icon"><MicIcon /></span><b>No meetings yet</b><p>Send your assistant to a Google Meet, Zoom, Teams, or Jitsi call. Your captures will appear here.</p><button className="button secondary" onClick={onNewMeeting}>Create your first meeting <ArrowRightIcon /></button></div>}

      <section className="setup-card" aria-labelledby="setup-title">
        <div className="setup-icon"><ProvidersIcon /></div>
        <div><h2 id="setup-title">Your AI, your choice</h2><p>Choose named configurations for transcription, minutes, and Ask AI. A new transcription default applies to the next assistant join; active calls keep their current route.</p></div>
        <button className="button secondary" onClick={onOpenProviders}>Manage providers</button>
      </section>
    </section>
  );
}

function MeetingRow({ meeting, onOpen }: { meeting: Meeting; onOpen(): void }) {
  return <article className="meeting-row">
    <div className="meeting-platform" aria-hidden="true">{meeting.platform === "Zoom" ? "Z" : meeting.platform === "Microsoft Teams" ? "T" : "G"}</div>
    <div className="meeting-info"><h3>{meeting.title}</h3><p>{meeting.platform} · {meeting.startsAt} · {meeting.participants} participants</p></div>
    <div className="meeting-meta"><span className={`status ${meeting.status}`}>{statusLabel[meeting.status]}</span><span>{meeting.duration}</span></div>
    <button className="row-action" aria-label={`Open ${meeting.title}`} onClick={onOpen}><ArrowRightIcon /></button>
  </article>;
}
