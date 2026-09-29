import type { InPersonSeed } from "@/lib/in-person-types";
import type { CachedCalendarEvent } from "@/lib/types";

const MAX_EXPECTED = 30;

/** A calendar event as recorder input: its title, invitees as expected people, and the event link for prep. */
export function inPersonSeedFromEvent(event: CachedCalendarEvent, eventDate: string, timezone: string): InPersonSeed {
  const names = (event.invitees ?? [])
    .map((person) => person.name?.trim() || person.email?.split("@")[0]?.replace(/[._-]+/g, " ").trim() || "")
    .filter(Boolean);
  return {
    title: event.title,
    expectedPeople: [...new Set(names)].slice(0, MAX_EXPECTED),
    calendarEvent: { connection_id: event.connection_id, event_id: event.event_id, event_date: eventDate, timezone },
  };
}

export const BLANK_SEED: InPersonSeed = { title: null, expectedPeople: [], calendarEvent: null };
