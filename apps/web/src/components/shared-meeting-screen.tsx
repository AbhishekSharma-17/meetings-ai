"use client";

import { useEffect, useState } from "react";
import { FileText, MessageSquareText } from "lucide-react";
import { coordinationService, firstName, possessive, type MeetingCoordination } from "@/lib/coordination";
import { meetingsService } from "@/lib/meetings-service";
import { meetingStatusLabel } from "@/lib/meeting-status";
import type { MeetingDetail, MeetingMinutes, TranscriptSegment } from "@/lib/types";
import { formatFullDateTime } from "@/lib/time-preferences";
import { CallCoordinationPanel } from "./call-coordination-panel";
import { KnowledgeEvidenceScreen } from "./knowledge-evidence-screen";
import { TranscriptTurn } from "./meeting-transcript";
import { PageHeader } from "./ui/page-header";
import { EmptyState, LoadingRow } from "./ui/feedback";

const POLL_MS = 15_000;
const LIVE = new Set<MeetingDetail["status"]>(["joining", "waiting_room", "live", "needs_attention", "stopping", "processing"]);

function elapsed(value: TranscriptSegment["startedAt"]): string {
  if (typeof value === "number") return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
  return value ?? "";
}

/**
 * A meeting opened by someone who is not an owner or admin: a teammate's assistant they share
 * (read-only status, transcript and approved minutes), else a cited knowledge source.
 */
export function MemberMeetingScreen({ meetingId, focusSegmentId, backLabel, onBack, onBackToKnowledge }: {
  meetingId: string; focusSegmentId: string | null; backLabel: string; onBack(): void; onBackToKnowledge(): void;
}) {
  const [coverage, setCoverage] = useState<MeetingCoordination | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void coordinationService.forMeeting(meetingId).then((view) => { if (active) setCoverage(view.your_role ? view : null); })
      .catch(() => { if (active) setCoverage(null); });
    return () => { active = false; };
  }, [meetingId]);
  if (coverage === undefined) return <section className="page narrow"><LoadingRow>Opening meeting…</LoadingRow></section>;
  if (!coverage) return <KnowledgeEvidenceScreen meetingId={meetingId} focusSegmentId={focusSegmentId} onBack={onBackToKnowledge} />;
  return <SharedMeetingScreen meetingId={meetingId} coverage={coverage} backLabel={backLabel} onBack={onBack} />;
}

function SharedMeetingScreen({ meetingId, coverage, backLabel, onBack }: { meetingId: string; coverage: MeetingCoordination; backLabel: string; onBack(): void }) {
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [minutes, setMinutes] = useState<MeetingMinutes | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const next = await meetingsService.getMeeting(meetingId);
        if (!active) return;
        setMeeting(next); setError(null);
        if (next.status !== "created") {
          const [turns, approved] = await Promise.all([
            meetingsService.getTranscript(meetingId).catch(() => [] as TranscriptSegment[]),
            coordinationService.sharedMinutes(meetingId).catch(() => null),
          ]);
          if (active) { setSegments(turns.filter((turn) => turn.isFinal)); setMinutes(approved); }
        }
        if (active && LIVE.has(next.status)) timer = window.setTimeout(() => void load(), POLL_MS);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "This meeting is unavailable.");
      }
    }
    let timer: number | undefined;
    void load();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [meetingId]);

  const owner = coverage.owner;
  return <section className="page narrow shared-meeting" aria-labelledby="shared-meeting-title">
    <PageHeader back={{ label: backLabel, onClick: onBack }} eyebrow={`Shared by ${owner?.display_name ?? "a teammate"}`} titleId="shared-meeting-title"
      title={meeting?.title ?? (error ? "Meeting unavailable" : <span className="skeleton record-title-skeleton" aria-hidden="true" />)}
      badge={meeting ? <span className={`status ${meeting.status}`}>{meetingStatusLabel[meeting.status]}</span> : undefined}
      description={meeting ? `${meeting.platform} · ${meeting.joinedAt ? `Joined ${formatFullDateTime(meeting.joinedAt)}` : `${possessive(firstName(owner))} assistant hasn't joined yet`}` : undefined} />
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <CallCoordinationPanel meetingId={meetingId} onChanged={() => void coordinationService.forMeeting(meetingId).catch(() => onBack())} />
    {meeting ? <>
      <section className="card" aria-labelledby="shared-minutes-title">
        <div className="card-header"><div><h2 id="shared-minutes-title">Minutes</h2><p>Shown once {owner?.display_name ?? "the owner"} approves them.</p></div></div>
        <div className="card-body">
          {minutes ? <div className="shared-minutes">
            <p>{minutes.executive_summary}</p>
            {minutes.decisions.length ? <><h3>Decisions</h3><ul>{minutes.decisions.map((item) => <li key={item}>{item}</li>)}</ul></> : null}
            {minutes.action_items.length ? <><h3>Action items</h3><ul>{minutes.action_items.map((item, index) => <li key={`${item.description}-${index}`}>{item.description}{item.owner ? <small> · {item.owner}</small> : null}{item.due_date ? <small> · {item.due_date}</small> : null}</li>)}</ul></> : null}
          </div> : <EmptyState plain icon={<FileText />} title="No approved minutes yet">{meeting.status === "ready" ? "The minutes are still being reviewed." : "Minutes appear here after the call is recorded and reviewed."}</EmptyState>}
        </div>
      </section>
      <section className="card transcript-card" aria-labelledby="shared-transcript-title">
        <div className="card-header"><div><h2 id="shared-transcript-title">Transcript</h2><p>Finalized turns. Speaker labels are reviewed by the meeting owner.</p></div><span className="section-count">{segments.length} turn{segments.length === 1 ? "" : "s"}</span></div>
        <div className="card-body transcript-body">
          {segments.length ? <ol className="transcript-list">{segments.map((turn) => <TranscriptTurn key={turn.id} id={`shared-${encodeURIComponent(turn.segmentId)}`} segment={turn} focused={false}
            assistantName={meeting.botName} time={elapsed(turn.startedAt)} timeTitle="Elapsed time into the meeting" highlight="" />)}</ol>
            : <EmptyState plain icon={<MessageSquareText />} title="No transcript yet">{meeting.status === "created" ? "The transcript appears once the assistant joins." : "Finalized turns appear here as the call is recorded."}</EmptyState>}
        </div>
      </section>
    </> : !error ? <LoadingRow>Loading meeting…</LoadingRow> : null}
  </section>;
}
