import { AudioLines, Database, FileText, type LucideIcon } from "lucide-react";
import type { Capability, ConnectionState, ProfileKind, ProviderProfile, VaultCredential, VaultProviderType } from "@/lib/types";
import type { Tone } from "./ui/feedback";

/** Pipeline stages on the AI providers screen. Titles feed the "Add … profile" and default labels. */
export const profileInfo: Record<ProfileKind, { title: string; description: string; capabilities: Capability[]; icon: LucideIcon }> = {
  transcription: { title: "Transcription", description: "Turns meeting audio into a speaker-attributed transcript.", capabilities: ["transcription"], icon: AudioLines },
  mom: { title: "MOM & actions", description: "Drafts minutes, decisions, action items and recap emails.", capabilities: ["text_generation"], icon: FileText },
  embedding: { title: "Knowledge embeddings", description: "Indexes approved meetings for AI knowledge search.", capabilities: ["embeddings"], icon: Database },
};

export const profileKinds = Object.keys(profileInfo) as ProfileKind[];

export const providerOptions = ["OpenAI", "OpenRouter", "Vexa native / self-hosted", "OpenAI-compatible"];

export const capabilityLabel: Record<Capability, string> = {
  transcription: "Transcription",
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
  return days < 30 ? `Used ${days} d ago` : `Used ${new Date(value).toLocaleDateString()}`;
}

export function usageText(credential: VaultCredential): string {
  const parts: string[] = [];
  if (credential.used_by_profiles) parts.push(`${credential.used_by_profiles} profile${credential.used_by_profiles === 1 ? "" : "s"}`);
  if (credential.used_by_settings) parts.push("web research");
  return parts.length ? `Used by ${parts.join(" and ")}` : "Not in use";
}
