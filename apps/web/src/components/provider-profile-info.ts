import { AudioLines, Database, FileText, type LucideIcon } from "lucide-react";
import { formatDate } from "@/lib/time-preferences";
import type { Capability, CatalogCapability, CatalogProviderType, ConnectionState, ProfileKind, ProviderProfile, VaultCredential, VaultProviderType } from "@/lib/types";
import type { Tone } from "./ui/feedback";

type ProfileKindInfo = {
  title: string;
  /** Lower-case noun used in sentences and accessible names ("Add LLM profile"). */
  noun: string;
  description: string;
  capabilities: Capability[];
  icon: LucideIcon;
  /** Catalog capability used to list models for this kind. */
  catalog: CatalogCapability;
  defaultLabel: string;
  defaultHint: string;
};

/** Pipeline stages on the AI providers screen (kinds and APIs keep their original names). */
export const profileInfo: Record<ProfileKind, ProfileKindInfo> = {
  transcription: {
    title: "Speech to text", noun: "speech-to-text", capabilities: ["transcription"], icon: AudioLines, catalog: "transcription",
    description: "Turns meeting audio into a speaker-attributed transcript.",
    defaultLabel: "Make this the default speech-to-text model",
    defaultHint: "New meetings use it. A meeting that is already being recorded keeps the model it started with.",
  },
  mom: {
    title: "LLM", noun: "LLM", capabilities: ["text_generation"], icon: FileText, catalog: "text_generation",
    description: "Writes minutes and action items; also the fallback for Ask AI and research.",
    defaultLabel: "Make this the default LLM",
    defaultHint: "Used for new minutes, and for Ask AI and research unless Workspace AI picks another model.",
  },
  embedding: {
    title: "Embeddings", noun: "embeddings", capabilities: ["embeddings"], icon: Database, catalog: "embeddings",
    description: "Indexes meetings and documents so AI search can find them.",
    defaultLabel: "Make this the default embedding model",
    // Verified in the API: uploaded documents re-embed in the background (IndexingWorker backfill);
    // meeting knowledge bases keep their old index until they are re-indexed.
    defaultHint: "Used to index meetings and documents for AI search. Documents re-index in the background; re-index a meeting knowledge base to switch it over.",
  },
};

export const profileKinds = Object.keys(profileInfo) as ProfileKind[];

export const providerOptions = ["OpenAI", "OpenRouter", "Vexa native / self-hosted", "OpenAI-compatible"];

export const capabilityLabel: Record<Capability, string> = {
  transcription: "Speech to text",
  text_generation: "Text generation",
  embeddings: "Embeddings",
};

export const connectionText: Record<ConnectionState, string> = {
  configured: "Configuration valid",
  not_configured: "Not configured",
  checking: "Checking…",
  failed: "Check failed",
};

export const connectionTone: Record<ConnectionState, Tone> = {
  configured: "success",
  not_configured: "warning",
  checking: "info",
  failed: "danger",
};

export const isUnsavedProfile = (id: string) => id.startsWith("new-");

/* ---------- Saved API keys (workspace vault) ---------- */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENAI_BASE_URL = "https://api.openai.com/v1";

export const vaultProviderLabel: Record<VaultProviderType, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  openai_compatible: "OpenAI-compatible",
  exa: "Exa web research",
  openrouter_management: "OpenRouter management key (billing only)",
  openai_admin: "OpenAI admin key (billing only)",
  exa_service: "Exa service key (billing only)",
};

export const vaultProviderOptions: { value: VaultProviderType; label: string }[] = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "openai", label: "OpenAI" },
  { value: "exa", label: "Exa (web research)" },
  { value: "openai_compatible", label: "OpenAI-compatible endpoint" },
];

export const normalizeBaseUrl = (value: string | null | undefined) => (value ?? "").trim().replace(/\/+$/, "");

/** Mirrors the server rule: a saved key is only ever sent to the host it was saved for. */
export function compatibleCredentials(profile: Pick<ProviderProfile, "provider" | "endpoint">, credentials: VaultCredential[]): VaultCredential[] {
  const endpoint = normalizeBaseUrl(profile.endpoint);
  return credentials.filter((credential) => {
    if (profile.provider === "OpenAI") return credential.provider_type === "openai" && (!endpoint || endpoint === OPENAI_BASE_URL);
    if (profile.provider === "OpenRouter") return credential.provider_type === "openrouter";
    if (profile.provider === "OpenAI-compatible") {
      if (credential.provider_type === "openrouter") return endpoint === OPENROUTER_BASE_URL;
      return credential.provider_type === "openai_compatible" && normalizeBaseUrl(credential.base_url) === endpoint;
    }
    return false;
  });
}

/** Whether a pasted key for this profile can also be saved to the workspace vault. */
export const canSaveToVault = (provider: string) => provider === "OpenAI" || provider === "OpenRouter" || provider === "OpenAI-compatible";

export function lastUsedText(value: string | null): string {
  if (!value) return "Never used";
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return "Never used";
  if (minutes < 2) return "Used just now";
  if (minutes < 60) return `Used ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Used ${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `Used ${days} d ago` : `Used ${formatDate(value)}`;
}

export function usageText(credential: VaultCredential): string {
  const parts: string[] = [];
  if (credential.used_by_profiles) parts.push(`${credential.used_by_profiles} profile${credential.used_by_profiles === 1 ? "" : "s"}`);
  if (credential.used_by_settings) parts.push("web research");
  return parts.length ? `Used by ${parts.join(" and ")}` : "Not in use";
}

/* ---------- Model catalog helpers ---------- */

/** GPT-6 routing already recommended by Workspace AI (verified 2026-09-27); shown first when listed. */
export const recommendedModelIds: Record<CatalogCapability, readonly string[]> = {
  text_generation: ["gpt-6-luna", "gpt-6-sol", "openai/gpt-6-luna", "openai/gpt-6-sol"],
  vision: ["gpt-6-luna", "openai/gpt-6-luna"],
  transcription: [],
  embeddings: [],
};

export const catalogProviderFor: Record<string, CatalogProviderType | undefined> = {
  OpenAI: "openai",
  OpenRouter: "openrouter",
  "OpenAI-compatible": "openai_compatible",
};

/** Short, non-reversible tag so a changed pasted key re-lists models without keeping the key in the request id. */
export function keyTag(secret: string): string {
  let hash = 5381;
  for (let index = 0; index < secret.length; index += 1) hash = ((hash * 33) ^ secret.charCodeAt(index)) >>> 0;
  return hash.toString(36);
}
