import type { MeetingStatus } from "./types";

export type CaptureTiming = {
  joinedAt?: string | null;
  stoppedAt?: string | null;
  status: MeetingStatus;
};

/** Only an assistant that has actually joined can have a running capture clock. */
export function hasRunningCapture(timing: CaptureTiming): boolean {
  return Boolean(timing.joinedAt) && !timing.stoppedAt
    && ["live", "needs_attention", "stopping"].includes(timing.status);
}

/** Actual capture time, never the calendar slot, creation time or last UI refresh. */
export function meetingDuration(timing: CaptureTiming, now = Date.now()): string | null {
  if (!timing.joinedAt) return null;
  const start = Date.parse(timing.joinedAt);
  const end = timing.stoppedAt ? Date.parse(timing.stoppedAt) : hasRunningCapture(timing) ? now : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}
