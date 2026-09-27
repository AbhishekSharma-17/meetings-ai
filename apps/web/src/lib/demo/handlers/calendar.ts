import type { CachedCalendarEvent, CalendarConnection, CalendarEvent, CalendarSchedule } from "../../types";
import { DEMO_CALENDARS_KEY, DEMO_PENDING_NOTICE_KEY } from "../../demo-mode";
import { calendarEventId, localTime } from "../fixtures/ids";
import { json, noContent, notify, problem, str, strList, wait } from "../http";
import type { DemoRouter } from "../router";
import type { AddedCalendar, DemoStore } from "../store";
import { createMeeting, startJoin } from "./meetings";

const SYNC_DELAY_MS = 1_200;
const PROVIDERS: CalendarConnection["provider"][] = ["googlecalendar", "outlook", "calendly", "zoom"];
const PROVIDER_LABELS: Record<CalendarConnection["provider"], string> = { googlecalendar: "Google Calendar", outlook: "Outlook Calendar", calendly: "Calendly", zoom: "Zoom" };

function dayKeyIn(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  } catch {
    const date = new Date(iso);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
}

function inRange(store: DemoStore, start: string | null, end: string | null, timezone: string, connectionIds?: string[]): CachedCalendarEvent[] {
  const active = new Set(store.connections.filter((item) => item.status === "ACTIVE").map((item) => item.id));
  return store.events.filter((event) => {
    if (!active.has(event.connection_id) || (connectionIds?.length && !connectionIds.includes(event.connection_id))) return false;
    const day = dayKeyIn(event.starts_at, timezone);
    return (!start || day >= start) && (!end || day <= end);
  });
}

function snapshot(store: DemoStore, start: string | null, end: string | null, timezone: string) {
  const ids = new Set(store.connections.map((item) => item.id));
  return { events: inRange(store, start, end, timezone), syncs: store.syncs.filter((sync) => ids.has(sync.connection_id)), errors: {} };
}

function saveAdded(store: DemoStore) {
  const added: AddedCalendar[] = store.connections.filter((item) => item.id.startsWith("demo-cal-new-")).map((item) => ({ id: item.id, provider: item.provider, label: item.label }));
  try { window.sessionStorage.setItem(DEMO_CALENDARS_KEY, JSON.stringify(added)); } catch { /* Only this page view keeps it. */ }
}

/** A few sample events for an account "connected" during the demo. */
function sampleEvents(store: DemoStore, connection: CalendarConnection): CachedCalendarEvent[] {
  const titles = ["Weekly planning (personal calendar)", "Coffee with Fabrikam Health", "Proposal review: Contoso Logistics", "Quarterly planning with Priya"];
  const platform = connection.provider === "outlook" ? "teams" : connection.provider === "zoom" ? "zoom" : "google_meet";
  const url = platform === "teams" ? "https://teams.microsoft.com/l/meetup-join/19%3ameeting_personal%40thread.v2/0" : platform === "zoom" ? "https://us06web.zoom.us/j/81122334455" : "https://meet.google.com/pqr-stuv-wxy";
  return titles.map((title, index) => {
    const start = localTime(store.clock, [1, 2, 5, 9][index], [8, 12, 16, 9][index], 30);
    const id = calendarEventId(900 + store.events.length + index);
    return { id, synced_at: new Date().toISOString(), connection_id: connection.id, provider: connection.provider, event_id: `evt-new-${store.events.length + index}`, title, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 30 * 60_000).toISOString(), meeting_url: url, platform, agenda: null, organizer: connection.identity ?? null, invitees: [] };
  });
}

function toEvent(event: CachedCalendarEvent): CalendarEvent {
  return {
    connection_id: event.connection_id, provider: event.provider, event_id: event.event_id, title: event.title, starts_at: event.starts_at, ends_at: event.ends_at,
    meeting_url: event.meeting_url, platform: event.platform, agenda: event.agenda, organizer: event.organizer, invitees: event.invitees,
  };
}

function eventFor(store: DemoStore, body: Record<string, unknown>): CachedCalendarEvent | undefined {
  return store.events.find((event) => event.connection_id === str(body.connection_id) && event.event_id === str(body.event_id));
}

function schedule(store: DemoStore, meetingId: string, event: CalendarEvent): CalendarSchedule {
  const record: CalendarSchedule = { meeting_id: meetingId, connection_id: event.connection_id, event_id: event.event_id, starts_at: event.starts_at, ends_at: event.ends_at, provider: event.provider, status: "pending", last_error: null };
  store.schedules = [...store.schedules.filter((item) => item.meeting_id !== meetingId), record];
  return record;
}

export function registerCalendar(router: DemoRouter): void {
  router
    .on("GET", "/v1/calendar/connections", ({ store }) => json(store.connections))
    .on("POST", "/v1/calendar/connect/:provider", ({ store, params, body }) => {
      const provider = PROVIDERS.find((item) => item === params.provider);
      if (!provider) return problem(404, "Unknown calendar provider.");
      const id = `demo-cal-new-${provider}-${store.connections.length + 1}`;
      const label = str(body.alias)?.trim() || (provider === "googlecalendar" ? "Personal" : PROVIDER_LABELS[provider]);
      store.connections = [...store.connections, { id, provider, status: "ACTIVE", label, identity: `alex.morgan@${provider === "outlook" ? "outlook" : "gmail"}.example` }];
      saveAdded(store);
      try { window.sessionStorage.setItem(DEMO_PENDING_NOTICE_KEY, JSON.stringify(`Demo: ${PROVIDER_LABELS[provider]} sign-in was simulated — no real account was connected. Sync to load sample events.`)); } catch { /* Notice is optional. */ }
      return json({ redirect_url: `${window.location.pathname}?calendar=connected&connected_account_id=${encodeURIComponent(id)}` });
    })
    .on("PATCH", "/v1/calendar/connections/:id", ({ store, params, body }) => {
      const alias = str(body.alias)?.trim();
      if (!alias) return problem(422, "Enter a name for this account.");
      const current = store.connections.find((item) => item.id === params.id);
      if (!current) return problem(404, "calendar connection not found");
      const updated = { ...current, label: alias.slice(0, 60) };
      store.connections = store.connections.map((item) => item.id === params.id ? updated : item);
      saveAdded(store);
      return json(updated);
    })
    .on("DELETE", "/v1/calendar/connections/:id", ({ store, params }) => {
      store.connections = store.connections.filter((item) => item.id !== params.id);
      store.events = store.events.filter((event) => event.connection_id !== params.id);
      store.syncs = store.syncs.filter((sync) => sync.connection_id !== params.id);
      saveAdded(store);
      notify("Demo: the account was disconnected in the sample only. Reload the demo to restore it.");
      return noContent();
    })
    .on("GET", "/v1/calendar/events", ({ store, query }) => {
      const period = query.get("period") ?? "this_week";
      const [from, to] = { today: [0, 0], tomorrow: [1, 1], this_week: [0, 6], next_week: [7, 13] }[period] ?? [0, 6];
      const timezone = query.get("timezone") ?? "UTC";
      const start = dayKeyIn(localTime(store.clock, from, 12).toISOString(), timezone);
      const end = dayKeyIn(localTime(store.clock, to, 12).toISOString(), timezone);
      const events = inRange(store, start, end, timezone, [query.get("connection_id") ?? ""]).map(toEvent);
      return json({ events });
    })
    .on("GET", "/v1/calendar/synced", ({ store, query }) => json(snapshot(store, query.get("start_date"), query.get("end_date"), query.get("timezone") ?? "UTC")))
    .on("POST", "/v1/calendar/sync", async ({ store, body }) => {
      await wait(SYNC_DELAY_MS);
      const requested = strList(body.connection_ids);
      const targets = store.connections.filter((item) => item.status === "ACTIVE" && (!requested.length || requested.includes(item.id)));
      const now = new Date().toISOString();
      for (const connection of targets) {
        if (!store.events.some((event) => event.connection_id === connection.id)) store.events = [...store.events, ...sampleEvents(store, connection)];
        const range = { range_start: localTime(store.clock, -60, 0).toISOString(), range_end: localTime(store.clock, 60, 0).toISOString() };
        store.syncs = [...store.syncs.filter((sync) => sync.connection_id !== connection.id), { connection_id: connection.id, last_synced_at: now, truncated: false, ...range }];
      }
      store.events = store.events.map((event) => targets.some((item) => item.id === event.connection_id) ? { ...event, synced_at: now } : event);
      return json(snapshot(store, str(body.start_date), str(body.end_date), str(body.timezone) ?? "UTC"));
    })
    .on("GET", "/v1/calendar/schedules", ({ store }) => json(store.schedules))
    .on("GET", "/v1/calendar/schedules/:id", ({ store, params }) => {
      const record = store.schedules.find((item) => item.meeting_id === params.id);
      return record ? json(record) : problem(404, "schedule not found");
    })
    .on("POST", "/v1/calendar/schedules/:id/cancel", ({ store, params }) => {
      const record = store.schedules.find((item) => item.meeting_id === params.id);
      if (!record) return problem(404, "schedule not found");
      const cancelled = { ...record, status: "cancelled" as const };
      store.schedules = store.schedules.map((item) => item.meeting_id === params.id ? cancelled : item);
      return json(cancelled);
    })
    .on("POST", "/v1/calendar/schedules", ({ store, body }) => {
      const event = eventFor(store, body);
      if (!event) return problem(404, "calendar event not found");
      const seed = createMeeting(store, { ...(body.meeting as Record<string, unknown>), title: str((body.meeting as Record<string, unknown>)?.title) ?? event.title, meeting_url: event.meeting_url });
      schedule(store, seed.meeting.id, event);
      notify("Demo: the assistant is scheduled in this sample only — it will not join the real call.");
      return json({ meeting: seed.meeting }, 201);
    })
    .on("POST", "/v1/calendar/meetings", ({ store, body }) => {
      const event = eventFor(store, body);
      if (!event) return problem(404, "calendar event not found");
      const seed = createMeeting(store, { ...(body.meeting as Record<string, unknown>), title: str((body.meeting as Record<string, unknown>)?.title) ?? event.title, meeting_url: event.meeting_url });
      startJoin(store, seed.meeting.id);
      return json({ meeting: store.seeds.find((item) => item.meeting.id === seed.meeting.id)?.meeting ?? seed.meeting }, 201);
    });
}
