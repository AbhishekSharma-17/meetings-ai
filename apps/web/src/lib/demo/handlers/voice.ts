import type { VoiceSampleHolder, VoiceSampleStatus } from "../../voice-sample-service";
import { OWNER_ID } from "../fixtures/people";
import { json, noContent, notify, problem } from "../http";
import type { DemoRouter } from "../router";
import type { DemoStore } from "../store";

/**
 * The visitor's voice sample (`/v1/me/voice-sample`), kept in this tab's memory only. The demo never
 * records the microphone: the sample is a quiet clip the page generates, so playback still works.
 */
type DemoSample = { blob: Blob; durationMs: number; updatedAt: string };

const samples = new WeakMap<DemoStore, DemoSample>();
const MIN_MS = 5_000;
const MAX_MS = 10_000;
const MAX_BYTES = 1024 * 1024;

function statusOf(store: DemoStore): VoiceSampleStatus {
  const sample = samples.get(store);
  return {
    sample: sample ? { mime_type: sample.blob.type.split(";")[0] || "audio/wav", duration_ms: sample.durationMs, byte_size: sample.blob.size, updated_at: sample.updatedAt } : null,
    matching: { status: "available", message: "Your workspace's speech-to-text model uses voice samples to suggest names." },
    min_duration_ms: MIN_MS, max_duration_ms: MAX_MS, max_bytes: MAX_BYTES,
  };
}

export function registerVoiceSamples(router: DemoRouter): void {
  router
    .on("GET", "/v1/me/voice-sample", ({ store }) => json(statusOf(store)))
    .on("PUT", "/v1/me/voice-sample", ({ store, form }) => {
      const file = form?.get("file");
      const durationMs = Number(form?.get("duration_ms"));
      if (!(file instanceof Blob) || !file.type.startsWith("audio/")) return problem(415, "upload WebM, MP4, Ogg or WAV audio");
      if (file.size > MAX_BYTES) return problem(413, "a voice sample can be at most 1 MB");
      if (!Number.isFinite(durationMs) || durationMs < MIN_MS || durationMs > MAX_MS) return problem(422, "a voice sample must be between 5 and 10 seconds long");
      samples.set(store, { blob: file, durationMs: Math.round(durationMs), updatedAt: new Date().toISOString() });
      notify("Demo: your voice sample stays in this browser tab only and disappears when you leave the demo.");
      return json(statusOf(store));
    })
    .on("DELETE", "/v1/me/voice-sample", ({ store }) => { samples.delete(store); return noContent(); })
    .on("GET", "/v1/me/voice-sample/audio", ({ store }) => {
      const sample = samples.get(store);
      if (!sample) return problem(404, "you have no voice sample in this workspace");
      return new Response(sample.blob, { status: 200, headers: { "content-type": sample.blob.type || "audio/wav", "cache-control": "no-store" } });
    })
    .on("GET", "/v1/workspace/voice-samples", ({ store }) => {
      const sample = samples.get(store);
      const holders: VoiceSampleHolder[] = sample ? [{ user_id: OWNER_ID, display_name: store.displayName, duration_ms: sample.durationMs, updated_at: sample.updatedAt }] : [];
      return json(holders);
    });
}
