import type { InPersonSession, SpeakerNameRow, SpeakerNamesView } from "../../in-person-types";
import { ORG_MAIN } from "../fixtures/ids";
import { OWNER_ID } from "../fixtures/people";
import { IN_PERSON_DEMO_ID, RECORDING_SCRIPT, recordingSuggestions, scriptSegments, sessionRecord, workshopSeed, workshopSuggestions, type DemoSuggestion } from "../fixtures/in-person";
import type { MeetingSeed } from "../fixtures/meetings";
import { json, noContent, notify, problem, str, strList } from "../http";
import { asMinutes, draftMinutes } from "../minutes-generator";
import type { DemoRequest, DemoRouter } from "../router";
import type { DemoStore } from "../store";
import { createMeeting, findSeed, refreshBaseCounts, replaceMeeting } from "./meetings";

/** Seconds after stop at which each finalize stage starts; "done" at the end. */
const STAGES: Array<[number, NonNullable<InPersonSession["finalize"]>["stage"]]> = [[0, "queued"], [0.6, "assembling"], [1.2, "transcribing"], [2.8, "reconciling"], [3.3, "naming"], [3.8, "saving"], [4.3, "done"]];
const PARTS = 3;
const MAX_CAPTIONS = 40;

type Recording = {
  session: InPersonSession;
  expected: string[];
  stoppedAt: number | null;
  suggestions: Record<string, DemoSuggestion>;
  approved: Record<string, string>;
  dismissed: string[];
  /** The calendar event the recording was started from, if any (for calendar marks). */
  calendarEvent: { connection_id: string; event_id: string } | null;
};

/** In-person state per demo store (kept beside the store so the shared store shape stays unchanged). */
const recordings = new WeakMap<DemoStore, Map<string, Recording>>();

function all(store: DemoStore): Map<string, Recording> {
  let map = recordings.get(store);
  if (!map) { map = new Map(); recordings.set(store, map); }
  return map;
}

/** Adds the finished sample in-person meeting (and its speaker suggestions) to a new demo store. */
export function seedInPerson(store: DemoStore): void {
  if (store.orgId !== ORG_MAIN || store.seeds.some((seed) => seed.meeting.id === IN_PERSON_DEMO_ID)) return;
  const seed = workshopSeed(store.clock);
  // Listed right after yesterday's roadmap call, so it shows among the recent meetings on Home.
  const after = store.seeds.findIndex((item) => item.key === "acme-roadmap");
  store.seeds = after < 0 ? [...store.seeds, seed] : [...store.seeds.slice(0, after + 1), seed, ...store.seeds.slice(after + 1)];
  store.minutes[seed.meeting.id] = asMinutes(seed, draftMinutes(seed, seed.segments));
  store.guidance[seed.meeting.id] = { template: "client", instructions: "", focus_fields: [] };
  store.delivery[seed.meeting.id] = { internal_recipients: ["alex.morgan@northwindlabs.example"], participant_recipients: [], send_to_participants: false, include_transcript: false };
  store.jobs[seed.meeting.id] = { enabled: true, attempts: 1, next_retry_at: null, last_error: null, completed_at: seed.meeting.stopped_at, exhausted: false };
  store.identities[seed.meeting.id] = [];
  const received = 104;
  all(store).set(seed.meeting.id, {
    session: sessionRecord(seed, { status: "done", last_seq: received - 1, received_chunks: received, duration_ms: 26 * 60_000, total_bytes: 12_400_000, speaker_labels: "diarized",
      finalize: { stage: "done", message: null, parts_total: PARTS, parts_done: PARTS }, moments: [{ at_ms: 9 * 60_000, label: null }] }),
    expected: ["Asha Patel", "Chen Li"], stoppedAt: null, suggestions: workshopSuggestions(seed.segments), approved: {}, dismissed: [], calendarEvent: null,
  });
  refreshBaseCounts(store);
}

/** Moves a stopped demo recording through the finalize stages; at the end it becomes a finished meeting. */
function advance(store: DemoStore, recording: Recording): Recording {
  if (recording.session.status !== "finalizing" || recording.stoppedAt === null) return recording;
  const elapsed = (Date.now() - recording.stoppedAt) / 1000;
  const stage = [...STAGES].reverse().find(([start]) => elapsed >= start)?.[1] ?? "queued";
  const partsDone = stage === "transcribing" ? Math.min(PARTS, Math.floor(((elapsed - 1.2) / 1.6) * PARTS)) : ["queued", "assembling"].includes(stage) ? 0 : PARTS;
  if (stage !== "done") return { ...recording, session: { ...recording.session, finalize: { stage, message: null, parts_total: PARTS, parts_done: partsDone } } };
  const id = recording.session.meeting_id;
  const lines = RECORDING_SCRIPT.slice(0, Math.max(5, Math.min(RECORDING_SCRIPT.length, recording.session.received_chunks + 3)));
  const segments = scriptSegments(`ip-${id.slice(-6)}`, lines);
  const minutes = Math.max(1, Math.round(recording.session.duration_ms / 60_000));
  const finished = replaceMeeting(store, id, { status: "completed", stopped_at: new Date().toISOString(), duration: `${minutes} min`, participant_count: 2 }, { segments, live: false });
  if (finished) {
    store.minutes[id] = asMinutes(finished, draftMinutes(finished, segments));
    store.jobs[id] = { enabled: true, attempts: 1, next_retry_at: null, last_error: null, completed_at: new Date().toISOString(), exhausted: false };
  }
  notify("Demo: the sample transcript is ready. Speaker names are suggested for you to approve.");
  return {
    ...recording, stoppedAt: null, suggestions: recordingSuggestions(segments, store.displayName, recording.expected),
    session: { ...recording.session, status: "done", speaker_labels: "diarized", captions: [], finalize: { stage: "done", message: null, parts_total: PARTS, parts_done: PARTS } },
  };
}

function current(store: DemoStore, id: string): Recording | null {
  const map = all(store);
  const found = map.get(id);
  if (!found) return null;
  const next = advance(store, found);
  if (next !== found) map.set(id, next);
  return next;
}

function save(store: DemoStore, recording: Recording): Response {
  all(store).set(recording.session.meeting_id, recording);
  return json(recording.session);
}

function withRecording(handler: (recording: Recording, request: DemoRequest) => Response) {
  return (request: DemoRequest) => {
    const recording = current(request.store, request.params.id);
    return recording ? handler(recording, request) : problem(404, "Recording not found.");
  };
}

function namesView(store: DemoStore, recording: Recording): SpeakerNamesView {
  if (recording.session.status !== "done") return { status: "pending", message: null, single_speaker: false, speakers: [] };
  const seed = findSeed(store, recording.session.meeting_id);
  const segments = seed?.segments ?? [];
  const labels = [...new Set(segments.map((segment) => segment.raw_speaker))];
  const speakers = labels.map((label): SpeakerNameRow => {
    const turns = segments.filter((segment) => segment.raw_speaker === label);
    const approved = recording.approved[label] ?? null;
    const suggestion = recording.suggestions[label] ?? null;
    const state = approved ? "approved" : recording.dismissed.includes(label) ? "dismissed" : suggestion ? "suggested" : "none";
    return { speaker: label, segments: turns.length, first_at_seconds: turns[0]?.start_seconds ?? 0, sample: turns[0]?.text.slice(0, 90) ?? null, current_name: approved, state, suggestion };
  });
  return { status: "ready", message: null, single_speaker: labels.length === 1, speakers };
}

function applyNames(store: DemoStore, recording: Recording, approvals: Array<{ speaker: string; name: string }>): Recording {
  const approved = { ...recording.approved, ...Object.fromEntries(approvals.map((item) => [item.speaker, item.name])) };
  const seed = findSeed(store, recording.session.meeting_id);
  if (seed) {
    const segments = seed.segments.map((segment) => approved[segment.raw_speaker] && !segment.speaker_reviewed
      ? { ...segment, speaker: approved[segment.raw_speaker], attribution_source: "Name approved by you" } : segment);
    replaceMeeting(store, seed.meeting.id, {}, { segments });
  }
  return { ...recording, approved, dismissed: recording.dismissed.filter((label) => !approved[label]) };
}

function start(store: DemoStore, body: Record<string, unknown>): Response {
  const consent = body.consent as { everyone_agreed?: unknown; notice_shown?: unknown } | undefined;
  if (consent?.everyone_agreed !== true) return problem(422, "Confirm that everyone present agreed to be recorded.");
  const title = str(body.title)?.trim() || "In-person meeting";
  const created: MeetingSeed = createMeeting(store, { title, tags: ["in-person"] });
  const now = new Date().toISOString();
  const seed = replaceMeeting(store, created.meeting.id, { platform: "in_person", meeting_url: "", status: "active", joined_at: now }, { fromCalendar: false }) ?? created;
  const device = body.device === "phone" || body.device === "laptop" ? body.device : "unknown";
  const session = sessionRecord(seed, { status: "recording", device, recorded_by: { user_id: OWNER_ID, display_name: store.displayName },
    consent: { everyone_agreed: true, notice_shown: consent.notice_shown === true, agreed_at: now }, started_at: now, stopped_at: null });
  const event = body.calendar_event as { connection_id?: unknown; event_id?: unknown } | null | undefined;
  const calendarEvent = event && str(event.connection_id) && str(event.event_id) ? { connection_id: str(event.connection_id) as string, event_id: str(event.event_id) as string } : null;
  all(store).set(session.meeting_id, { session, expected: strList(body.expected_people).slice(0, 30), stoppedAt: null, suggestions: {}, approved: {}, dismissed: [], calendarEvent });
  notify("Demo: nothing is recorded. The microphone is not used; audio, captions and the transcript are simulated.");
  return json(session, 201);
}

function receiveChunk(store: DemoStore, recording: Recording, query: URLSearchParams): Response {
  const { session } = recording;
  if (session.status !== "recording" && session.status !== "paused") return problem(409, "This recording is not accepting audio any more.");
  const seq = Number(query.get("seq"));
  const duration = Math.min(20_000, Math.max(1, Number(query.get("duration_ms")) || 1));
  const receipt = (duplicate: boolean, next: InPersonSession) => json({ seq, duplicate, last_seq: next.last_seq, received_chunks: next.received_chunks, duration_ms: next.duration_ms, total_bytes: next.total_bytes });
  if (!Number.isInteger(seq) || seq < 0) return problem(422, "seq must be a whole number.");
  if (seq <= session.last_seq) return receipt(true, session);
  if (seq > session.last_seq + 1) return problem(409, { message: "Audio arrived out of order.", expected_seq: session.last_seq + 1 });
  const line = RECORDING_SCRIPT[seq % RECORDING_SCRIPT.length];
  const captions = [...session.captions, { seq, start_ms: session.duration_ms, text: line[1] }].slice(-MAX_CAPTIONS);
  const next: InPersonSession = { ...session, last_seq: seq, received_chunks: session.received_chunks + 1, duration_ms: session.duration_ms + duration, total_bytes: session.total_bytes + 16_000, captions };
  all(store).set(session.meeting_id, { ...recording, session: next });
  return receipt(false, next);
}

export function registerInPerson(router: DemoRouter): void {
  router
    .on("POST", "/v1/in-person/meetings", ({ store, body }) => start(store, body))
    .on("GET", "/v1/in-person/calendar-links", ({ store }) => json([...all(store).keys()].map((id) => current(store, id)).flatMap((recording) => recording?.calendarEvent
      ? [{ meeting_id: recording.session.meeting_id, ...recording.calendarEvent, status: recording.session.status, title: recording.session.title }] : [])))
    .on("GET", "/v1/in-person/meetings/:id", withRecording((recording) => json(recording.session)))
    .on("POST", "/v1/in-person/meetings/:id/chunks", withRecording((recording, { store, query }) => receiveChunk(store, recording, query)))
    .on("POST", "/v1/in-person/meetings/:id/pause", withRecording((recording, { store }) => save(store, { ...recording, session: { ...recording.session, status: recording.session.status === "recording" ? "paused" : recording.session.status } })))
    .on("POST", "/v1/in-person/meetings/:id/resume", withRecording((recording, { store }) => save(store, { ...recording, session: { ...recording.session, status: recording.session.status === "paused" ? "recording" : recording.session.status } })))
    .on("POST", "/v1/in-person/meetings/:id/moments", withRecording((recording, { store, body }) => {
      const atMs = typeof body.at_ms === "number" ? Math.max(0, Math.round(body.at_ms)) : 0;
      return save(store, { ...recording, session: { ...recording.session, moments: [...recording.session.moments, { at_ms: atMs, label: str(body.label) }].slice(0, 50) } });
    }))
    .on("POST", "/v1/in-person/meetings/:id/stop", withRecording((recording, { store, body }) => {
      const finalSeq = typeof body.final_seq === "number" ? body.final_seq : -1;
      if (finalSeq > recording.session.last_seq) return problem(409, { message: "Some audio has not arrived yet.", expected_seq: recording.session.last_seq + 1 });
      replaceMeeting(store, recording.session.meeting_id, { status: "stopping" });
      return save(store, { ...recording, stoppedAt: Date.now(), session: { ...recording.session, status: "finalizing", stopped_at: new Date().toISOString(), finalize: { stage: "queued", message: null, parts_total: PARTS, parts_done: 0 } } });
    }))
    .on("POST", "/v1/in-person/meetings/:id/retry", withRecording((recording, { store }) => recording.session.status === "failed"
      ? save(store, { ...recording, stoppedAt: Date.now(), session: { ...recording.session, status: "finalizing", error: null } }) : json(recording.session)))
    .on("POST", "/v1/in-person/meetings/:id/discard", withRecording((recording, { store }) => {
      store.seeds = store.seeds.filter((seed) => seed.meeting.id !== recording.session.meeting_id);
      all(store).delete(recording.session.meeting_id);
      refreshBaseCounts(store);
      return noContent();
    }))
    .on("GET", "/v1/in-person/meetings/:id/speaker-names", withRecording((recording, { store }) => json(namesView(store, recording))))
    .on("POST", "/v1/in-person/meetings/:id/speaker-names/approve", withRecording((recording, { store, body }) => {
      const approvals = (Array.isArray(body.approvals) ? body.approvals as Record<string, unknown>[] : [])
        .map((item) => ({ speaker: str(item.speaker)?.trim() ?? "", name: str(item.name)?.trim() ?? "" }))
        .filter((item) => item.speaker && item.name).slice(0, 20);
      if (!approvals.length) return problem(422, "Choose at least one speaker and a name.");
      const next = applyNames(store, recording, approvals);
      all(store).set(recording.session.meeting_id, next);
      return json(namesView(store, next));
    }))
    .on("POST", "/v1/in-person/meetings/:id/speaker-names/dismiss", withRecording((recording, { store, body }) => {
      const speaker = str(body.speaker) ?? "";
      const next = { ...recording, dismissed: [...new Set([...recording.dismissed, speaker])] };
      all(store).set(recording.session.meeting_id, next);
      return json(namesView(store, next));
    }))
    .on("POST", "/v1/in-person/meetings/:id/speaker-names/refresh", withRecording((recording, { store }) => {
      const next = { ...recording, dismissed: [] };
      all(store).set(recording.session.meeting_id, next);
      notify("Demo: suggestions were checked again. In a real workspace this re-reads the transcript.");
      return json(namesView(store, next));
    }));
}
