import type { Page, Route } from "@playwright/test";

/**
 * Browser media fakes for the in-person recorder: getUserMedia, enumerateDevices, MediaRecorder
 * (small Blobs on a short timeslice), AudioContext (a moving level) and the screen wake lock.
 * Counters on window let tests assert what was (or was not) touched.
 */
export async function installMediaFakes(page: Page, options: { denyMic?: boolean; chunkMs?: number } = {}) {
  await page.addInitScript(({ denyMic, chunkMs }) => {
    const w = window as unknown as Record<string, unknown>;
    w.__IN_PERSON_TEST_CHUNK_MS = chunkMs;
    w.__gumCalls = 0; w.__recorders = 0; w.__wakeLocks = 0; w.__wakeReleased = 0;
    const devices = [
      { kind: "audioinput", deviceId: "mic-1", label: "Built-in microphone", groupId: "a" },
      { kind: "audioinput", deviceId: "mic-2", label: "USB conference microphone", groupId: "b" },
    ];
    const media = navigator.mediaDevices ?? {};
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
    Object.defineProperty(media, "getUserMedia", { configurable: true, value: async () => {
      w.__gumCalls = (w.__gumCalls as number) + 1;
      if (denyMic) throw new DOMException("Permission denied", "NotAllowedError");
      return new MediaStream();
    } });
    Object.defineProperty(media, "enumerateDevices", { configurable: true, value: async () => devices });

    class FakeRecorder extends EventTarget {
      static isTypeSupported(type: string) { return type.startsWith("audio/webm"); }
      state: "inactive" | "recording" | "paused" = "inactive";
      mimeType: string;
      private timer: number | undefined;
      constructor(_stream: MediaStream, init?: { mimeType?: string }) {
        super();
        this.mimeType = init?.mimeType ?? "audio/webm";
        w.__recorders = (w.__recorders as number) + 1;
      }
      start(slice: number) { this.state = "recording"; this.timer = window.setInterval(() => { if (this.state === "recording") this.emit(); }, slice); }
      pause() { this.state = "paused"; }
      resume() { this.state = "recording"; }
      stop() {
        window.clearInterval(this.timer);
        const wasActive = this.state !== "inactive";
        this.state = "inactive";
        if (wasActive) this.emit();
        this.dispatchEvent(new Event("stop"));
      }
      private emit() {
        const event = new Event("dataavailable") as Event & { data: Blob };
        Object.defineProperty(event, "data", { value: new Blob([new Uint8Array(64)], { type: this.mimeType }) });
        this.dispatchEvent(event);
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FakeRecorder });

    class FakeAudioContext {
      createAnalyser() {
        return { fftSize: 1024, getFloatTimeDomainData(buffer: Float32Array) { const t = Date.now() / 300; for (let i = 0; i < buffer.length; i++) buffer[i] = 0.12 * Math.sin(i / 8 + t); }, connect() {} };
      }
      createMediaStreamSource() { return { connect() {} }; }
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => {
      w.__wakeLocks = (w.__wakeLocks as number) + 1;
      return { release: async () => { w.__wakeReleased = (w.__wakeReleased as number) + 1; }, addEventListener() {} };
    } } });
  }, { denyMic: options.denyMic ?? false, chunkMs: options.chunkMs ?? 400 });
}

export const MEETING_ID = "00000000-0000-4000-8000-0000000000a1";
const OWNER = { user_id: "00000000-0000-4000-8000-000000000002", organization_id: "00000000-0000-4000-8000-000000000001", email: "alex@example.test", display_name: "Alex Morgan", must_change_password: false };
const STAGES = ["queued", "transcribing", "naming", "done"] as const;

type Row = { speaker: string; segments: number; first_at_seconds: number; sample: string | null; current_name: string | null; state: string; suggestion: unknown };

export type InPersonMockState = {
  createBodies: Array<Record<string, unknown>>;
  chunkSeqs: number[];
  streamStarts: number[];
  contentTypes: string[];
  stopBodies: unknown[];
  approveBodies: unknown[];
  moments: unknown[];
  status: "none" | "recording" | "paused" | "finalizing" | "done" | "failed";
  finalizePolls: number;
  failFinalize: boolean;
  createError: { status: number; detail: string } | null;
  /** Chunk uploads answer 503, so audio piles up on the device. */
  failChunks: boolean;
  rows: Row[];
  names: Record<string, string>;
};

function session(state: InPersonMockState) {
  const received = state.chunkSeqs.length;
  const stage = state.status === "finalizing" ? STAGES[Math.min(state.finalizePolls, STAGES.length - 1)] : state.status === "done" ? "done" : state.status === "failed" ? "failed" : null;
  return {
    meeting_id: MEETING_ID, title: String(state.createBodies[0]?.title ?? "In-person meeting"), status: state.status === "none" ? "recording" : state.status,
    device: "laptop", recorded_by: { user_id: OWNER.user_id, display_name: OWNER.display_name }, is_recorder: true,
    consent: { everyone_agreed: true, notice_shown: Boolean((state.createBodies[0]?.consent as { notice_shown?: boolean } | undefined)?.notice_shown), agreed_at: "2026-09-29T10:00:00Z" },
    mime_type: "audio/webm", started_at: "2026-09-29T10:00:00Z", stopped_at: state.status === "recording" || state.status === "paused" ? null : "2026-09-29T10:20:00Z",
    last_seq: received - 1, received_chunks: received, duration_ms: received * 400, total_bytes: received * 64,
    captions: state.chunkSeqs.slice(0, 40).map((seq) => ({ seq, start_ms: seq * 400, text: `Caption line ${seq + 1} from the room.` })),
    moments: state.moments, finalize: stage ? { stage, message: state.status === "failed" ? "Speech-to-text timed out." : null, parts_total: 3, parts_done: Math.min(3, state.finalizePolls) } : null,
    speaker_labels: state.status === "done" ? "diarized" : null, error: state.status === "failed" ? "Speech-to-text timed out after three attempts." : null,
    limits: { max_chunk_bytes: 5_000_000, max_total_bytes: 500_000_000, max_duration_ms: 14_400_000, chunk_ms: 15_000 },
  };
}

function meeting(state: InPersonMockState) {
  const status = state.status === "done" ? "completed" : state.status === "finalizing" ? "stopping" : state.status === "failed" ? "failed" : "active";
  return {
    id: MEETING_ID, title: String(state.createBodies[0]?.title ?? "Office design review"), meeting_url: "", platform: "in_person", status, bot_name: "Meetings AI",
    created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:20:00Z", joined_at: "2026-09-29T10:00:00Z", stopped_at: status === "completed" ? "2026-09-29T10:20:00Z" : null,
  };
}

function segments(state: InPersonMockState) {
  const lines: Array<[string, string]> = [["Speaker A", "Thanks everyone, I'm Alex. Let's review the office design."], ["Speaker B", "Alex, I think the quiet room should move next to the kitchen."], ["Speaker A", "Good point, Priya. Let's agree that today."]];
  return lines.map(([raw, text], index) => ({ segment_id: `ip-${index + 1}`, raw_speaker: raw, speaker: state.names[raw] ?? raw, text, start_seconds: index * 6, end_seconds: index * 6 + 5, completed: true }));
}

export function speakerRows(): Row[] {
  return [
    { speaker: "Speaker A", segments: 2, first_at_seconds: 0, sample: "Thanks everyone, I'm Alex.", current_name: null, state: "suggested",
      suggestion: { name: "Alex Morgan", confidence: "high", reason: "Introduced themselves as Alex", evidence: [{ quote: "I'm Alex", at_seconds: 0, kind: "self_introduction" }] } },
    { speaker: "Speaker B", segments: 1, first_at_seconds: 6, sample: "Alex, I think the quiet room should move.", current_name: null, state: "suggested",
      suggestion: { name: "Priya Shah", confidence: "medium", reason: "Speaker A called them Priya right after", evidence: [{ quote: "Good point, Priya.", at_seconds: 12, kind: "addressed" }] } },
  ];
}

export function newState(): InPersonMockState {
  return { createBodies: [], chunkSeqs: [], streamStarts: [], contentTypes: [], stopBodies: [], approveBodies: [], moments: [], status: "none", finalizePolls: 0, failFinalize: false, createError: null, failChunks: false, rows: speakerRows(), names: {} };
}

/** Mocks every /v1 route the recorder and the in-person meeting page use. */
export async function mockInPersonApi(page: Page, state: InPersonMockState, role: "owner" | "member" = "owner") {
  await page.route("**/v1/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const ip = `/v1/in-person/meetings/${MEETING_ID}`;
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === "/v1/auth/session") return reply({ authenticated: true });
    if (path === "/v1/auth/me") return reply({ ...OWNER, role });
    if (path === "/v1/provider-profiles" || path === "/v1/provider-defaults") return reply([]);
    if (path === "/v1/meetings" && method === "GET") return reply({ items: state.status === "none" ? [] : [meeting(state)], count: state.status === "none" ? 0 : 1 });
    if (path === "/v1/in-person/meetings" && method === "POST") {
      state.createBodies.push(request.postDataJSON());
      if (state.createError) return reply({ detail: state.createError.detail }, state.createError.status);
      state.status = "recording";
      return reply(session(state), 201);
    }
    if (path === `${ip}/chunks`) {
      if (state.failChunks) return reply({ detail: "Temporarily unavailable." }, 503);
      const seq = Number(url.searchParams.get("seq"));
      const expected = state.chunkSeqs.length;
      if (seq < expected) return reply({ seq, duplicate: true, last_seq: expected - 1, received_chunks: expected, duration_ms: expected * 400, total_bytes: expected * 64 });
      if (seq > expected) return reply({ detail: { message: "Missing earlier audio.", expected_seq: expected } }, 409);
      state.chunkSeqs.push(seq);
      state.streamStarts.push(Number(url.searchParams.get("stream_start")));
      state.contentTypes.push(request.headers()["content-type"] ?? "");
      return reply({ seq, duplicate: false, last_seq: seq, received_chunks: seq + 1, duration_ms: (seq + 1) * 400, total_bytes: (seq + 1) * 64 });
    }
    if (path === `${ip}/pause`) { state.status = "paused"; return reply(session(state)); }
    if (path === `${ip}/resume`) { state.status = "recording"; return reply(session(state)); }
    if (path === `${ip}/moments`) { state.moments.push(request.postDataJSON()); return reply(session(state)); }
    if (path === `${ip}/stop`) {
      const body = request.postDataJSON() as { final_seq: number };
      state.stopBodies.push(body);
      if (body.final_seq !== state.chunkSeqs.length - 1) return reply({ detail: { message: "Audio still arriving.", expected_seq: state.chunkSeqs.length } }, 409);
      state.status = "finalizing";
      return reply(session(state));
    }
    if (path === `${ip}/retry`) { state.status = "finalizing"; state.failFinalize = false; state.finalizePolls = 0; return reply(session(state)); }
    if (path === ip) {
      if (state.status === "finalizing") {
        state.finalizePolls += 1;
        if (state.failFinalize && state.finalizePolls >= 2) state.status = "failed";
        else if (state.finalizePolls >= STAGES.length - 1) state.status = "done";
      }
      return reply(session(state));
    }
    if (path === `${ip}/speaker-names`) return reply({ status: "ready", message: null, single_speaker: false, speakers: state.rows });
    if (path === `${ip}/speaker-names/approve`) {
      const body = request.postDataJSON() as { approvals: Array<{ speaker: string; name: string }> };
      state.approveBodies.push(body);
      for (const item of body.approvals) state.names[item.speaker] = item.name;
      state.rows = state.rows.map((row) => state.names[row.speaker] ? { ...row, state: "approved", current_name: state.names[row.speaker] } : row);
      return reply({ status: "ready", message: null, single_speaker: false, speakers: state.rows });
    }
    if (path === `${ip}/speaker-names/dismiss`) {
      const body = request.postDataJSON() as { speaker: string };
      state.rows = state.rows.map((row) => row.speaker === body.speaker ? { ...row, state: "dismissed" } : row);
      return reply({ status: "ready", message: null, single_speaker: false, speakers: state.rows });
    }
    if (path === `/v1/meetings/${MEETING_ID}`) return reply(meeting(state));
    if (path === `/v1/meetings/${MEETING_ID}/transcript`) return reply({ segments: state.status === "done" ? segments(state) : [] });
    if (path === `/v1/meetings/${MEETING_ID}/participants`) return reply({ meeting_id: MEETING_ID, participants: [], observed_roster: "speakers", upstream_available: true });
    if (path.endsWith("/speaker-identities") || path.endsWith("/speaker-suggestions")) return reply([]);
    if (path.endsWith("/delivery-settings")) return reply({ internal_recipients: [], participant_recipients: [], send_to_participants: false, include_transcript: false });
    return reply({ detail: "mock route missing" }, 404);
  });
}

/** Reads the counters the media fakes keep on window. */
export function counters(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, number>;
    return { gum: w.__gumCalls, recorders: w.__recorders, wakeLocks: w.__wakeLocks, wakeReleased: w.__wakeReleased };
  });
}
