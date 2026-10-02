/** What each storage purge removes and what it cannot undo. Keep each note to one short sentence. */
import type { StorageCategoryKey } from "@/lib/types";

export type StorageCopy = { noun: string; nouns: string; removes: string[]; notes: string[]; rebuild?: boolean };

export const storageCopy: Record<StorageCategoryKey, StorageCopy> = {
  meetings: {
    noun: "meeting", nouns: "meetings",
    removes: ["Meeting records, transcripts, speaker reviews and minutes", "Delivery logs and the meeting's AI search data", "Saved AI chats that cite these meetings"],
    notes: ["Recordings and transcripts are also erased from the meeting recording service.", "Sent recap emails and downloaded files can't be recalled.", "Meetings that are still live are skipped."],
  },
  meeting_preps: {
    noun: "prep", nouns: "meeting preps",
    removes: ["Generated briefings and organizer inputs", "Documents uploaded for the prep and their AI search data"],
    notes: ["Calendar events stay; you can prepare again later."],
  },
  documents: {
    noun: "document", nouns: "documents",
    removes: ["Uploaded files' extracted text and summaries", "Their AI search data"],
    notes: ["Downloaded copies can't be recalled.", "Past AI answers keep the text they quoted."],
  },
  search_index: {
    noun: "search data set", nouns: "AI search data sets",
    removes: ["Data prepared for AI search"],
    notes: ["Meetings and documents are kept, so AI search data can be prepared again.", "AI knowledge answers may be less complete until search data is prepared again."],
    rebuild: true,
  },
  knowledge_bases: {
    noun: "knowledge base", nouns: "knowledge bases",
    removes: ["The knowledge base, its sharing settings and AI search data", "Its documents and saved AI chats"],
    notes: ["Meetings are kept but leave the knowledge base."],
  },
  ai_chats: {
    noun: "conversation", nouns: "AI chats",
    removes: ["Saved questions, answers and citations"],
    notes: ["Copied or exported answers can't be recalled."],
  },
  calendar_cache: {
    noun: "calendar account", nouns: "saved calendar events",
    removes: ["Previously synced calendar events"],
    notes: ["Events are fetched again on the next sync.", "Events with a meeting prep are kept."],
  },
  logs: {
    noun: "log", nouns: "logs",
    removes: ["Usage and cost history and/or audit trail entries"],
    notes: ["Cost reports lose the deleted history.", "This deletion is itself recorded in the audit trail."],
  },
};
