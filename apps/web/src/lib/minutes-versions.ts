import { api } from "./meetings-service";
import type { BackgroundJob, MinutesDraft, MomGuidance } from "./types";

export type MinutesVersionSummary = {
  id: string; meeting_id: string; label: string; creator_id: string; creator_name: string;
  template: string; status: "empty" | "draft" | "approved"; visibility: "private" | "workspace" | "specific";
  revision: number; is_mine: boolean; can_read: boolean; created_at: string; updated_at: string;
};
export type MinutesVersion = MinutesVersionSummary & {
  guidance: MomGuidance | null; content: MinutesDraft | null; user_ids: string[];
  source_is_current: boolean; provider: string | null; model: string | null;
};

const path = (id: string) => `/v1/minutes-versions/${id}`;
export const minutesVersions = {
  list: (meetingId: string) => api<MinutesVersionSummary[]>(`/v1/meetings/${meetingId}/minutes-versions`),
  inbox: () => api<MinutesVersionSummary[]>("/v1/me/minutes-versions"),
  create: (meetingId: string, label: string, guidance: MomGuidance, perspective = "standard") => api<MinutesVersion>(`/v1/meetings/${meetingId}/minutes-versions`, { method: "POST", body: JSON.stringify({ label, guidance, perspective }) }),
  get: (id: string) => api<MinutesVersion>(path(id)),
  save: (version: MinutesVersion, label: string, guidance: MomGuidance, content?: MinutesDraft | null, perspective = version.template) => api<MinutesVersion>(path(version.id), { method: "PATCH", body: JSON.stringify({ revision: version.revision, label, guidance, content, perspective }) }),
  generate: (version: MinutesVersion) => api<MinutesVersion>(`${path(version.id)}/generate`, { method: "POST", body: JSON.stringify({ revision: version.revision }) }),
  startJob: (version: MinutesVersion) => api<BackgroundJob>(`${path(version.id)}/jobs`, { method: "POST", body: JSON.stringify({ revision: version.revision }) }),
  approve: (version: MinutesVersion) => api<MinutesVersion>(`${path(version.id)}/approve`, { method: "POST", body: JSON.stringify({ revision: version.revision }) }),
  share: (version: MinutesVersion, visibility: MinutesVersion["visibility"], userIds: string[]) => api<MinutesVersion>(`${path(version.id)}/sharing`, { method: "POST", body: JSON.stringify({ revision: version.revision, visibility, user_ids: userIds }) }),
  remove: (version: MinutesVersion) => api<void>(`${path(version.id)}?revision=${version.revision}`, { method: "DELETE" }),
};
