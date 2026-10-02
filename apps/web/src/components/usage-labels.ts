/** Plain-language names and number formats for usage, cost and storage records (keys come from the API). */
import type { Tone } from "./ui/feedback";
import { formatDate as formatZonedDate, formatDateTime } from "@/lib/time-preferences";

const purposeNames: Record<string, string> = {
  mom_generation: "Minutes drafting",
  personal_mom: "Personal MOM drafting",
  knowledge_answer: "AI knowledge answers",
  knowledge_chat: "AI knowledge answers",
  knowledge_query_plan: "AI knowledge question planning",
  knowledge_search: "Knowledge search",
  knowledge_index: "Knowledge indexing",
  knowledge_embedding: "Knowledge indexing",
  meeting_prep: "Meeting prep briefs",
  meeting_prep_planning: "Meeting prep planning",
  meeting_prep_repair: "Meeting prep brief repair",
  meeting_prep_research: "Meeting prep research",
  apollo_connection_test: "Apollo connection check",
  apollo_credit_check: "Apollo credit check",
  meeting_transcription: "Meeting transcription",
  in_person_transcription: "In-person transcription",
  in_person_live_preview: "In-person live captions",
  in_person_speaker_naming: "In-person speaker names",
  in_person_speaker_continuity: "In-person speaker matching",
  document_vision: "Document reading (OCR)",
  document_embedding: "Document indexing",
  credential_test: "API key check",
  transcription: "Transcription",
  search: "Web search",
  contents: "Web page reading",
  vision: "Image understanding",
  llm: "Text generation",
  embedding: "Embeddings",
};

const providerNames: Record<string, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  openai_compatible: "OpenAI-compatible",
  anthropic: "Anthropic",
  vexa: "Vexa",
  vexa_native: "Vexa",
  exa: "Exa",
  apollo: "Apollo",
  unknown: "Unknown provider",
};

const kindNames: Record<string, string> = {
  llm: "Text generation",
  embedding: "Embeddings",
  vision: "Vision / OCR",
  transcription: "Transcription",
  search: "Web search",
  contents: "Web page reading",
  apollo: "Apollo data",
};

const kindTones: Record<string, Tone> = {
  llm: "brand", embedding: "info", vision: "info", transcription: "warning", search: "success", contents: "success", apollo: "info",
};

const unitNames: Record<string, [string, string]> = {
  audio_seconds: ["second of audio", "seconds of audio"],
  results: ["result", "results"],
  pages: ["page", "pages"],
  records: ["record", "records"],
  requests: ["request", "requests"],
  search_calls: ["search", "searches"],
  tokens: ["token", "tokens"],
};

const sentence = (value: string) => {
  const words = value.replaceAll(/[_-]+/g, " ").trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "Other";
};

export const purposeLabel = (value: string): string => purposeNames[value] ?? sentence(value);
export const providerLabel = (value: string): string => providerNames[value.toLowerCase()] ?? sentence(value);
export const kindLabel = (value: string): string => kindNames[value] ?? sentence(value);
export const kindTone = (value: string): Tone => kindTones[value] ?? "neutral";
export const statusLabel = (value: string): string => value === "succeeded" ? "Succeeded" : value === "failed" ? "Failed" : sentence(value);
export const detailLabel = (value: string): string => sentence(value);

export function unitsLabel(units: number | null, unitType: string | null): string {
  if (units === null || unitType === null) return "—";
  if (unitType === "audio_seconds") return formatDuration(units * 1000);
  const [one, many] = unitNames[unitType] ?? [sentence(unitType).toLowerCase(), sentence(unitType).toLowerCase()];
  return `${formatNumber(units)} ${units === 1 ? one : many}`;
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(value < 0.0001 ? 6 : 4)}`;
  return `$${value.toFixed(value < 10 ? 3 : 2)}`;
}

export const formatNumber = (value: number): string => Math.round(value * 100) / 100 === Math.round(value)
  ? Math.round(value).toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 10) return `${minutes} min ${Math.round(seconds % 60)} s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}

export function formatWhen(value: string | null): string {
  if (!value) return "—";
  return formatDateTime(value);
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  return formatZonedDate(value);
}

/** Deletion counters in the purge result use table-ish keys; show them as words. */
export const countLabel = (key: string, count: number): string => `${count.toLocaleString()} ${sentence(key).toLowerCase().replace(/s$/, count === 1 ? "" : "s")}`;
