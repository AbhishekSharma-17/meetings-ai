"use client";

import { useEffect, useState } from "react";
import { hasRunningCapture, meetingDuration } from "@/lib/meeting-duration";
import type { Meeting } from "@/lib/types";

/** Advance live durations locally; finished records stay frozen without extra API calls. */
export function useMeetingDuration(meeting: Meeting): string {
  const [now, setNow] = useState(() => Date.now());
  const running = hasRunningCapture(meeting);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [running]);
  return meetingDuration(meeting, now) ?? meeting.duration;
}
