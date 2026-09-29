import type { AccountLinkPreview, AuditEvent, BriefDocument, CalendarConnection, CalendarEvent, CalendarPeriod, CalendarSchedule, CalendarSnapshot, Capability, ConnectionState, CreateMeetingInput, CurrentAccount, EmailDelivery, InviteResult, KnowledgeBase, KnowledgeChatResponse, KnowledgeConversation, KnowledgeIndexStatus, KnowledgeMap, KnowledgeSearchResponse, KnowledgeTextProfile, KnowledgeWikiOverview, Meeting, MeetingDeliverySettings, MeetingDetail, MeetingMinutes, MeetingParticipants, MeetingStatus, MinutesDraft, MinutesStatus, MomGuidance, OrganizationBrief, PostMeetingJob, PrepReport, AiSettingsInput, AiSettingsView, CredentialTestResult, ModelCatalog, ModelCatalogQuery, ProfileKeyChoice, ProfileKind, ProviderProfile, ResendStatus, VaultCredential, VaultCredentialInput, VaultProviderType, RetentionPolicy, SpeakerIdentity, SpeakerSuggestion, Team, TeamInput, TextModelCatalog, TranscriptSegment, TranscriptionRoute, UsageSummary, Workspace, WorkspaceCalendarConnection, WorkspaceMember, WorkspaceOperations, WorkspaceOption } from "./types";
import { formatDateTime } from "./time-store";

export interface MeetingsService {
  getSession(): Promise<boolean>;
  getCurrentAccount(): Promise<CurrentAccount>;
  updateProfile(displayName: string): Promise<CurrentAccount>;
  login(email: string, password: string): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  inviteMember(email: string, displayName: string, role: "admin" | "member" | "viewer"): Promise<InviteResult>;
  resendInvite(userId: string): Promise<InviteResult>;
  resetMemberAccess(userId: string): Promise<InviteResult>;
  requestPasswordReset(email: string): Promise<void>;
  inspectAccountLink(token: string): Promise<AccountLinkPreview>;
  acceptAccountLink(token: string, password: string): Promise<CurrentAccount>;
  changeMemberRole(userId: string, role: CurrentAccount["role"]): Promise<CurrentAccount>;
  removeMember(userId: string): Promise<void>;
  logout(): Promise<void>;
  getWorkspace(): Promise<Workspace>;
  listWorkspaces(): Promise<WorkspaceOption[]>;
  createWorkspace(displayName: string): Promise<CurrentAccount>;
  switchWorkspace(id: string): Promise<CurrentAccount>;
  setDefaultWorkspace(id: string | null): Promise<WorkspaceOption[]>;
  uploadProfilePhoto(file: File): Promise<CurrentAccount>;
  removeProfilePhoto(): Promise<CurrentAccount>;
  updateWorkspace(patch: { display_name: string; contact_email: string | null }): Promise<Workspace>;
  getOrganizationBrief(): Promise<OrganizationBrief>;
  saveOrganizationBrief(brief: OrganizationBrief): Promise<OrganizationBrief>;
  listBriefDocuments(): Promise<BriefDocument[]>;
  uploadBriefDocument(file: File): Promise<BriefDocument>;
  deleteBriefDocument(id: string): Promise<void>;
  listWorkspaceMembers(): Promise<WorkspaceMember[]>;
  listTeams(): Promise<Team[]>;
  createTeam(input: TeamInput): Promise<Team>;
  updateTeam(id: string, input: Partial<TeamInput>): Promise<Team>;
  deleteTeam(id: string): Promise<void>;
  listWorkspaceAudit(): Promise<AuditEvent[]>;
  getWorkspaceOperations(): Promise<WorkspaceOperations>;
  getWorkspaceUsage(): Promise<UsageSummary>;
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
  chatKnowledge(query: string, tags: string[], knowledgeBaseId?: string | null, conversationId?: string | null, profileId?: string | null, modelId?: string | null): Promise<KnowledgeChatResponse>;
  streamKnowledgeChat(query: string, tags: string[], knowledgeBaseId: string, conversationId: string | null, profileId: string | null, modelId: string | null, onDelta: (delta: string) => void): Promise<KnowledgeChatResponse>;
  listKnowledgeTextProfiles(): Promise<KnowledgeTextProfile[]>;
  listKnowledgeModels(profileId: string): Promise<TextModelCatalog>;
  listMeetings(): Promise<Meeting[]>;
  createMeeting(input: CreateMeetingInput): Promise<MeetingDetail>;
  scheduleMeeting(input: CreateMeetingInput, startsAt: string): Promise<MeetingDetail>;
  listCalendarConnections(): Promise<CalendarConnection[]>;
  listWorkspaceCalendarConnections(): Promise<WorkspaceCalendarConnection[]>;
  /** Returns the provider consent URL. `popup` asks for the callback page that reports back to the opening tab. */
  connectCalendar(provider: CalendarConnection["provider"], alias?: string, options?: { popup?: boolean }): Promise<string>;
  renameCalendarConnection(connectionId: string, alias: string): Promise<CalendarConnection>;
  disconnectCalendar(connectionId: string): Promise<void>;
  scanCalendar(connectionId: string, period: CalendarPeriod, timezone: string): Promise<CalendarEvent[]>;
  getSyncedCalendar(startDate: string, endDate: string, timezone: string): Promise<CalendarSnapshot>;
  syncCalendar(startDate: string, endDate: string, timezone: string, connectionIds?: string[]): Promise<CalendarSnapshot>;
  getMeetingPrep(eventId: string): Promise<PrepReport | null>;
  generateMeetingPrep(eventId: string, input: { context: string; target_company: string | null; profile_urls: string[]; text_profile_id: string | null; research_enabled: boolean }): Promise<PrepReport>;
  listCalendarSchedules(): Promise<CalendarSchedule[]>;
  getCalendarSchedule(meetingId: string): Promise<CalendarSchedule | null>;
  scheduleCalendarEvent(event: CalendarEvent, period: CalendarPeriod, timezone: string, input: CreateMeetingInput, eventDate?: string): Promise<MeetingDetail>;
  joinCalendarEvent(event: CalendarEvent, period: CalendarPeriod, timezone: string, input: CreateMeetingInput, eventDate?: string): Promise<MeetingDetail>;
  getMeetingSource(meetingId: string): Promise<CalendarEvent | null>;
  cancelCalendarSchedule(meetingId: string): Promise<CalendarSchedule>;
  getMeeting(id: string): Promise<MeetingDetail>;
  deleteMeeting(id: string): Promise<void>;
  updateMeetingKnowledge(id: string, tags: string[], knowledgeEnabled: boolean, knowledgeBaseId?: string | null): Promise<MeetingDetail>;
  getTranscriptionRoute(id: string): Promise<TranscriptionRoute>;
  joinMeeting(id: string, coordination?: "own"): Promise<MeetingDetail>;
  stopMeeting(id: string): Promise<MeetingDetail>;
  refreshMeeting(id: string): Promise<MeetingDetail>;
  getTranscript(id: string): Promise<TranscriptSegment[]>;
  exportTranscript(id: string): Promise<string>;
  getParticipants(id: string): Promise<MeetingParticipants>;
  getSpeakerIdentities(id: string): Promise<SpeakerIdentity[]>;
  saveSpeakerIdentity(id: string, speaker: string, email: string | null): Promise<SpeakerIdentity[]>;
  getSpeakerSuggestions(id: string): Promise<SpeakerSuggestion[]>;
  saveSpeakerIdentities(id: string, identities: { speaker: string; email: string }[]): Promise<SpeakerIdentity[]>;
  correctSpeaker(id: string, segmentId: string, displayName: string | null, applyToRawLabel: boolean): Promise<TranscriptSegment[]>;
  getMinutes(id: string): Promise<MeetingMinutes | null>;
  getMomGuidance(id: string): Promise<MomGuidance>;
  saveMomGuidance(id: string, guidance: MomGuidance): Promise<MomGuidance>;
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
  saveProviderProfile(profile: ProviderProfile, apiKey?: string, keyChoice?: ProfileKeyChoice): Promise<ProviderProfile>;
  deleteProviderProfile(id: string): Promise<void>;
  testProviderConnection(profile: ProviderProfile): Promise<ProviderProfile>;
  listCredentials(providerType?: VaultProviderType): Promise<VaultCredential[]>;
  createCredential(input: VaultCredentialInput): Promise<VaultCredential>;
  updateCredential(id: string, patch: { label?: string; secret?: string }): Promise<VaultCredential>;
  deleteCredential(id: string): Promise<void>;
  testCredential(id: string): Promise<CredentialTestResult>;
  getAiSettings(): Promise<AiSettingsView>;
  updateAiSettings(input: AiSettingsInput): Promise<AiSettingsView>;
  /** Live model list for one capability; a pasted key travels in a header and is never stored. */
  browseModelCatalog(query: ModelCatalogQuery, apiKey?: string): Promise<ModelCatalog>;
}

/** Deleting a saved key that profiles or workspace settings still use (HTTP 409). */
export class CredentialInUseError extends Error {
  constructor(message: string, readonly usedBy: string[]) { super(message); }
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
  credential_id?: string | null;
  credential_label?: string | null;
};
type BackendDefault = {
  capability: Capability;
  ordered_profile_ids: string[];
};

type BackendMeeting = {
  id: string;
  minutes_status?: string | null;
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
    credentialId: profile.credential_id ?? null,
    credentialLabel: profile.credential_label ?? null,
  };
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/v1/auth/")) {
      window.dispatchEvent(new Event("meetings-ai-session-expired"));
    }
    const payload = await response.json().catch(() => null) as unknown;
    throw new ApiError(apiErrorMessage(payload) ?? `API request failed (${response.status})`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function withTeamPhotos(team: Team): Team {
  return { ...team, members: team.members.map(withPhoto) };
}

/** Profile photo URLs are API paths; resolve them against the configured API origin. */
function withPhoto<T extends { photo_url?: string | null }>(record: T): T {
  const path = record.photo_url;
  // In-browser data (demo mode's sample photos and uploads) is already a usable image URL.
  if (path && /^(data:image\/|blob:)/.test(path)) return record;
  return { ...record, photo_url: path && path.startsWith("/v1/") ? `${API_BASE_URL}${path}` : null };
}

function apiErrorMessage(payload: unknown): string | null {
  if (typeof payload === "string") return payload || null;
  if (Array.isArray(payload)) {
    const messages = payload.map((item) => {
      if (typeof item === "object" && item !== null && "msg" in item && typeof item.msg === "string") {
        const location = "loc" in item && Array.isArray(item.loc)
          ? item.loc.filter((part: unknown) => part !== "body").join(".")
          : "";
        return location ? `${location}: ${item.msg}` : item.msg;
      }
      return apiErrorMessage(item);
    }).filter(Boolean);
    return messages.length ? messages.join("; ") : null;
  }
  if (typeof payload === "object" && payload !== null) {
    for (const key of ["detail", "message", "error"]) {
      if (key in payload) {
        const message = apiErrorMessage((payload as Record<string, unknown>)[key]);
        if (message) return message;
      }
    }
  }
  return null;
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

function minutesStatusFrom(value: string | null | undefined): MinutesStatus | null {
  return value === "draft" || value === "approved" || value === "sent" ? value : null;
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
  return formatDateTime(parsed);
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
    minutesStatus: minutesStatusFrom(meeting.minutes_status),
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
    return withPhoto(await api<CurrentAccount>("/v1/auth/me"));
  }

  async updateProfile(displayName: string): Promise<CurrentAccount> {
    return withPhoto(await api<CurrentAccount>("/v1/auth/me", {
      method: "PATCH", body: JSON.stringify({ display_name: displayName }),
    }));
  }

  async uploadProfilePhoto(file: File): Promise<CurrentAccount> {
    const body = new FormData(); body.append("file", file);
    const response = await fetch(`${API_BASE_URL}/v1/auth/me/photo`, { method: "PUT", body });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as unknown;
      throw new ApiError(apiErrorMessage(payload) ?? `Upload failed (${response.status})`, response.status);
    }
    return withPhoto(await response.json() as CurrentAccount);
  }

  async removeProfilePhoto(): Promise<CurrentAccount> {
    return withPhoto(await api<CurrentAccount>("/v1/auth/me/photo", { method: "DELETE" }));
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

  async resendInvite(userId: string): Promise<InviteResult> {
    return api<InviteResult>(`/v1/workspace/members/${userId}/resend-invite`, { method: "POST" });
  }

  async resetMemberAccess(userId: string): Promise<InviteResult> {
    return api<InviteResult>(`/v1/workspace/members/${userId}/reset-access`, { method: "POST" });
  }

  async requestPasswordReset(email: string): Promise<void> {
    await api("/v1/auth/password-reset", { method: "POST", body: JSON.stringify({ email }) });
  }

  async inspectAccountLink(token: string): Promise<AccountLinkPreview> {
    return api<AccountLinkPreview>("/v1/auth/account-link", { method: "POST", body: JSON.stringify({ token }) });
  }

  async acceptAccountLink(token: string, password: string): Promise<CurrentAccount> {
    return api<CurrentAccount>("/v1/auth/account-link/accept", { method: "POST", body: JSON.stringify({ token, password }) });
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

  async setDefaultWorkspace(id: string | null): Promise<WorkspaceOption[]> {
    return api<WorkspaceOption[]>("/v1/workspaces/default", { method: "PUT", body: JSON.stringify({ organization_id: id }) });
  }

  async updateWorkspace(patch: { display_name: string; contact_email: string | null }): Promise<Workspace> {
    return api<Workspace>("/v1/workspace", { method: "PATCH", body: JSON.stringify(patch) });
  }

  async getOrganizationBrief(): Promise<OrganizationBrief> { return api<OrganizationBrief>("/v1/workspace/brief"); }
  async saveOrganizationBrief(brief: OrganizationBrief): Promise<OrganizationBrief> {
    return api<OrganizationBrief>("/v1/workspace/brief", { method: "PUT", body: JSON.stringify(brief) });
  }
  async listBriefDocuments(): Promise<BriefDocument[]> { return api<BriefDocument[]>("/v1/workspace/brief/documents"); }
  async uploadBriefDocument(file: File): Promise<BriefDocument> {
    const body = new FormData(); body.append("file", file);
    const response = await fetch(`${API_BASE_URL}/v1/workspace/brief/documents`, { method: "POST", body });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as unknown;
      throw new ApiError(apiErrorMessage(payload) ?? `Upload failed (${response.status})`, response.status);
    }
    return response.json() as Promise<BriefDocument>;
  }
  async deleteBriefDocument(id: string): Promise<void> { await api<void>(`/v1/workspace/brief/documents/${id}`, { method: "DELETE" }); }

  async listWorkspaceMembers(): Promise<WorkspaceMember[]> {
    return (await api<WorkspaceMember[]>("/v1/workspace/members")).map(withPhoto);
  }

  async listTeams(): Promise<Team[]> {
    return (await api<Team[]>("/v1/workspace/teams")).map(withTeamPhotos);
  }

  async createTeam(input: TeamInput): Promise<Team> {
    return withTeamPhotos(await api<Team>("/v1/workspace/teams", { method: "POST", body: JSON.stringify(input) }));
  }

  async updateTeam(id: string, input: Partial<TeamInput>): Promise<Team> {
    return withTeamPhotos(await api<Team>(`/v1/workspace/teams/${id}`, { method: "PATCH", body: JSON.stringify(input) }));
  }

  async deleteTeam(id: string): Promise<void> {
    await api<void>(`/v1/workspace/teams/${id}`, { method: "DELETE" });
  }

  async listWorkspaceAudit(): Promise<AuditEvent[]> {
    return api<AuditEvent[]>("/v1/workspace/audit?limit=30");
  }

  async getWorkspaceOperations(): Promise<WorkspaceOperations> {
    return api<WorkspaceOperations>("/v1/workspace/operations");
  }

  async getWorkspaceUsage(): Promise<UsageSummary> {
    return api<UsageSummary>("/v1/workspace/usage");
  }

  async listWorkspaceCalendarConnections(): Promise<WorkspaceCalendarConnection[]> {
    return api<WorkspaceCalendarConnection[]>("/v1/workspace/calendar-connections");
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

  async chatKnowledge(query: string, tags: string[], knowledgeBaseId?: string | null, conversationId?: string | null, profileId?: string | null, modelId?: string | null): Promise<KnowledgeChatResponse> {
    return api<KnowledgeChatResponse>("/v1/knowledge/chat", {
      method: "POST", body: JSON.stringify({ query, tags, limit: 8, knowledge_base_id: knowledgeBaseId ?? null, conversation_id: conversationId ?? null, text_profile_id: profileId ?? null, model_id: modelId ?? null }),
    });
  }

  async streamKnowledgeChat(query: string, tags: string[], knowledgeBaseId: string, conversationId: string | null, profileId: string | null, modelId: string | null, onDelta: (delta: string) => void): Promise<KnowledgeChatResponse> {
    const path = "/v1/knowledge/chat/stream";
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, tags, limit: 8, knowledge_base_id: knowledgeBaseId, conversation_id: conversationId, text_profile_id: profileId, model_id: modelId }),
    });
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event("meetings-ai-session-expired"));
      const payload = await response.json().catch(() => null) as unknown;
      throw new ApiError(apiErrorMessage(payload) ?? `API request failed (${response.status})`, response.status);
    }
    if (!response.body) throw new Error("The browser could not open the answer stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: KnowledgeChatResponse | null = null;
    const receive = (frame: string) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!event || !data) return;
      const value: unknown = JSON.parse(data);
      if (event === "delta" && typeof value === "string") onDelta(value);
      if (event === "final") final = value as KnowledgeChatResponse;
      if (event === "error") throw new Error(typeof value === "string" ? value : "The answer could not be completed.");
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          receive(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
      if (buffer.trim()) receive(buffer);
    } finally {
      reader.releaseLock();
    }
    if (!final) throw new Error("The answer stream ended before it was verified. Please try again.");
    return final;
  }

  async listKnowledgeTextProfiles(): Promise<KnowledgeTextProfile[]> {
    return api<KnowledgeTextProfile[]>("/v1/knowledge/text-profiles");
  }

  async listKnowledgeModels(profileId: string): Promise<TextModelCatalog> {
    return api<TextModelCatalog>(`/v1/knowledge/text-profiles/${profileId}/models`);
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
        ...(input.momGuidance ? { mom_guidance: input.momGuidance } : {}),
        tags: input.tags ?? [],
        knowledge_enabled: input.knowledgeEnabled ?? false,
        knowledge_base_id: input.knowledgeBaseId ?? null,
      }),
    });
    return toMeetingDetail(meeting);
  }

  async scheduleMeeting(input: CreateMeetingInput, startsAt: string): Promise<MeetingDetail> {
    const result = await api<{ meeting: BackendMeeting }>("/v1/meetings/schedules", {
      method: "POST",
      body: JSON.stringify({
        starts_at: startsAt, ...(input.coordination ? { coordination: input.coordination } : {}),
        meeting: {
          meeting_url: input.meetingUrl, title: input.title || undefined,
          bot_name: input.botName || "Meetings AI", delivery_settings: input.deliverySettings,
          mom_guidance: input.momGuidance,
          tags: input.tags ?? [], knowledge_enabled: input.knowledgeEnabled ?? false,
          knowledge_base_id: input.knowledgeBaseId ?? null,
        },
      }),
    });
    return toMeetingDetail(result.meeting);
  }

  async listCalendarConnections(): Promise<CalendarConnection[]> {
    return api<CalendarConnection[]>("/v1/calendar/connections");
  }

  async connectCalendar(provider: CalendarConnection["provider"], alias = "", options: { popup?: boolean } = {}): Promise<string> {
    const result = await api<{ redirect_url: string }>(`/v1/calendar/connect/${provider}`, {
      method: "POST", body: JSON.stringify({ callback_origin: window.location.origin, alias: alias.trim() || null, popup: Boolean(options.popup) }),
    });
    return result.redirect_url;
  }

  async renameCalendarConnection(connectionId: string, alias: string): Promise<CalendarConnection> {
    return api<CalendarConnection>(`/v1/calendar/connections/${encodeURIComponent(connectionId)}`, {
      method: "PATCH", body: JSON.stringify({ alias: alias.trim() }),
    });
  }

  async disconnectCalendar(connectionId: string): Promise<void> {
    await api<void>(`/v1/calendar/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
  }

  async scanCalendar(connectionId: string, period: CalendarPeriod, timezone: string): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({ connection_id: connectionId, period, timezone });
    const result = await api<{ events: CalendarEvent[] }>(`/v1/calendar/events?${params}`);
    return result.events;
  }

  async getSyncedCalendar(startDate: string, endDate: string, timezone: string): Promise<CalendarSnapshot> {
    const params = new URLSearchParams({ start_date: startDate, end_date: endDate, timezone });
    return api<CalendarSnapshot>(`/v1/calendar/synced?${params}`);
  }

  async syncCalendar(startDate: string, endDate: string, timezone: string, connectionIds: string[] = []): Promise<CalendarSnapshot> {
    return api<CalendarSnapshot>("/v1/calendar/sync", { method: "POST", body: JSON.stringify({
      start_date: startDate, end_date: endDate, timezone, connection_ids: connectionIds,
    }) });
  }

  async getMeetingPrep(eventId: string): Promise<PrepReport | null> {
    return api<PrepReport | null>(`/v1/calendar/events/${eventId}/prep`);
  }

  async generateMeetingPrep(eventId: string, input: { context: string; target_company: string | null; profile_urls: string[]; text_profile_id: string | null; research_enabled: boolean }): Promise<PrepReport> {
    return api<PrepReport>(`/v1/calendar/events/${eventId}/prep`, { method: "POST", body: JSON.stringify(input) });
  }

  async listCalendarSchedules(): Promise<CalendarSchedule[]> {
    return api<CalendarSchedule[]>("/v1/calendar/schedules");
  }

  async getCalendarSchedule(meetingId: string): Promise<CalendarSchedule | null> {
    try { return await api<CalendarSchedule>(`/v1/calendar/schedules/${meetingId}`); }
    catch (cause) { if (cause instanceof ApiError && cause.status === 404) return null; throw cause; }
  }

  async scheduleCalendarEvent(event: CalendarEvent, period: CalendarPeriod, timezone: string, input: CreateMeetingInput, eventDate?: string): Promise<MeetingDetail> {
    const result = await api<{ meeting: BackendMeeting }>("/v1/calendar/schedules", { method: "POST", body: JSON.stringify({
      connection_id: event.connection_id, event_id: event.event_id, period, event_date: eventDate, timezone,
      ...(input.coordination ? { coordination: input.coordination } : {}),
      meeting: {
        meeting_url: event.meeting_url, title: input.title || event.title, bot_name: input.botName || "Meetings AI",
        delivery_settings: input.deliverySettings, tags: input.tags ?? [],
        mom_guidance: input.momGuidance,
        knowledge_enabled: input.knowledgeEnabled ?? false, knowledge_base_id: input.knowledgeBaseId ?? null,
      },
    }) });
    return toMeetingDetail(result.meeting);
  }

  async joinCalendarEvent(event: CalendarEvent, period: CalendarPeriod, timezone: string, input: CreateMeetingInput, eventDate?: string): Promise<MeetingDetail> {
    const result = await api<{ meeting: BackendMeeting }>("/v1/calendar/meetings", { method: "POST", body: JSON.stringify({
      connection_id: event.connection_id, event_id: event.event_id, period, event_date: eventDate, timezone,
      ...(input.coordination ? { coordination: input.coordination } : {}),
      meeting: {
        meeting_url: event.meeting_url, title: input.title || event.title, bot_name: input.botName || "Meetings AI",
        delivery_settings: input.deliverySettings, tags: input.tags ?? [], mom_guidance: input.momGuidance,
        knowledge_enabled: input.knowledgeEnabled ?? false, knowledge_base_id: input.knowledgeBaseId ?? null,
      },
    }) });
    return toMeetingDetail(result.meeting);
  }

  async getMeetingSource(meetingId: string): Promise<CalendarEvent | null> {
    try { return await api<CalendarEvent>(`/v1/meetings/${meetingId}/source`); }
    catch (cause) { if (cause instanceof ApiError && cause.status === 404) return null; throw cause; }
  }

  async cancelCalendarSchedule(meetingId: string): Promise<CalendarSchedule> {
    return api<CalendarSchedule>(`/v1/calendar/schedules/${meetingId}/cancel`, { method: "POST" });
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

  async joinMeeting(id: string, coordination?: "own"): Promise<MeetingDetail> {
    return toMeetingDetail(await api<BackendMeeting>(`/v1/meetings/${id}/join${coordination ? `?coordination=${coordination}` : ""}`, { method: "POST" }));
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

  async getSpeakerSuggestions(id: string): Promise<SpeakerSuggestion[]> {
    return api<SpeakerSuggestion[]>(`/v1/meetings/${id}/speaker-suggestions`);
  }

  async saveSpeakerIdentities(id: string, identities: { speaker: string; email: string }[]): Promise<SpeakerIdentity[]> {
    return api<SpeakerIdentity[]>(`/v1/meetings/${id}/speaker-identities/bulk`, {
      method: "POST", body: JSON.stringify({ identities }),
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

  async getMomGuidance(id: string): Promise<MomGuidance> {
    return api<MomGuidance>(`/v1/meetings/${id}/mom-guidance`);
  }

  async saveMomGuidance(id: string, guidance: MomGuidance): Promise<MomGuidance> {
    return api<MomGuidance>(`/v1/meetings/${id}/mom-guidance`, { method: "PUT", body: JSON.stringify(guidance) });
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

  async saveProviderProfile(profile: ProviderProfile, apiKey?: string, keyChoice?: ProfileKeyChoice): Promise<ProviderProfile> {
    const type = providerType(profile.provider);
    const payload = {
      name: profile.label,
      provider_type: type,
      execution_location: type === "openai" ? "cloud" : profile.executionLocation,
      base_url: type === "openai" ? null : profile.endpoint || null,
      capabilities: profile.capabilities.map((capability) => ({ capability, model: profile.model })),
      ...(apiKey ? { api_key: apiKey } : {}),
      ...(apiKey && keyChoice?.saveToVaultLabel ? { save_to_vault: true, credential_label: keyChoice.saveToVaultLabel } : {}),
      ...(!apiKey && keyChoice && keyChoice.credentialId !== undefined ? { credential_id: keyChoice.credentialId } : {}),
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

  async listCredentials(providerType?: VaultProviderType): Promise<VaultCredential[]> {
    return api<VaultCredential[]>(`/v1/credentials${providerType ? `?provider_type=${providerType}` : ""}`);
  }

  async createCredential(input: VaultCredentialInput): Promise<VaultCredential> {
    return api<VaultCredential>("/v1/credentials", { method: "POST", body: JSON.stringify(input) });
  }

  async updateCredential(id: string, patch: { label?: string; secret?: string }): Promise<VaultCredential> {
    return api<VaultCredential>(`/v1/credentials/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  }

  async deleteCredential(id: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/v1/credentials/${id}`, { method: "DELETE", headers: { "content-type": "application/json" } });
    if (response.status === 409) {
      const payload = await response.json().catch(() => null) as { detail?: { message?: string; used_by?: unknown } } | null;
      const usedBy = Array.isArray(payload?.detail?.used_by) ? payload.detail.used_by.filter((item): item is string => typeof item === "string") : [];
      throw new CredentialInUseError(payload?.detail?.message ?? "This key is still in use.", usedBy);
    }
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event("meetings-ai-session-expired"));
      const payload = await response.json().catch(() => null) as unknown;
      throw new ApiError(apiErrorMessage(payload) ?? `API request failed (${response.status})`, response.status);
    }
  }

  async testCredential(id: string): Promise<CredentialTestResult> {
    return api<CredentialTestResult>(`/v1/credentials/${id}/test`, { method: "POST" });
  }

  async getAiSettings(): Promise<AiSettingsView> {
    return api<AiSettingsView>("/v1/ai/settings");
  }

  async updateAiSettings(input: AiSettingsInput): Promise<AiSettingsView> {
    return api<AiSettingsView>("/v1/ai/settings", { method: "PUT", body: JSON.stringify(input) });
  }

  async browseModelCatalog(query: ModelCatalogQuery, apiKey?: string): Promise<ModelCatalog> {
    const params = new URLSearchParams({ capability: query.capability });
    if (query.provider) params.set("provider", query.provider);
    if (query.profileId) params.set("profile_id", query.profileId);
    if (query.credentialId) params.set("credential_id", query.credentialId);
    if (query.baseUrl) params.set("base_url", query.baseUrl);
    return api<ModelCatalog>(`/v1/model-catalog?${params.toString()}`, apiKey ? { headers: { "X-Provider-Key": apiKey } } : undefined);
  }
}

export const meetingsService: MeetingsService = new HttpMeetingsService();

/* ---------- Our company identity (who WE are; members read, owners/admins edit) ---------- */
/** Rejects a response that is not an identity (e.g. an older API or proxy page) instead of crashing callers. */
function asIdentity(value: unknown): import("./types").OrganizationIdentity {
  const candidate = value as Partial<import("./types").OrganizationIdentity> | null;
  if (!candidate || !Array.isArray(candidate.aliases) || !Array.isArray(candidate.domains)) {
    throw new Error("The workspace identity response was not understood.");
  }
  return candidate as import("./types").OrganizationIdentity;
}

export const identityService = {
  async get(): Promise<import("./types").OrganizationIdentity> {
    return asIdentity(await api<unknown>("/v1/workspace/identity"));
  },
  async save(input: import("./types").OrganizationIdentityInput): Promise<import("./types").OrganizationIdentity> {
    return asIdentity(await api<unknown>("/v1/workspace/identity", { method: "PUT", body: JSON.stringify(input) }));
  },
};

/* ---------- Meeting prep v2: inputs, documents, streamed generation, history ---------- */
type PrepInputsT = import("./types").PrepInputs;
type PrepHistoryT = import("./types").PrepHistory;
type AnyPrepReportT = import("./types").AnyPrepReport;
type PrepDocumentT = import("./types").PrepDocument;
type PrepGenerateInputT = import("./types").PrepGenerateInput;
type PrepStageT = import("./types").PrepStage;

/** HTTP status of a failed service call (e.g. 404 for an API that is not deployed, 409 for missing setup), else null. */
export function serviceErrorStatus(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

async function failed(response: Response): Promise<never> {
  if (response.status === 401) window.dispatchEvent(new Event("meetings-ai-session-expired"));
  const payload = await response.json().catch(() => null) as unknown;
  throw new ApiError(apiErrorMessage(payload) ?? `API request failed (${response.status})`, response.status);
}

export const prepService = {
  getLatest(eventId: string): Promise<AnyPrepReportT | null> {
    return api<AnyPrepReportT | null>(`/v1/calendar/events/${eventId}/prep`);
  },
  getInputs(eventId: string): Promise<PrepInputsT> {
    return api<PrepInputsT>(`/v1/calendar/events/${eventId}/prep/inputs`);
  },
  saveInputs(eventId: string, inputs: PrepInputsT): Promise<PrepInputsT> {
    return api<PrepInputsT>(`/v1/calendar/events/${eventId}/prep/inputs`, { method: "PUT", body: JSON.stringify(inputs) });
  },
  getHistory(eventId: string): Promise<PrepHistoryT> {
    return api<PrepHistoryT>(`/v1/calendar/events/${eventId}/prep/history`);
  },
  /** Read-only preview of our company vs. the target and each attendee's side, with unsaved corrections. */
  previewWhosWho(eventId: string, input: import("./types").WhosWhoInput): Promise<import("./types").WhosWho> {
    return api<import("./types").WhosWho>(`/v1/calendar/events/${eventId}/prep/whos-who`, { method: "POST", body: JSON.stringify(input) });
  },
  generate(eventId: string, input: PrepGenerateInputT): Promise<AnyPrepReportT> {
    return api<AnyPrepReportT>(`/v1/calendar/events/${eventId}/prep`, { method: "POST", body: JSON.stringify(input) });
  },
  /** POST /prep/stream (SSE): progress events, then the saved report. Errors carry the HTTP status. */
  async generateStream(eventId: string, input: PrepGenerateInputT, onStage: (stage: PrepStageT, message: string) => void): Promise<AnyPrepReportT> {
    const response = await fetch(`${API_BASE_URL}/v1/calendar/events/${eventId}/prep/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    if (!response.ok) return failed(response);
    if (!response.body) throw new ApiError("The browser could not open the progress stream.", 0);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: AnyPrepReportT | null = null;
    const receive = (frame: string) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!event || !data) return;
      const value = JSON.parse(data) as Record<string, unknown>;
      if (event === "progress") onStage(value.stage as PrepStageT, typeof value.message === "string" ? value.message : "");
      if (event === "final") final = value as unknown as AnyPrepReportT;
      if (event === "error") throw new ApiError(typeof value.detail === "string" ? value.detail : "The briefing could not be completed.", typeof value.status === "number" ? value.status : 500);
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          receive(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
      if (buffer.trim()) receive(buffer);
    } finally {
      reader.releaseLock();
    }
    if (!final) throw new ApiError("The briefing stream ended before the report was saved. Please try again.", 0);
    return final;
  },
  listDocuments(eventId: string): Promise<PrepDocumentT[]> {
    return api<PrepDocumentT[]>(`/v1/documents?scope=prep&scope_id=${encodeURIComponent(eventId)}`);
  },
  async uploadDocument(eventId: string, file: File): Promise<PrepDocumentT> {
    const body = new FormData();
    body.append("scope", "prep");
    body.append("scope_id", eventId);
    body.append("file", file);
    const response = await fetch(`${API_BASE_URL}/v1/documents`, { method: "POST", body });
    if (!response.ok) return failed(response);
    return response.json() as Promise<PrepDocumentT>;
  },
  async deleteDocument(documentId: string): Promise<void> {
    await api<void>(`/v1/documents/${documentId}`, { method: "DELETE" });
  },
};

/* ---------- Usage & cost transparency and workspace storage (owners and admins) ---------- */
type UsageSummaryDetailT = import("./types").UsageSummaryDetail;
type UsageRangeT = import("./types").UsageRange;
type UsageEventFiltersT = import("./types").UsageEventFilters;
type UsageEventPageT = import("./types").UsageEventPage;
type StorageSummaryT = import("./types").StorageSummary;
type StorageItemT = import("./types").StorageItem;
type StorageCategoryKeyT = import("./types").StorageCategoryKey;
type StoragePurgeRequestT = import("./types").StoragePurgeRequest;
type StoragePurgeResultT = import("./types").StoragePurgeResult;

function usageQuery(filters: Partial<UsageEventFiltersT>, extra: Record<string, string | number | null | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) {
    if (value !== null && value !== undefined && String(value).trim() !== "") params.set(key, String(value).trim());
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const usageService = {
  summary(range: UsageRangeT): Promise<UsageSummaryDetailT> {
    return api<UsageSummaryDetailT>(`/v1/workspace/usage${usageQuery(range)}`);
  },
  events(filters: UsageEventFiltersT, cursor: string | null = null, limit = 50): Promise<UsageEventPageT> {
    return api<UsageEventPageT>(`/v1/workspace/usage/events${usageQuery(filters, { cursor, limit })}`);
  },
  /** Same-origin download link; the session cookie authorises it. */
  exportUrl(filters: UsageEventFiltersT): string {
    return `${API_BASE_URL}/v1/workspace/usage/export.csv${usageQuery(filters)}`;
  },
};

/** Remaining credit / spend for saved provider keys (owners and admins). */
export const balanceService = {
  overview(): Promise<import("./types").BalanceOverview> {
    return api<import("./types").BalanceOverview>("/v1/provider-balances");
  },
  /** Re-checks with the providers now (rate limited per workspace); one key when `credentialId` is given. */
  refresh(credentialId?: string): Promise<import("./types").BalanceOverview> {
    return api<import("./types").BalanceOverview>(`/v1/provider-balances/refresh${credentialId ? `?credential_id=${encodeURIComponent(credentialId)}` : ""}`, { method: "POST" });
  },
};

/** The workspace's Apollo research source (owners and admins). The API key is write-only. */
export const apolloService = {
  status(): Promise<import("./types").ApolloIntegration> {
    return api<import("./types").ApolloIntegration>("/v1/workspace/integrations/apollo");
  },
  /** Connects or replaces: the key is tested with Apollo first; a rejected key is never stored. */
  connect(apiKey: string): Promise<import("./types").ApolloIntegration> {
    return api<import("./types").ApolloIntegration>("/v1/workspace/integrations/apollo", { method: "PUT", body: JSON.stringify({ api_key: apiKey }) });
  },
  test(): Promise<import("./types").ApolloIntegration> {
    return api<import("./types").ApolloIntegration>("/v1/workspace/integrations/apollo/test", { method: "POST" });
  },
  disconnect(): Promise<void> {
    return api<void>("/v1/workspace/integrations/apollo", { method: "DELETE" });
  },
};

export const storageService = {
  summary(includeCapture = false): Promise<StorageSummaryT> {
    return api<StorageSummaryT>(`/v1/workspace/storage${includeCapture ? "?include_capture=true" : ""}`);
  },
  async items(category: StorageCategoryKeyT, q = "", limit = 200): Promise<StorageItemT[]> {
    const response = await api<{ category: string; items: StorageItemT[] }>(`/v1/workspace/storage/items${usageQuery({}, { category, q, limit })}`);
    return response.items;
  },
  purge(request: StoragePurgeRequestT): Promise<StoragePurgeResultT> {
    return api<StoragePurgeResultT>("/v1/workspace/storage/purge", { method: "POST", body: JSON.stringify(request) });
  },
};

/* ---------- Notification center and background jobs (every role; own records only) ---------- */
type AppNotificationT = import("./types").AppNotification;
type NotificationPageT = import("./types").NotificationPage;
type BackgroundJobT = import("./types").BackgroundJob;

/** Detected reschedules, cancellations and link changes of followed calendar events. */
export const calendarChangeService = {
  forMeeting(meetingId: string): Promise<import("./types").CalendarChangeHistory> {
    return api<import("./types").CalendarChangeHistory>(`/v1/meetings/${meetingId}/schedule/changes`);
  },
  forCalendarEvent(eventId: string): Promise<import("./types").CalendarChangeHistory> {
    return api<import("./types").CalendarChangeHistory>(`/v1/calendar/events/${eventId}/changes`);
  },
};

export const notificationService = {
  list(options: { unread?: boolean; limit?: number; cursor?: string | null } = {}): Promise<NotificationPageT> {
    return api<NotificationPageT>(`/v1/notifications${usageQuery({}, { unread: options.unread ? "true" : null, limit: options.limit ?? 30, cursor: options.cursor ?? null })}`);
  },
  async unreadCount(): Promise<number> {
    return (await api<{ unread_count: number }>("/v1/notifications/unread-count")).unread_count;
  },
  markRead(id: string): Promise<AppNotificationT> {
    return api<AppNotificationT>(`/v1/notifications/${id}/read`, { method: "POST" });
  },
  async markAllRead(): Promise<number> {
    return (await api<{ unread_count: number }>("/v1/notifications/read-all", { method: "POST" })).unread_count;
  },
  remove(id: string): Promise<void> {
    return api<void>(`/v1/notifications/${id}`, { method: "DELETE" });
  },
  /** Clears the signed-in person's notifications in this workspace; `readOnly` keeps unread ones. */
  clear(options: { readOnly?: boolean } = {}): Promise<{ cleared: number; unread_count: number }> {
    return api<{ cleared: number; unread_count: number }>(`/v1/notifications${options.readOnly ? "?read_only=true" : ""}`, { method: "DELETE" });
  },
};

export const jobService = {
  get(id: string): Promise<BackgroundJobT> {
    return api<BackgroundJobT>(`/v1/background-jobs/${id}`);
  },
  /** The newest active job for one subject (e.g. a calendar event or meeting), or null. */
  async active(kind: string, subjectId: string): Promise<BackgroundJobT | null> {
    const jobs = await api<BackgroundJobT[]>(`/v1/background-jobs${usageQuery({}, { kind, subject_id: subjectId, active: "true", limit: 1 })}`);
    return jobs[0] ?? null;
  },
  cancel(id: string): Promise<BackgroundJobT> {
    return api<BackgroundJobT>(`/v1/background-jobs/${id}/cancel`, { method: "POST" });
  },
  /** Starts a briefing in the background (or returns the one already running for this event). */
  startPrep(eventId: string, input: PrepGenerateInputT): Promise<BackgroundJobT> {
    return api<BackgroundJobT>(`/v1/calendar/events/${eventId}/prep/jobs`, { method: "POST", body: JSON.stringify(input) });
  },
  startMinutes(meetingId: string): Promise<BackgroundJobT> {
    return api<BackgroundJobT>(`/v1/meetings/${meetingId}/minutes/jobs`, { method: "POST" });
  },
  startReindex(baseId: string): Promise<BackgroundJobT> {
    return api<BackgroundJobT>(`/v1/knowledge-bases/${baseId}/reindex/jobs`, { method: "POST" });
  },
};

type TimePreferencesPayloadT = import("./types").TimePreferencesPayload;

export const preferencesService = {
  get(): Promise<TimePreferencesPayloadT> {
    return api<TimePreferencesPayloadT>("/v1/me/preferences");
  },
  /** Only the fields given change; `timezone: null` follows the browser again. */
  update(patch: { timezone?: string | null; time_format?: TimePreferencesPayloadT["time_format"] }): Promise<TimePreferencesPayloadT> {
    return api<TimePreferencesPayloadT>("/v1/me/preferences", { method: "PUT", body: JSON.stringify(patch) });
  },
  /** Reports this browser's zone (idempotent) and returns the saved preferences. */
  reportDetected(timezone: string): Promise<TimePreferencesPayloadT> {
    return api<TimePreferencesPayloadT>("/v1/me/preferences/detected", { method: "POST", body: JSON.stringify({ timezone }) });
  },
};

type LeavePolicyT = import("./types").LeavePolicy;
type LeavePolicyValuesT = import("./types").LeavePolicyValues;
type MeetingLeaveT = import("./types").MeetingLeave;

/** Rejects a response that is not a leave policy (e.g. an older API or proxy page) instead of crashing callers. */
function asLeavePolicy(value: unknown): LeavePolicyT {
  const candidate = value as Partial<LeavePolicyT> | null;
  if (!candidate || typeof candidate.silence_minutes !== "number" || !candidate.limits || !candidate.defaults) {
    throw new Error("The leave rules response was not understood.");
  }
  return candidate as LeavePolicyT;
}

function asMeetingLeave(value: unknown): MeetingLeaveT {
  const candidate = value as Partial<MeetingLeaveT> | null;
  if (!candidate || typeof candidate.in_call !== "boolean" || !candidate.policy) throw new Error("The meeting leave response was not understood.");
  return candidate as MeetingLeaveT;
}

/** When the assistant leaves a call: the workspace policy (members read, owners/admins edit) and each meeting's status. */
export const leaveService = {
  async getPolicy(): Promise<LeavePolicyT> {
    return asLeavePolicy(await api<unknown>("/v1/workspace/leave-policy"));
  },
  async savePolicy(values: LeavePolicyValuesT): Promise<LeavePolicyT> {
    return asLeavePolicy(await api<unknown>("/v1/workspace/leave-policy", { method: "PUT", body: JSON.stringify(values) }));
  },
  async getMeetingLeave(meetingId: string): Promise<MeetingLeaveT> {
    return asMeetingLeave(await api<unknown>(`/v1/meetings/${meetingId}/leave`));
  },
  /** Keeps the assistant in the call 30 more minutes (owners and admins). */
  async keepInCall(meetingId: string): Promise<MeetingLeaveT> {
    return asMeetingLeave(await api<unknown>(`/v1/meetings/${meetingId}/keep`, { method: "POST" }));
  },
};
