"use client";

import { FormEvent, useEffect, useState } from "react";
import { leaveService, serviceErrorStatus } from "@/lib/meetings-service";
import { LEAVE_FIELDS, policyPreview, serviceLimitNote } from "@/lib/leave-copy";
import type { LeavePolicy, LeavePolicyValues } from "@/lib/types";
import { Alert, Skeleton } from "./ui/feedback";

type Draft = Record<keyof LeavePolicyValues, string>;

const toDraft = (values: LeavePolicyValues): Draft => ({
  silence_minutes: String(values.silence_minutes), quiet_after_end_minutes: String(values.quiet_after_end_minutes),
  no_one_joined_minutes: String(values.no_one_joined_minutes), max_hours: String(values.max_hours),
});

/** The first field outside its allowed range, as a sentence, or null when every value is valid. */
function draftProblem(draft: Draft, limits: LeavePolicy["limits"]): string | null {
  for (const field of LEAVE_FIELDS) {
    const value = Number(draft[field.key]);
    const [low, high] = limits[field.key];
    if (!Number.isInteger(value) || value < low || value > high) return `${field.label} must be a whole number from ${low} to ${high} ${field.unit}.`;
  }
  return null;
}

function toValues(draft: Draft): LeavePolicyValues {
  return { silence_minutes: Number(draft.silence_minutes), quiet_after_end_minutes: Number(draft.quiet_after_end_minutes),
    no_one_joined_minutes: Number(draft.no_one_joined_minutes), max_hours: Number(draft.max_hours) };
}

/** "When the assistant leaves a call": every member reads it; owners and admins change it. */
export function WorkspaceLeavePolicy({ onSaved }: { onSaved(message: string): void }) {
  const [policy, setPolicy] = useState<LeavePolicy | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    void leaveService.getPolicy().then((loaded) => { setPolicy(loaded); setDraft(toDraft(loaded)); }).catch((cause: unknown) => {
      if (serviceErrorStatus(cause) === 404) setUnavailable(true);
      else setError("Could not load when the assistant leaves a call.");
    });
  }, []);

  if (unavailable) return null;
  const locked = !policy?.can_edit || busy;
  const problem = draft && policy ? draftProblem(draft, policy.limits) : null;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || problem) return;
    setBusy(true); setError(null);
    try {
      const saved = await leaveService.savePolicy(toValues(draft));
      setPolicy(saved); setDraft(toDraft(saved));
      onSaved("Saved. New calls use these rules; calls already running pick them up within a minute.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save when the assistant leaves a call.");
    } finally { setBusy(false); }
  }

  return <section className="card settings-section" id="settings-leave" aria-labelledby="leave-policy-title">
    <div className="card-header"><div>
      <h2 id="leave-policy-title">When the assistant leaves a call</h2>
      <p>It stays for as long as people keep talking, even when a meeting runs late, and leaves once the call is really over.</p>
    </div></div>
    <form onSubmit={(event) => void save(event)}>
      <div className="card-body form-stack">
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {policy && draft ? <>
          <div className="leave-rules">
            <p>It also leaves right away when the host ends the meeting or removes it from the call.</p>
            <p className="field-hint">{serviceLimitNote(policy.service_max_hours)}</p>
          </div>
          <div className="leave-fields">
            {LEAVE_FIELDS.map((field) => {
              const [low, high] = policy.limits[field.key];
              return <div className="field" key={field.key}>
                <label htmlFor={`leave-${field.key}`}>{field.label}</label>
                <div className="leave-input">
                  <input id={`leave-${field.key}`} type="number" inputMode="numeric" min={low} max={high} step={1} required
                    value={draft[field.key]} disabled={locked} aria-describedby={`leave-${field.key}-hint`}
                    onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })} />
                  <span aria-hidden="true">{field.unit === "hours" ? "hours" : "min"}</span>
                </div>
                <p className="field-hint" id={`leave-${field.key}-hint`}>{field.hint} {low}–{high} {field.unit}.</p>
              </div>;
            })}
          </div>
          {problem ? <p className="form-error" role="alert">{problem}</p>
            : <Alert tone="info" role="note" className="leave-preview">{policyPreview(toValues(draft), policy.service_max_hours)}</Alert>}
          {!policy.can_edit ? <p className="field-hint">Only a workspace owner or admin can change these rules.</p> : null}
        </> : !error ? <Skeleton lines={4} /> : null}
      </div>
      {policy?.can_edit && draft ? <div className="card-footer">
        <button type="button" className="button ghost" disabled={busy} onClick={() => setDraft(toDraft(policy.defaults))}>Use recommended values</button>
        <button type="submit" className="button primary" disabled={busy || problem !== null}>{busy ? "Saving…" : "Save leave rules"}</button>
      </div> : null}
    </form>
  </section>;
}
