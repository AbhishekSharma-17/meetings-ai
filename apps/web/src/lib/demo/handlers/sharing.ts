import type { MeetingShare, MeetingSharing, PersonRef, RecapDelivery } from "../../sharing-service";
import { newId } from "../fixtures/ids";
import { json, notify, problem, str, strList } from "../http";
import type { DemoRouter } from "../router";
import type { DemoStore } from "../store";
import { findSeed } from "./meetings";

/** Shares and resends made in the demo, per store (the demo store type stays unchanged). */
type SharingState = { shares: Record<string, MeetingShare[]>; resends: Record<string, RecapDelivery[]> };
const states = new WeakMap<DemoStore, SharingState>();

function stateOf(store: DemoStore): SharingState {
  let state = states.get(store);
  if (!state) { state = { shares: {}, resends: {} }; states.set(store, state); }
  return state;
}

function you(store: DemoStore): PersonRef {
  return { user_id: "demo-you", display_name: store.displayName };
}

function history(store: DemoStore, meetingId: string): MeetingSharing {
  const state = stateOf(store);
  const minutes = store.minutes[meetingId];
  const settings = store.delivery[meetingId];
  // The sample's recap, once sent, is the first delivery.
  const recap: RecapDelivery[] = minutes?.status === "sent" && minutes.sent_at ? [{
    id: `demo-recap-${meetingId}`, kind: "recap", status: "sent", error: null, sent_by: you(store), created_at: minutes.sent_at,
    recipients: settings?.internal_recipients.length ? settings.internal_recipients : ["team@example.com"], include_transcript: settings?.include_transcript ?? false,
  }] : [];
  return { shares: state.shares[meetingId] ?? [], deliveries: [...(state.resends[meetingId] ?? []), ...recap] };
}

export function registerSharing(router: DemoRouter): void {
  router
    .on("GET", "/v1/meetings/:id/sharing", ({ store, params }) => findSeed(store, params.id) ? json(history(store, params.id)) : problem(404, "meeting not found"))
    .on("POST", "/v1/meetings/:id/shares", ({ store, params, body }) => {
      if (!findSeed(store, params.id)) return problem(404, "meeting not found");
      const ids = strList(body.user_ids);
      const people = store.members.filter((member) => ids.includes(member.user_id) && member.status === "active");
      if (!people.length || people.length !== ids.length) return problem(422, "Choose active members of this workspace.");
      const state = stateOf(store);
      const current = state.shares[params.id] ?? [];
      const now = new Date().toISOString();
      const added = people.filter((member) => !current.some((share) => share.person.user_id === member.user_id && !share.revoked_at)).map((member): MeetingShare => ({
        id: newId(14), person: { user_id: member.user_id, display_name: member.display_name, email: member.email }, shared_by: you(store),
        note: str(body.note)?.trim() || null, created_at: now, revoked_at: null, revoked_by: null,
      }));
      state.shares = { ...state.shares, [params.id]: [...added, ...current] };
      notify("Demo: nobody was notified. In a real workspace each person gets a notification and can open the meeting.");
      return json(history(store, params.id));
    })
    .on("DELETE", "/v1/meetings/:id/shares/:shareId", ({ store, params }) => {
      const state = stateOf(store);
      const now = new Date().toISOString();
      state.shares = { ...state.shares, [params.id]: (state.shares[params.id] ?? []).map((share) => share.id === params.shareId && !share.revoked_at ? { ...share, revoked_at: now, revoked_by: you(store) } : share) };
      return json(history(store, params.id));
    })
    .on("POST", "/v1/meetings/:id/minutes/resend", ({ store, params, body }) => {
      if (store.minutes[params.id]?.status !== "sent") return problem(409, "send the recap first; resending is for a recap that was already sent");
      const recipients = strList(body.recipients).map((item) => item.toLowerCase());
      if (!recipients.length) return problem(422, "Enter at least one recipient email address.");
      const now = new Date().toISOString();
      const delivery: RecapDelivery = { id: newId(15), kind: "resend", recipients, status: "sent", error: null, sent_by: you(store), include_transcript: body.include_transcript === true, created_at: now };
      const state = stateOf(store);
      state.resends = { ...state.resends, [params.id]: [delivery, ...(state.resends[params.id] ?? [])] };
      notify(`Demo: no email was sent. In a real workspace the recap would go to ${recipients.length} more recipient${recipients.length === 1 ? "" : "s"}.`);
      return json({ id: delivery.id, meeting_id: params.id, recipients, status: "sent", provider_message_id: "demo-not-sent", error: null, created_at: now });
    })
    .on("GET", "/v1/meetings/:id/shared-view", () => problem(404, "this meeting isn't shared with you"))
    .on("GET", "/v1/me/shared-meetings", () => json([]));
}
