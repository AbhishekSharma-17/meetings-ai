import type { Capability, ConnectionState, Meeting, ProfileKind, ProviderProfile } from "./types";

export interface MeetingsService {
  listMeetings(): Promise<Meeting[]>;
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
    throw new Error(payload?.detail ?? `API request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

class HttpMeetingsService implements MeetingsService {
  async listMeetings(): Promise<Meeting[]> {
    return [];
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
