import type { Meeting } from "@/lib/types";

const statusLabel = { live: "Live", ready: "MOM ready", processing: "Processing" } as const;

export function Dashboard({ meetings, onNewMeeting, onOpenProviders }: { meetings: Meeting[]; onNewMeeting(): void; onOpenProviders(): void }) {
  const readyCount = meetings.filter((meeting) => meeting.status === "ready").length;
  const liveCount = meetings.filter((meeting) => meeting.status === "live").length;
  return (
    <section className="page dashboard">
      <div className="hero-row">
        <div>
          <p className="eyebrow">WORKSPACE</p>
          <h1>Your meetings, made useful.</h1>
          <p className="intro">Send a bot, review a reliable MOM, and make the follow-up happen.</p>
        </div>
        <button className="button primary" onClick={onNewMeeting}><span aria-hidden="true">+</span> New meeting</button>
      </div>

      <div className="notice" role="status">
        <span className="notice-icon" aria-hidden="true">✦</span>
        <div><b>Local foundation is running.</b><span>Configure and test an AI provider before the first live meeting witness.</span></div>
      </div>

      <div className="stats" aria-label="Meeting summary">
        <article><span>Meetings captured</span><strong>{meetings.length}</strong><small>{liveCount ? `${liveCount} currently live` : "No live meeting"}</small></article>
        <article><span>MOMs ready</span><strong>{readyCount}</strong><small>Evidence review comes in Milestone 2</small></article>
        <article><span>Follow-ups sent</span><strong>0</strong><small>Resend delivery comes in Milestone 3</small></article>
      </div>

      <div className="section-heading"><div><h2>Recent meetings</h2><p>Everything is a draft until you publish it.</p></div><button className="text-button">View all <span aria-hidden="true">→</span></button></div>
      {meetings.length ? <div className="meeting-list">
        {meetings.map((meeting) => <MeetingRow key={meeting.id} meeting={meeting} />)}
      </div> : <div className="empty-state"><b>No meeting records yet.</b><p>The first real Meet, Zoom, or Teams witness will appear here after the capture adapter is connected.</p></div>}

      <section className="setup-card" aria-labelledby="setup-title">
        <div className="setup-icon" aria-hidden="true">⚙</div>
        <div><h2 id="setup-title">Configure your AI pipeline</h2><p>Choose the transcription, MOM and embedding providers that fit your workflow. OpenAI, open-source and compatible endpoints are all supported.</p></div>
        <button className="button secondary" onClick={onOpenProviders}>Manage providers</button>
      </section>
    </section>
  );
}

function MeetingRow({ meeting }: { meeting: Meeting }) {
  return <article className="meeting-row">
    <div className="meeting-platform" aria-hidden="true">{meeting.platform === "Zoom" ? "Z" : meeting.platform === "Microsoft Teams" ? "T" : "G"}</div>
    <div className="meeting-info"><h3>{meeting.title}</h3><p>{meeting.platform} · {meeting.startsAt} · {meeting.participants} participants</p></div>
    <div className="meeting-meta"><span className={`status ${meeting.status}`}>{statusLabel[meeting.status]}</span><span>{meeting.duration}</span></div>
    <button className="row-action" aria-label={`Open ${meeting.title}`}>→</button>
  </article>;
}
