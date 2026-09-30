"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { isDemoActive } from "@/lib/demo-mode";
import type { StoredChunk, StoredSession } from "@/lib/in-person-chunk-store";
import { createRelay, RecordingController } from "@/lib/in-person-controller";
import { deviceKind, microphoneError, openMicrophone, recordingUnsupported } from "@/lib/in-person-media";
import { MediaRecorderEngine, SimulatedEngine, type RecorderEngine } from "@/lib/in-person-recorder";
import { inPersonService, statusOf } from "@/lib/in-person-service";
import type { InPersonSeed, InPersonSession } from "@/lib/in-person-types";
import { useMicrophoneCheck } from "./in-person-mic-check";
import { InPersonSetup, type SetupValues, type StartProblem } from "./in-person-setup";
import { InPersonRecording } from "./in-person-recording";
import { InPersonFinalizing } from "./in-person-finalizing";
import { InPersonBackgroundBanner } from "./in-person-background";

/** A recording left unfinished on this device (found after a reload). */
export type PendingRecording = { stored: StoredSession; session: InPersonSession; buffered: StoredChunk[] };

export type InPersonRequest =
  | { kind: "new"; seed: InPersonSeed }
  | { kind: "resume"; pending: PendingRecording; action: "finish" | "continue" };

type Phase = "setup" | "recording" | "finalizing";

function startProblem(cause: unknown): StartProblem {
  const status = statusOf(cause);
  const message = cause instanceof Error ? cause.message : "";
  if (status === 409) return { title: "Speech-to-text isn't set up", detail: message || "This workspace has no speech-to-text profile yet.", providers: true };
  if (status === 403) return { title: "You can't record in this workspace", detail: "Viewers can read meetings but not record them. Ask an admin to change your role." };
  if (status === 429) return { title: "Too many recordings started", detail: "Wait a minute, then try again." };
  return { title: "The recording could not start", detail: message || "Check your connection and try again." };
}

type RecorderProps = {
  identity: string;
  canOpenProviders: boolean;
  /** The person navigated elsewhere: keep recording, show a compact banner instead of the recorder page. */
  background: boolean;
  onReturn(): void;
  onClose(): void;
  /** The recording is done (or the person chose to leave while it is processed): open its meeting. */
  onFinished(meetingId: string): void;
  onOpenProviders(): void;
};

/**
 * The in-person recorder. Setup is a dialog over the current screen; recording and finalizing take over the
 * main area as a normal page (render this as a direct child of `main`).
 */
export function InPersonRecorder({ request, ...props }: RecorderProps & { request: InPersonRequest | null }) {
  if (!request) return null;
  return <Flow request={request} {...props} />;
}

function Flow({ request, identity, canOpenProviders, background, onReturn, onClose, onFinished, onOpenProviders }: RecorderProps & { request: InPersonRequest }) {
  const [demo] = useState(isDemoActive);
  const [laptop] = useState(() => deviceKind() === "laptop");
  const check = useMicrophoneCheck();
  const [phase, setPhase] = useState<Phase>(request.kind === "new" ? "setup" : "recording");
  const [session, setSession] = useState<InPersonSession | null>(request.kind === "resume" ? request.pending.session : null);
  const [controller, setController] = useState<RecordingController | null>(() => request.kind === "resume" ? resumeController(request.pending, identity, request.action) : null);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<StartProblem | null>(null);
  const mounted = useRef(true);
  const page = useRef<HTMLElement>(null);
  const backgroundRef = useRef(background);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { backgroundRef.current = background; }, [background]);

  // The recorder page replaces the screen underneath: start at the top and move focus onto it.
  const onPage = phase !== "setup" && !background;
  useEffect(() => {
    if (!onPage) return;
    window.scrollTo({ top: 0 });
    const timer = window.setTimeout(() => page.current?.focus({ preventScroll: true }), 0);
    return () => window.clearTimeout(timer);
  }, [onPage, phase]);

  useEffect(() => {
    if (!controller) return;
    controller.retain();
    return () => controller.release();
  }, [controller]);

  // Leaving the page mid-recording would stop the microphone; ask the browser to confirm first.
  useEffect(() => {
    if (phase !== "recording") return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };  // returnValue: older WebKit
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  const buildEngine = useCallback(async (handlers: ConstructorParameters<typeof SimulatedEngine>[0], fresh: boolean): Promise<RecorderEngine> => {
    if (demo) return new SimulatedEngine(handlers);
    const unsupported = recordingUnsupported();
    if (unsupported) throw Object.assign(new Error(unsupported), { name: "NotSupportedError" });
    const stream = (fresh ? check.take() : null) ?? await openMicrophone(check.deviceId || null);
    return new MediaRecorderEngine(stream, handlers);
  }, [check, demo]);

  async function start(values: SetupValues) {
    if (request.kind !== "new") return;
    setStarting(true); setProblem(null);
    const relay = createRelay();
    let engine: RecorderEngine;
    try { engine = await buildEngine(relay.handlers, true); }
    catch (cause) { if (mounted.current) { setProblem(microphoneError(cause)); setStarting(false); } return; }
    try {
      const created = await inPersonService.create({
        title: values.title, device: deviceKind(), mime_type: engine.mimeType, consent: { everyone_agreed: true, notice_shown: values.noticeShown },
        expected_people: values.expectedPeople, calendar_event: request.seed.calendarEvent,
      });
      // Closed while the meeting was being created: release the microphone and stop here.
      if (!mounted.current) { engine.dispose(); return; }
      const next = new RecordingController({ session: created, identity });
      relay.connect(next);
      next.begin(engine);
      setSession(created); setController(next); setPhase("recording");
    } catch (cause) {
      engine.dispose();
      if (mounted.current) setProblem(startProblem(cause));
    } finally { if (mounted.current) setStarting(false); }
  }

  const resumeEngine = useCallback(async (): Promise<string | null> => {
    if (!controller) return null;
    try { controller.begin(await buildEngine(controller, false)); return null; }
    catch (cause) { const { title, detail } = microphoneError(cause); return `${title}. ${detail}`; }
  }, [buildEngine, controller]);

  const stopped = useCallback((next: InPersonSession) => { setSession(next); setPhase("finalizing"); }, []);
  // Done while the person works elsewhere: don't pull them away; the notification says it's ready.
  const done = useCallback((meetingId: string) => { if (backgroundRef.current) onClose(); else onFinished(meetingId); }, [onClose, onFinished]);

  return <>
    {request.kind === "new" ? <Dialog.Root open={phase === "setup"} onOpenChange={(open) => { if (!open && !starting) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog lg ip-setup" finalFocus={() => page.current ?? true}>
          <InPersonSetup seed={request.seed} check={check} demo={demo} laptop={laptop} starting={starting} problem={problem}
            canOpenProviders={canOpenProviders} onStart={(values) => void start(values)} onCancel={onClose} onOpenProviders={onOpenProviders} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root> : null}
    {phase !== "setup" && session ? <section ref={page} tabIndex={-1} hidden={background} className="page narrow ip-recorder" aria-labelledby="ip-recorder-title" data-phase={phase}>
      {phase === "recording" && controller ? <InPersonRecording controller={controller} session={session} onStopped={stopped} onResumeEngine={resumeEngine} /> : null}
      {phase === "finalizing" ? <InPersonFinalizing session={session} onDone={done} onLeave={onFinished} /> : null}
    </section> : null}
    {background && phase !== "setup" && session ? <InPersonBackgroundBanner session={session} controller={phase === "recording" ? controller : null} onReturn={onReturn} /> : null}
  </>;
}

function resumeController(pending: PendingRecording, identity: string, action: "finish" | "continue"): RecordingController {
  const lastLocal = pending.buffered.at(-1)?.seq ?? -1;
  const nextSeq = Math.max(pending.stored.nextSeq, pending.session.last_seq + 1, lastLocal + 1);
  const bufferedMs = pending.buffered.filter((chunk) => chunk.seq > pending.session.last_seq).reduce((sum, chunk) => sum + chunk.durationMs, 0);
  const controller = new RecordingController({ session: pending.session, identity, nextSeq, buffered: pending.buffered, initialElapsedMs: pending.session.duration_ms + bufferedMs });
  // "Keep recording" waits for a tap on Resume: browsers want a gesture before the microphone starts.
  if (action === "continue") controller.onEnded(RELOAD_NOTE);
  return controller;
}

const RELOAD_NOTE = "Recording paused when the page was reloaded. Resume to keep recording (the microphone starts again), or stop to create the transcript.";
