import type { AiSettingsView, CatalogCapability, CatalogModel, CatalogProviderType, KnowledgeTextProfile, VaultCredential } from "../../types";
import { type Clock, credentialId, minutesFrom, profileId } from "./ids";

export type BackendProfile = {
  id: string; name: string; provider_type: "openai" | "openai_compatible" | "vexa_native"; execution_location: "local" | "cloud";
  base_url: string | null; capabilities: Array<{ capability: "transcription" | "text_generation" | "embeddings"; model: string }>;
  credential_configured: boolean; credential_hint: string | null; credential_id: string | null; credential_label: string | null;
};
export type BackendDefault = { capability: string; ordered_profile_ids: string[] };

export const OPENROUTER_URL = "https://openrouter.ai/api/v1";
export const KEY_OPENAI = credentialId(1);
export const KEY_OPENROUTER = credentialId(2);
export const KEY_EXA = credentialId(3);
export const PROFILE_MINUTES = profileId(1);
export const PROFILE_FAST = profileId(2);
export const PROFILE_STT = profileId(3);
export const PROFILE_STT_ALT = profileId(4);
export const PROFILE_EMBED = profileId(5);

export function credentials(clock: Clock): VaultCredential[] {
  return [
    { id: KEY_OPENAI, label: "OpenAI production", provider_type: "openai", base_url: null, hint: "sk-…7Qa2", created_at: minutesFrom(clock, -60 * 24 * 120), updated_at: minutesFrom(clock, -60 * 24 * 40), last_used_at: minutesFrom(clock, -6), used_by_profiles: 3, used_by_settings: false },
    { id: KEY_OPENROUTER, label: "OpenRouter team", provider_type: "openrouter", base_url: OPENROUTER_URL, hint: "sk-or-…c81f", created_at: minutesFrom(clock, -60 * 24 * 60), updated_at: minutesFrom(clock, -60 * 24 * 60), last_used_at: minutesFrom(clock, -3), used_by_profiles: 2, used_by_settings: true },
    { id: KEY_EXA, label: "Exa research", provider_type: "exa", base_url: null, hint: "…4e9d", created_at: minutesFrom(clock, -60 * 24 * 30), updated_at: minutesFrom(clock, -60 * 24 * 30), last_used_at: minutesFrom(clock, -60 * 20), used_by_profiles: 0, used_by_settings: true },
  ];
}

export function profiles(): BackendProfile[] {
  const openai = { credential_configured: true, credential_hint: "sk-…7Qa2", credential_id: KEY_OPENAI, credential_label: "OpenAI production" };
  const router = { credential_configured: true, credential_hint: "sk-or-…c81f", credential_id: KEY_OPENROUTER, credential_label: "OpenRouter team" };
  return [
    { id: PROFILE_MINUTES, name: "GPT-6 via OpenRouter", provider_type: "openai_compatible", execution_location: "cloud", base_url: OPENROUTER_URL, capabilities: [{ capability: "text_generation", model: "openai/gpt-6-sol" }], ...router },
    { id: PROFILE_FAST, name: "GPT-6 Luna (OpenAI)", provider_type: "openai", execution_location: "cloud", base_url: null, capabilities: [{ capability: "text_generation", model: "gpt-6-luna" }], ...openai },
    { id: PROFILE_STT, name: "OpenAI transcription", provider_type: "openai", execution_location: "cloud", base_url: null, capabilities: [{ capability: "transcription", model: "gpt-4o-transcribe" }], ...openai },
    { id: PROFILE_STT_ALT, name: "OpenRouter speech-to-text", provider_type: "openai_compatible", execution_location: "cloud", base_url: OPENROUTER_URL, capabilities: [{ capability: "transcription", model: "openai/whisper-large-v3" }], ...router },
    { id: PROFILE_EMBED, name: "OpenAI embeddings", provider_type: "openai", execution_location: "cloud", base_url: null, capabilities: [{ capability: "embeddings", model: "text-embedding-3-small" }], ...openai },
  ];
}

export function providerDefaults(): BackendDefault[] {
  return [
    { capability: "transcription", ordered_profile_ids: [PROFILE_STT, PROFILE_STT_ALT] },
    { capability: "text_generation", ordered_profile_ids: [PROFILE_MINUTES] },
    { capability: "embeddings", ordered_profile_ids: [PROFILE_EMBED] },
  ];
}

export type AiSettingsState = Omit<AiSettingsView, "can_edit" | "effective_chat" | "automatic_vision" | "research_credential_label" | "vision_configured" | "research_configured">;

export function aiSettings(clock: Clock): AiSettingsState {
  return {
    chat_profile_id: PROFILE_MINUTES, chat_model: "openai/gpt-6-luna", vision_profile_id: PROFILE_MINUTES, vision_model: "openai/gpt-6-luna",
    research_credential_id: KEY_EXA, research_profile_id: PROFILE_MINUTES, research_model: "openai/gpt-6-sol",
    updated_at: minutesFrom(clock, -60 * 24 * 6), updated_by: "Alex Morgan",
  };
}

export function textProfiles(list: BackendProfile[]): KnowledgeTextProfile[] {
  return list.filter((profile) => profile.capabilities.some((item) => item.capability === "text_generation"))
    .map((profile) => ({ id: profile.id, name: profile.name, provider_type: profile.provider_type, base_url: profile.base_url, capabilities: profile.capabilities }));
}

type Row = [id: string, name: string, vendor: string, input: number | null, output: number | null, extra?: Partial<CatalogModel>];
const row = ([id, name, vendor, input, output, extra]: Row): CatalogModel => ({
  id, name, vendor, input_per_million_usd: input, output_per_million_usd: output, usd_per_minute: null, context_length: 400_000, accepts_images: null, ...extra,
});

const OPENAI_MODELS: Record<CatalogCapability, Row[]> = {
  text_generation: [["gpt-6-sol", "GPT-6 Sol", "OpenAI", 2, 10], ["gpt-6-luna", "GPT-6 Luna", "OpenAI", 0.1, 0.5, { accepts_images: true }], ["gpt-6-astra", "GPT-6 Astra", "OpenAI", 10, 50], ["gpt-5-mini", "GPT-5 mini", "OpenAI", 0.25, 2]],
  vision: [["gpt-6-luna", "GPT-6 Luna", "OpenAI", 0.1, 0.5, { accepts_images: true }], ["gpt-6-sol", "GPT-6 Sol", "OpenAI", 2, 10, { accepts_images: true }]],
  transcription: [["gpt-4o-transcribe", "GPT-4o Transcribe", "OpenAI", null, null, { usd_per_minute: 0.006, context_length: null }], ["gpt-4o-mini-transcribe", "GPT-4o mini Transcribe", "OpenAI", null, null, { usd_per_minute: 0.003, context_length: null }], ["whisper-1", "Whisper", "OpenAI", null, null, { usd_per_minute: 0.006, context_length: null }]],
  embeddings: [["text-embedding-3-small", "Text Embedding 3 Small", "OpenAI", 0.02, null, { context_length: 8191 }], ["text-embedding-3-large", "Text Embedding 3 Large", "OpenAI", 0.13, null, { context_length: 8191 }]],
};

const ROUTER_MODELS: Record<CatalogCapability, Row[]> = {
  text_generation: [
    ["openai/gpt-6-sol", "GPT-6 Sol", "OpenAI", 2, 10], ["openai/gpt-6-luna", "GPT-6 Luna", "OpenAI", 0.1, 0.5, { accepts_images: true }],
    ["anthropic/claude-sonnet-5", "Claude Sonnet 5", "Anthropic", 3, 15, { accepts_images: true }], ["google/gemini-3-flash", "Gemini 3 Flash", "Google", 0.3, 2.5, { accepts_images: true, context_length: 1_000_000 }],
    ["meta-llama/llama-4-maverick", "Llama 4 Maverick", "Meta", 0.15, 0.6], ["mistralai/mistral-large-3", "Mistral Large 3", "Mistral", 2, 6],
  ],
  vision: [["openai/gpt-6-luna", "GPT-6 Luna", "OpenAI", 0.1, 0.5, { accepts_images: true }], ["google/gemini-3-flash", "Gemini 3 Flash", "Google", 0.3, 2.5, { accepts_images: true }], ["anthropic/claude-sonnet-5", "Claude Sonnet 5", "Anthropic", 3, 15, { accepts_images: true }]],
  transcription: [["openai/whisper-large-v3", "Whisper Large v3", "OpenAI", null, null, { usd_per_minute: 0.002, context_length: null }], ["microsoft/mai-transcribe-2", "MAI Transcribe 2", "Microsoft", null, null, { usd_per_minute: 0.004, context_length: null }]],
  embeddings: [["openai/text-embedding-3-small", "Text Embedding 3 Small", "OpenAI", 0.02, null, { context_length: 8191 }], ["qwen/qwen3-embedding-8b", "Qwen3 Embedding 8B", "Qwen", 0.01, null, { context_length: 32_000 }]],
};

export function catalogModels(provider: CatalogProviderType, capability: CatalogCapability): CatalogModel[] {
  const table = provider === "openai" ? OPENAI_MODELS : ROUTER_MODELS;
  return (table[capability] ?? []).map(row);
}
