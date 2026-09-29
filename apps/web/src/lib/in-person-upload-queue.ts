import { deleteChunk, type StoredChunk } from "./in-person-chunk-store";
import { uploadChunk, type ChunkOutcome, type ChunkUpload } from "./in-person-service";
import type { ChunkReceipt } from "./in-person-types";

/** Waits between retries: 1 s, 2 s, 5 s, 10 s, then every 30 s at most. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const SLOW_DOWN_MS = 5_000;
/** Recently confirmed pieces kept in memory, so a server that asks for them again can be answered. */
const ACKED_KEPT = 40;

export type UploadState = "saved" | "uploading" | "offline" | "retrying" | "error";
export type QueueSnapshot = { state: UploadState; pending: number; uploaded: number; message: string | null; receipt: ChunkReceipt | null };

type Options = {
  send?(chunk: ChunkUpload): Promise<ChunkOutcome>;
  remove?(key: string): Promise<void>;
  onChange(snapshot: QueueSnapshot): void;
};

export function backoffFor(attempt: number, slowDown: boolean): number {
  const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  return slowDown ? Math.max(wait, SLOW_DOWN_MS) : wait;
}

const online = () => typeof navigator === "undefined" || navigator.onLine !== false;

/**
 * Uploads buffered audio pieces strictly in sequence order, one at a time. A piece leaves the
 * device only after a 200 response; network trouble retries with backoff, and going offline
 * pauses the queue until the browser is back online.
 */
export class UploadQueue {
  private readonly pending = new Map<number, StoredChunk>();
  private readonly acked = new Map<number, StoredChunk>();
  private readonly send: (chunk: ChunkUpload) => Promise<ChunkOutcome>;
  private readonly remove: (key: string) => Promise<void>;
  private readonly onChange: (snapshot: QueueSnapshot) => void;
  private inFlight = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private offline = !online();
  private fatal: string | null = null;
  private retryMessage: string | null = null;
  private uploaded = 0;
  private receipt: ChunkReceipt | null = null;
  private waiters: Array<{ resolve(): void; reject(error: Error): void }> = [];
  private disposed = false;
  private listening = false;

  constructor(options: Options) {
    this.send = options.send ?? uploadChunk;
    this.remove = options.remove ?? deleteChunk;
    this.onChange = options.onChange;
  }

  add(chunk: StoredChunk): void {
    if (this.disposed) return;
    this.listen();
    this.pending.set(chunk.seq, chunk);
    this.emit();
    this.pump();
  }

  get size(): number { return this.pending.size; }

  /** The server is missing audio from `expectedSeq`: queue it again if this device still has it. */
  rewind(expectedSeq: number): boolean {
    const upTo = this.pending.size ? Math.min(...this.pending.keys()) : Math.max(expectedSeq, ...this.acked.keys()) + 1;
    for (let seq = expectedSeq; seq < upTo; seq += 1) {
      const chunk = this.acked.get(seq);
      if (!chunk) return false;
      this.pending.set(seq, chunk);
    }
    this.fatal = null;
    this.emit();
    this.pump();
    return true;
  }

  /** Resolves once every buffered piece is uploaded; rejects if the queue cannot continue. */
  flush(): Promise<void> {
    if (this.fatal) return Promise.reject(new Error(this.fatal));
    if (!this.pending.size && !this.inFlight) return Promise.resolve();
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); this.pump(); });
  }

  /** Try again now (after an error, or to skip a backoff wait). */
  retryNow(): void {
    this.fatal = null; this.attempt = 0;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.emit();
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleOnline);
      window.removeEventListener("offline", this.handleOffline);
    }
    for (const waiter of this.waiters) waiter.reject(new Error("The recorder was closed."));
    this.waiters = [];
  }

  snapshot(): QueueSnapshot {
    const pending = this.pending.size;
    const state: UploadState = this.fatal ? "error" : this.offline ? "offline" : this.timer ? "retrying" : pending ? "uploading" : "saved";
    const message = this.fatal ?? (state === "retrying" ? this.retryMessage : null);
    return { state, pending, uploaded: this.uploaded, message, receipt: this.receipt };
  }

  /** Online/offline listeners are attached with the first piece, so an unused queue has no side effects. */
  private listen() {
    if (this.listening || typeof window === "undefined") return;
    this.listening = true;
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
  }

  private readonly handleOnline = () => {
    this.offline = false; this.attempt = 0;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.emit();
    this.pump();
  };

  private readonly handleOffline = () => {
    this.offline = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.emit();
  };

  private emit() {
    if (!this.disposed) this.onChange(this.snapshot());
    if (!this.pending.size && !this.inFlight && !this.fatal) {
      const waiters = this.waiters; this.waiters = [];
      for (const waiter of waiters) waiter.resolve();
    }
  }

  private fail(message: string) {
    this.fatal = message;
    const waiters = this.waiters; this.waiters = [];
    for (const waiter of waiters) waiter.reject(new Error(message));
    this.emit();
  }

  private pump() {
    if (this.disposed || this.inFlight || this.timer || this.offline || this.fatal || !this.pending.size) return;
    const seq = Math.min(...this.pending.keys());
    const chunk = this.pending.get(seq) as StoredChunk;
    this.inFlight = true;
    this.emit();
    void this.send({ meetingId: chunk.meetingId, seq: chunk.seq, durationMs: chunk.durationMs, streamStart: chunk.streamStart, blob: chunk.blob, contentType: chunk.contentType })
      .catch((): ChunkOutcome => ({ kind: "retry", message: "Could not reach Meetings AI.", slowDown: false }))
      .then((outcome) => this.settle(chunk, outcome));
  }

  private async settle(chunk: StoredChunk, outcome: ChunkOutcome) {
    this.inFlight = false;
    if (this.disposed) return;
    if (outcome.kind === "ok" || (outcome.kind === "gap" && outcome.expectedSeq > chunk.seq)) {
      if (outcome.kind === "ok") this.receipt = outcome.receipt;
      await this.confirm(chunk);
    } else if (outcome.kind === "gap") {
      if (!this.rewind(outcome.expectedSeq)) this.fail("Part of this recording is missing on the server and no longer on this device. Stop the recording to keep what was saved, or discard it.");
      return;
    } else if (outcome.kind === "retry") {
      this.retryMessage = outcome.message;
      if (!online()) this.offline = true;
      else this.timer = setTimeout(() => { this.timer = null; this.emit(); this.pump(); }, backoffFor(this.attempt, outcome.slowDown));
      this.attempt += 1;
    } else {
      this.fail(outcome.message);
      return;
    }
    this.emit();
    this.pump();
  }

  private async confirm(chunk: StoredChunk) {
    this.pending.delete(chunk.seq);
    this.acked.set(chunk.seq, chunk);
    for (const seq of [...this.acked.keys()].sort((a, b) => a - b).slice(0, Math.max(0, this.acked.size - ACKED_KEPT))) this.acked.delete(seq);
    this.uploaded += 1;
    this.attempt = 0;
    await this.remove(chunk.key).catch(() => undefined);
  }
}
