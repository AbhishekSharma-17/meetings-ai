"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Bookmark, CircleStop, CloudOff, Pause, Play, RefreshCw, RotateCw } from "lucide-react";
import type { RecordingController, RecorderSnapshot } from "@/lib/in-person-controller";
import { isHandheld, watchLowBattery } from "@/lib/in-person-media";
import type { InPersonSession } from "@/lib/in-person-types";
import { Alert } from "./ui/feedback";
import { InPersonLevel } from "./in-person-level";
import { InPersonCaptions } from "./in-person-captions";
import { formatClock, useLevel, useRecorderSnapshot, useSessionPoll, useTicker } from "./use-in-person";

const CAPTION_POLL_MS = 5_000;
const TIMER_TICK_MS = 500;
const TOAST_MS = 4_000;

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
  const [toast, setToast] = useState<string | null>(null);
  const [lowBattery, setLowBattery] = useState(false);
  const [resumeProblem, setResumeProblem] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [handheld] = useState(isHandheld);
  const stopping = useRef(false);
  useTicker(TIMER_TICK_MS, recording);

  useEffect(() => watchLowBattery(setLowBattery), []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

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
    setToast(`Moment marked at ${formatClock(moment.atMs)}`);
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
  const barLabel = finishing ? "Finishing" : paused ? "Paused" : snapshot.phase === "interrupted" ? "Stopped" : "Recording";
  return <div className="ip-screen ip-recording" data-phase={snapshot.phase}>
    <div className="ip-live-bar" data-state={recording ? "live" : "held"}>
      <span className="ip-live-dot" aria-hidden="true" />
      <Dialog.Title className="ip-live-title">{barLabel}</Dialog.Title>
      <span className="ip-live-meeting">{session.title}</span>
    </div>

    <div className="ip-recording-body">
      <section className="ip-meter-block" aria-label="Recording time and level">
        <p className="ip-timer tabular" aria-live="off">{formatClock(controller.elapsedMs())}</p>
        <InPersonLevel level={level} paused={!recording} label="Input level" />
        <p className="ip-upload" data-state={upload.state}>
          {upload.state === "offline" ? <CloudOff aria-hidden="true" /> : upload.state === "retrying" ? <RotateCw aria-hidden="true" /> : null}
          <span role="status" data-testid="upload-status">{uploadLabel(upload)}</span>
        </p>
        {detail ? <p className="field-hint ip-upload-detail">{detail}</p> : null}
        {upload.state === "error" || upload.state === "retrying" ? <button type="button" className="button secondary sm" onClick={() => controller.retryUploads()}><RefreshCw aria-hidden="true" /> Try again now</button> : null}
      </section>

      <div className="ip-notes">
        {snapshot.phase === "interrupted" ? <Alert tone="warning" title="Recording stopped" actions={<>
          <button type="button" className="button primary" disabled={resuming} onClick={() => void resumeEngine()}><Play aria-hidden="true" />{resuming ? "Starting…" : "Resume recording"}</button>
          <button type="button" className="button secondary" onClick={() => setConfirming(true)}>Stop and transcribe</button>
        </>}>{snapshot.interruption} Everything recorded so far is safe.{resumeProblem ? ` ${resumeProblem}` : ""}</Alert> : null}
        {snapshot.stopError ? <Alert tone="danger" title="The recording has not finished yet" actions={<button type="button" className="button secondary" onClick={() => void finish(false)}>Try again</button>}>{snapshot.stopError}</Alert> : null}
        {handheld ? <Alert tone="neutral" role="note">Keep this screen on and this page open. Locking the phone or switching apps may stop the recording.</Alert>
          : <Alert tone="neutral" role="note">Keep this tab open until you stop. Audio is saved on this device as you go.</Alert>}
        {lowBattery ? <Alert tone="warning">Battery is below 15%. Plug in to keep recording.</Alert> : null}
        {snapshot.storage === "memory" ? <Alert tone="warning">This browser can&apos;t keep audio on the device. Leave this page open until uploads show Saved.</Alert> : null}
        {poll.error && active ? <p className="field-hint">Live preview paused: {poll.error}</p> : null}
      </div>

      {snapshot.moments.length ? <section className="ip-moments" aria-label="Marked moments">
        <h3>Moments</h3>
        <ul>{snapshot.moments.map((moment, index) => <li key={`${moment.atMs}-${index}`}><Bookmark aria-hidden="true" /><span className="tabular">{formatClock(moment.atMs)}</span>{moment.saved ? null : <small>Saving…</small>}</li>)}</ul>
      </section> : null}

      <InPersonCaptions captions={poll.session?.captions ?? []} />
    </div>

    {toast ? <p className="ip-toast" role="status">{toast}</p> : null}
    <footer className="ip-controls">
      {finishing ? <p className="ip-finishing" role="status"><span className="spinner" aria-hidden="true" />{upload.state === "offline" ? "Waiting for a connection to upload the rest…" : upload.pending ? `Uploading the last ${upload.pending === 1 ? "piece" : `${upload.pending} pieces`}…` : "Finishing…"}</p> : <>
        {paused ? <button type="button" className="button secondary" onClick={() => controller.resume()}><Play aria-hidden="true" />Resume</button>
          : <button type="button" className="button secondary" disabled={!recording} onClick={() => controller.pause()}><Pause aria-hidden="true" />Pause</button>}
        <button type="button" className="button secondary" disabled={!recording && !paused} onClick={mark}><Bookmark aria-hidden="true" />Mark moment</button>
        <button type="button" className="button danger" onClick={() => setConfirming(true)}><CircleStop aria-hidden="true" />Stop</button>
      </>}
    </footer>
    <StopConfirm open={confirming} onCancel={() => setConfirming(false)} onConfirm={() => void finish(true)} />
  </div>;
}

function StopConfirm({ open, onCancel, onConfirm }: { open: boolean; onCancel(): void; onConfirm(): void }) {
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop ip-confirm-backdrop" />
      <Dialog.Popup className="dialog ip-confirm" role="alertdialog">
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
