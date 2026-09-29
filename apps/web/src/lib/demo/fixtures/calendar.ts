import type { CachedCalendarEvent, CalendarConnection, CalendarEventChange, CalendarInvitee, CalendarSchedule, CalendarSyncState, WorkspaceCalendarConnection } from "../../types";
import { calendarEventId, type Clock, localTime, minutesFrom } from "./ids";
import type { MeetingSeed } from "./meetings";
import { DOMAIN, team } from "./people";

export const CAL_GOOGLE = "demo-cal-google";
export const CAL_OUTLOOK = "demo-cal-outlook";
export const CAL_CALENDLY = "demo-cal-calendly";

export function calendarConnections(): CalendarConnection[] {
  return [
    { id: CAL_GOOGLE, provider: "googlecalendar", status: "ACTIVE", label: "Work", identity: `alex.morgan@${DOMAIN}` },
    { id: CAL_OUTLOOK, provider: "outlook", status: "ACTIVE", label: "Microsoft 365", identity: "alex.morgan@northwindlabs.onmicrosoft.example" },
    { id: CAL_CALENDLY, provider: "calendly", status: "ACTIVE", label: "Sales bookings", identity: `alex.morgan@${DOMAIN}` },
  ];
}

export function workspaceCalendarConnections(own: CalendarConnection[]): WorkspaceCalendarConnection[] {
  const owner = team[0];
  const others: WorkspaceCalendarConnection[] = [
    { id: "demo-cal-priya", provider: "googlecalendar", status: "ACTIVE", label: "Work", identity: team[1].email, user_id: team[1].id, user_name: team[1].name, user_email: team[1].email },
    { id: "demo-cal-daniel", provider: "outlook", status: "ACTIVE", label: "Client projects", identity: team[2].email, user_id: team[2].id, user_name: team[2].name, user_email: team[2].email },
    { id: "demo-cal-sofia", provider: "googlecalendar", status: "EXPIRED", label: "Work", identity: team[3].email, user_id: team[3].id, user_name: team[3].name, user_email: team[3].email },
  ];
  return [...own.map((item) => ({ ...item, user_id: owner.id, user_name: owner.name, user_email: owner.email })), ...others];
}

const LINK = {
  google_meet: "https://meet.google.com/xka-pqrm-tdw",
  zoom: "https://us06web.zoom.us/j/83421907756",
  teams: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_northwind_demo%40thread.v2/0",
} as const;
type Platform = keyof typeof LINK;

type EventSpec = {
  title: string; day: number; hour: number; minute?: number; length?: number; platform: Platform; connections: string[];
  invitees?: CalendarInvitee[]; agenda?: string; organizer?: string; at?: Date;
  /** The start before the organizer moved it (shows the "Rescheduled" state in the demo). */
  movedFrom?: Date;
};

/** The scheduled meeting that was moved in the demo, and where it was before. */
export const DEMO_RESCHEDULED_KEY = "initech-scoping";
export const demoOriginalStart = (clock: Clock): Date => localTime(clock, 0, 16);

const who = (name: string, email: string, response: string | null = "accepted"): CalendarInvitee => ({ name, email, response_status: response });
const internal = [who("Alex Morgan", `alex.morgan@${DOMAIN}`), who("Priya Shah", `priya.shah@${DOMAIN}`), who("Daniel Kim", `daniel.kim@${DOMAIN}`), who("Sofia Alvarez", `sofia.alvarez@${DOMAIN}`, "tentative"), who("Marcus Reed", `marcus.reed@${DOMAIN}`)];

function adHoc(): EventSpec[] {
  return [
    { title: "Acme Robotics — Rotterdam demo planning", day: 3, hour: 14, length: 60, platform: "teams", connections: [CAL_OUTLOOK],
      agenda: "Plan the December Rotterdam demo: autonomous yard trucks, Dutch maintenance manuals, FieldGuide extension.",
      organizer: "asha.patel@acme-robotics.example",
      invitees: [who("Asha Patel", "asha.patel@acme-robotics.example"), who("Chen Li", "chen.li@acme-robotics.example"), who("Jeroen Visser", "jeroen.visser@acme-robotics.example", "needsAction"), who("Alex Morgan", `alex.morgan@${DOMAIN}`), who("Daniel Kim", `daniel.kim@${DOMAIN}`)] },
    { title: "Globex — quarterly business review prep", day: 3, hour: 14, minute: 30, length: 45, platform: "google_meet", connections: [CAL_GOOGLE],
      agenda: "Month-end performance report and renewal status.", invitees: [internal[1], internal[4], internal[0]] },
    { title: "Discovery call: Fabrikam Health", day: 2, hour: 11, minute: 30, length: 30, platform: "zoom", connections: [CAL_CALENDLY],
      agenda: "Booked via Calendly: \"We want to use AI to summarise clinical documentation for our care coordinators.\"", organizer: "Alex Morgan",
      invitees: [who("Dr. Elena Park", "elena.park@fabrikam-health.example", null), who("Sam Carter", "sam.carter@fabrikam-health.example", null)] },
    { title: "Hannah Lee — onboarding plan", day: 2, hour: 11, length: 60, platform: "google_meet", connections: [CAL_GOOGLE],
      agenda: "First two weeks: Acme shadowing, Initech handover.", invitees: [internal[1], who("Hannah Lee", `hannah.lee@${DOMAIN}`, "needsAction")] },
    { title: "Intro: Contoso Logistics", day: 4, hour: 15, length: 30, platform: "google_meet", connections: [CAL_CALENDLY, CAL_GOOGLE],
      agenda: "Booked via Calendly: warehouse slotting optimisation and dispatcher copilot.", organizer: "Alex Morgan",
      invitees: [who("Priyanka Rao", "priyanka.rao@contoso-logistics.example", null)] },
    { title: "Globex — quarterly business review", day: 8, hour: 10, length: 60, platform: "teams", connections: [CAL_OUTLOOK],
      organizer: "maria@globex.example", agenda: "Service performance, month-end SLA, renewal next steps.",
      invitees: [who("Maria Rossi", "maria@globex.example"), who("Tom Becker", "tom@globex.example"), internal[0], internal[1], internal[4]] },
    { title: "Northwind Labs — all hands", day: 12, hour: 16, length: 45, platform: "google_meet", connections: [CAL_GOOGLE], invitees: internal, agenda: "Q4 goals, new hires, client wins." },
    { title: "Initech — pilot kickoff", day: 15, hour: 10, length: 60, platform: "zoom", connections: [CAL_GOOGLE],
      invitees: [who("Omar Haddad", "omar.haddad@initech.example", "tentative"), who("Nina Brooks", "nina.brooks@initech.example"), internal[0], internal[3], who("Hannah Lee", `hannah.lee@${DOMAIN}`)] },
    { title: "Fabrikam Health — proposal walkthrough", day: 16, hour: 13, length: 45, platform: "zoom", connections: [CAL_GOOGLE],
      invitees: [who("Dr. Elena Park", "elena.park@fabrikam-health.example", "tentative"), internal[0], internal[3]] },
    { title: "Contoso Logistics — follow-up", day: 18, hour: 11, length: 30, platform: "google_meet", connections: [CAL_GOOGLE], invitees: [who("Priyanka Rao", "priyanka.rao@contoso-logistics.example"), internal[0]] },
    { title: "Woodgrove Bank — proposal review", day: 26, hour: 14, length: 60, platform: "teams", connections: [CAL_OUTLOOK], invitees: [who("James Okafor", "james.okafor@woodgrove.example"), internal[0], internal[1]] },
    { title: "Globex — renewal signature", day: 30, hour: 11, length: 30, platform: "teams", connections: [CAL_OUTLOOK], invitees: [who("Lena Fischer", "lena@globex.example"), internal[4]] },
    { title: "Acme Robotics — pilot readout", day: 33, hour: 15, length: 60, platform: "google_meet", connections: [CAL_GOOGLE, CAL_OUTLOOK],
      invitees: [who("Asha Patel", "asha.patel@acme-robotics.example"), who("Chen Li", "chen.li@acme-robotics.example"), internal[0], internal[1], internal[2]] },
    { title: "Tailspin Energy — discovery", day: -9, hour: 16, length: 30, platform: "zoom", connections: [CAL_CALENDLY], invitees: [who("Noah Fischer", "noah@tailspin-energy.example", null)] },
    { title: "Acme Robotics — pilot proposal prep", day: -12, hour: 13, length: 45, platform: "google_meet", connections: [CAL_GOOGLE], invitees: [internal[0], internal[1], internal[2]] },
    { title: "Initech — intro call", day: -16, hour: 10, length: 30, platform: "zoom", connections: [CAL_GOOGLE], invitees: [who("Omar Haddad", "omar.haddad@initech.example"), internal[0]] },
    { title: "Globex — month-end review", day: -20, hour: 15, length: 45, platform: "teams", connections: [CAL_OUTLOOK], invitees: [who("Maria Rossi", "maria@globex.example"), internal[2]] },
    { title: "Woodgrove Bank — AI readiness workshop", day: -27, hour: 9, minute: 30, length: 120, platform: "teams", connections: [CAL_OUTLOOK], invitees: [who("James Okafor", "james.okafor@woodgrove.example"), internal[0], internal[3]] },
    { title: "Litware — partner sync", day: -30, hour: 17, length: 30, platform: "google_meet", connections: [CAL_GOOGLE], invitees: [who("Ava Brooks", "ava@litware.example"), internal[0]] },
  ];
}

function fromMeetings(seeds: MeetingSeed[], clock: Clock): EventSpec[] {
  const connectionFor = (seed: MeetingSeed): string[] => {
    if (seed.key === "globex-procurement" || seed.key === "acme-roadmap") return [CAL_GOOGLE, CAL_OUTLOOK];
    return seed.meeting.platform === "teams" ? [CAL_OUTLOOK] : [CAL_GOOGLE];
  };
  return seeds.filter((seed) => seed.fromCalendar).map((seed) => {
    const start = seed.meeting.status === "created" ? localTime(clock, 1, 10) : new Date(new Date(seed.meeting.created_at).getTime() + 4 * 60_000);
    return {
      title: seed.meeting.title, day: 0, hour: 0, at: start, length: Number.parseInt(seed.meeting.duration ?? "45", 10) || 45,
      platform: seed.meeting.platform as Platform, connections: connectionFor(seed), invitees: seed.invitees, agenda: seed.agenda, organizer: seed.organizer,
      movedFrom: seed.key === DEMO_RESCHEDULED_KEY ? demoOriginalStart(clock) : undefined,
    };
  });
}

function recurring(clock: Clock): EventSpec[] {
  const live = new Date(clock.start - 14 * 60_000);
  const leadership = [-32, -25, -18, -11, 3, 10, 17, 24, 31].map((day): EventSpec => ({
    title: "Northwind Labs — weekly leadership sync", day, hour: 9, length: 30, platform: "google_meet", connections: [CAL_GOOGLE], invitees: internal,
    agenda: "Pipeline, delivery, hiring, numbers.", organizer: `alex.morgan@${DOMAIN}`,
  }));
  const acme = [-28, -21, -14, -7, 7, 14, 21, 28].map((day): EventSpec => ({
    title: "Acme Robotics — weekly delivery sync", day, hour: live.getHours(), minute: live.getMinutes(), length: 30, platform: "google_meet", connections: [CAL_GOOGLE],
    invitees: [internal[0], internal[2], who("Asha Patel", "asha.patel@acme-robotics.example"), who("Chen Li", "chen.li@acme-robotics.example")],
    agenda: "Weekly FieldGuide pilot status.", organizer: `alex.morgan@${DOMAIN}`,
  }));
  return [...leadership, ...acme];
}

export function calendarEvents(clock: Clock, seeds: MeetingSeed[]): CachedCalendarEvent[] {
  const specs = [...fromMeetings(seeds, clock), ...recurring(clock), ...adHoc()];
  const events: CachedCalendarEvent[] = [];
  const syncedAt = minutesFrom(clock, -2);
  const connections = calendarConnections();
  for (const spec of specs) {
    const start = spec.at ?? localTime(clock, spec.day, spec.hour, spec.minute ?? 0);
    const end = new Date(start.getTime() + (spec.length ?? 45) * 60_000);
    for (const connectionId of spec.connections) {
      const index = events.length + 1;
      const provider = connections.find((item) => item.id === connectionId)?.provider ?? "googlecalendar";
      events.push({
        id: calendarEventId(index), synced_at: syncedAt, connection_id: connectionId, provider, event_id: `evt-${index}`,
        title: spec.title, starts_at: start.toISOString(), ends_at: end.toISOString(), meeting_url: LINK[spec.platform], platform: spec.platform,
        agenda: spec.agenda ?? null, organizer: spec.organizer ?? `alex.morgan@${DOMAIN}`, invitees: spec.invitees ?? [],
        rescheduled_from: spec.movedFrom?.toISOString() ?? null,
      });
    }
  }
  return events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

export function calendarSyncs(clock: Clock, connectionIds: string[]): CalendarSyncState[] {
  return connectionIds.map((id, index) => ({
    connection_id: id, last_synced_at: minutesFrom(clock, -2 - index), range_start: localTime(clock, -60, 0).toISOString(),
    range_end: localTime(clock, 60, 0).toISOString(), truncated: false,
  }));
}

export function calendarSchedules(seeds: MeetingSeed[], events: CachedCalendarEvent[], clock: Clock): CalendarSchedule[] {
  return seeds.filter((seed) => seed.meeting.status === "created").flatMap((seed) => {
    const event = events.find((item) => item.title === seed.meeting.title);
    return event ? [{ meeting_id: seed.meeting.id, connection_id: event.connection_id, event_id: event.event_id, starts_at: event.starts_at, ends_at: event.ends_at, provider: event.provider, status: "pending" as const, last_error: null,
      rescheduled_from: event.rescheduled_from ?? null, last_checked_at: minutesFrom(clock, -2) }] : [];
  });
}

/** The demo's detected change for a schedule or synced event that has `rescheduled_from`. */
export function demoMove(clock: Clock, item: { starts_at: string; ends_at: string; provider?: string | null; rescheduled_from?: string | null }, ids: { meeting_id?: string | null; cache_event_id?: string | null }): CalendarEventChange[] {
  if (!item.rescheduled_from) return [];
  const length = new Date(item.ends_at).getTime() - new Date(item.starts_at).getTime();
  return [{
    id: `${(ids.meeting_id ?? ids.cache_event_id ?? "change").slice(0, 24)}-moved`, kind: "moved", provider: item.provider ?? "googlecalendar", source: "watcher",
    detected_at: minutesFrom(clock, -95), old_starts_at: item.rescheduled_from, new_starts_at: item.starts_at,
    old_ends_at: new Date(new Date(item.rescheduled_from).getTime() + length).toISOString(), new_ends_at: item.ends_at,
    old_meeting_url: null, new_meeting_url: null, meeting_id: ids.meeting_id ?? null, cache_event_id: ids.cache_event_id ?? null,
  }];
}
