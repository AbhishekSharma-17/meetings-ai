import type { CalendarCoordination, CallCheck, CoordinationPerson, CoverageSummary, MeetingCoordination, TeammateAssistant } from "../../coordination";
import type { MeetingSeed } from "../fixtures/meetings";
import { OWNER_ID, team } from "../fixtures/people";
import { ORG_MAIN } from "../fixtures/ids";
import { json, notify, problem } from "../http";
import type { DemoRouter } from "../router";
import type { DemoStore } from "../store";
import { findSeed } from "./meetings";

/**
 * Call coordination in the sample workspace. Seeds: Priya Shah shares Alex's live Acme weekly
 * sync; Alex and Sofia Alvarez both kept their own assistant for the Initech scoping workshop;
 * Priya's assistant is in the Globex procurement call and scheduled for the Globex QBR.
 */
type Person = { id: string; name: string };
type DemoRecord = {
  meeting_id: string; owner: Person; url: string; start: number; end: number; state: TeammateAssistant["state"];
  covering: Person[]; kept_own: boolean; virtual: boolean; handed_to: string | null;
};
type State = { youShare: Record<string, boolean>; handedOver: Record<string, string> };

const HOUR = 3_600_000;
const GRACE = 5 * 60_000;
const ALEX: Person = { id: OWNER_ID, name: team[0].name };
const PRIYA: Person = { id: team[1].id, name: team[1].name };
const SOFIA: Person = { id: team[3].id, name: team[3].name };
const SOFIA_INITECH = "demo-coordination-sofia-initech";
const PRIYA_QBR = "demo-coordination-priya-qbr";
const states = new WeakMap<DemoStore, State>();

function stateOf(store: DemoStore): State {
  const existing = states.get(store);
  if (existing) return existing;
  const created: State = { youShare: {}, handedOver: {} };
  states.set(store, created);
  return created;
}

const callKey = (url: string) => url.trim().toLowerCase().split(/[?#]/)[0].replace(/\/+$/, "");
const person = (value: Person, you = ALEX.id): CoordinationPerson => ({ user_id: value.id, display_name: value.name, is_you: value.id === you });
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end + GRACE && b.start < a.end + GRACE;

function seedState(store: DemoStore, seed: MeetingSeed): TeammateAssistant["state"] {
  const status = seed.meeting.status;
  if (stateOf(store).handedOver[seed.meeting.id]) return "idle";
  if (["live", "needs_attention", "active"].includes(status)) return "in_call";
  if (["joining", "waiting_room"].includes(status)) return "joining";
  if (status === "created") return store.schedules.some((item) => item.meeting_id === seed.meeting.id && item.status === "pending") ? "scheduled" : "idle";
  return ["completed", "ready", "stopped"].includes(status) ? "ended" : "idle";
}

function records(store: DemoStore): DemoRecord[] {
  const state = stateOf(store);
  const main = store.orgId === ORG_MAIN;
  const list: DemoRecord[] = store.seeds.map((seed) => {
    const schedule = store.schedules.find((item) => item.meeting_id === seed.meeting.id);
    const start = new Date(schedule?.starts_at ?? seed.meeting.joined_at ?? seed.meeting.created_at).getTime();
    const owner = seed.key === "globex-procurement" && main ? PRIYA : ALEX;
    return {
      meeting_id: seed.meeting.id, owner, url: seed.meeting.meeting_url, start, end: schedule ? new Date(schedule.ends_at).getTime() : start + HOUR,
      state: seedState(store, seed), covering: [...(seed.key === "acme-weekly" && main ? [PRIYA] : []), ...(state.youShare[seed.meeting.id] ? [ALEX] : [])],
      kept_own: seed.key === "initech-scoping", virtual: false, handed_to: state.handedOver[seed.meeting.id] ?? null,
    };
  });
  const initech = list.find((item) => store.seeds.find((seed) => seed.meeting.id === item.meeting_id)?.key === "initech-scoping");
  if (initech) list.push({ ...initech, meeting_id: SOFIA_INITECH, owner: SOFIA, state: "scheduled", covering: state.youShare[SOFIA_INITECH] ? [ALEX] : [], virtual: true, handed_to: null });
  const qbr = main ? store.events.find((event) => event.title === "Globex — quarterly business review") : undefined;
  if (qbr) list.push({ meeting_id: PRIYA_QBR, owner: PRIYA, url: qbr.meeting_url, start: new Date(qbr.starts_at).getTime(), end: new Date(qbr.ends_at).getTime(), state: "scheduled", covering: state.youShare[PRIYA_QBR] ? [ALEX] : [], kept_own: false, virtual: true, handed_to: null });
  return list;
}

const ACTIVE = new Set<TeammateAssistant["state"]>(["scheduled", "joining", "in_call"]);

function assistant(record: DemoRecord): TeammateAssistant {
  return { meeting_id: record.meeting_id, owner: person(record.owner), starts_at: new Date(record.start).toISOString(), state: record.state,
    covering: record.covering.map((item) => person(item)), kept_own: record.kept_own, can_open: !record.virtual };
}

function sameCall(all: DemoRecord[], record: { url: string; start: number; end: number }, exclude?: string): DemoRecord[] {
  return all.filter((item) => item.meeting_id !== exclude && callKey(item.url) === callKey(record.url) && overlaps(item, record));
}

/** Daniel Kim has the Acme weekly sync on his calendar too (a count only, never his event). */
const onCalendar = (record: DemoRecord, store: DemoStore) => store.seeds.some((seed) => seed.meeting.id === record.meeting_id && seed.key === "acme-weekly") ? 1 : 0;

function view(store: DemoStore, record: DemoRecord): MeetingCoordination {
  const all = records(store);
  const handed = record.handed_to ? all.find((item) => item.meeting_id === record.handed_to) ?? null : null;
  const mine = record.owner.id === ALEX.id;
  const sharing = record.covering.some((item) => item.id === ALEX.id);
  return {
    meeting_id: record.meeting_id, state: record.state, starts_at: new Date(record.start).toISOString(), owner: person(record.owner),
    covering: record.covering.map((item) => person(item)), your_role: mine ? "owner" : sharing ? "sharing" : null, receive_recap: sharing,
    kept_own: record.kept_own, handed_to: handed ? assistant(handed) : null,
    other_assistants: sameCall(all, record, record.meeting_id).filter((item) => ACTIVE.has(item.state)).map(assistant),
    teammates_on_calendar: onCalendar(record, store), can_share: !mine && !sharing && record.state !== "idle", can_stop_sharing: sharing, can_manage: true,
  };
}

function share(store: DemoStore, target: DemoRecord): void {
  const state = stateOf(store);
  state.youShare[target.meeting_id] = true;
  for (const own of sameCall(records(store), target, target.meeting_id).filter((item) => item.owner.id === ALEX.id && item.state === "scheduled")) {
    state.handedOver[own.meeting_id] = target.meeting_id;
    store.schedules = store.schedules.map((item) => item.meeting_id === own.meeting_id ? { ...item, status: "cancelled" as const, last_error: `Handed over: ${target.owner.name}'s assistant covers this call.` } : item);
  }
  const delivery = store.delivery[target.meeting_id];
  const email = team[0].email;
  if (delivery && !delivery.internal_recipients.includes(email)) store.delivery[target.meeting_id] = { ...delivery, internal_recipients: [...delivery.internal_recipients, email] };
  notify(`Demo: you now share ${target.owner.name}'s assistant — no second assistant joins, and ${target.owner.name.split(" ")[0]} is told.`);
}

function calendarItems(store: DemoStore, start: number, end: number): CalendarCoordination[] {
  const all = records(store);
  return store.events.filter((event) => new Date(event.starts_at).getTime() < end && new Date(event.ends_at).getTime() > start).flatMap((event) => {
    const window = { url: event.meeting_url, start: new Date(event.starts_at).getTime(), end: new Date(event.ends_at).getTime() };
    const matching = sameCall(all, window).filter((item) => item.state !== "idle");
    const owned = matching.find((item) => item.owner.id === ALEX.id && ACTIVE.has(item.state));
    const shared = matching.find((item) => item.covering.some((who) => who.id === ALEX.id));
    const theirs = matching.filter((item) => item.owner.id !== ALEX.id && (ACTIVE.has(item.state) || item === shared));
    const count = owned ? onCalendar(owned, store) : 0;
    if (!theirs.length && !owned && !shared) return [];
    const mine = owned ?? shared;
    return [{ event_id: event.id, assistants: theirs.map(assistant), your_role: owned ? "owner" : shared ? "sharing" : null,
      your_meeting_id: mine && !mine.virtual ? mine.meeting_id : null, shared_from: shared && !owned ? person(shared.owner) : null, teammates_on_calendar: count }];
  });
}

function summaries(store: DemoStore): CoverageSummary[] {
  const all = records(store);
  return all.filter((record) => !record.virtual).flatMap((record) => {
    const others = ACTIVE.has(record.state) ? sameCall(all, record, record.meeting_id).filter((item) => ACTIVE.has(item.state)).length : 0;
    const handed = record.handed_to ? all.find((item) => item.meeting_id === record.handed_to) : undefined;
    const sharing = record.covering.some((item) => item.id === ALEX.id);
    if (!record.covering.length && !handed && !others) return [];
    return [{ meeting_id: record.meeting_id, owner: person(record.owner), covering: record.covering.map((item) => person(item)),
      your_role: record.owner.id === ALEX.id ? "owner" : sharing ? "sharing" : null, kept_own: record.kept_own && others > 0,
      handed_to_owner: handed ? person(handed.owner) : null, other_assistants: others }];
  });
}

function checkCall(store: DemoStore, body: Record<string, unknown>): CallCheck {
  const url = typeof body.meeting_url === "string" ? body.meeting_url : "";
  if (!/^https:\/\/([a-z0-9-]+\.)*(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.jit\.si)\//i.test(url)) return { supported: false, platform: null, assistants: [], your_assistants: [], teammates_on_calendar: 0 };
  const start = typeof body.starts_at === "string" ? new Date(body.starts_at).getTime() : Date.now();
  const end = typeof body.ends_at === "string" ? new Date(body.ends_at).getTime() : start + HOUR;
  const matching = sameCall(records(store), { url, start, end }).filter((item) => ACTIVE.has(item.state));
  return { supported: true, platform: /zoom/i.test(url) ? "zoom" : /teams/i.test(url) ? "teams" : "google_meet",
    assistants: matching.filter((item) => item.owner.id !== ALEX.id).map(assistant), your_assistants: matching.filter((item) => item.owner.id === ALEX.id).map(assistant),
    teammates_on_calendar: 0 };
}

const find = (store: DemoStore, id: string) => { findSeed(store, id); return records(store).find((item) => item.meeting_id === id); };

export function registerCoordination(router: DemoRouter): void {
  router
    .on("POST", "/v1/call-coordination/check", ({ store, body }) => json(checkCall(store, body)))
    .on("GET", "/v1/call-coordination/calendar", ({ store, query }) => {
      const start = Date.parse(query.get("start") ?? ""); const end = Date.parse(query.get("end") ?? "");
      return Number.isNaN(start) || Number.isNaN(end) ? problem(400, "choose a range") : json(calendarItems(store, start, end));
    })
    .on("GET", "/v1/call-coordination/meetings", ({ store }) => json(summaries(store)))
    .on("GET", "/v1/meetings/:id/coordination", ({ store, params }) => {
      const record = find(store, params.id);
      return record && !record.virtual ? json(view(store, record)) : problem(404, "meeting not found");
    })
    .on("POST", "/v1/meetings/:id/coverage", ({ store, params }) => {
      const record = find(store, params.id);
      if (!record) return problem(404, "meeting not found");
      if (record.owner.id === ALEX.id) return problem(409, "this is your own assistant");
      share(store, record);
      return json(view(store, find(store, params.id) ?? record));
    })
    .on("DELETE", "/v1/meetings/:id/coverage", ({ store, params }) => {
      const record = find(store, params.id);
      if (!record || !stateOf(store).youShare[params.id]) return problem(404, "you are not sharing this assistant");
      delete stateOf(store).youShare[params.id];
      return json(view(store, find(store, params.id) ?? record));
    })
    .on("GET", "/v1/meetings/:id/coverage/minutes", ({ store, params }) => {
      const minutes = store.minutes[params.id];
      return minutes && minutes.status !== "draft" ? json(minutes) : problem(404, "minutes are still being reviewed");
    });
}
