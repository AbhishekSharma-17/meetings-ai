import { meetingBadge } from "@/lib/meeting-status";
import type { Meeting } from "@/lib/types";

/** A meeting's status pill: its scheduled join before the call, capture status while the call runs,
 * minutes progress once it's over. */
export function MeetingBadge({ meeting }: { meeting: Pick<Meeting, "status" | "minutesStatus" | "schedule"> }) {
  const badge = meetingBadge(meeting);
  return <span className={`status ${badge.tone}`}>{badge.label}</span>;
}
