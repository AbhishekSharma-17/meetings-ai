import type { Capability, ConnectionState, CreateMeetingInput, Meeting, MeetingDetail, MeetingStatus, ProfileKind, ProviderProfile, TranscriptSegment } from "./types";

export interface MeetingsService {
  listMeetings(): Promise<Meeting[]>;
  createMeeting(input: CreateMeetingInput): Promise<MeetingDetail>;
  getMeeting(id: string): Promise<MeetingDetail>;
  joinMeeting(id: string): Promise<MeetingDetail>;
  stopMeeting(id: string): Promise<MeetingDetail>;
  refreshMeeting(id: string): Promise<MeetingDetail>;
  getTranscript(id: string): Promise<TranscriptSegment[]>;
  listProviderProfiles(): Promise<ProviderProfile[]>;
  saveProviderProfile(profile: ProviderProfile, apiKey?: string): Promise<ProviderProfile>;
  testProviderConnection(profile: ProviderProfile, apiKey?: string): Promise<ProviderProfile>;
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
  last_error?: string | null;
  detail?: string | null;
};

type BackendTranscriptSegment = {
  id?: string;
  speaker?: string | null;
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

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8320";

const initialProfiles: ProviderProfile[] = [
  { id: "new-transcription-openai", kind: "transcription", label: "OpenAI transcription", provider: "OpenAI", executionLocation: "cloud", endpoint: "https://api.openai.com/v1", model: "gpt-4o-transcribe", capabilities: ["transcription"], connectionState: "not_configured", isDefault: false, apiKeyConfigured: false },
  { id: "new-mom-openai", kind: "mom", label: "OpenAI MOM", provider: "OpenAI", executionLocation: "cloud", endpoint: "https://api.openai.com/v1", model: "", capabilities: ["text_generation"], connectionState: "not_configured", isDefault: false, apiKeyConfigured: false },
  { id: "new-embedding-local", kind: "embedding", label: "Local embeddings", provider: "OpenAI-compatible", executionLocation: "local", endpoint: "http://localhost:11434/v1", model: "", capabilities: ["embeddings"], connectionState: "not_configured", isDefault: false, apiKeyConfigured: false },
];

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
  return {
    id: profile.id,
    kind: kindFor(capability),
    label: profile.name,
    provider: providerLabel(profile.provider_type),
    executionLocation: profile.execution_location,
    endpoint: profile.base_url ?? "",
    model: configured?.model ?? "",
    capabilities: profile.capabilities.map((item) => item.capability),
    connectionState: "not_configured",
    isDefault: defaults.some((item) => item.capability === capability && item.ordered_profile_ids[0] === profile.id),
    apiKeyConfigured: profile.credential_configured,
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: string } | null;
    throw new ApiError(payload?.detail ?? `API request failed (${response.status})`, response.status);
  }
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
    startsAt: relativeTimestamp(createdAt),
    duration: meeting.duration || "—",
    participants: meeting.participant_count ?? meeting.participants ?? 0,
  };
}

function toTranscriptSegment(segment: BackendTranscriptSegment, index: number): TranscriptSegment {
  return {
    id: segment.id ?? `segment-${index}`,
    speaker: segment.speaker_name || segment.speaker || "Unidentified speaker",
    text: segment.text ?? segment.content ?? "",
    startedAt: timestamp(segment.started_at ?? segment.start_time ?? segment.start_seconds),
    endedAt: timestamp(segment.ended_at ?? segment.end_time ?? segment.end_seconds),
    isFinal: segment.is_final ?? segment.completed ?? true,
  };
}

class HttpMeetingsService implements MeetingsService {
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
      }),
    });
    return toMeetingDetail(meeting);
  }

  async getMeeting(id: string): Promise<MeetingDetail> {
    return toMeetingDetail(await api<BackendMeeting>(`/v1/meetings/${id}`));
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

  async listProviderProfiles(): Promise<ProviderProfile[]> {
    try {
      const [profiles, defaults] = await Promise.all([
        api<BackendProfile[]>("/v1/provider-profiles"),
        api<BackendDefault[]>("/v1/provider-defaults"),
      ]);
      return profiles.length ? profiles.map((profile) => toFrontend(profile, defaults)) : structuredClone(initialProfiles);
    } catch {
      return structuredClone(initialProfiles);
    }
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

  async testProviderConnection(profile: ProviderProfile, apiKey?: string): Promise<ProviderProfile> {
    const saved = await this.saveProviderProfile(profile, apiKey);
    const result = await api<{ status: "configuration_valid" | "configuration_invalid" }>(`/v1/provider-profiles/${saved.id}/test`, { method: "POST" });
    const connectionState: ConnectionState = result.status === "configuration_valid" ? "configured" : "failed";
    return { ...saved, connectionState };
  }
}

export const meetingsService: MeetingsService = new HttpMeetingsService();
