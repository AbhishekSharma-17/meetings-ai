import { api } from "./meetings-service";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

export type VoiceSampleMatching = {
  /** available: the speech-to-text model uses voice samples; unsupported / not_configured: it doesn't. */
  status: "available" | "unsupported" | "not_configured";
  message: string;
};

export type VoiceSample = { mime_type: string; duration_ms: number; byte_size: number; updated_at: string };

export type VoiceSampleStatus = {
  sample: VoiceSample | null;
  matching: VoiceSampleMatching;
  min_duration_ms: number;
  max_duration_ms: number;
  max_bytes: number;
};

export type VoiceSampleHolder = { user_id: string; display_name: string; duration_ms: number; updated_at: string };

const PATH = "/v1/me/voice-sample";

/** A failed request: the HTTP status and the server's (already user-safe) explanation. */
export class VoiceSampleError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function failure(response: Response, fallback: string): Promise<VoiceSampleError> {
  // These two calls can't use api() (multipart body, binary reply), so they raise the same sign-in prompt it does.
  if (response.status === 401) window.dispatchEvent(new Event("meetings-ai-session-expired"));
  const payload = await response.json().catch(() => null) as { detail?: unknown } | null;
  const detail = typeof payload?.detail === "string" ? payload.detail : null;
  const message = detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : fallback;
  return new VoiceSampleError(message.endsWith(".") ? message : `${message}.`, response.status);
}

export const voiceSampleService = {
  status(): Promise<VoiceSampleStatus> {
    return api<VoiceSampleStatus>(PATH);
  },

  async save(audio: Blob, durationMs: number): Promise<VoiceSampleStatus> {
    const body = new FormData();
    body.append("file", audio, `voice-sample.${audio.type.includes("mp4") ? "m4a" : audio.type.includes("wav") ? "wav" : audio.type.includes("ogg") ? "ogg" : "webm"}`);
    body.append("duration_ms", String(Math.round(durationMs)));
    const response = await fetch(`${API_BASE_URL}${PATH}`, { method: "PUT", body });
    if (!response.ok) throw await failure(response, "Your voice sample could not be saved. Try again.");
    return await response.json() as VoiceSampleStatus;
  },

  async remove(): Promise<void> {
    await api<void>(PATH, { method: "DELETE" });
  },

  /** The owner's own sample as a Blob (the API serves it to nobody else). */
  async audio(): Promise<Blob> {
    const response = await fetch(`${API_BASE_URL}${PATH}/audio`, { cache: "no-store" });
    if (!response.ok) throw await failure(response, "Your voice sample could not be loaded. Try again.");
    return response.blob();
  },

  /** Owners and admins: who has a sample (names only, never audio). */
  holders(): Promise<VoiceSampleHolder[]> {
    return api<VoiceSampleHolder[]>("/v1/workspace/voice-samples");
  },
};
