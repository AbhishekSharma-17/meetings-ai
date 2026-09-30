"use client";

import { useEffect, useRef, useState } from "react";
import { BellRing, Check, RefreshCw } from "lucide-react";
import { inPersonService } from "@/lib/in-person-service";
import type { FinalizeStage, InPersonSession } from "@/lib/in-person-types";
import { Alert, Badge } from "./ui/feedback";
import { PageHeader } from "./ui/page-header";
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
  return <>
    <PageHeader eyebrow="In-person recording" titleId="ip-recorder-title" title={failed ? "The transcript could not be created" : "Creating the transcript"}
      badge={failed ? <Badge tone="danger">Needs attention</Badge> : <Badge tone="info" dot>Processing</Badge>}
      description={session.title}
      actions={<button type="button" className="button secondary" onClick={() => onLeave(session.meeting_id)}>Leave this page</button>} />

    <div className="ip-recorder-body">
      {failed ? <Alert tone="danger" title="Something went wrong while processing the audio"
        actions={<button type="button" className="button primary sm" disabled={retrying} onClick={() => void retry()}><RefreshCw aria-hidden="true" />{retrying ? "Retrying…" : "Retry"}</button>}>
        {session.error ?? finalize?.message ?? "The audio is saved. Retry to try again."}
      </Alert> : <section className="card" aria-labelledby="ip-finalize-title">
        <div className="card-header">
          <div><h2 id="ip-finalize-title">Progress</h2><p>The transcript and speaker suggestions usually take a few minutes.</p></div>
          <span className="section-count">{progress}%</span>
        </div>
        <div className="card-body ip-finalize-body">
          <div className="ip-progress" role="progressbar" aria-label="Transcript progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={`${stageLabel(finalize?.stage)}${parts}`}>
            <span style={{ transform: `scaleX(${progress / 100})` }} />
          </div>
          {/* The step list shows the stage; this only announces changes to screen readers. */}
          <p className="sr-only" role="status">{stageLabel(finalize?.stage)}{parts}</p>
          <ol className="prep-steps">
            {STEPS.map((step, index) => {
              const state = index < current ? "done" : index === current ? "active" : "pending";
              return <li key={step.stage} className="prep-step" data-state={state} aria-current={state === "active" ? "step" : undefined}>
                <span className="prep-step-mark" aria-hidden="true">{state === "done" ? <Check /> : state === "active" ? <span className="spinner" /> : null}</span>
                <span>{step.label}{state === "active" ? parts : ""}</span>
                <span className="sr-only">{state === "done" ? "done" : state === "active" ? "in progress" : "waiting"}</span>
              </li>;
            })}
          </ol>
        </div>
        <div className="card-footer split">
          <p className="field-hint ip-leave-hint"><BellRing aria-hidden="true" />You can leave this page; we&apos;ll notify you when the transcript is ready.</p>
        </div>
      </section>}
      {retryError ? <p className="form-error" role="alert">{retryError}</p> : null}
      {poll.error ? <p className="field-hint">Can&apos;t check progress right now ({poll.error}). Checking again…</p> : null}
    </div>
  </>;
}
