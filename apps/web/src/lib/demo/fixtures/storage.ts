import type { StorageCategory, StorageCategoryKey, StorageItem, StorageSummary } from "../../types";
import { type Clock, minutesFrom } from "./ids";

type CategoryInfo = { label: string; description: string; tables: string[] };

const INFO: Record<StorageCategoryKey | "workspace", CategoryInfo> = {
  meetings: { label: "Meetings & transcripts", description: "Meeting records, transcript segments, speaker reviews, minutes, evidence and email delivery logs.", tables: ["meetings", "transcript_segments", "meeting_minutes", "email_deliveries"] },
  search_index: { label: "Search index", description: "Retrieval chunks and embedding vectors derived from meetings and documents. Can be rebuilt.", tables: ["knowledge_chunks", "chunk_embeddings"] },
  documents: { label: "Documents", description: "Uploaded company and knowledge-base documents with their extracted text.", tables: ["documents", "document_pages"] },
  meeting_preps: { label: "Meeting preps", description: "Generated pre-meeting briefings, organizer inputs and documents uploaded for a prep.", tables: ["prep_reports", "prep_inputs"] },
  ai_chats: { label: "AI chats", description: "Saved Ask AI conversations, answers and citations.", tables: ["knowledge_conversations", "knowledge_messages"] },
  knowledge_bases: { label: "Knowledge bases", description: "Knowledge base definitions, sharing settings and indexing jobs.", tables: ["knowledge_bases", "knowledge_base_members"] },
  calendar_cache: { label: "Calendar cache", description: "Synced calendar event snapshots. Cleared events are fetched again on the next sync.", tables: ["calendar_events", "calendar_syncs"] },
  logs: { label: "Logs", description: "Usage/cost ledger and workspace audit trail.", tables: ["usage_events", "audit_events"] },
  workspace: { label: "Workspace settings", description: "Workspace profile, memberships, AI provider settings and retention policy. Not deletable here.", tables: ["organizations", "memberships", "provider_profiles"] },
};

export type StorageItems = Record<StorageCategoryKey, StorageItem[]>;

function category(key: StorageCategoryKey | "workspace", items: StorageItem[], fixed?: { rows: number; bytes: number }): StorageCategory {
  const info = INFO[key];
  const rows = fixed?.rows ?? items.reduce((sum, item) => sum + item.rows, 0);
  const bytes = fixed?.bytes ?? items.reduce((sum, item) => sum + item.bytes, 0);
  const share = info.tables.length;
  return {
    key, label: info.label, description: info.description, rows, bytes, purgeable: key !== "workspace",
    tables: info.tables.map((name, index) => ({ name, rows: Math.round(rows / share) + (index === 0 ? rows % share : 0), bytes: Math.round(bytes / share) })),
  };
}

export function storageSummary(clock: Clock, orgId: string, items: StorageItems, includeCapture: boolean, meetingCount: number): StorageSummary {
  const keys: StorageCategoryKey[] = ["meetings", "search_index", "documents", "meeting_preps", "ai_chats", "knowledge_bases", "calendar_cache", "logs"];
  const categories = [...keys.map((key) => category(key, items[key])), category("workspace", [], { rows: 42, bytes: 38_400 })].sort((a, b) => b.bytes - a.bytes);
  return {
    organization_id: orgId, measured_at: minutesFrom(clock, 0),
    total_bytes: categories.reduce((sum, item) => sum + item.bytes, 0), total_rows: categories.reduce((sum, item) => sum + item.rows, 0), categories,
    database: { dialect: "postgresql", size_bytes: 612_000_000, note: "Whole product database, all workspaces, including indexes and free space." },
    capture: includeCapture
      ? { status: "measured", recording_bytes: meetingCount * 184_000_000, recordings: meetingCount, meetings_checked: meetingCount, meetings_with_capture: meetingCount, note: "Recordings are kept by the capture service. Sizes are reported by it and are not part of the product database." }
      : { status: "not_requested", recording_bytes: null, recordings: 0, meetings_checked: 0, meetings_with_capture: 0, note: "Measure recordings to include the capture service's storage." },
    method: "Row data measured per workspace in the product database (PostgreSQL column sizes plus row headers). Indexes, free space and other workspaces are not included; the whole database size is shown for context.",
  };
}
