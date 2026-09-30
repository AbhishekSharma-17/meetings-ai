"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { MeetingDetail, MeetingMinutes, TranscriptSegment } from "@/lib/types";
import { MeetingBadge } from "./meeting-badge";
import { MeetingTranscript, relativeTime, transcriptSeconds } from "./meeting-transcript";
import { InPersonRecordMeta, InPersonStatusAlert, useInPersonSession } from "./in-person-meeting-panels";
import { InPersonSpeakerNames } from "./in-person-speaker-names";
import { PageHeader } from "./ui/page-header";
import { EmptyState, LoadingRow } from "./ui/feedback";

const POLL_MS = 5_000;

/**
 * An in-person meeting opened by the member who recorded it: status, speaker naming, the transcript
 * (with per-line speaker fixes) and the minutes once an admin has drafted them.
 */
export function InPersonMemberMeeting({ meetingId, backLabel, onBack }: { meetingId: string; backLabel: string; onBack(): void }) {
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [minutes, setMinutes] = useState<MeetingMinutes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const recording = useInPersonSession(meetingId, true);
  const done = recording.session?.status === "done" || meeting?.status === "ready";

  const loadTranscript = useCallback(() => meetingsService.getTranscript(meetingId).then(setSegments).catch(() => undefined), [meetingId]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const next = await meetingsService.getMeeting(meetingId);
        if (!active) return;
        setMeeting(next); setError(null);
        await loadTranscript();
        const drafted = await meetingsService.getMinutes(meetingId).catch(() => null);
        if (active) setMinutes(drafted);
        if (active && next.status !== "ready" && next.status !== "failed" && next.status !== "stopped") timer = window.setTimeout(() => void load(), POLL_MS);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "This meeting is unavailable.");
      }
    };
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [meetingId, loadTranscript]);

  async function saveSpeaker(segment: TranscriptSegment, name: string, applyToSameLabel: boolean): Promise<boolean> {
    setSaving(true); setError(null);
    try { setSegments(await meetingsService.correctSpeaker(meetingId, segment.segmentId, name.trim() || null, applyToSameLabel)); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the speaker."); return false; }
    finally { setSaving(false); }
  }

  function download() {
    const ordered = [...segments].sort((a, b) => transcriptSeconds(a.startedAt) - transcriptSeconds(b.startedAt));
    const first = ordered.length ? transcriptSeconds(ordered[0].startedAt) : 0;
    const markdown = [`# Transcript — ${meeting?.title ?? "Meeting"}`, "", ...ordered.flatMap((turn) => [`**[${relativeTime(transcriptSeconds(turn.startedAt) - first)}] ${turn.speaker}:** ${turn.text}`, ""])].join("\n");
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    Object.assign(document.createElement("a"), { href: url, download: `meetings-ai-transcript-${meetingId}.md` }).click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  return <section className="page narrow ip-member-meeting" aria-labelledby="ip-member-title">
    <PageHeader back={{ label: backLabel, onClick: onBack }} titleId="ip-member-title"
      title={meeting?.title ?? (error ? "Meeting unavailable" : <span className="skeleton record-title-skeleton" aria-hidden="true" />)}
      badge={meeting ? <MeetingBadge meeting={meeting} /> : undefined}
      description={<InPersonRecordMeta session={recording.session} />} />
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="record-alerts"><InPersonStatusAlert session={recording.session} onChanged={recording.setSession} /></div>
    {meeting ? <div className="stack-lg">
      {done ? <InPersonSpeakerNames meetingId={meetingId} onApplied={() => void loadTranscript()} /> : null}
      <section className="card" aria-labelledby="ip-member-minutes">
        <div className="card-header"><div><h2 id="ip-member-minutes">Minutes</h2><p>Drafted from the transcript and reviewed by a workspace admin.</p></div></div>
        <div className="card-body">
          {minutes ? <div className="shared-minutes"><p>{minutes.executive_summary}</p>
            {minutes.decisions.length ? <><h3>Decisions</h3><ul>{minutes.decisions.map((item) => <li key={item}>{item}</li>)}</ul></> : null}
          </div> : <EmptyState plain icon={<FileText />} title="No minutes yet">{done ? "Minutes appear here once they are drafted." : "Minutes are drafted after the transcript is ready."}</EmptyState>}
        </div>
      </section>
      <MeetingTranscript meetingTitle={meeting.title} assistantName={meeting.botName} segments={segments} isPolling={!done} isLive={false} saving={saving} onSaveSpeaker={saveSpeaker} onDownload={download} />
    </div> : !error ? <LoadingRow>Loading meeting…</LoadingRow> : null}
  </section>;
}
