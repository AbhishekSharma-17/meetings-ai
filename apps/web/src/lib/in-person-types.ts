/** In-person recording: the API contract for meetings recorded from a phone or laptop browser. */

export type InPersonStatus = "recording" | "paused" | "finalizing" | "done" | "failed";
export type InPersonDevice = "phone" | "laptop" | "unknown";
export type FinalizeStage = "queued" | "assembling" | "transcribing" | "reconciling" | "naming" | "saving" | "done" | "failed";

export type InPersonCaption = { seq: number; start_ms: number; text: string };
export type InPersonMoment = { at_ms: number; label: string | null };

export type InPersonSession = {
  meeting_id: string;
  title: string;
  status: InPersonStatus;
  device: InPersonDevice;
  recorded_by: { user_id: string; display_name: string | null };
  is_recorder: boolean;
  consent: { everyone_agreed: true; notice_shown: boolean; agreed_at: string };
  /** Base type the server expects in content-type, e.g. "audio/webm" or "audio/mp4". */
  mime_type: string;
  started_at: string;
  stopped_at: string | null;
  /** -1 before the first chunk. */
  last_seq: number;
  received_chunks: number;
  duration_ms: number;
  total_bytes: number;
  /** Live preview, oldest first, at most 40. */
  captions: InPersonCaption[];
  moments: InPersonMoment[];
  finalize: { stage: FinalizeStage; message: string | null; parts_total: number; parts_done: number } | null;
  /** Known once done. */
  speaker_labels: "diarized" | "single" | null;
  error: string | null;
  limits: { max_chunk_bytes: number; max_total_bytes: number; max_duration_ms: number; chunk_ms: number };
};

export type CalendarEventLink = { connection_id: string; event_id: string; event_date: string; timezone: string };

export type CreateInPersonInput = {
  title?: string | null;
  language?: string | null;
  device: InPersonDevice;
  mime_type: string;
  consent: { everyone_agreed: true; notice_shown: boolean };
  expected_people?: string[];
  calendar_event?: CalendarEventLink | null;
};

export type ChunkReceipt = { seq: number; duplicate: boolean; last_seq: number; received_chunks: number; duration_ms: number; total_bytes: number };

export type SpeakerNameEvidence = { quote: string; at_seconds: number; kind: "addressed" | "self_introduction" | "expected_person" | "invitee" };

export type SpeakerNameRow = {
  /** Raw label, e.g. "Speaker A". */
  speaker: string;
  segments: number;
  first_at_seconds: number;
  /** A short line they said. */
  sample: string | null;
  /** Approved name, if any. */
  current_name: string | null;
  state: "suggested" | "approved" | "dismissed" | "none";
  suggestion: { name: string; confidence: "high" | "medium" | "low"; reason: string; evidence: SpeakerNameEvidence[] } | null;
};

export type SpeakerNamesView = {
  status: "pending" | "ready" | "unavailable" | "not_applicable";
  message: string | null;
  single_speaker: boolean;
  speakers: SpeakerNameRow[];
};

/** An in-person recording started from a calendar event (matched by connection_id + event_id). */
export type InPersonCalendarLink = { meeting_id: string; connection_id: string; event_id: string; status: InPersonStatus; title: string | null };

/** What an entry point (Home, Meetings, Calendar, a calendar event) hands to the recorder. */
export type InPersonSeed = {
  title: string | null;
  expectedPeople: string[];
  calendarEvent: CalendarEventLink | null;
};
