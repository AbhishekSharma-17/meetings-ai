"use client";

import { useCallback, useEffect, useState } from "react";
import { forgetSession, listChunks, listSessions, purgeStaleRecordings } from "@/lib/in-person-chunk-store";
import { inPersonService, statusOf } from "@/lib/in-person-service";
import { Alert } from "./ui/feedback";
import type { PendingRecording } from "./in-person-flow";

/** Finds a recording this device started that never finished (the page was reloaded or closed). */
export function usePendingRecording(identity: string | null, enabled: boolean) {
  const [pending, setPending] = useState<PendingRecording | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!identity || !enabled) return;
    let active = true;
    void (async () => {
      await purgeStaleRecordings().catch(() => 0);  // unusable audio left by any account on this device
      for (const stored of await listSessions(identity)) {
        try {
          const session = await inPersonService.get(stored.meetingId);
          if (session.status === "recording" || session.status === "paused") {
            const buffered = await listChunks(stored.meetingId);
            if (active) setPending({ stored, session, buffered });
            return;
          }
          await forgetSession(stored.meetingId);
        } catch (cause) {
          // Gone (discarded elsewhere) or no longer ours: nothing left to finish here.
          const status = statusOf(cause);
          if (status === 404 || status === 403) await forgetSession(stored.meetingId);
        }
      }
      if (active) setPending(null);
    })();
    return () => { active = false; };
  }, [identity, enabled, nonce]);

  return { pending, recheck: useCallback(() => setNonce((value) => value + 1), []), clear: useCallback(() => setPending(null), []) };
}

/** "An in-person recording didn't finish" with finish, keep recording and discard. */
export function InPersonResumeBanner({ pending, onFinish, onContinue, onDiscarded }: {
  pending: PendingRecording;
  onFinish(): void;
  onContinue(): void;
  onDiscarded(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = pending.buffered.filter((chunk) => chunk.seq > pending.session.last_seq).length;

  async function discard() {
    setBusy(true); setError(null);
    try {
      await inPersonService.discard(pending.session.meeting_id);
      await forgetSession(pending.session.meeting_id);
      onDiscarded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not discard the recording.");
      setBusy(false);
    }
  }

  const saved = waiting ? `${waiting} piece${waiting === 1 ? "" : "s"} of audio ${waiting === 1 ? "is" : "are"} saved on this device and not uploaded yet.` : "The audio recorded so far is already uploaded.";
  return <Alert tone="warning" className="ip-resume" title={`“${pending.session.title}” didn't finish recording`}
    actions={confirming ? <>
      <button type="button" className="button ghost sm" disabled={busy} onClick={() => setConfirming(false)}>Keep it</button>
      <button type="button" className="button danger sm" disabled={busy} onClick={() => void discard()}>{busy ? "Discarding…" : "Discard recording"}</button>
    </> : <>
      <button type="button" className="button primary sm" onClick={onFinish}>Upload the saved audio and finish</button>
      <button type="button" className="button secondary sm" onClick={onContinue}>Keep recording</button>
      <button type="button" className="text-button destructive" onClick={() => setConfirming(true)}>Discard</button>
    </>}>
    {confirming ? "Discarding deletes this meeting and all of its audio. This cannot be undone." : `${saved} Finish to create the transcript.`}
    {error ? <span className="form-error" role="alert"> {error}</span> : null}
  </Alert>;
}
