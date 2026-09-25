import type { AuditEvent, Capability, ConnectionState, CreateMeetingInput, CurrentAccount, EmailDelivery, InviteResult, KnowledgeBase, KnowledgeChatResponse, KnowledgeConversation, KnowledgeIndexStatus, KnowledgeMap, KnowledgeSearchResponse, KnowledgeWikiOverview, Meeting, MeetingDeliverySettings, MeetingDetail, MeetingMinutes, MeetingParticipants, MeetingStatus, MinutesDraft, PostMeetingJob, ProfileKind, ProviderProfile, ResendStatus, RetentionPolicy, SpeakerIdentity, TranscriptSegment, TranscriptionRoute, Workspace, WorkspaceMember, WorkspaceOperations, WorkspaceOption } from "./types";

export interface MeetingsService {
  getSession(): Promise<boolean>;
  getCurrentAccount(): Promise<CurrentAccount>;
  updateProfile(displayName: string): Promise<CurrentAccount>;
  login(email: string, password: string): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  inviteMember(email: string, displayName: string, role: "admin" | "member" | "viewer"): Promise<InviteResult>;
  resetMemberPassword(userId: string): Promise<InviteResult>;
  changeMemberRole(userId: string, role: CurrentAccount["role"]): Promise<CurrentAccount>;
  removeMember(userId: string): Promise<void>;
  logout(): Promise<void>;
  getWorkspace(): Promise<Workspace>;
  listWorkspaces(): Promise<WorkspaceOption[]>;
  createWorkspace(displayName: string): Promise<CurrentAccount>;
  switchWorkspace(id: string): Promise<CurrentAccount>;
  updateWorkspace(patch: { display_name: string; contact_email: string | null }): Promise<Workspace>;
  listWorkspaceMembers(): Promise<WorkspaceMember[]>;
  listWorkspaceAudit(): Promise<AuditEvent[]>;
  getWorkspaceOperations(): Promise<WorkspaceOperations>;
  getRetentionPolicy(): Promise<RetentionPolicy>;
  saveRetentionPolicy(policy: RetentionPolicy): Promise<RetentionPolicy>;
  listKnowledgeBases(): Promise<KnowledgeBase[]>;
  getKnowledgeOverview(baseId: string): Promise<KnowledgeWikiOverview>;
  getKnowledgeMap(baseId: string): Promise<KnowledgeMap>;
  getKnowledgeIndex(baseId: string): Promise<KnowledgeIndexStatus>;
  reindexKnowledge(baseId: string): Promise<KnowledgeIndexStatus>;
  createKnowledgeBase(name: string, description?: string): Promise<KnowledgeBase>;
  deleteKnowledgeBase(id: string): Promise<void>;
  updateKnowledgeBase(id: string, patch: { name?: string; description?: string | null; text_profile_id?: string | null }): Promise<KnowledgeBase>;
  shareKnowledgeBase(id: string, visibility: "private" | "organization" | "specific", userIds: string[]): Promise<KnowledgeBase>;
  listKnowledgeConversations(baseId: string): Promise<KnowledgeConversation[]>;
  getKnowledgeConversation(baseId: string, conversationId: string): Promise<KnowledgeConversation>;
  deleteKnowledgeConversation(baseId: string, conversationId: string): Promise<void>;
  searchKnowledge(query: string, tags: string[], knowledgeBaseId?: string | null): Promise<KnowledgeSearchResponse>;
  chatKnowledge(query: string, tags: string[], knowledgeBaseId?: string | null, conversationId?: string | null): Promise<KnowledgeChatResponse>;
  listMeetings(): Promise<Meeting[]>;
  createMeeting(input: CreateMeetingInput): Promise<MeetingDetail>;
  getMeeting(id: string): Promise<MeetingDetail>;
  deleteMeeting(id: string): Promise<void>;
  updateMeetingKnowledge(id: string, tags: string[], knowledgeEnabled: boolean, knowledgeBaseId?: string | null): Promise<MeetingDetail>;
  getTranscriptionRoute(id: string): Promise<TranscriptionRoute>;
  joinMeeting(id: string): Promise<MeetingDetail>;
  stopMeeting(id: string): Promise<MeetingDetail>;
  refreshMeeting(id: string): Promise<MeetingDetail>;
  getTranscript(id: string): Promise<TranscriptSegment[]>;
  exportTranscript(id: string): Promise<string>;
  getParticipants(id: string): Promise<MeetingParticipants>;
  getSpeakerIdentities(id: string): Promise<SpeakerIdentity[]>;
  saveSpeakerIdentity(id: string, speaker: string, email: string | null): Promise<SpeakerIdentity[]>;
  correctSpeaker(id: string, segmentId: string, displayName: string | null, applyToRawLabel: boolean): Promise<TranscriptSegment[]>;
  getMinutes(id: string): Promise<MeetingMinutes | null>;
  deleteMinutes(id: string): Promise<void>;
  generateMinutes(id: string): Promise<MeetingMinutes>;
  saveMinutes(id: string, draft: MinutesDraft): Promise<MeetingMinutes>;
  approveMinutes(id: string): Promise<MeetingMinutes>;
  sendMinutes(id: string, recipients: string[], includeTranscript: boolean): Promise<EmailDelivery>;
  getDeliverySettings(id: string): Promise<MeetingDeliverySettings>;
  getPostMeetingJob(id: string): Promise<PostMeetingJob>;
  retryPostMeetingJob(id: string): Promise<PostMeetingJob>;
  saveDeliverySettings(id: string, settings: MeetingDeliverySettings): Promise<MeetingDeliverySettings>;
  sendConfiguredMinutes(id: string): Promise<EmailDelivery>;
  getResendStatus(): Promise<ResendStatus>;
  listProviderProfiles(): Promise<ProviderProfile[]>;
  saveProviderProfile(profile: ProviderProfile, apiKey?: string): Promise<ProviderProfile>;
  deleteProviderProfile(id: string): Promise<void>;
  testProviderConnection(profile: ProviderProfile): Promise<ProviderProfile>;
}

type BackendProviderType = "openai" | "openai_compatible" | "vexa_native";
type BackendProfile = {
  id: string;
  name: string;
  provider_type: BackendProviderType;
  execution_location: "local" | "cloud";
  base_url: string | null;
  capabilities: Array<{ capability: Capability; model: string }>;
  credential_configured: boolean;
  credential_hint?: string | null;
};
type BackendDefault = {
  capability: Capability;
  ordered_profile_ids: string[];
};

type BackendMeeting = {
  id: string;
  title?: string | null;
  meeting_url?: string | null;
  url?: string | null;
  platform?: string | null;
  status?: string | null;
  bot_name?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  joined_at?: string | null;
  stopped_at?: string | null;
  duration?: string | null;
  participant_count?: number | null;
  participants?: number | null;
  error_message?: string | null;
  tags?: string[];
  knowledge_enabled?: boolean;
  knowledge_base_id?: string | null;
  last_error?: string | null;
  detail?: string | null;
};

type BackendTranscriptSegment = {
  id?: string;
  segment_id?: string | null;
  speaker?: string | null;
  raw_speaker?: string | null;
  speaker_reviewed?: boolean;
  attribution_source?: string | null;
  speaker_name?: string | null;
  text?: string | null;
  content?: string | null;
  started_at?: string | null;
  start_time?: string | number | null;
  ended_at?: string | null;
  end_time?: string | number | null;
  start_seconds?: number | null;
  end_seconds?: number | null;
  is_final?: boolean | null;
  completed?: boolean | null;
};

// Same-origin by default so browser-port forwarding and deployed custom domains
// work without exposing the private API container address to the browser.
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

function kindFor(capability: Capability): ProfileKind {
  if (capability === "transcription") return "transcription";
  if (capability === "embeddings") return "embedding";
  return "mom";
}

function providerLabel(providerType: BackendProviderType): string {
  if (providerType === "openai") return "OpenAI";
  if (providerType === "vexa_native") return "Vexa native / self-hosted";
  return "OpenAI-compatible";
}

function providerType(label: string): BackendProviderType {
  if (label === "OpenAI") return "openai";
  if (label === "Vexa native / self-hosted") return "vexa_native";
  return "openai_compatible";
}

function toFrontend(profile: BackendProfile, defaults: BackendDefault[]): ProviderProfile {
  const configured = profile.capabilities[0];
  const capability = configured?.capability ?? "text_generation";
  const connectionConfigured = profile.provider_type === "openai"
    ? profile.credential_configured
    : profile.provider_type === "vexa_native"
      ? Boolean(profile.base_url)
      : Boolean(profile.base_url) && (profile.execution_location === "local" || profile.credential_configured);
  return {
    id: profile.id,
    kind: kindFor(capability),
    label: profile.name,
    provider: profile.provider_type === "openai_compatible" && profile.base_url?.replace(/\/$/, "") === "https://openrouter.ai/api/v1" ? "OpenRouter" : providerLabel(profile.provider_type),
    executionLocation: profile.execution_location,
    endpoint: profile.base_url ?? "",
    model: configured?.model ?? "",
    capabilities: profile.capabilities.map((item) => item.capability),
    connectionState: connectionConfigured ? "configured" : "not_configured",
    isDefault: defaults.some((item) => item.capability === capability && item.ordered_profile_ids[0] === profile.id),
    apiKeyConfigured: profile.credential_configured,
    credentialHint: profile.credential_hint ?? null,
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/v1/auth/")) {
      window.dispatchEvent(new Event("meetings-ai-session-expired"));
    }
    const payload = await response.json().catch(() => null) as { detail?: string } | null;
    throw new ApiError(payload?.detail ?? `API request failed (${response.status})`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function platformFrom(value: string | null | undefined, url: string): Meeting["platform"] {
  const source = `${value ?? ""} ${url}`.toLowerCase();
  if (source.includes("zoom")) return "Zoom";
  if (source.includes("teams") || source.includes("microsoft")) return "Microsoft Teams";
  return "Google Meet";
}

function meetingStatus(value: string | null | undefined): MeetingStatus {
  const status = (value ?? "created").toLowerCase();
  if (status === "joined" || status === "recording" || status === "live" || status === "active") return "live";
  if (status === "waiting_room" || status === "waiting-room" || status === "lobby" || status === "awaiting_admission") return "waiting_room";
  if (status === "needs_help" || status === "needs_human_help") return "needs_attention";
  if (status === "completed" || status === "ready") return "ready";
  if (status === "stopped" || status === "cancelled") return "stopped";
  if (status === "stopping") return "stopping";
  if (status === "failed" || status === "error") return "failed";
  if (status === "processing") return "processing";
  if (status === "joining" || status === "queued" || status === "requested") return "joining";
  return "created";
}

function timestamp(value: string | number | null | undefined): string | number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  return value;
}

function relativeTimestamp(value: string | null): string {
  if (!value) return "Not yet";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(parsed);
}

function toMeetingDetail(meeting: BackendMeeting): MeetingDetail {
  const meetingUrl = meeting.meeting_url ?? meeting.url ?? "";
  const createdAt = meeting.created_at ?? null;
  return {
    id: meeting.id,
    title: meeting.title || "Untitled meeting",
    meetingUrl,
    platform: platformFrom(meeting.platform, meetingUrl),
    status: meetingStatus(meeting.status),
    botName: meeting.bot_name || "Meetings AI",
    createdAt,
    updatedAt: meeting.updated_at ?? null,
    joinedAt: meeting.joined_at ?? null,
    stoppedAt: meeting.stopped_at ?? null,
    errorMessage: meeting.error_message ?? meeting.last_error ?? meeting.detail ?? null,
    tags: meeting.tags ?? [],
    knowledgeEnabled: meeting.knowledge_enabled ?? false,
    knowledgeBaseId: meeting.knowledge_base_id ?? null,
    startsAt: relativeTimestamp(createdAt),
    duration: meeting.duration || "—",
    participants: meeting.participant_count ?? meeting.participants ?? 0,
  };
}

function toTranscriptSegment(segment: BackendTranscriptSegment, index: number): TranscriptSegment {
  const segmentId = segment.segment_id ?? segment.id ?? `segment-${index}`;
  return {
    id: segmentId,
    segmentId,
    speaker: segment.speaker_name || segment.speaker || "Unidentified speaker",
    rawSpeaker: segment.raw_speaker ?? segment.speaker ?? null,
    speakerReviewed: segment.speaker_reviewed ?? false,
    attributionSource: segment.attribution_source ?? null,
    text: segment.text ?? segment.content ?? "",
    startedAt: timestamp(segment.started_at ?? segment.start_time ?? segment.start_seconds),
    endedAt: timestamp(segment.ended_at ?? segment.end_time ?? segment.end_seconds),
    isFinal: segment.is_final ?? segment.completed ?? true,
  };
}

class HttpMeetingsService implements MeetingsService {
  async getSession(): Promise<boolean> {
    return (await api<{ authenticated: boolean }>("/v1/auth/session")).authenticated;
  }

  async getCurrentAccount(): Promise<CurrentAccount> {
    return api<CurrentAccount>("/v1/auth/me");
  }

  async updateProfile(displayName: string): Promise<CurrentAccount> {
    return api<CurrentAccount>("/v1/auth/me", {
      method: "PATCH", body: JSON.stringify({ display_name: displayName }),
    });
  }

  async login(email: string, password: string): Promise<void> {
    await api("/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await api("/v1/auth/change-password", {
      method: "POST", body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
  }

  async inviteMember(email: string, displayName: string, role: "admin" | "member" | "viewer"): Promise<InviteResult> {
    return api<InviteResult>("/v1/workspace/invite", {
      method: "POST", body: JSON.stringify({ email, display_name: displayName, role }),
    });
  }

  async resetMemberPassword(userId: string): Promise<InviteResult> {
    return api<InviteResult>(`/v1/workspace/members/${userId}/temporary-password`, { method: "POST" });
  }

  async changeMemberRole(userId: string, role: CurrentAccount["role"]): Promise<CurrentAccount> {
    return api<CurrentAccount>(`/v1/workspace/members/${userId}/role`, {
      method: "PATCH", body: JSON.stringify({ role }),
    });
  }

  async removeMember(userId: string): Promise<void> {
    await api<void>(`/v1/workspace/members/${userId}`, { method: "DELETE" });
  }

  async logout(): Promise<void> {
    await api("/v1/auth/logout", { method: "POST" });
  }

  async getWorkspace(): Promise<Workspace> {
    return api<Workspace>("/v1/workspace");
  }

  async listWorkspaces(): Promise<WorkspaceOption[]> {
    return api<WorkspaceOption[]>("/v1/workspaces");
  }

  async createWorkspace(displayName: string): Promise<CurrentAccount> {
    return api<CurrentAccount>("/v1/workspaces", { method: "POST", body: JSON.stringify({ display_name: displayName }) });
  }

  async switchWorkspace(id: string): Promise<CurrentAccount> {
    return api<CurrentAccount>(`/v1/workspaces/${id}/switch`, { method: "POST" });
  }

  async updateWorkspace(patch: { display_name: string; contact_email: string | null }): Promise<Workspace> {
    return api<Workspace>("/v1/workspace", { method: "PATCH", body: JSON.stringify(patch) });
  }

  async listWorkspaceMembers(): Promise<WorkspaceMember[]> {
    return api<WorkspaceMember[]>("/v1/workspace/members");
  }

  async listWorkspaceAudit(): Promise<AuditEvent[]> {
    return api<AuditEvent[]>("/v1/workspace/audit?limit=30");
  }

  async getWorkspaceOperations(): Promise<WorkspaceOperations> {
    return api<WorkspaceOperations>("/v1/workspace/operations");
  }

  async getRetentionPolicy(): Promise<RetentionPolicy> {
    return api<RetentionPolicy>("/v1/workspace/retention");
  }

  async saveRetentionPolicy(policy: RetentionPolicy): Promise<RetentionPolicy> {
    return api<RetentionPolicy>("/v1/workspace/retention", { method: "PUT", body: JSON.stringify(policy) });
  }

  async listKnowledgeBases(): Promise<KnowledgeBase[]> {
    return api<KnowledgeBase[]>("/v1/knowledge-bases");
  }

  async getKnowledgeOverview(baseId: string): Promise<KnowledgeWikiOverview> {
    return api<KnowledgeWikiOverview>(`/v1/knowledge-bases/${baseId}/overview`);
  }

  async getKnowledgeMap(baseId: string): Promise<KnowledgeMap> {
    return api<KnowledgeMap>(`/v1/knowledge-bases/${baseId}/map`);
  }

  async getKnowledgeIndex(baseId: string): Promise<KnowledgeIndexStatus> {
    return api<KnowledgeIndexStatus>(`/v1/knowledge-bases/${baseId}/index`);
  }

  async reindexKnowledge(baseId: string): Promise<KnowledgeIndexStatus> {
    return api<KnowledgeIndexStatus>(`/v1/knowledge-bases/${baseId}/reindex`, { method: "POST" });
  }

  async createKnowledgeBase(name: string, description?: string): Promise<KnowledgeBase> {
    return api<KnowledgeBase>("/v1/knowledge-bases", {
      method: "POST", body: JSON.stringify({ name, description: description || null }),
    });
  }

  async deleteKnowledgeBase(id: string): Promise<void> {
    return api<void>(`/v1/knowledge-bases/${id}`, { method: "DELETE" });
  }

  async updateKnowledgeBase(id: string, patch: { name?: string; description?: string | null; text_profile_id?: string | null }): Promise<KnowledgeBase> {
    return api<KnowledgeBase>(`/v1/knowledge-bases/${id}`, {
      method: "PATCH", body: JSON.stringify(patch),
    });
  }

  async shareKnowledgeBase(id: string, visibility: "private" | "organization" | "specific", userIds: string[]): Promise<KnowledgeBase> {
    return api<KnowledgeBase>(`/v1/knowledge-bases/${id}/sharing`, {
      method: "PUT", body: JSON.stringify({ visibility, user_ids: userIds }),
    });
  }

  async listKnowledgeConversations(baseId: string): Promise<KnowledgeConversation[]> {
    return api<KnowledgeConversation[]>(`/v1/knowledge-bases/${baseId}/conversations`);
  }

  async getKnowledgeConversation(baseId: string, conversationId: string): Promise<KnowledgeConversation> {
    return api<KnowledgeConversation>(`/v1/knowledge-bases/${baseId}/conversations/${conversationId}`);
  }

  async deleteKnowledgeConversation(baseId: string, conversationId: string): Promise<void> {
    return api<void>(`/v1/knowledge-bases/${baseId}/conversations/${conversationId}`, { method: "DELETE" });
  }

  async searchKnowledge(query: string, tags: string[], knowledgeBaseId?: string | null): Promise<KnowledgeSearchResponse> {
    return api<KnowledgeSearchResponse>("/v1/knowledge/search", {
      method: "POST", body: JSON.stringify({ query, tags, knowledge_base_id: knowledgeBaseId ?? null }),
    });
  }

  async chatKnowledge(query: string, tags: string[], knowledgeBaseId?: string | null, conversationId?: string | null): Promise<KnowledgeChatResponse> {
    return api<KnowledgeChatResponse>("/v1/knowledge/chat", {
      method: "POST", body: JSON.stringify({ query, tags, limit: 8, knowledge_base_id: knowledgeBaseId ?? null, conversation_id: conversationId ?? null }),
    });
  }

  async listMeetings(): Promise<Meeting[]> {
    try {
      const response = await api<BackendMeeting[] | { items?: BackendMeeting[] }>("/v1/meetings");
      const meetings = Array.isArray(response) ? response : response.items ?? [];
      return meetings.map(toMeetingDetail);
    } catch {
      return [];
    }
  }

  async createMeeting(input: CreateMeetingInput): Promise<MeetingDetail> {
    const meeting = await api<BackendMeeting>("/v1/meetings", {
      method: "POST",
      body: JSON.stringify({
        meeting_url: input.meetingUrl,
        ...(input.title ? { title: input.title } : {}),
        ...(input.botName ? { bot_name: input.botName } : {}),
        ...(input.deliverySettings ? { delivery_settings: input.deliverySettings } : {}),
        tags: input.tags ?? [],
        knowledge_enabled: input.knowledgeEnabled ?? false,
        knowledge_base_id: input.knowledgeBaseId ?? null,
      }),
    });
    return toMeetingDetail(meeting);
  }

  async getMeeting(id: string): Promise<MeetingDetail> {
    return toMeetingDetail(await api<BackendMeeting>(`/v1/meetings/${id}`));
  }

  async deleteMeeting(id: string): Promise<void> {
    return api<void>(`/v1/meetings/${id}`, { method: "DELETE" });
  }

  async updateMeetingKnowledge(id: string, tags: string[], knowledgeEnabled: boolean, knowledgeBaseId?: string | null): Promise<MeetingDetail> {
    return toMeetingDetail(await api<BackendMeeting>(`/v1/meetings/${id}/knowledge`, {
      method: "PATCH", body: JSON.stringify({ tags, knowledge_enabled: knowledgeEnabled, ...(knowledgeBaseId !== undefined ? { knowledge_base_id: knowledgeBaseId } : {}) }),
    }));
  }

  async getTranscriptionRoute(id: string): Promise<TranscriptionRoute> {
    return api<TranscriptionRoute>(`/v1/meetings/${id}/transcription-route`);
  }

  async joinMeeting(id: string): Promise<MeetingDetail> {
    return toMeetingDetail(await api<BackendMeeting>(`/v1/meetings/${id}/join`, { method: "POST" }));
  }

  async stopMeeting(id: string): Promise<MeetingDetail> {
    try {
      return toMeetingDetail(await api<BackendMeeting>(`/v1/meetings/${id}/stop`, { method: "POST" }));
    } catch (error) {
      // Product-level stop is idempotent. An upstream Vexa 404 can happen after
      // the bot has already stopped, so reconcile against product state instead.
      if (error instanceof ApiError && error.status === 404) return this.getMeeting(id);
      throw error;
    }
  }

  async refreshMeeting(id: string): Promise<MeetingDetail> {
    return toMeetingDetail(await api<BackendMeeting>(`/v1/meetings/${id}/refresh`, { method: "POST" }));
  }

  async getTranscript(id: string): Promise<TranscriptSegment[]> {
    const response = await api<BackendTranscriptSegment[] | { segments?: BackendTranscriptSegment[] }>(`/v1/meetings/${id}/transcript`);
    const segments = Array.isArray(response) ? response : response.segments ?? [];
    return segments.map(toTranscriptSegment);
  }

  async exportTranscript(id: string): Promise<string> {
    const response = await api<unknown>(`/v1/meetings/${id}/transcript`);
    return JSON.stringify(response, null, 2);
  }

  async getParticipants(id: string): Promise<MeetingParticipants> {
    return api<MeetingParticipants>(`/v1/meetings/${id}/participants`);
  }

  async getSpeakerIdentities(id: string): Promise<SpeakerIdentity[]> {
    return api<SpeakerIdentity[]>(`/v1/meetings/${id}/speaker-identities`);
  }

  async saveSpeakerIdentity(id: string, speaker: string, email: string | null): Promise<SpeakerIdentity[]> {
    return api<SpeakerIdentity[]>(`/v1/meetings/${id}/speaker-identities`, {
      method: "PUT", body: JSON.stringify({ speaker, email }),
    });
  }

  async correctSpeaker(id: string, segmentId: string, displayName: string | null, applyToRawLabel: boolean): Promise<TranscriptSegment[]> {
    const response = await api<{ segments: BackendTranscriptSegment[] }>(
      `/v1/meetings/${id}/transcript/segments/${encodeURIComponent(segmentId)}/speaker`,
      { method: "PUT", body: JSON.stringify({ display_name: displayName, apply_to_raw_label: applyToRawLabel }) },
    );
    return response.segments.map(toTranscriptSegment);
  }

  async getMinutes(id: string): Promise<MeetingMinutes | null> {
    try {
      return await api<MeetingMinutes>(`/v1/meetings/${id}/minutes`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async deleteMinutes(id: string): Promise<void> {
    return api<void>(`/v1/meetings/${id}/minutes`, { method: "DELETE" });
  }

  async generateMinutes(id: string): Promise<MeetingMinutes> {
    return api<MeetingMinutes>(`/v1/meetings/${id}/minutes/generate`, { method: "POST" });
  }

  async saveMinutes(id: string, draft: MinutesDraft): Promise<MeetingMinutes> {
    return api<MeetingMinutes>(`/v1/meetings/${id}/minutes`, {
      method: "PUT",
      body: JSON.stringify(draft),
    });
  }

  async approveMinutes(id: string): Promise<MeetingMinutes> {
    return api<MeetingMinutes>(`/v1/meetings/${id}/minutes/approve`, { method: "POST" });
  }

  async sendMinutes(id: string, recipients: string[], includeTranscript: boolean): Promise<EmailDelivery> {
    return api<EmailDelivery>(`/v1/meetings/${id}/minutes/send`, {
      method: "POST",
      body: JSON.stringify({ recipients, include_transcript: includeTranscript }),
    });
  }

  async getDeliverySettings(id: string): Promise<MeetingDeliverySettings> {
    return api<MeetingDeliverySettings>(`/v1/meetings/${id}/delivery-settings`);
  }

  async getPostMeetingJob(id: string): Promise<PostMeetingJob> {
    return api<PostMeetingJob>(`/v1/meetings/${id}/post-meeting-job`);
  }

  async retryPostMeetingJob(id: string): Promise<PostMeetingJob> {
    return api<PostMeetingJob>(`/v1/meetings/${id}/post-meeting-job/retry`, { method: "POST" });
  }

  async saveDeliverySettings(id: string, settings: MeetingDeliverySettings): Promise<MeetingDeliverySettings> {
    return api<MeetingDeliverySettings>(`/v1/meetings/${id}/delivery-settings`, {
      method: "PUT", body: JSON.stringify(settings),
    });
  }

  async sendConfiguredMinutes(id: string): Promise<EmailDelivery> {
    return api<EmailDelivery>(`/v1/meetings/${id}/minutes/send-configured`, { method: "POST" });
  }

  async getResendStatus(): Promise<ResendStatus> {
    return api<ResendStatus>("/v1/integrations/resend/status");
  }

  async listProviderProfiles(): Promise<ProviderProfile[]> {
    const [profiles, defaults] = await Promise.all([
      api<BackendProfile[]>("/v1/provider-profiles"),
      api<BackendDefault[]>("/v1/provider-defaults"),
    ]);
    return profiles.map((profile) => toFrontend(profile, defaults));
  }

  async saveProviderProfile(profile: ProviderProfile, apiKey?: string): Promise<ProviderProfile> {
    const type = providerType(profile.provider);
    const payload = {
      name: profile.label,
      provider_type: type,
      execution_location: type === "openai" ? "cloud" : profile.executionLocation,
      base_url: type === "openai" ? null : profile.endpoint || null,
      capabilities: profile.capabilities.map((capability) => ({ capability, model: profile.model })),
      ...(apiKey ? { api_key: apiKey } : {}),
    };
    const creating = profile.id.startsWith("new-");
    const saved = await api<BackendProfile>(
      creating ? "/v1/provider-profiles" : `/v1/provider-profiles/${profile.id}`,
      { method: creating ? "POST" : "PATCH", body: JSON.stringify(payload) },
    );
    if (profile.isDefault) {
      const capability = saved.capabilities[0].capability;
      const local = saved.execution_location === "local";
      await api<BackendDefault>(`/v1/provider-defaults/${capability}`, {
        method: "PUT",
        body: JSON.stringify(local
          ? { policy: "local_only", local_profile_id: saved.id }
          : { policy: "cloud_only", cloud_profile_id: saved.id }),
      });
    }
    return { ...toFrontend(saved, []), isDefault: profile.isDefault };
  }

  async deleteProviderProfile(id: string): Promise<void> {
    if (id.startsWith("new-")) return;
    await api<void>(`/v1/provider-profiles/${id}`, { method: "DELETE" });
  }

  async testProviderConnection(profile: ProviderProfile): Promise<ProviderProfile> {
    if (profile.id.startsWith("new-")) throw new Error("Save the configuration before validating it.");
    const result = await api<{ status: "configuration_valid" | "configuration_invalid" }>(`/v1/provider-profiles/${profile.id}/test`, { method: "POST" });
    const connectionState: ConnectionState = result.status === "configuration_valid" ? "configured" : "failed";
    return { ...profile, connectionState };
  }
}

export const meetingsService: MeetingsService = new HttpMeetingsService();
