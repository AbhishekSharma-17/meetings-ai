import type { CalendarEvent, MeetingParticipants } from "../../types";
import { baseId as knowledgeBaseId, newId } from "../fixtures/ids";
import type { BackendMeeting, MeetingSeed } from "../fixtures/meetings";
import { visibleSegments } from "../fixtures/meetings";
import { PROFILE_STT } from "../fixtures/providers";
import { buildTranscript } from "../fixtures/transcript-kit";
import { json, noContent, notify, problem, str, strList } from "../http";
import { asMinutes, draftMinutes, SAMPLE_CALL } from "../minutes-generator";
import type { DemoRequest, DemoRouter } from "../router";
import type { DemoStore } from "../store";

const JOIN_TO_LOBBY_MS = 4_000;
const LOBBY_TO_LIVE_MS = 11_000;

/** Moves meetings the visitor sent the assistant to through joining → lobby → live. */
export function advanceMeetings(store: DemoStore): void {
  const now = Date.now();
  store.seeds = store.seeds.map((seed) => {
    const requested = store.joinRequests[seed.meeting.id];
    if (!requested) return seed;
    const elapsed = now - requested;
    if (seed.meeting.status === "joining" && elapsed >= JOIN_TO_LOBBY_MS) return { ...seed, meeting: { ...seed.meeting, status: "waiting_room" } };
    if (seed.meeting.status === "waiting_room" && elapsed >= LOBBY_TO_LIVE_MS) {
      const joinedAt = new Date(requested + LOBBY_TO_LIVE_MS).toISOString();
      const segments = seed.segments.length ? seed.segments : buildTranscript(seed.key, SAMPLE_CALL, { gap: 5 });
      return { ...seed, live: true, segments, meeting: { ...seed.meeting, status: "live", joined_at: joinedAt, updated_at: joinedAt } };
    }
    return seed;
  });
}

export function findSeed(store: DemoStore, id: string): MeetingSeed | undefined {
  advanceMeetings(store);
  return store.seeds.find((seed) => seed.meeting.id === id);
}

export function replaceMeeting(store: DemoStore, id: string, patch: Partial<BackendMeeting>, extra: Partial<MeetingSeed> = {}): MeetingSeed | undefined {
  store.seeds = store.seeds.map((seed) => seed.meeting.id === id ? { ...seed, ...extra, meeting: { ...seed.meeting, ...patch, updated_at: new Date().toISOString() } } : seed);
  refreshBaseCounts(store);
  return store.seeds.find((seed) => seed.meeting.id === id);
}

export function refreshBaseCounts(store: DemoStore): void {
  store.bases = store.bases.map((base) => ({ ...base, meeting_count: store.seeds.filter((seed) => seed.meeting.knowledge_enabled && seed.meeting.knowledge_base_id === base.id).length }));
}

/** Creates a new sample meeting from the New meeting dialog or a calendar event. */
export function createMeeting(store: DemoStore, input: Record<string, unknown>, status: "created" | "joining" = "created"): MeetingSeed {
  const url = str(input.meeting_url) ?? "https://meet.google.com/new-demo-call";
  const platform = /zoom/i.test(url) ? "zoom" : /teams|microsoft/i.test(url) ? "teams" : "google_meet";
  const now = new Date().toISOString();
  const id = newId(3);
  const baseIdValue = str(input.knowledge_base_id);
  const seed: MeetingSeed = {
    key: `new-${id.slice(-6)}`, live: false, invitees: [], minutes: null, draftFailed: false, fromCalendar: false, organizer: "alex.morgan@northwindlabs.example", agenda: "",
    segments: [],
    meeting: {
      id, title: str(input.title)?.trim() || "Sample meeting", meeting_url: url, platform, status, bot_name: str(input.bot_name) || "Meetings AI",
      created_at: now, updated_at: now, joined_at: null, stopped_at: null, duration: null, participant_count: 0, error_message: null,
      tags: strList(input.tags), knowledge_enabled: Boolean(input.knowledge_enabled), knowledge_base_id: baseIdValue,
    },
  };
  store.seeds = [seed, ...store.seeds];
  store.minutes[id] = null;
  store.guidance[id] = (input.mom_guidance as DemoStore["guidance"][string]) ?? { template: "standard", instructions: "", focus_fields: [] };
  store.delivery[id] = (input.delivery_settings as DemoStore["delivery"][string]) ?? { internal_recipients: ["alex.morgan@northwindlabs.example"], participant_recipients: [], send_to_participants: false, include_transcript: false };
  store.jobs[id] = { enabled: true, attempts: 0, next_retry_at: null, last_error: null, completed_at: null, exhausted: false };
  store.identities[id] = [];
  if (status === "joining") startJoin(store, id);
  refreshBaseCounts(store);
  return seed;
}

export function startJoin(store: DemoStore, id: string): void {
  store.joinRequests[id] = Date.now();
  replaceMeeting(store, id, { status: "joining", error_message: null });
  notify("Demo: no assistant is joining a real call. This sample meeting will reach the lobby, then go live with a sample transcript.");
}

function participants(seed: MeetingSeed, segments = seed.segments): MeetingParticipants {
  const invited = seed.invitees.map((person) => ({ name: person.name, email: person.email, source: "invite", response_status: person.response_status }));
  const heard = Array.from(new Set(segments.map((segment) => segment.speaker).filter((name): name is string => Boolean(name))))
    .filter((name) => !seed.invitees.some((person) => person.name === name))
    .map((name) => ({ name, email: null, source: "speaker", response_status: null }));
  return { meeting_id: seed.meeting.id, participants: [...invited, ...heard], observed_roster: segments.length ? "speakers" : "not_recorded", upstream_available: true };
}

function source(store: DemoStore, seed: MeetingSeed): CalendarEvent | null {
  if (!seed.fromCalendar) return null;
  const event = store.events.find((item) => item.title === seed.meeting.title && Math.abs(new Date(item.starts_at).getTime() - new Date(seed.meeting.created_at).getTime()) < 3 * 86_400_000)
    ?? store.events.find((item) => item.title === seed.meeting.title);
  if (!event) return null;
  return {
    connection_id: event.connection_id, provider: event.provider, event_id: event.event_id, title: event.title, starts_at: event.starts_at, ends_at: event.ends_at,
    meeting_url: event.meeting_url, platform: event.platform, agenda: event.agenda, organizer: event.organizer, invitees: event.invitees,
  };
}

function withSeed(handler: (seed: MeetingSeed, request: DemoRequest) => Response) {
  return (request: DemoRequest) => {
    const seed = findSeed(request.store, request.params.id);
    return seed ? handler(seed, request) : problem(404, "meeting not found");
  };
}

export function registerMeetings(router: DemoRouter): void {
  router
    .on("GET", "/v1/meetings", ({ store }) => { advanceMeetings(store); return json({ items: store.seeds.map((seed) => seed.meeting), count: store.seeds.length }); })
    .on("POST", "/v1/meetings", ({ store, body }) => json(createMeeting(store, body).meeting, 201))
    .on("POST", "/v1/meetings/schedules", ({ store, body }) => {
      const seed = createMeeting(store, (body.meeting as Record<string, unknown>) ?? {});
      notify("Demo: the assistant is scheduled in this sample only — it will not join a real call.");
      return json({ meeting: seed.meeting }, 201);
    })
    .on("GET", "/v1/meetings/:id", withSeed((seed) => json(seed.meeting)))
    .on("DELETE", "/v1/meetings/:id", withSeed((seed, { store }) => {
      if (!["created", "completed", "failed"].includes(seed.meeting.status)) return problem(409, "Stop the assistant before deleting this meeting.");
      store.seeds = store.seeds.filter((item) => item.meeting.id !== seed.meeting.id);
      store.schedules = store.schedules.filter((item) => item.meeting_id !== seed.meeting.id);
      refreshBaseCounts(store);
      return noContent();
    }))
    .on("PATCH", "/v1/meetings/:id/knowledge", withSeed((seed, { store, body }) => {
      const enabled = Boolean(body.knowledge_enabled);
      const nextBase = "knowledge_base_id" in body ? str(body.knowledge_base_id) : seed.meeting.knowledge_base_id;
      const updated = replaceMeeting(store, seed.meeting.id, { tags: strList(body.tags), knowledge_enabled: enabled, knowledge_base_id: enabled ? nextBase ?? knowledgeBaseId(1) : nextBase });
      return json(updated?.meeting ?? seed.meeting);
    }))
    .on("GET", "/v1/meetings/:id/transcription-route", withSeed((seed) => json(seed.meeting.joined_at
      ? { mode: "profile", profile_id: PROFILE_STT, profile_name: "OpenAI transcription", provider_type: "openai", model: "gpt-4o-transcribe", endpoint_host: "api.openai.com", selected_at: seed.meeting.joined_at }
      : { mode: "pending", profile_id: null, profile_name: null, provider_type: null, model: null, endpoint_host: null, selected_at: null })))
    .on("POST", "/v1/meetings/:id/join", withSeed((seed, { store }) => {
      if (["live", "waiting_room", "joining"].includes(seed.meeting.status)) return json(seed.meeting);
      startJoin(store, seed.meeting.id);
      return json(findSeed(store, seed.meeting.id)?.meeting ?? seed.meeting);
    }))
    .on("POST", "/v1/meetings/:id/stop", withSeed((seed, { store }) => {
      const now = Date.now();
      const segments = visibleSegments(seed, now);
      const started = seed.meeting.joined_at ? new Date(seed.meeting.joined_at).getTime() : now;
      const minutes = Math.max(1, Math.round((now - started) / 60_000));
      store.joinRequests = Object.fromEntries(Object.entries(store.joinRequests).filter(([id]) => id !== seed.meeting.id));
      const stopped = replaceMeeting(store, seed.meeting.id, { status: segments.length ? "completed" : "stopped", stopped_at: new Date(now).toISOString(), duration: `${minutes} min` }, { live: false, segments });
      if (stopped && segments.length && !store.minutes[seed.meeting.id]) {
        store.minutes[seed.meeting.id] = asMinutes(stopped, draftMinutes(stopped, segments));
        store.jobs[seed.meeting.id] = { enabled: true, attempts: 1, next_retry_at: null, last_error: null, completed_at: new Date().toISOString(), exhausted: false };
      }
      return json(stopped?.meeting ?? seed.meeting);
    }))
    .on("POST", "/v1/meetings/:id/refresh", withSeed((seed) => json(seed.meeting)))
    .on("GET", "/v1/meetings/:id/transcript", withSeed((seed) => json({ segments: visibleSegments(seed, Date.now()) })))
    .on("GET", "/v1/meetings/:id/participants", withSeed((seed) => json(participants(seed, visibleSegments(seed, Date.now())))))
    .on("GET", "/v1/meetings/:id/speaker-identities", withSeed((seed, { store }) => json(store.identities[seed.meeting.id] ?? [])))
    .on("PUT", "/v1/meetings/:id/speaker-identities", withSeed((seed, { store, body }) => {
      const speaker = str(body.speaker);
      if (!speaker) return problem(422, "Choose a speaker.");
      const email = str(body.email)?.trim() || null;
      const rest = (store.identities[seed.meeting.id] ?? []).filter((item) => item.speaker !== speaker);
      store.identities[seed.meeting.id] = email ? [...rest, { speaker, email, confirmed_at: new Date().toISOString() }] : rest;
      return json(store.identities[seed.meeting.id]);
    }))
    .on("PUT", "/v1/meetings/:id/transcript/segments/:segmentId/speaker", withSeed((seed, { store, params, body }) => {
      const target = seed.segments.find((segment) => segment.segment_id === params.segmentId);
      if (!target) return problem(404, "transcript turn not found");
      const name = str(body.display_name)?.trim() || null;
      const applyAll = Boolean(body.apply_to_raw_label);
      const segments = seed.segments.map((segment) => (segment.segment_id === target.segment_id || (applyAll && segment.raw_speaker === target.raw_speaker))
        ? { ...segment, speaker: name, speaker_reviewed: Boolean(name), attribution_source: name ? "Corrected by you" : null } : segment);
      const updated = replaceMeeting(store, seed.meeting.id, {}, { segments });
      return json({ segments: updated ? visibleSegments(updated, Date.now()) : segments });
    }))
    .on("GET", "/v1/meetings/:id/source", withSeed((seed, { store }) => {
      const event = source(store, seed);
      return event ? json(event) : problem(404, "This meeting was not added from a calendar.");
    }));
}
