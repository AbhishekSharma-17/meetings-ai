import type { EmailDelivery, MeetingDeliverySettings, MeetingMinutes, MinutesDraft, MomGuidance } from "../../types";
import { newId } from "../fixtures/ids";
import type { MeetingSeed } from "../fixtures/meetings";
import { visibleSegments } from "../fixtures/meetings";
import { json, noContent, notify, problem, strList, wait } from "../http";
import { asMinutes, draftMinutes } from "../minutes-generator";
import type { DemoRequest, DemoRouter } from "../router";
import type { DemoStore } from "../store";
import { findSeed } from "./meetings";

const GENERATE_DELAY_MS = 1_400;
const CAPTURING = new Set(["live", "waiting_room", "joining", "created"]);

function withSeed(handler: (seed: MeetingSeed, request: DemoRequest) => Response | Promise<Response>) {
  return (request: DemoRequest) => {
    const seed = findSeed(request.store, request.params.id);
    return seed ? handler(seed, request) : problem(404, "meeting not found");
  };
}

function setMinutes(store: DemoStore, id: string, minutes: MeetingMinutes | null): Response {
  store.minutes = { ...store.minutes, [id]: minutes };
  return minutes ? json(minutes) : noContent();
}

function recipients(settings: MeetingDeliverySettings): string[] {
  return Array.from(new Set([...settings.internal_recipients, ...(settings.send_to_participants ? settings.participant_recipients : [])]));
}

function send(store: DemoStore, seed: MeetingSeed, to: string[]): Response {
  const minutes = store.minutes[seed.meeting.id];
  if (!minutes) return problem(404, "No minutes to send.");
  if (minutes.status !== "approved" && minutes.status !== "sent") return problem(409, "approve the MOM before sending it");
  if (!to.length) return problem(422, "Enter at least one recipient email address.");
  const now = new Date().toISOString();
  store.minutes = { ...store.minutes, [seed.meeting.id]: { ...minutes, status: "sent", sent_at: now, updated_at: now } };
  notify(`Demo: no email was sent. In a real workspace the approved recap would go to ${to.length} recipient${to.length === 1 ? "" : "s"}.`);
  const delivery: EmailDelivery = { id: newId(13), meeting_id: seed.meeting.id, recipients: to, status: "sent", provider_message_id: "demo-not-sent", error: null, created_at: now };
  return json(delivery);
}

export function registerMinutes(router: DemoRouter): void {
  router
    .on("GET", "/v1/meetings/:id/minutes", withSeed((seed, { store }) => {
      const minutes = store.minutes[seed.meeting.id];
      return minutes ? json(minutes) : problem(404, "minutes not found");
    }))
    .on("DELETE", "/v1/meetings/:id/minutes", withSeed((seed, { store }) => {
      store.jobs = { ...store.jobs, [seed.meeting.id]: { ...store.jobs[seed.meeting.id], completed_at: null, last_error: null } };
      return setMinutes(store, seed.meeting.id, null);
    }))
    .on("POST", "/v1/meetings/:id/minutes/generate", withSeed(async (seed, { store }) => {
      if (CAPTURING.has(seed.meeting.status)) return problem(409, "Wait until capture has finished before drafting minutes.");
      const segments = visibleSegments(seed, Date.now());
      if (!segments.length) return problem(409, "There is no transcript to draft minutes from.");
      if (store.minutes[seed.meeting.id]?.status === "sent") return problem(409, "sent MOM cannot be edited; regenerate a new draft");
      await wait(GENERATE_DELAY_MS);
      return setMinutes(store, seed.meeting.id, asMinutes(seed, draftMinutes(seed, segments)));
    }))
    .on("PUT", "/v1/meetings/:id/minutes", withSeed((seed, { store, body }) => {
      const current = store.minutes[seed.meeting.id];
      if (!current) return problem(404, "minutes not found");
      if (current.status === "sent") return problem(409, "sent MOM cannot be edited; regenerate a new draft");
      const draft = body as Partial<MinutesDraft>;
      return setMinutes(store, seed.meeting.id, {
        ...current, ...draft, discussion_points: strList(draft.discussion_points ?? current.discussion_points), decisions: strList(draft.decisions ?? current.decisions),
        open_questions: strList(draft.open_questions ?? current.open_questions), status: "draft", approved_at: null, last_error: null, updated_at: new Date().toISOString(),
      });
    }))
    .on("POST", "/v1/meetings/:id/minutes/approve", withSeed((seed, { store }) => {
      const current = store.minutes[seed.meeting.id];
      if (!current) return problem(404, "minutes not found");
      if (current.status === "sent") return json(current);
      const now = new Date().toISOString();
      return setMinutes(store, seed.meeting.id, { ...current, status: "approved", approved_at: now, updated_at: now });
    }))
    .on("POST", "/v1/meetings/:id/minutes/send", withSeed((seed, { store, body }) => send(store, seed, strList(body.recipients))))
    .on("POST", "/v1/meetings/:id/minutes/send-configured", withSeed((seed, { store }) => send(store, seed, recipients(store.delivery[seed.meeting.id]))))
    .on("GET", "/v1/meetings/:id/delivery-settings", withSeed((seed, { store }) => json(store.delivery[seed.meeting.id])))
    .on("PUT", "/v1/meetings/:id/delivery-settings", withSeed((seed, { store, body }) => {
      const next: MeetingDeliverySettings = {
        internal_recipients: strList(body.internal_recipients), participant_recipients: strList(body.participant_recipients),
        send_to_participants: Boolean(body.send_to_participants), include_transcript: Boolean(body.include_transcript),
      };
      store.delivery = { ...store.delivery, [seed.meeting.id]: next };
      return json(next);
    }))
    .on("GET", "/v1/meetings/:id/mom-guidance", withSeed((seed, { store }) => json(store.guidance[seed.meeting.id])))
    .on("PUT", "/v1/meetings/:id/mom-guidance", withSeed((seed, { store, body }) => {
      const next = { ...store.guidance[seed.meeting.id], ...(body as Partial<MomGuidance>), focus_fields: strList(body.focus_fields) };
      store.guidance = { ...store.guidance, [seed.meeting.id]: next };
      return json(next);
    }))
    .on("GET", "/v1/meetings/:id/post-meeting-job", withSeed((seed, { store }) => json(store.jobs[seed.meeting.id])))
    .on("POST", "/v1/meetings/:id/post-meeting-job/retry", withSeed(async (seed, { store }) => {
      await wait(GENERATE_DELAY_MS);
      const job = { enabled: true, attempts: store.jobs[seed.meeting.id].attempts + 1, next_retry_at: null, last_error: null, completed_at: new Date().toISOString(), exhausted: false };
      store.jobs = { ...store.jobs, [seed.meeting.id]: job };
      if (!store.minutes[seed.meeting.id]) store.minutes = { ...store.minutes, [seed.meeting.id]: asMinutes(seed, draftMinutes(seed, seed.segments)) };
      return json(job);
    }));
}
