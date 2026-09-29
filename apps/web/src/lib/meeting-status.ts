import type { Meeting, MeetingStatus } from "./types";

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

/**
 * The badge a meeting shows. Once the call is over, the minutes' progress is what matters, so a
 * finished meeting reads "Minutes approved" or "Recap sent" instead of staying "Ready to review".
 */
export function meetingBadge(meeting: Pick<Meeting, "status" | "minutesStatus">): { tone: string; label: string } {
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
