import { BellRing, Check } from "lucide-react";
import type { PrepStage } from "@/lib/types";

const researchSteps: { stage: PrepStage; label: string }[] = [
  { stage: "planning", label: "Planning research" },
  { stage: "searching", label: "Searching public sources" },
  { stage: "reading", label: "Reading sources and your documents" },
  { stage: "writing", label: "Writing the briefing" },
];
const contextSteps: { stage: PrepStage; label: string }[] = [
  { stage: "reading", label: "Reading your documents" },
  { stage: "writing", label: "Writing the briefing" },
];
const order: PrepStage[] = ["queued", "planning", "searching", "reading", "writing", "done"];

/**
 * Live research steps from the background job (or the SSE stream on older APIs). `stage` null means the
 * synchronous fallback is running (no step detail). `background` marks a server-side job the user can leave.
 */
export function PrepProgress({ stage, research, background = false, onCancel }: { stage: PrepStage | null; research: boolean; background?: boolean; onCancel?(): void }) {
  const steps = research ? researchSteps : contextSteps;
  const current = stage ? order.indexOf(stage) : -1;
  return <section className="card prep-progress" aria-labelledby="prep-progress-title">
    <div className="card-body">
      <h2 id="prep-progress-title">{stage === null ? <span className="spinner" aria-hidden="true" /> : null}Preparing your briefing</h2>
      <p className="field-hint">{research ? "Research usually takes under a minute." : "This usually takes a few seconds."}</p>
      <ol className="prep-steps" role="status" aria-live="polite">
        {steps.map((step) => {
          const index = order.indexOf(step.stage);
          const state = stage === null ? "pending" : index < current ? "done" : index === current ? "active" : "pending";
          return <li key={step.stage} className="prep-step" data-state={state} aria-current={state === "active" ? "step" : undefined}>
            <span className="prep-step-mark" aria-hidden="true">{state === "done" ? <Check /> : state === "active" ? <span className="spinner" /> : null}</span>
            <span>{step.label}</span>
            <span className="sr-only">{state === "done" ? "done" : state === "active" ? "in progress" : "waiting"}</span>
          </li>;
        })}
      </ol>
      {background ? <div className="prep-background-hint">
        <p className="field-hint"><BellRing aria-hidden="true" />Running in the background — you can leave this page. We’ll notify you when it’s ready.</p>
        {onCancel ? <button type="button" className="button ghost sm" onClick={onCancel}>Cancel</button> : null}
      </div> : null}
    </div>
  </section>;
}
