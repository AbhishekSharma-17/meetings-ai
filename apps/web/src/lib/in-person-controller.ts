import { chunkKey, forgetSession, putChunk, saveSession, type StoredChunk } from "./in-person-chunk-store";
import { ScreenWakeLock } from "./in-person-media";
import type { EngineChunk, EngineHandlers, RecorderEngine } from "./in-person-recorder";
import { inPersonService } from "./in-person-service";
import type { InPersonSession } from "./in-person-types";
import { UploadQueue, type QueueSnapshot } from "./in-person-upload-queue";

const STOP_ATTEMPTS = 3;

export type RecorderPhase = "idle" | "recording" | "paused" | "interrupted" | "stopping" | "stopped";
export type LocalMoment = { atMs: number; label: string | null; saved: boolean };

export type RecorderSnapshot = {
  phase: RecorderPhase;
  /** Last sequence number recorded on this device (-1 before the first piece). */
  lastSeq: number;
  upload: QueueSnapshot;
  storage: "device" | "memory";
  moments: LocalMoment[];
  /** Why recording stopped on its own, while waiting for the person to resume or stop. */
  interruption: string | null;
  /** Why finishing failed; finishing can be retried. */
  stopError: string | null;
};

/** Lets an engine be built (to learn its format) before the controller that receives its pieces exists. */
export function createRelay(): { handlers: EngineHandlers; connect(target: EngineHandlers): void } {
  let target: EngineHandlers | null = null;
  return {
    handlers: { onChunk: (chunk) => target?.onChunk(chunk), onEnded: (message) => target?.onEnded(message) },
    connect(next) { target = next; },
  };
}

type Options = {
  session: InPersonSession;
  identity: string;
  /** Continue numbering after pieces already recorded (after a reload). */
  nextSeq?: number;
  /** Time already recorded, so the timer continues where it was. */
  initialElapsedMs?: number;
  /** Pieces still on this device from before a reload. */
  buffered?: StoredChunk[];
};

/**
 * One in-person recording on this device: numbers each piece, writes it to IndexedDB, queues it
 * for upload, and finishes with a stop request once every piece has arrived.
 */
export class RecordingController implements EngineHandlers {
  readonly meetingId: string;
  private session: InPersonSession;
  private readonly identity: string;
  private readonly queue: UploadQueue;
  private readonly wakeLock = new ScreenWakeLock();
  private engine: RecorderEngine | null = null;
  private nextSeq: number;
  private streamStartNext = true;
  private writes: Promise<void> = Promise.resolve();
  private activeMs: number;
  private runningSince: number | null = null;
  private listeners = new Set<() => void>();
  private current: RecorderSnapshot;
  private disposed = false;
  private holds = 0;
  /** Pieces from before a reload; queued when a view first uses the controller (the constructor stays side-effect free). */
  private buffered: StoredChunk[];
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: Options) {
    this.session = options.session;
    this.meetingId = options.session.meeting_id;
    this.identity = options.identity;
    this.nextSeq = options.nextSeq ?? options.session.last_seq + 1;
    this.activeMs = options.initialElapsedMs ?? 0;
    this.queue = new UploadQueue({ onChange: (upload) => this.update({ upload }) });
    this.current = { phase: "idle", lastSeq: this.nextSeq - 1, upload: this.queue.snapshot(), storage: "device", moments: [], interruption: null, stopError: null };
    this.buffered = options.buffered ?? [];
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.current;

  elapsedMs(): number { return this.activeMs + (this.runningSince !== null ? Date.now() - this.runningSince : 0); }
  level(): number { return this.current.phase === "recording" ? this.engine?.level() ?? 0 : 0; }
  get simulated(): boolean { return Boolean(this.engine?.simulated); }

  /** Starts (or, after an interruption or reload, continues) recording with a fresh engine. */
  begin(engine: RecorderEngine): void {
    // The view may have closed while the microphone or the API was still answering.
    if (this.disposed) { engine.dispose(); return; }
    this.engine?.dispose();
    this.engine = engine;
    this.streamStartNext = true;
    engine.start();
    this.runningSince = Date.now();
    this.update({ phase: "recording", interruption: null });
    void this.wakeLock.acquire();
    void this.remember();
  }

  pause(): void {
    if (this.current.phase !== "recording" || !this.engine) return;
    this.engine.pause();
    this.hold();
    this.update({ phase: "paused" });
    void inPersonService.pause(this.meetingId).catch(() => undefined);
  }

  resume(): void {
    if (this.current.phase !== "paused" || !this.engine) return;
    this.engine.resume();
    this.runningSince = Date.now();
    this.update({ phase: "recording" });
    void inPersonService.resume(this.meetingId).catch(() => undefined);
  }

  markMoment(label: string | null = null): LocalMoment {
    const moment: LocalMoment = { atMs: this.elapsedMs(), label, saved: false };
    this.update({ moments: [...this.current.moments, moment] });
    void this.saveMoment(moment);
    return moment;
  }

  retryUploads(): void { this.queue.retryNow(); void this.saveMissingMoments(); }

  /** Stops the engine, uploads everything still buffered and asks the server to build the transcript. */
  async stop(): Promise<InPersonSession> {
    this.update({ phase: "stopping", stopError: null });
    const engine = this.engine;
    this.engine = null;
    if (engine) { await engine.stop().catch(() => undefined); engine.dispose(); }
    this.hold();
    void this.wakeLock.release();
    return this.finish();
  }

  /** Uploads what is left and sends stop. Safe to call again after a failure. */
  async finish(): Promise<InPersonSession> {
    this.update({ phase: "stopping", stopError: null });
    this.queueBuffered();
    try {
      await this.writes;
      for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt += 1) {
        await this.queue.flush();
        const finalSeq = Math.max(this.nextSeq - 1, this.current.upload.receipt?.last_seq ?? -1);
        const outcome = await inPersonService.stop(this.meetingId, finalSeq);
        if (outcome.kind === "ok") {
          this.session = outcome.session;
          this.update({ phase: "stopped" });
          await forgetSession(this.meetingId);
          return outcome.session;
        }
        if (!this.queue.rewind(outcome.expectedSeq)) throw new Error("Part of this recording is missing on the server and is no longer on this device.");
      }
      throw new Error("The server has not received every piece of audio yet. Try again.");
    } catch (cause) {
      const message = cause instanceof Error && cause.message !== "Failed to fetch" ? cause.message : "Could not reach Meetings AI. Your audio is still on this device.";
      this.update({ stopError: message });
      throw new Error(message);
    }
  }

  onChunk = (chunk: EngineChunk): void => {
    if (this.disposed) return;
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const stored: StoredChunk = {
      key: chunkKey(this.meetingId, seq), meetingId: this.meetingId, seq, durationMs: chunk.durationMs,
      streamStart: this.streamStartNext, blob: chunk.blob, contentType: this.session.mime_type,
    };
    this.streamStartNext = false;
    this.update({ lastSeq: seq });
    this.writes = this.writes.then(async () => {
      const storage = await putChunk(stored);
      if (storage !== this.current.storage) this.update({ storage });
      this.queue.add(stored);
      await this.remember();
    });
  };

  onEnded = (message: string): void => {
    if (this.disposed || this.current.phase === "stopping" || this.current.phase === "stopped") return;
    this.hold();
    this.engine?.dispose();
    this.engine = null;
    this.update({ phase: "interrupted", interruption: message });
  };

  /** A view is using this controller (React may mount, unmount and remount a view in development). */
  retain(): void {
    this.holds += 1;
    this.queueBuffered();
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
  }

  /** Disposes once no view has used the controller for a moment. */
  release(): void {
    this.holds = Math.max(0, this.holds - 1);
    if (this.holds || this.releaseTimer) return;
    this.releaseTimer = setTimeout(() => { this.releaseTimer = null; if (!this.holds) this.dispose(); }, 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.dispose();
    this.engine = null;
    this.queue.dispose();
    void this.wakeLock.release();
    this.listeners.clear();
  }

  private queueBuffered() {
    const buffered = this.buffered;
    this.buffered = [];
    for (const chunk of buffered) this.queue.add(chunk);
  }

  private hold() {
    if (this.runningSince !== null) { this.activeMs += Date.now() - this.runningSince; this.runningSince = null; }
  }

  private remember(): Promise<void> {
    return saveSession({
      meetingId: this.meetingId, identity: this.identity, title: this.session.title, nextSeq: this.nextSeq,
      contentType: this.session.mime_type, startedAt: this.session.started_at,
    });
  }

  private async saveMoment(moment: LocalMoment) {
    try {
      await inPersonService.addMoment(this.meetingId, moment.atMs, moment.label);
      this.update({ moments: this.current.moments.map((item) => item === moment ? { ...item, saved: true } : item) });
    } catch { /* Kept locally; saved again when uploads recover. */ }
  }

  private async saveMissingMoments() {
    for (const moment of this.current.moments.filter((item) => !item.saved)) await this.saveMoment(moment);
  }

  private update(patch: Partial<RecorderSnapshot>) {
    if (this.disposed) return;
    const previous = this.current.upload.state;
    this.current = { ...this.current, ...patch };
    if (patch.upload && previous !== "saved" && patch.upload.state === "saved") void this.saveMissingMoments();
    for (const listener of this.listeners) listener();
  }
}
