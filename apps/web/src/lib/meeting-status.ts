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
