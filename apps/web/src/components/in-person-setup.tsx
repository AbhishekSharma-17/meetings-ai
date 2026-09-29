"use client";

import { useState, type FormEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Mic, X } from "lucide-react";
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

  return <form className="ip-screen ip-setup" onSubmit={submit} noValidate>
    <header className="ip-setup-head">
      <div>
        <p className="eyebrow"><Mic aria-hidden="true" />In person</p>
        <Dialog.Title className="ip-title">Record an in-person meeting</Dialog.Title>
        <Dialog.Description className="ip-intro">Record a face-to-face conversation from this device. You get a transcript, speaker names you approve and draft minutes.</Dialog.Description>
      </div>
      <button type="button" className="icon-button ip-close" aria-label="Cancel" onClick={onCancel}><X aria-hidden="true" /></button>
    </header>

    <div className="ip-setup-body">
      <InPersonInstallHint />
      <div className="field">
        <label htmlFor="ip-title">Meeting title</label>
        <input id="ip-title" value={title} maxLength={MAX_TITLE} onChange={(event) => setTitle(event.target.value)} autoComplete="off" />
      </div>
      <ChipInput id="ip-expected" label="Who's expected" kind="text" value={expected} onChange={setExpected} maxItems={MAX_EXPECTED} maxItemLength={120}
        placeholder="Type a name, then comma" labelSuffix={<span className="optional">optional</span>}
        hint="Names help suggest who is speaking. Nobody is contacted." />
      <InPersonMicCheck check={check} showPicker={laptop} demo={demo} />

      <fieldset className="ip-consent">
        <legend>Consent</legend>
        <label className="check-label ip-consent-check">
          <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} required />
          <span>Everyone present has agreed to be recorded</span>
        </label>
        <SwitchField id="ip-notice" label="Show a notice to read aloud" description="Shows a short notice in large text you can read to the room." checked={showNotice} onChange={setShowNotice} />
        {showNotice ? <blockquote className="ip-notice" aria-label="Notice to read aloud">{READ_ALOUD_NOTICE}</blockquote> : null}
        <p className="field-hint">The consent is saved with the meeting, with the time and whether the notice was shown.</p>
      </fieldset>

      {problem ? <Alert tone={problem.providers ? "warning" : "danger"} title={problem.title}
        actions={problem.providers && canOpenProviders ? <button type="button" className="button secondary" onClick={onOpenProviders}>Open AI providers</button> : undefined}>
        {problem.detail}{problem.providers && !canOpenProviders ? " Ask a workspace admin to add a speech-to-text provider." : ""}
      </Alert> : null}
    </div>

    <footer className="ip-actions">
      <button type="button" className="button ghost" onClick={onCancel}>Cancel</button>
      <button type="submit" className="button primary" disabled={!agreed || starting}>{starting ? "Starting…" : "Start recording"}</button>
    </footer>
  </form>;
}
