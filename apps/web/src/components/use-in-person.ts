"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { RecordingController } from "@/lib/in-person-controller";
import { inPersonService } from "@/lib/in-person-service";
import type { InPersonSession } from "@/lib/in-person-types";

const LEVEL_SAMPLE_MS = 100;

export function useRecorderSnapshot(controller: RecordingController) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

/** Re-renders every `ms` while enabled (for timers). */
export function useTicker(ms: number, enabled: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), ms);
    return () => window.clearInterval(timer);
  }, [ms, enabled]);
}

/** Samples an input level (0–1) about ten times a second. */
export function useLevel(read: () => number, enabled: boolean): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!enabled) { queueMicrotask(() => setLevel(0)); return; }
    const timer = window.setInterval(() => setLevel(read()), LEVEL_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, [read, enabled]);
  return level;
}

/** Polls the recording session (captions while recording, progress while finalizing). */
export function useSessionPoll(meetingId: string, intervalMs: number, enabled: boolean, initial: InPersonSession | null) {
  const [session, setSession] = useState<InPersonSession | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const next = await inPersonService.get(meetingId);
        if (!active) return;
        setSession(next); setError(null);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not check the recording.");
      }
      if (active) timer = window.setTimeout(() => void load(), intervalMs);
    };
    timer = window.setTimeout(() => void load(), nonce ? 0 : Math.min(intervalMs, 1_000));
    return () => { active = false; window.clearTimeout(timer); };
  }, [meetingId, intervalMs, enabled, nonce]);
  return { session, setSession, error, reload: () => setNonce((value) => value + 1) };
}

/** "4:07" or "1:02:45". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}
