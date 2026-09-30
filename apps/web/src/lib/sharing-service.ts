import { api } from "./meetings-service";
import type { EmailDelivery, MeetingMinutes } from "./types";

/**
 * Sharing a meeting's transcript and approved minutes with workspace members, emailing the sent
 * recap again, and the history of both. Owners and admins share, revoke and resend; a member a
 * meeting is shared with reads it (shared view, Shared with me).
 */
export type PersonRef = { user_id: string; display_name: string; email?: string | null };

export type MeetingShare = {
  id: string;
  person: PersonRef;
  shared_by: PersonRef | null;
  note: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_by: PersonRef | null;
};

export type RecapDelivery = {
  id: string;
  kind: "recap" | "resend";
  recipients: string[];
  status: string;
  error: string | null;
  sent_by: PersonRef | null;
  /** null for emails sent before senders were recorded. */
  include_transcript: boolean | null;
  created_at: string;
};

export type MeetingSharing = { shares: MeetingShare[]; deliveries: RecapDelivery[] };

export type SharedMeetingView = { shared_by: PersonRef | null; shared_at: string; note: string | null; minutes: MeetingMinutes | null };

export type SharedWithMeItem = {
  meeting_id: string; title: string; platform: string; status: string; meeting_at: string;
  shared_by: PersonRef | null; shared_at: string; note: string | null;
};

export const sharingService = {
  history(meetingId: string): Promise<MeetingSharing> {
    return api<MeetingSharing>(`/v1/meetings/${meetingId}/sharing`);
  },
  share(meetingId: string, userIds: string[], note: string): Promise<MeetingSharing> {
    return api<MeetingSharing>(`/v1/meetings/${meetingId}/shares`, {
      method: "POST", body: JSON.stringify({ user_ids: userIds, note: note.trim() || null }),
    });
  },
  revoke(meetingId: string, shareId: string): Promise<MeetingSharing> {
    return api<MeetingSharing>(`/v1/meetings/${meetingId}/shares/${shareId}`, { method: "DELETE" });
  },
  resend(meetingId: string, recipients: string[], includeTranscript: boolean): Promise<EmailDelivery> {
    return api<EmailDelivery>(`/v1/meetings/${meetingId}/minutes/resend`, {
      method: "POST", body: JSON.stringify({ recipients, include_transcript: includeTranscript }),
    });
  },
  /** The share for the signed-in member, or null when the meeting isn't shared with them. */
  async sharedView(meetingId: string): Promise<SharedMeetingView | null> {
    try { return await api<SharedMeetingView>(`/v1/meetings/${meetingId}/shared-view`); }
    catch (cause) { if ((cause as { status?: number }).status === 404) return null; throw cause; }
  },
  sharedWithMe(): Promise<SharedWithMeItem[]> {
    return api<SharedWithMeItem[]>("/v1/me/shared-meetings");
  },
};

/** Active shares first; revoked ones stay in the history. */
export function activeShares(sharing: MeetingSharing | null): MeetingShare[] {
  return sharing?.shares.filter((share) => !share.revoked_at) ?? [];
}
