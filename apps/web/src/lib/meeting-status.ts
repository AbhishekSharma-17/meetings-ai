import type { Meeting, MeetingSchedule, MeetingStatus } from "./types";

/** One vocabulary for meeting status everywhere: dashboard, library and detail. */
export const meetingStatusLabel: Record<MeetingStatus, string> = {
  created: "Created",
  joining: "Joining",
  waiting_room: "In lobby",
  live: "Live",
  needs_attention: "Needs attention",
  stopping: "Stopping",
  processing: "Processing",
  ready: "Ready to review",
  stopped: "Stopped",
  failed: "Needs attention",
};

export type ScheduleState = "scheduled" | "moved" | "waiting" | "cancelled" | "missed" | "join_failed";

/** The API's note while a join waits for a free assistant (every one is in another call). */
export const WAITING_FOR_ASSISTANT = "Waiting for a free assistant";

/**
 * What a meeting that hasn't run yet is waiting for, from its scheduled join: null once the
 * assistant has joined (or for a meeting sent straight to a call).
 */
export function scheduleState(meeting: { status: Meeting["status"]; schedule?: Pick<MeetingSchedule, "status" | "rescheduledFrom" | "note"> | null }): ScheduleState | null {
  const schedule = meeting.schedule;
  if (!schedule || meeting.status !== "created") return null;
  if (schedule.status === "pending") {
    if (schedule.note?.startsWith(WAITING_FOR_ASSISTANT)) return "waiting";
    return schedule.rescheduledFrom ? "moved" : "scheduled";
  }
  if (schedule.status === "cancelled") return "cancelled";
  if (schedule.status === "missed") return "missed";
  if (schedule.status === "failed") return "join_failed";
  return null;
}

const scheduleBadges: Record<ScheduleState, { tone: string; label: string }> = {
  scheduled: { tone: "scheduled", label: "Scheduled" },
  moved: { tone: "scheduled", label: "Rescheduled" },
  waiting: { tone: "missed", label: "Waiting for assistant" },
  cancelled: { tone: "cancelled", label: "Cancelled" },
  missed: { tone: "missed", label: "Missed" },
  join_failed: { tone: "failed", label: "Couldn't join" },
};

/** The meeting didn't happen and won't: cancelled in the calendar (or here), or its time passed. */
export function didNotHappen(meeting: Parameters<typeof scheduleState>[0]): boolean {
  const state = scheduleState(meeting);
  return state === "cancelled" || state === "missed";
}

/**
 * The badge a meeting shows. Before the call, its scheduled join ("Scheduled", "Cancelled"…);
 * once the call is over, the minutes' progress, so a finished meeting reads "Minutes approved"
 * or "Recap sent" instead of staying "Ready to review".
 */
export function meetingBadge(meeting: Pick<Meeting, "status" | "minutesStatus" | "schedule">): { tone: string; label: string } {
  const state = scheduleState(meeting);
  if (state) return scheduleBadges[state];
  if (isReviewed(meeting)) {
    return meeting.minutesStatus === "sent" ? { tone: "sent", label: "Recap sent" } : { tone: "approved", label: "Minutes approved" };
  }
  return { tone: meeting.status, label: meetingStatusLabel[meeting.status] };
}

/** The call is over and its minutes were approved or sent: nothing is left to review. */
export function isReviewed(meeting: Pick<Meeting, "status" | "minutesStatus">): boolean {
  return (meeting.status === "ready" || meeting.status === "stopped")
    && (meeting.minutesStatus === "approved" || meeting.minutesStatus === "sent");
}

/** Captured and processed, with minutes still to draft or review. */
export function needsReview(meeting: Pick<Meeting, "status" | "minutesStatus">): boolean {
  return meeting.status === "ready" && !isReviewed(meeting);
}

export const inProgressStatuses: ReadonlySet<MeetingStatus> = new Set(["joining", "waiting_room", "live", "stopping", "processing"]);
export const attentionStatuses: ReadonlySet<MeetingStatus> = new Set(["failed", "needs_attention"]);

/** Short platform monogram used in list rows; avoids per-meeting colour. */
export function platformMonogram(platform: Meeting["platform"] | string): string {
  if (platform === "In person" || platform === "in_person") return "IP";
  if (/zoom/i.test(platform)) return "Zm";
  if (/teams/i.test(platform)) return "Tm";
  if (/jitsi/i.test(platform)) return "Ji";
  return "Gm";
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "U";
  return (parts.length === 1 ? parts[0].slice(0, 1) : `${parts[0][0]}${parts[parts.length - 1][0]}`).toUpperCase();
}
