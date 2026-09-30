"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Bookmark, CircleStop, Pause, Play, RefreshCw } from "lucide-react";
import type { RecordingController, RecorderSnapshot } from "@/lib/in-person-controller";
import { isHandheld, watchLowBattery } from "@/lib/in-person-media";
import type { InPersonSession } from "@/lib/in-person-types";
import { Alert, Badge, LoadingRow, type Tone } from "./ui/feedback";
import { PageHeader } from "./ui/page-header";
import { SettingsToast, type SettingsNotice } from "./settings-toast";
import { InPersonLevel } from "./in-person-level";
import { InPersonCaptions } from "./in-person-captions";
import { formatClock, useLevel, useRecorderSnapshot, useSessionPoll, useTicker } from "./use-in-person";

const CAPTION_POLL_MS = 5_000;
const TIMER_TICK_MS = 500;

export function uploadLabel(upload: RecorderSnapshot["upload"]): string {
  if (upload.state === "offline") return "Offline — keeping audio on this device";
  if (upload.state === "retrying") return "Retrying…";
  if (upload.state === "error") return "Upload stopped";
  // One piece in flight is the normal rhythm; only a backlog is worth mentioning.
  if (upload.state === "uploading" && upload.pending > 1) return `Uploading ${upload.pending} pieces…`;
  return "Saved";
}

function uploadDetail(upload: RecorderSnapshot["upload"]): string | null {
  if (upload.state === "offline") return upload.pending ? `${upload.pending} piece${upload.pending === 1 ? "" : "s"} waiting. Uploads resume when you're back online.` : "Uploads resume when you're back online.";
  if (upload.state === "retrying" || upload.state === "error") return upload.message;
  return null;
}

function uploadTone(upload: RecorderSnapshot["upload"]): Tone {
  if (upload.state === "offline" || upload.state === "retrying") return "warning";
  if (upload.state === "error") return "danger";
  if (upload.state === "uploading" && upload.pending > 1) return "neutral";
  return "success";
}

type Status = { label: string; tone: Tone; dot: boolean };

/** The page header's status badge: a word and a tone, never colour alone. */
export function recorderStatus(snapshot: RecorderSnapshot): Status {
  if (snapshot.phase === "stopping" || snapshot.phase === "idle") return { label: "Finishing", tone: "neutral", dot: false };
  if (snapshot.phase === "paused") return { label: "Paused", tone: "warning", dot: false };
  if (snapshot.phase === "interrupted") return { label: "Stopped", tone: "warning", dot: false };
  if (snapshot.upload.state === "offline") return { label: "Offline — saving on this device", tone: "neutral", dot: true };
  return { label: "Recording", tone: "danger", dot: true };
}

function finishingLabel(upload: RecorderSnapshot["upload"]): string {
  if (upload.state === "offline") return "Waiting for a connection to upload the rest…";
  if (upload.pending) return `Uploading the last ${upload.pending === 1 ? "piece" : `${upload.pending} pieces`}…`;
  return "Finishing…";
}

export function InPersonRecording({ controller, session, onStopped, onResumeEngine }: {
  controller: RecordingController;
  session: InPersonSession;
  onStopped(session: InPersonSession): void;
  /** Starts a fresh microphone stream after an interruption; returns a problem to show, or null. */
  onResumeEngine(): Promise<string | null>;
}) {
  const snapshot = useRecorderSnapshot(controller);
  const recording = snapshot.phase === "recording";
  const active = recording || snapshot.phase === "paused" || snapshot.phase === "interrupted";
  const readLevel = useCallback(() => controller.level(), [controller]);
  const level = useLevel(readLevel, recording);
  const poll = useSessionPoll(session.meeting_id, CAPTION_POLL_MS, active, session);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<SettingsNotice | null>(null);
  const [lowBattery, setLowBattery] = useState(false);
  const [resumeProblem, setResumeProblem] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [handheld] = useState(isHandheld);
  const stopping = useRef(false);
  useTicker(TIMER_TICK_MS, recording);

  useEffect(() => watchLowBattery(setLowBattery), []);

  const finish = useCallback(async (stopFirst: boolean) => {
    if (stopping.current) return;
    stopping.current = true;
    setConfirming(false);
    try { onStopped(stopFirst ? await controller.stop() : await controller.finish()); }
    catch { /* The controller keeps the reason in stopError; the person can try again. */ }
    finally { stopping.current = false; }
  }, [controller, onStopped]);

  // A reload recovery ("upload the saved audio and finish") starts straight in the finishing step.
  const autoFinished = useRef(false);
  useEffect(() => {
    if (snapshot.phase !== "idle" || autoFinished.current) return;
    autoFinished.current = true;
    queueMicrotask(() => void finish(false));
  }, [finish, snapshot.phase]);

  function mark() {
    const moment = controller.markMoment();
    setNotice({ text: `Moment marked at ${formatClock(moment.atMs)}`, tone: "success" });
  }

  async function resumeEngine() {
    setResuming(true); setResumeProblem(null);
    setResumeProblem(await onResumeEngine());
    setResuming(false);
  }

  const upload = snapshot.upload;
  const detail = uploadDetail(upload);
  const paused = snapshot.phase === "paused";
  const finishing = snapshot.phase === "stopping" || snapshot.phase === "idle";
  const status = recorderStatus(snapshot);
  return <>
    <PageHeader eyebrow="In-person recording" titleId="ip-recorder-title" title={session.title}
      badge={<Badge tone={status.tone} dot={status.dot}>{status.label}</Badge>}
      description="Stop when the meeting ends. The transcript and speaker suggestions follow a few minutes later." />

    <div className="ip-recorder-body">
      {snapshot.phase === "interrupted" ? <Alert tone="warning" title="Recording stopped" actions={<>
        <button type="button" className="button primary sm" disabled={resuming} onClick={() => void resumeEngine()}><Play aria-hidden="true" />{resuming ? "Starting…" : "Resume recording"}</button>
        <button type="button" className="button secondary sm" onClick={() => setConfirming(true)}>Stop and transcribe</button>
      </>}>{snapshot.interruption} Everything recorded so far is safe.{resumeProblem ? ` ${resumeProblem}` : ""}</Alert> : null}
      {snapshot.stopError ? <Alert tone="danger" title="The recording has not finished yet" actions={<button type="button" className="button secondary sm" onClick={() => void finish(false)}>Try again</button>}>{snapshot.stopError}</Alert> : null}

      <section className="card ip-session" aria-label="Time and input level">
        <div className="card-body ip-session-body">
          <div className="ip-clock">
            <div>
              <p className="stat-label">Recorded time</p>
              <p className="ip-timer tabular" aria-live="off">{formatClock(controller.elapsedMs())}</p>
            </div>
            <span role="status" className="ip-upload" data-testid="upload-status"><Badge tone={uploadTone(upload)} dot>{uploadLabel(upload)}</Badge></span>
          </div>
          <InPersonLevel level={level} paused={!recording} label="Input level" />
          {detail || upload.state === "error" || upload.state === "retrying" ? <div className="ip-upload-detail">
            {detail ? <p className="field-hint">{detail}</p> : null}
            {upload.state === "error" || upload.state === "retrying" ? <button type="button" className="button secondary sm" onClick={() => controller.retryUploads()}><RefreshCw aria-hidden="true" />Try again now</button> : null}
          </div> : null}
          {snapshot.moments.length ? <div className="ip-moments">
            <h2 className="field-label">Moments</h2>
            <ul className="tag-list" aria-label="Marked moments">{snapshot.moments.map((moment, index) => <li key={`${moment.atMs}-${index}`} className="tag">
              <Bookmark aria-hidden="true" /><span className="tabular">{formatClock(moment.atMs)}</span>{moment.saved ? null : <span className="text-tertiary">· saving…</span>}
            </li>)}</ul>
          </div> : null}
        </div>
        <div className="card-footer ip-controls">
          {finishing ? <LoadingRow>{finishingLabel(upload)}</LoadingRow> : <>
            {paused ? <button type="button" className="button secondary" onClick={() => controller.resume()}><Play aria-hidden="true" />Resume</button>
              : <button type="button" className="button secondary" disabled={!recording} onClick={() => controller.pause()}><Pause aria-hidden="true" />Pause</button>}
            <button type="button" className="button secondary" disabled={!recording && !paused} onClick={mark}><Bookmark aria-hidden="true" />Mark moment</button>
            <button type="button" className="button danger" onClick={() => setConfirming(true)}><CircleStop aria-hidden="true" />Stop</button>
          </>}
        </div>
      </section>

      {handheld ? <Alert tone="neutral" role="note">Keep this screen on and this page open. Locking the phone or switching apps may stop the recording.</Alert>
        : <Alert tone="neutral" role="note">Keep this tab open until you stop. Audio is saved on this device as you go.</Alert>}
      {lowBattery ? <Alert tone="warning">Battery is below 15%. Plug in to keep recording.</Alert> : null}
      {snapshot.storage === "memory" ? <Alert tone="warning">This browser can&apos;t keep audio on the device. Leave this page open until uploads show Saved.</Alert> : null}

      <InPersonCaptions captions={poll.session?.captions ?? []} problem={poll.error && active ? poll.error : null} />
    </div>

    <SettingsToast notice={notice} onDismiss={() => setNotice(null)} />
    <StopConfirm open={confirming} onCancel={() => setConfirming(false)} onConfirm={() => void finish(true)} />
  </>;
}

function StopConfirm({ open, onCancel, onConfirm }: { open: boolean; onCancel(): void; onConfirm(): void }) {
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog" role="alertdialog">
        <Dialog.Title className="dialog-title">Stop and create the transcript?</Dialog.Title>
        <Dialog.Description className="dialog-intro">Recording ends and the rest of the audio is uploaded. The transcript and speaker suggestions usually take a few minutes.</Dialog.Description>
        <div className="dialog-footer">
          <button type="button" className="button secondary" onClick={onCancel}>Keep recording</button>
          <button type="button" className="button danger" onClick={onConfirm}><CircleStop aria-hidden="true" />Stop and transcribe</button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
