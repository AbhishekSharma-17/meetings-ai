import { api } from "./meetings-service";
import type { ChunkReceipt, CreateInPersonInput, InPersonCalendarLink, InPersonSession, SpeakerNamesView } from "./in-person-types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
const base = (id: string) => `/v1/in-person/meetings/${encodeURIComponent(id)}`;

/** The result of one chunk upload, decided from the HTTP status and body. */
export type ChunkOutcome =
  | { kind: "ok"; receipt: ChunkReceipt }
  /** 409 with expected_seq: the server is missing earlier audio (or already has this piece). */
  | { kind: "gap"; expectedSeq: number; message: string }
  /** Temporary: offline, 5xx, 429 or a signed-out session. Try again later. */
  | { kind: "retry"; message: string; slowDown: boolean }
  /** Permanent for this recording: not recording any more, too large, wrong type, not the recorder. */
  | { kind: "fatal"; status: number; message: string };

export type ChunkUpload = { meetingId: string; seq: number; durationMs: number; streamStart: boolean; blob: Blob; contentType: string };

function detailOf(payload: unknown): { message: string | null; expectedSeq: number | null } {
  if (!payload || typeof payload !== "object") return { message: null, expectedSeq: null };
  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail === "string") return { message: detail, expectedSeq: null };
  if (detail && typeof detail === "object") {
    const record = detail as { message?: unknown; expected_seq?: unknown };
    return {
      message: typeof record.message === "string" ? record.message : null,
      expectedSeq: typeof record.expected_seq === "number" && Number.isInteger(record.expected_seq) ? record.expected_seq : null,
    };
  }
  return { message: null, expectedSeq: null };
}

const fatalCopy: Record<number, string> = {
  403: "Only the person who started this recording can add audio to it.",
  404: "This recording no longer exists. It may have been discarded.",
  413: "A piece of audio was larger than the server accepts.",
  415: "The server did not accept this audio format.",
};

/** Sends one numbered piece of audio. Uses its own fetch so a 409 sequence gap can be read. */
export async function uploadChunk(chunk: ChunkUpload): Promise<ChunkOutcome> {
  const query = new URLSearchParams({ seq: String(chunk.seq), duration_ms: String(chunk.durationMs), stream_start: chunk.streamStart ? "1" : "0" });
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${base(chunk.meetingId)}/chunks?${query}`, {
      method: "POST", body: chunk.blob, headers: { "content-type": chunk.contentType },
    });
  } catch {
    return { kind: "retry", message: "Could not reach Meetings AI.", slowDown: false };
  }
  const payload = await response.json().catch(() => null) as unknown;
  if (response.ok) return { kind: "ok", receipt: payload as ChunkReceipt };
  const { message, expectedSeq } = detailOf(payload);
  if (response.status === 409 && expectedSeq !== null) return { kind: "gap", expectedSeq, message: message ?? "Audio arrived out of order." };
  if (response.status === 429) return { kind: "retry", message: "The server asked us to slow down.", slowDown: true };
  if (response.status === 401) return { kind: "retry", message: "Your sign-in expired. Sign in again in another tab; the audio stays on this device.", slowDown: true };
  if (response.status >= 500 || response.status === 408) return { kind: "retry", message: "Meetings AI is temporarily unavailable.", slowDown: false };
  return { kind: "fatal", status: response.status, message: message ?? fatalCopy[response.status] ?? `Upload failed (${response.status}).` };
}

export const inPersonService = {
  create(input: CreateInPersonInput): Promise<InPersonSession> {
    return api<InPersonSession>("/v1/in-person/meetings", { method: "POST", body: JSON.stringify(input) });
  },
  /** Recordings started from calendar events: all in the workspace for admins, your own for members. */
  calendarLinks(): Promise<InPersonCalendarLink[]> {
    return api<InPersonCalendarLink[]>("/v1/in-person/calendar-links");
  },
  get(id: string): Promise<InPersonSession> {
    return api<InPersonSession>(base(id));
  },
  pause(id: string): Promise<InPersonSession> {
    return api<InPersonSession>(`${base(id)}/pause`, { method: "POST" });
  },
  resume(id: string): Promise<InPersonSession> {
    return api<InPersonSession>(`${base(id)}/resume`, { method: "POST" });
  },
  addMoment(id: string, atMs: number, label: string | null): Promise<InPersonSession> {
    return api<InPersonSession>(`${base(id)}/moments`, { method: "POST", body: JSON.stringify({ at_ms: Math.max(0, Math.round(atMs)), label }) });
  },
  /** 409 carries expected_seq when chunks up to final_seq have not all arrived (see stopOutcome). */
  async stop(id: string, finalSeq: number): Promise<{ kind: "ok"; session: InPersonSession } | { kind: "gap"; expectedSeq: number }> {
    const response = await fetch(`${API_BASE_URL}${base(id)}/stop`, {
      method: "POST", body: JSON.stringify({ final_seq: finalSeq }), headers: { "content-type": "application/json" },
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (response.ok) return { kind: "ok", session: payload as InPersonSession };
    const { message, expectedSeq } = detailOf(payload);
    if (response.status === 409 && expectedSeq !== null) return { kind: "gap", expectedSeq };
    throw new InPersonError(message ?? `Could not stop the recording (${response.status}).`, response.status);
  },
  retry(id: string): Promise<InPersonSession> {
    return api<InPersonSession>(`${base(id)}/retry`, { method: "POST" });
  },
  discard(id: string): Promise<void> {
    return api<void>(`${base(id)}/discard`, { method: "POST" });
  },
  speakerNames(id: string): Promise<SpeakerNamesView> {
    return api<SpeakerNamesView>(`${base(id)}/speaker-names`);
  },
  approveNames(id: string, approvals: Array<{ speaker: string; name: string }>): Promise<SpeakerNamesView> {
    return api<SpeakerNamesView>(`${base(id)}/speaker-names/approve`, { method: "POST", body: JSON.stringify({ approvals }) });
  },
  dismissName(id: string, speaker: string): Promise<SpeakerNamesView> {
    return api<SpeakerNamesView>(`${base(id)}/speaker-names/dismiss`, { method: "POST", body: JSON.stringify({ speaker }) });
  },
  refreshNames(id: string): Promise<SpeakerNamesView> {
    return api<SpeakerNamesView>(`${base(id)}/speaker-names/refresh`, { method: "POST" });
  },
};

export class InPersonError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** The HTTP status of a failed in-person or meetings API call, when there is one. */
export function statusOf(error: unknown): number | null {
  return error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number" ? (error as { status: number }).status : null;
}
