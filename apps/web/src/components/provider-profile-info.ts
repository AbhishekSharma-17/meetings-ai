import { AudioLines, BookOpenText, FileText, type LucideIcon } from "lucide-react";
import type { Capability, ConnectionState, ProfileKind } from "@/lib/types";
import type { Tone } from "./ui/feedback";

/** Pipeline stages on the AI providers screen. Titles feed the "Add … profile" and default labels. */
export const profileInfo: Record<ProfileKind, { title: string; description: string; capabilities: Capability[]; icon: LucideIcon }> = {
  transcription: { title: "Transcription", description: "Turns meeting audio into a speaker-attributed transcript.", capabilities: ["transcription"], icon: AudioLines },
  mom: { title: "MOM & actions", description: "Drafts minutes, decisions, action items and recap emails.", capabilities: ["text_generation"], icon: FileText },
  embedding: { title: "Knowledge embeddings", description: "Indexes approved meetings for AI knowledge search.", capabilities: ["embeddings"], icon: BookOpenText },
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
