"use client";

import { useState, type FormEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { InPersonSeed } from "@/lib/in-person-types";
import { ChipInput } from "./ui/chip-input";
import { SwitchField } from "./ui/switch";
import { Alert } from "./ui/feedback";
import { InPersonInstallHint } from "./in-person-install-hint";
import { InPersonMicCheck, type MicrophoneCheck } from "./in-person-mic-check";

export const DEFAULT_TITLE = "In-person meeting";
export const READ_ALOUD_NOTICE = "This meeting is being recorded and transcribed by Meetings AI for notes and minutes. Tell me now if you do not agree.";
const MAX_EXPECTED = 30;
const MAX_TITLE = 200;

export type SetupValues = { title: string; expectedPeople: string[]; noticeShown: boolean };
/** A problem starting the recording; `providers` marks the missing speech-to-text setup. */
export type StartProblem = { title: string; detail: string; providers?: boolean };

export function InPersonSetup({ seed, check, demo, laptop, starting, problem, canOpenProviders, onStart, onCancel, onOpenProviders }: {
  seed: InPersonSeed;
  check: MicrophoneCheck;
  demo: boolean;
  laptop: boolean;
  starting: boolean;
  problem: StartProblem | null;
  canOpenProviders: boolean;
  onStart(values: SetupValues): void;
  onCancel(): void;
  onOpenProviders(): void;
}) {
  const [title, setTitle] = useState(seed.title?.trim() || DEFAULT_TITLE);
  const [expected, setExpected] = useState<string[]>(seed.expectedPeople.slice(0, MAX_EXPECTED));
  const [agreed, setAgreed] = useState(false);
  const [showNotice, setShowNotice] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agreed || starting) return;
    onStart({ title: title.trim() || DEFAULT_TITLE, expectedPeople: expected, noticeShown: showNotice });
  }

  return <>
    <Dialog.Close className="close-button" aria-label="Cancel" disabled={starting}><X aria-hidden="true" /></Dialog.Close>
    <Dialog.Title className="dialog-title">Record an in-person meeting</Dialog.Title>
    <Dialog.Description className="dialog-intro">Record a face-to-face conversation from this device. You get a transcript, speaker names you approve and draft minutes.</Dialog.Description>
    <form className="ip-setup-form" onSubmit={submit} noValidate>
      <InPersonInstallHint />
      <section className="ip-section" aria-labelledby="ip-meeting-heading">
        <h3 id="ip-meeting-heading" className="sr-only">Meeting</h3>
        <div className="field">
          <label htmlFor="ip-title">Meeting title</label>
          <input id="ip-title" value={title} maxLength={MAX_TITLE} onChange={(event) => setTitle(event.target.value)} autoComplete="off" disabled={starting} />
        </div>
        <ChipInput id="ip-expected" label="Who's expected" kind="text" value={expected} onChange={setExpected} maxItems={MAX_EXPECTED} maxItemLength={120}
          placeholder="Type a name, then comma" labelSuffix={<span className="optional">optional</span>} disabled={starting}
          hint="Names help suggest who is speaking. Nobody is contacted." />
      </section>

      <InPersonMicCheck check={check} showPicker={laptop} demo={demo} />

      <fieldset className="ip-section">
        <legend className="ip-section-title">Consent</legend>
        <label className="choice-card">
          <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} disabled={starting} required />
          <span><b>Everyone present has agreed to be recorded</b><small>Saved with the meeting, with the time and whether the notice was shown.</small></span>
        </label>
        <SwitchField id="ip-notice" label="Show a notice to read aloud" description="A short notice you can read to the room before you start." checked={showNotice} onChange={setShowNotice} disabled={starting} />
        {showNotice ? <Alert tone="neutral" role="note" className="ip-notice" title="Read this aloud">{READ_ALOUD_NOTICE}</Alert> : null}
      </fieldset>

      {problem ? <Alert tone={problem.providers ? "warning" : "danger"} title={problem.title}
        actions={problem.providers && canOpenProviders ? <button type="button" className="button secondary sm" onClick={onOpenProviders}>Open AI providers</button> : undefined}>
        {problem.detail}{problem.providers && !canOpenProviders ? " Ask a workspace admin to add a speech-to-text provider." : ""}
      </Alert> : null}

      <div className="dialog-footer">
        <button type="button" className="button secondary" onClick={onCancel} disabled={starting}>Cancel</button>
        <button type="submit" className="button primary" disabled={!agreed || starting}>{starting ? "Starting…" : "Start recording"}</button>
      </div>
    </form>
  </>;
}
