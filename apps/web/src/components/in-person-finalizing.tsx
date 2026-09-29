"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Check, FileAudio, RefreshCw } from "lucide-react";
import { inPersonService } from "@/lib/in-person-service";
import type { FinalizeStage, InPersonSession } from "@/lib/in-person-types";
import { Alert } from "./ui/feedback";
import { useSessionPoll } from "./use-in-person";

const FINALIZE_POLL_MS = 2_000;
const STEPS: Array<{ stage: FinalizeStage; label: string }> = [
  { stage: "queued", label: "Waiting to start" },
  { stage: "assembling", label: "Joining the audio" },
  { stage: "transcribing", label: "Transcribing audio" },
  { stage: "reconciling", label: "Lining up speakers" },
  { stage: "naming", label: "Suggesting speaker names" },
  { stage: "saving", label: "Saving the transcript" },
];

export function stageLabel(stage: FinalizeStage | null | undefined): string {
  if (stage === "done") return "Done";
  if (stage === "failed") return "Could not finish";
  return STEPS.find((step) => step.stage === stage)?.label ?? "Waiting to start";
}

/** 0–100, from the stage reached and, while transcribing, the parts done. */
export function finalizeProgress(session: InPersonSession): number {
  const finalize = session.finalize;
  if (session.status === "done" || finalize?.stage === "done") return 100;
  const index = Math.max(0, STEPS.findIndex((step) => step.stage === finalize?.stage));
  const within = finalize?.stage === "transcribing" && finalize.parts_total ? finalize.parts_done / finalize.parts_total : 0;
  return Math.round(((index + within) / STEPS.length) * 95) + 5;
}

export function InPersonFinalizing({ session: initial, onDone, onLeave }: {
  session: InPersonSession;
  onDone(meetingId: string): void;
  /** Leave while the transcript is built: the meeting page shows the progress. */
  onLeave(meetingId: string): void;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const poll = useSessionPoll(initial.meeting_id, FINALIZE_POLL_MS, true, initial);
  const session = poll.session ?? initial;
  const finished = useRef(false);

  useEffect(() => {
    if (session.status !== "done" || finished.current) return;
    finished.current = true;
    onDone(session.meeting_id);
  }, [onDone, session.meeting_id, session.status]);

  async function retry() {
    setRetrying(true); setRetryError(null);
    try { poll.setSession(await inPersonService.retry(session.meeting_id)); poll.reload(); }
    catch (cause) { setRetryError(cause instanceof Error ? cause.message : "Could not retry. Try again in a moment."); }
    finally { setRetrying(false); }
  }

  const failed = session.status === "failed";
  const progress = finalizeProgress(session);
  const finalize = session.finalize;
  const parts = finalize?.stage === "transcribing" && finalize.parts_total > 1 ? ` · ${finalize.parts_done} of ${finalize.parts_total} parts` : "";
  const current = STEPS.findIndex((step) => step.stage === finalize?.stage);
  return <div className="ip-screen ip-finalizing">
    <div className="ip-finalizing-body">
      <span className="ip-finalizing-icon" aria-hidden="true"><FileAudio /></span>
      <Dialog.Title className="ip-title">{failed ? "The transcript could not be created" : "Creating the transcript"}</Dialog.Title>
      <p className="ip-intro">{session.title}</p>
      {failed ? <Alert tone="danger" title="Something went wrong while processing the audio"
        actions={<button type="button" className="button primary" disabled={retrying} onClick={() => void retry()}><RefreshCw aria-hidden="true" />{retrying ? "Retrying…" : "Retry"}</button>}>
        {session.error ?? finalize?.message ?? "The audio is saved. Retry to try again."}
      </Alert> : <>
        <div className="ip-progress" role="progressbar" aria-label="Transcript progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${stageLabel(finalize?.stage)}${parts}`}>
          <span style={{ transform: `scaleX(${progress / 100})` }} />
        </div>
        <p className="ip-stage" role="status">{stageLabel(finalize?.stage)}{parts}</p>
        <ol className="ip-steps">
          {STEPS.map((step, index) => <li key={step.stage} data-state={index < current ? "done" : index === current ? "current" : "next"}>
            {index < current ? <Check aria-hidden="true" /> : <span className="ip-step-dot" aria-hidden="true" />}{step.label}
          </li>)}
        </ol>
      </>}
      {retryError ? <p className="form-error" role="alert">{retryError}</p> : null}
      {poll.error ? <p className="field-hint">Can&apos;t check progress right now ({poll.error}). Checking again…</p> : null}
      <p className="ip-leave-copy">You can leave this page; we&apos;ll notify you when the transcript is ready.</p>
    </div>
    <footer className="ip-actions">
      <button type="button" className="button secondary" onClick={() => onLeave(session.meeting_id)}>Leave this page</button>
    </footer>
  </div>;
}
