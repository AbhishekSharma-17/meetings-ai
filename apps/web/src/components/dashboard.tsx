import type { ReactNode } from "react";
import type { CurrentAccount, Meeting } from "@/lib/types";
import { attentionStatuses, inProgressStatuses, meetingStatusLabel, platformMonogram } from "@/lib/meeting-status";
import { ArrowRight, CalendarDays, CircleAlert, CircleCheck, FileText, Mic, Plus, Radio, Sparkles, Video } from "lucide-react";
import { ProvidersIcon } from "./ui-icons";
import { PageHeader } from "./ui/page-header";
import { EmptyState } from "./ui/feedback";

const RECENT_LIMIT = 6;

export function Dashboard({ meetings, account, onNewMeeting, onOpenCalendar, onOpenProviders, onOpenKnowledge, onOpenMeetings, onOpenMeeting }: {
  meetings: Meeting[];
  account: CurrentAccount | null;
  onNewMeeting(): void;
  onOpenCalendar(): void;
  onOpenProviders(): void;
  onOpenKnowledge(): void;
  onOpenMeetings(): void;
  onOpenMeeting(id: string): void;
}) {
  const readyCount = meetings.filter((meeting) => meeting.status === "ready").length;
  const liveCount = meetings.filter((meeting) => inProgressStatuses.has(meeting.status)).length;
  const attentionCount = meetings.filter((meeting) => attentionStatuses.has(meeting.status)).length;
  const firstName = account?.display_name.trim().split(/\s+/)[0];
  const greeting = firstName && firstName.toLowerCase() !== "workspace" ? `Welcome back, ${firstName}` : "Welcome back";
  const recent = meetings.slice(0, RECENT_LIMIT);
  return (
    <section className="page dashboard" aria-labelledby="dashboard-title">
      <PageHeader
        titleId="dashboard-title"
        title={greeting}
        description="Capture the meeting, review what matters and move decisions forward."
        actions={<><button className="button secondary" onClick={onOpenCalendar}><CalendarDays /> Calendar</button><button className="button primary" onClick={onNewMeeting}><Plus /> New meeting</button></>}
      />

      <div className="stat-grid dashboard-stats" aria-label="Meeting summary">
        <Stat icon={<Video />} label="All meetings" value={meetings.length} hint="Capture records in this workspace" />
        <Stat icon={<Radio />} label="Live now" value={liveCount} hint={liveCount ? "Transcripts are updating" : "No active captures"} />
        <Stat icon={<FileText />} label="Ready to review" value={readyCount} hint="Completed, awaiting minutes review" />
        <Stat icon={<CircleAlert />} label="Needs attention" value={attentionCount} hint={attentionCount ? "Open to retry or resolve" : "Nothing blocked"} />
      </div>

      <div className="dashboard-columns">
        <section className="card" aria-labelledby="recent-title">
          <div className="card-header">
            <div><h2 id="recent-title">Recent meetings</h2><p>Open a meeting to review its transcript, minutes and follow-up.</p></div>
            {meetings.length > RECENT_LIMIT ? <button type="button" className="button ghost sm" onClick={onOpenMeetings}>See all <ArrowRight /></button> : <span className="section-count">{meetings.length} total</span>}
          </div>
          {recent.length ? <ul className="dashboard-meeting-list">
            {recent.map((meeting) => <MeetingRow key={meeting.id} meeting={meeting} onOpen={() => onOpenMeeting(meeting.id)} />)}
          </ul> : <div className="card-body"><EmptyState plain icon={<Mic />} title="No meetings yet" action={<button className="button primary" onClick={onNewMeeting}><Plus /> Create your first meeting</button>}>Send your assistant to a Google Meet, Zoom, Teams or Jitsi call. Captures appear here.</EmptyState></div>}
        </section>

        <aside className="dashboard-side" aria-label="Next steps">
          <section className="card" aria-labelledby="flow-title">
            <div className="card-header plain"><div><h2 id="flow-title">How it works</h2><p>Every meeting follows the same reviewed path.</p></div></div>
            <ol className="dashboard-flow">
              <li><span className="flow-icon"><Mic aria-hidden="true" /></span><span><b>Capture</b><small>The assistant joins and transcribes with speaker labels.</small></span></li>
              <li><span className="flow-icon"><CircleCheck aria-hidden="true" /></span><span><b>Review</b><small>Check speakers and edit the drafted minutes.</small></span></li>
              <li><span className="flow-icon"><ArrowRight aria-hidden="true" /></span><span><b>Share</b><small>Approve before any recap email is sent.</small></span></li>
            </ol>
          </section>
          <button type="button" className="card dashboard-shortcut" onClick={onOpenKnowledge}>
            <span className="flow-icon brand"><Sparkles aria-hidden="true" /></span>
            <span><b>Ask your meetings</b><small>Chat with opted-in meetings and follow every answer to its source.</small></span>
            <ArrowRight className="shortcut-arrow" aria-hidden="true" />
          </button>
          <button type="button" className="card dashboard-shortcut" onClick={onOpenProviders}>
            <span className="flow-icon"><ProvidersIcon aria-hidden="true" /></span>
            <span><b>Your AI, your choice</b><small>Pick the transcription, minutes and Ask AI models. New defaults apply to the next join.</small></span>
            <ArrowRight className="shortcut-arrow" aria-hidden="true" />
          </button>
        </aside>
      </div>
    </section>
  );
}

function Stat({ icon, label, value, hint }: { icon: ReactNode; label: string; value: number; hint: string }) {
  return <article className="stat"><span className="stat-label">{icon}{label}</span><strong className="stat-value">{value}</strong><span className="stat-hint">{hint}</span></article>;
}

function MeetingRow({ meeting, onOpen }: { meeting: Meeting; onOpen(): void }) {
  return <li>
    <button type="button" className="dashboard-meeting" aria-label={`Open ${meeting.title}`} onClick={onOpen}>
      <span className="platform-tile" aria-hidden="true">{platformMonogram(meeting.platform)}</span>
      <span className="dashboard-meeting-copy"><b>{meeting.title}</b><small>{meeting.platform} · {meeting.startsAt}{meeting.participants ? ` · ${meeting.participants} participant${meeting.participants === 1 ? "" : "s"}` : ""}</small></span>
      <span className={`status ${meeting.status}`}>{meetingStatusLabel[meeting.status]}</span>
      <span className="dashboard-meeting-duration">{meeting.duration === "—" ? "" : meeting.duration}</span>
      <ArrowRight className="row-arrow" aria-hidden="true" />
    </button>
  </li>;
}
