"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { jobService } from "@/lib/meetings-service";
import type { BackgroundJob } from "@/lib/types";

const POLL_MS = 1_500;
const ACTIVE = new Set<BackgroundJob["status"]>(["queued", "running"]);
/** Window event: a background job started or finished, so the notification feed should look sooner. */
export const JOB_ACTIVITY_EVENT = "meetings-ai-job-activity";

function announceActivity(job: BackgroundJob): void {
  window.dispatchEvent(new CustomEvent(JOB_ACTIVITY_EVENT, { detail: { id: job.id, status: job.status } }));
}

export const isJobActive = (job: BackgroundJob | null | undefined): job is BackgroundJob => Boolean(job && ACTIVE.has(job.status));

type Callbacks = {
  /** An active job for this subject was found when the screen opened (the user came back). */
  onResume?(job: BackgroundJob): void;
  /** The tracked job finished: succeeded, failed or cancelled. Called once per job. */
  onFinish(job: BackgroundJob): void;
};

/**
 * Follows one server-side background job for a subject (a calendar event, a meeting…).
 * The job keeps running when the screen unmounts; on the next mount it is found again and
 * followed until it finishes. Polling pauses while the browser tab is hidden.
 */
export function useBackgroundJob(kind: string, subjectId: string, callbacks: Callbacks) {
  const [job, setJob] = useState<BackgroundJob | null>(null);
  const latest = useRef(callbacks);
  const finished = useRef<Set<string>>(new Set());
  useEffect(() => { latest.current = callbacks; });

  const settle = useCallback((next: BackgroundJob) => {
    setJob(next);
    if (!ACTIVE.has(next.status) && !finished.current.has(next.id)) {
      finished.current.add(next.id);
      latest.current.onFinish(next);
      announceActivity(next);
    }
  }, []);

  useEffect(() => {
    let current = true;
    // An older API without job endpoints answers 404; there is simply nothing to resume.
    void jobService.active(kind, subjectId).then((found) => {
      if (!current || !found) return;
      setJob(found);
      latest.current.onResume?.(found);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [kind, subjectId]);

  const activeId = isJobActive(job) ? job.id : null;
  useEffect(() => {
    if (!activeId) return;
    let current = true;
    const poll = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void jobService.get(activeId).then((next) => { if (current) settle(next); }).catch(() => undefined);
    };
    const timer = window.setInterval(poll, POLL_MS);
    const onVisible = () => { if (!document.hidden) poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { current = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [activeId, settle]);

  /** Follow a job just started (or returned as already running) by the server. */
  const track = useCallback((next: BackgroundJob) => { settle(next); announceActivity(next); }, [settle]);
  const cancel = useCallback(async () => {
    if (activeId) settle(await jobService.cancel(activeId));
  }, [activeId, settle]);

  return { job, running: isJobActive(job), track, cancel };
}
