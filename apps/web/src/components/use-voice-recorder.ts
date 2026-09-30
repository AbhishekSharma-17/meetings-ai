"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LevelMeter, microphoneError, openMicrophone, pickMimeType, recordingUnsupported, stopStream } from "@/lib/in-person-media";
import { isDemoActive } from "@/lib/demo-mode";
import { useLevel } from "./use-in-person";

export const SAMPLE_MIN_MS = 5_000;
export const SAMPLE_MAX_MS = 10_000;
const TICK_MS = 100;
const SLICE_MS = 1_000;
const DEMO_RATE = 8_000;

export type RecorderPhase = "idle" | "requesting" | "recording" | "recorded" | "error";
export type RecordedSample = { blob: Blob; durationMs: number; url: string };
export type RecorderProblem = { title: string; detail: string };

/** Demo mode never touches the microphone: a quiet WAV of the recorded length stands in for speech. */
function demoWav(durationMs: number): Blob {
  const samples = Math.round((DEMO_RATE * durationMs) / 1000);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, DEMO_RATE, true); view.setUint32(28, DEMO_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples * 2, true);
  return new Blob([buffer], { type: "audio/wav" });
}

function demoLevel(): number {
  const t = Date.now() / 1000;
  return Math.max(0.04, Math.min(0.95, 0.4 + 0.2 * Math.sin(t * 2.3) + 0.1 * Math.sin(t * 6.1 + 1.3)));
}

/**
 * Records one short voice sample (5–10 s) with the same microphone utilities as in-person recording.
 * Stops on its own at 10 s; the result stays in the browser until the caller saves it.
 */
export function useVoiceRecorder() {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [sample, setSample] = useState<RecordedSample | null>(null);
  const [problem, setProblem] = useState<RecorderProblem | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const meter = useRef<LevelMeter | null>(null);
  const pieces = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const ticker = useRef<number | undefined>(undefined);
  const demo = useRef(false);
  const attempt = useRef(0);

  const release = useCallback(() => {
    window.clearInterval(ticker.current); ticker.current = undefined;
    meter.current?.close(); meter.current = null;
    stopStream(stream.current); stream.current = null;
  }, []);

  // The object URL of a replaced sample is revoked by the effect below.
  const clearSample = useCallback(() => setSample(null), []);

  const finish = useCallback((blob: Blob, durationMs: number) => {
    release();
    recorder.current = null;
    if (durationMs < SAMPLE_MIN_MS || blob.size === 0) {
      setProblem({ title: "That was too short", detail: "Keep talking for at least 5 seconds, then stop." });
      setPhase("error");
      return;
    }
    setSample({ blob, durationMs, url: URL.createObjectURL(blob) });
    setPhase("recorded");
  }, [release]);

  const stop = useCallback(() => {
    const durationMs = Math.min(SAMPLE_MAX_MS, Date.now() - startedAt.current);
    if (demo.current) { finish(demoWav(durationMs), durationMs); return; }
    const active = recorder.current;
    if (!active || active.state === "inactive") return;
    const mine = attempt.current; // a Cancel before the async "stop" event lands must win
    active.addEventListener("stop", () => {
      if (mine === attempt.current) finish(new Blob(pieces.current, { type: active.mimeType || "audio/webm" }), durationMs);
    }, { once: true });
    active.stop();
  }, [finish]);

  const tick = useCallback(() => {
    const elapsed = Date.now() - startedAt.current;
    setElapsedMs(Math.min(elapsed, SAMPLE_MAX_MS));
    if (elapsed >= SAMPLE_MAX_MS) stop();
  }, [stop]);

  const begin = useCallback(() => {
    startedAt.current = Date.now();
    setElapsedMs(0);
    setPhase("recording");
    ticker.current = window.setInterval(tick, TICK_MS);
  }, [tick]);

  const start = useCallback(async () => {
    clearSample(); setProblem(null); pieces.current = [];
    const mine = ++attempt.current;
    demo.current = isDemoActive();
    if (demo.current) { begin(); return; }
    const unsupported = recordingUnsupported();
    if (unsupported) { setProblem({ title: "Recording is not available here", detail: unsupported }); setPhase("error"); return; }
    setPhase("requesting");
    try {
      const opened = await openMicrophone();
      if (mine !== attempt.current) { stopStream(opened); return; }
      const mimeType = pickMimeType();
      const next = new MediaRecorder(opened, mimeType ? { mimeType } : undefined);
      next.addEventListener("dataavailable", (event: BlobEvent) => { if (event.data?.size) pieces.current.push(event.data); });
      stream.current = opened; recorder.current = next; meter.current = new LevelMeter(opened);
      next.start(SLICE_MS);
      begin();
    } catch (cause) {
      release();
      setProblem(microphoneError(cause));
      setPhase("error");
    }
  }, [begin, clearSample, release]);

  /** Throw away whatever is being or was recorded and go back to the start. */
  const reset = useCallback(() => {
    attempt.current += 1;
    const active = recorder.current;
    recorder.current = null;
    if (active && active.state !== "inactive") { try { active.stop(); } catch { /* already stopped */ } }
    release(); clearSample(); setProblem(null); setElapsedMs(0); setPhase("idle");
  }, [clearSample, release]);

  useEffect(() => () => {
    attempt.current += 1;
    const active = recorder.current;
    if (active && active.state !== "inactive") { try { active.stop(); } catch { /* already stopped */ } }
    window.clearInterval(ticker.current);
    meter.current?.close();
    stopStream(stream.current);
  }, []);
  useEffect(() => () => { if (sample) URL.revokeObjectURL(sample.url); }, [sample]);

  const readLevel = useCallback(() => demo.current ? demoLevel() : meter.current?.read() ?? 0, []);
  const level = useLevel(readLevel, phase === "recording");
  return { phase, elapsedMs, sample, problem, level, start, stop, reset };
}
