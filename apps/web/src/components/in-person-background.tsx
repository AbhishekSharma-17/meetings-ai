"use client";

import type { RecordingController } from "@/lib/in-person-controller";
import type { InPersonSession } from "@/lib/in-person-types";
import { Alert, Badge } from "./ui/feedback";
import { formatClock, useRecorderSnapshot, useTicker } from "./use-in-person";

const TIMER_TICK_MS = 1_000;

/** Shown at the top of other screens while an in-person recording keeps running (or is being processed). */
export function InPersonBackgroundBanner({ session, controller, onReturn }: {
  session: InPersonSession;
  /** Null once the recording has stopped and the transcript is being made. */
  controller: RecordingController | null;
  onReturn(): void;
}) {
  return <div className="ip-resume-region">
    {controller ? <RecordingBanner session={session} controller={controller} onReturn={onReturn} />
      : <Alert tone="info" role="note" className="ip-resume" title={`Creating the transcript for “${session.title}”`}
        actions={<button type="button" className="button secondary sm" onClick={onReturn}>View progress</button>}>
        You can keep working. We&apos;ll notify you when the transcript is ready.
      </Alert>}
  </div>;
}

function RecordingBanner({ session, controller, onReturn }: { session: InPersonSession; controller: RecordingController; onReturn(): void }) {
  const snapshot = useRecorderSnapshot(controller);
  const recording = snapshot.phase === "recording";
  useTicker(TIMER_TICK_MS, recording);
  const state = recording ? <Badge tone="danger" dot>Recording</Badge>
    : snapshot.phase === "paused" ? <Badge tone="warning">Paused</Badge>
      : snapshot.phase === "interrupted" ? <Badge tone="warning">Stopped</Badge> : <Badge>Finishing</Badge>;
  return <Alert tone="neutral" role="note" className="ip-resume ip-background"
    title={<span className="cluster">{`“${session.title}”`}{state}<span className="tabular">{formatClock(controller.elapsedMs())}</span></span>}
    actions={<button type="button" className="button primary sm" onClick={onReturn}>Return to recording</button>}>
    {recording ? "The microphone is still on. Keep this tab open until you stop." : "Return to the recording to resume or stop it."}
  </Alert>;
}
