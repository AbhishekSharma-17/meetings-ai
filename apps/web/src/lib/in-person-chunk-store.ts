/**
 * Audio pieces are written to IndexedDB before they are uploaded, and deleted only after the
 * server confirms them, so a dropped connection or a reload never loses a recording.
 * Without IndexedDB (some private windows) pieces are kept in memory for this page only.
 */

const DB_NAME = "meetings-ai-recorder";
const DB_VERSION = 1;
const CHUNKS = "chunks";
const SESSIONS = "sessions";

export type StoredChunk = { key: string; meetingId: string; seq: number; durationMs: number; streamStart: boolean; blob: Blob; contentType: string };

/** A recording started on this device, remembered so a reload can finish it. */
export type StoredSession = {
  meetingId: string;
  /** "organization:user", so another account on this browser never sees it. */
  identity: string;
  title: string;
  /** The next sequence number to record. */
  nextSeq: number;
  contentType: string;
  startedAt: string;
  /** Last time this device wrote to the recording (set on save). */
  savedAt?: string;
};

/**
 * The server deletes the audio of a recording idle for 24 hours, so pieces kept on this device longer
 * than that can never be used; they are removed for every account on this browser (shared devices).
 */
export const STALE_RECORDING_MS = 48 * 60 * 60 * 1000;

export const chunkKey = (meetingId: string, seq: number) => `${meetingId}:${seq}`;

let opening: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  opening ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: "key" }).createIndex("meetingId", "meetingId");
        if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: "meetingId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return opening;
}

function run<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, work: (objects: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = work(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request ? request.result : undefined);
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB request failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB request aborted"));
  });
}

const memoryChunks = new Map<string, StoredChunk>();
const memorySessions = new Map<string, StoredSession>();

/** Where audio is kept: "device" survives a reload, "memory" does not. */
export async function storageKind(): Promise<"device" | "memory"> {
  return (await openDb()) ? "device" : "memory";
}

export async function putChunk(chunk: StoredChunk): Promise<"device" | "memory"> {
  const db = await openDb();
  if (db) {
    try { await run(db, CHUNKS, "readwrite", (store) => store.put(chunk)); return "device"; }
    catch { /* Quota or a closed database: fall back to memory for this page. */ }
  }
  memoryChunks.set(chunk.key, chunk);
  return "memory";
}

export async function deleteChunk(key: string): Promise<void> {
  memoryChunks.delete(key);
  const db = await openDb();
  if (db) await run(db, CHUNKS, "readwrite", (store) => store.delete(key)).catch(() => undefined);
}

export async function listChunks(meetingId: string): Promise<StoredChunk[]> {
  const fromMemory = [...memoryChunks.values()].filter((chunk) => chunk.meetingId === meetingId);
  const db = await openDb();
  const stored = db ? await run<StoredChunk[]>(db, CHUNKS, "readonly", (store) => store.index("meetingId").getAll(meetingId)).catch(() => []) ?? [] : [];
  const byKey = new Map([...stored, ...fromMemory].map((chunk) => [chunk.key, chunk]));
  return [...byKey.values()].sort((left, right) => left.seq - right.seq);
}

export async function saveSession(session: StoredSession): Promise<void> {
  const saved = { ...session, savedAt: new Date().toISOString() };
  memorySessions.set(session.meetingId, saved);
  const db = await openDb();
  if (db) await run(db, SESSIONS, "readwrite", (store) => store.put(saved)).catch(() => undefined);
}

/** Forgets recordings of any account on this browser that have been idle longer than ``maxAgeMs``. */
export async function purgeStaleRecordings(now = Date.now(), maxAgeMs = STALE_RECORDING_MS): Promise<number> {
  const db = await openDb();
  const stored = db ? await run<StoredSession[]>(db, SESSIONS, "readonly", (store) => store.getAll()).catch(() => []) ?? [] : [];
  const stale = stored.filter((session) => {
    const last = Date.parse(session.savedAt ?? session.startedAt);
    return Number.isFinite(last) && now - last > maxAgeMs;
  });
  for (const session of stale) await forgetSession(session.meetingId);
  return stale.length;
}

export async function listSessions(identity: string): Promise<StoredSession[]> {
  const db = await openDb();
  const stored = db ? await run<StoredSession[]>(db, SESSIONS, "readonly", (store) => store.getAll()).catch(() => []) ?? [] : [];
  const byId = new Map([...stored, ...memorySessions.values()].map((session) => [session.meetingId, session]));
  return [...byId.values()].filter((session) => session.identity === identity);
}

/** Forgets a recording on this device: its remembered session and any pieces still buffered. */
export async function forgetSession(meetingId: string): Promise<void> {
  memorySessions.delete(meetingId);
  for (const key of [...memoryChunks.keys()]) if (key.startsWith(`${meetingId}:`)) memoryChunks.delete(key);
  const db = await openDb();
  if (!db) return;
  const chunks = await listChunks(meetingId);
  await Promise.all(chunks.map((chunk) => run(db, CHUNKS, "readwrite", (store) => store.delete(chunk.key)).catch(() => undefined)));
  await run(db, SESSIONS, "readwrite", (store) => store.delete(meetingId)).catch(() => undefined);
}
