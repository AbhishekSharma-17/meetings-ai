import { LevelMeter, pickMimeType, stopStream } from "./in-person-media";

/** One MediaRecorder timeslice. Later pieces only decode together with piece 0 of the same stream. */
const CHUNK_MS = 15_000;
const DEMO_CHUNK_MS = 4_000;
const MIN_CHUNK_MS = 1;
const MAX_CHUNK_MS = 20_000;
const AUDIO_BITS_PER_SECOND = 48_000;

export type EngineChunk = { blob: Blob; durationMs: number };
export type EngineHandlers = {
  onChunk(chunk: EngineChunk): void;
  /** The recorder stopped on its own (microphone unplugged, phone locked, app switched). */
  onEnded(message: string): void;
};

/** A source of numbered audio pieces: the real microphone, or the demo's simulated one. */
export interface RecorderEngine {
  readonly mimeType: string;
  readonly simulated: boolean;
  start(): void;
  pause(): void;
  resume(): void;
  /** Resolves after the final piece has been handed to onChunk. */
  stop(): Promise<void>;
  /** Input level, 0–1. */
  level(): number;
  dispose(): void;
}

/** Tests can shorten the timeslice with window.__IN_PERSON_TEST_CHUNK_MS. */
function timeslice(fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const override = (window as unknown as { __IN_PERSON_TEST_CHUNK_MS?: unknown }).__IN_PERSON_TEST_CHUNK_MS;
  return typeof override === "number" && override > 0 ? override : fallback;
}

const clampDuration = (ms: number) => Math.min(MAX_CHUNK_MS, Math.max(MIN_CHUNK_MS, Math.round(ms)));

/** Wall-clock time of audio per piece, leaving out paused time. */
class ActiveClock {
  private since: number | null = null;
  private carried = 0;
  run() { this.since ??= Date.now(); }
  hold() { if (this.since !== null) { this.carried += Date.now() - this.since; this.since = null; } }
  /** Milliseconds recorded since the last take, then starts counting again. */
  take(): number {
    const now = Date.now();
    const total = this.carried + (this.since !== null ? now - this.since : 0);
    this.carried = 0;
    if (this.since !== null) this.since = now;
    return total;
  }
}

/** The real recorder: one MediaRecorder for the whole stream, paused and resumed in place. */
export class MediaRecorderEngine implements RecorderEngine {
  readonly simulated = false;
  readonly mimeType: string;
  private readonly recorder: MediaRecorder;
  private readonly meter: LevelMeter;
  private readonly clock = new ActiveClock();
  private stopping: { resolve(): void } | null = null;
  private stopped = false;

  constructor(private readonly stream: MediaStream, private readonly handlers: EngineHandlers) {
    const preferred = pickMimeType();
    const options: MediaRecorderOptions = { audioBitsPerSecond: AUDIO_BITS_PER_SECOND };
    if (preferred) options.mimeType = preferred;
    this.recorder = new MediaRecorder(stream, options);
    this.mimeType = this.recorder.mimeType || preferred || "audio/webm";
    this.meter = new LevelMeter(stream);
    this.recorder.addEventListener("dataavailable", this.onData);
    this.recorder.addEventListener("stop", this.onStop);
    this.recorder.addEventListener("error", () => handlers.onEnded("The recorder reported an error."));
  }

  start() { this.clock.run(); this.recorder.start(timeslice(CHUNK_MS)); }

  pause() {
    if (this.recorder.state !== "recording") return;
    this.recorder.pause(); this.clock.hold();
  }

  resume() {
    if (this.recorder.state !== "paused") return;
    this.clock.run(); this.recorder.resume();
  }

  stop(): Promise<void> {
    if (this.stopped || this.recorder.state === "inactive") return Promise.resolve();
    return new Promise((resolve) => { this.stopping = { resolve }; this.recorder.stop(); });
  }

  level() { return this.recorder.state === "recording" ? this.meter.read() : 0; }

  dispose() {
    if (this.recorder.state !== "inactive") { this.stopping = { resolve: () => undefined }; try { this.recorder.stop(); } catch { /* already stopped */ } }
    this.meter.close();
    stopStream(this.stream);
  }

  private readonly onData = (event: BlobEvent) => {
    if (!event.data || event.data.size === 0) return;
    this.handlers.onChunk({ blob: event.data, durationMs: clampDuration(this.clock.take()) });
  };

  private readonly onStop = () => {
    this.stopped = true;
    this.meter.close();
    if (this.stopping) { this.stopping.resolve(); this.stopping = null; return; }
    this.handlers.onEnded("Recording stopped. The microphone was interrupted, or the phone was locked or switched apps.");
  };
}

/** Demo mode: never touches the microphone. Emits small pieces on a timer and a gentle fake level. */
export class SimulatedEngine implements RecorderEngine {
  readonly simulated = true;
  readonly mimeType = "audio/webm;codecs=opus";
  private readonly clock = new ActiveClock();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private done = false;

  constructor(private readonly handlers: EngineHandlers) {}

  start() { this.running = true; this.clock.run(); this.schedule(); }
  pause() { this.running = false; this.clock.hold(); this.clear(); }
  resume() { if (this.done) return; this.running = true; this.clock.run(); this.schedule(); }

  async stop(): Promise<void> {
    if (this.done) return;
    this.done = true; this.running = false; this.clear();
    this.emit();
  }

  level() {
    if (!this.running) return 0;
    const t = Date.now() / 1000;
    const speech = 0.42 + 0.22 * Math.sin(t * 2.3) + 0.12 * Math.sin(t * 6.1 + 1.3) + 0.08 * Math.sin(t * 11.7);
    return Math.max(0.04, Math.min(0.95, speech));
  }

  dispose() { this.done = true; this.running = false; this.clear(); }

  private schedule() { this.clear(); this.timer = setInterval(() => this.emit(), timeslice(DEMO_CHUNK_MS)); }
  private clear() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private emit() {
    const duration = this.clock.take();
    if (duration < 50) return;
    this.handlers.onChunk({ blob: new Blob([new Uint8Array(512)], { type: "audio/webm" }), durationMs: clampDuration(duration) });
  }
}
