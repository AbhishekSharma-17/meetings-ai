"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, Users } from "lucide-react";
import { formatFullDateTime } from "@/lib/time-preferences";
import { inPersonService } from "@/lib/in-person-service";
import type { InPersonDevice, InPersonSession } from "@/lib/in-person-types";
import type { Meeting } from "@/lib/types";
import { Alert } from "./ui/feedback";
import { finalizeProgress, stageLabel } from "./in-person-finalizing";

const SESSION_POLL_MS = 4_000;

export const isInPerson = (meeting: Pick<Meeting, "platform"> | null | undefined) => meeting?.platform === "In person";

/** The "In person" mark for lists and headers: an icon and a word, never a colour. */
export function InPersonChip({ className = "" }: { className?: string }) {
  return <span className={`ip-chip ${className}`.trim()}><Users aria-hidden="true" />In person</span>;
}

const deviceWords: Record<InPersonDevice, string> = { phone: "phone", laptop: "laptop", unknown: "device" };

function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

export function recordedOn(session: InPersonSession): string {
  const who = session.recorded_by.display_name?.trim() || "a teammate";
  return `Recorded in person on ${possessive(who)} ${deviceWords[session.device] ?? "device"}`;
}

/** The recording session behind an in-person meeting; polled while it is still being recorded or processed. */
export function useInPersonSession(meetingId: string, enabled: boolean) {
  const [session, setSession] = useState<InPersonSession | null>(null);
  const [missing, setMissing] = useState(false);
  const busy = session?.status === "recording" || session?.status === "paused" || session?.status === "finalizing";
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const next = await inPersonService.get(meetingId);
        if (!active) return;
        setSession(next); setMissing(false);
        if (next.status === "recording" || next.status === "paused" || next.status === "finalizing") timer = window.setTimeout(() => void load(), SESSION_POLL_MS);
      } catch { if (active) setMissing(true); }
    };
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [meetingId, enabled, busy]);
  return { session, missing, setSession };
}

/** Header line: who recorded it on what, and the consent that was given. */
export function InPersonRecordMeta({ session }: { session: InPersonSession | null }) {
  if (!session) return <span className="ip-record-meta"><InPersonChip /></span>;
  const agreed = formatFullDateTime(new Date(session.consent.agreed_at));
  return <span className="ip-record-meta">
    <InPersonChip />
    <span>{recordedOn(session)}</span>
    <span className="ip-consent-record"><ShieldCheck aria-hidden="true" />Everyone present agreed to be recorded · {agreed} · {session.consent.notice_shown ? "notice shown" : "notice not shown"}</span>
  </span>;
}

/** What is happening with the recording, for the meeting page while it is not done. */
export function InPersonStatusAlert({ session, onChanged }: { session: InPersonSession | null; onChanged(session: InPersonSession): void }) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!session) return null;
  async function retry(id: string) {
    setRetrying(true); setError(null);
    try { onChanged(await inPersonService.retry(id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not retry."); }
    finally { setRetrying(false); }
  }
  if (session.status === "recording" || session.status === "paused") {
    return <Alert tone="info" title={session.status === "paused" ? "Recording paused" : "Recording in progress"}>
      {recordedOn(session)}. The transcript appears after the recording stops.
    </Alert>;
  }
  if (session.status === "finalizing") {
    const progress = finalizeProgress(session);
    return <Alert tone="info" title="Creating the transcript">
      <span className="ip-inline-progress">{stageLabel(session.finalize?.stage)} · {progress}%</span> You can leave this page; we&apos;ll notify you when the transcript is ready.
    </Alert>;
  }
  if (session.status === "failed") {
    return <Alert tone="danger" title="The transcript could not be created"
      actions={session.is_recorder ? <button type="button" className="button secondary sm" disabled={retrying} onClick={() => void retry(session.meeting_id)}>{retrying ? "Retrying…" : "Retry"}</button> : undefined}>
      {session.error ?? session.finalize?.message ?? "The audio is saved."}{error ? ` ${error}` : ""}
    </Alert>;
  }
  return null;
}
