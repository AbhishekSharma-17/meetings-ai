import type { CachedCalendarEvent, CalendarConnection } from "@/lib/types";
import { calendarProviderNames } from "./calendar-providers";
import { matchesQuery, type SearchField } from "@/lib/search";

/** Video platforms we can draw a mark for. `null` means no recognised join link. */
export type MeetingPlatform = "google_meet" | "teams" | "zoom" | "jitsi";

/**
 * One meeting as shown in the product. The same meeting can arrive from more than
 * one connected account (for example a Calendly booking that is also on the
 * Google calendar it writes to); those copies collapse into one entry that keeps
 * every source. `event` is the first copy and stays the identity used for
 * selection, scheduling and prep.
 */
export type CalendarEntry = { id: string; event: CachedCalendarEvent; sources: CachedCalendarEvent[] };

const platformAliases: Record<string, MeetingPlatform> = {
  google_meet: "google_meet", googlemeet: "google_meet", meet: "google_meet",
  teams: "teams", microsoft_teams: "teams", msteams: "teams",
  zoom: "zoom", jitsi: "jitsi",
};

function platformFromUrl(url: string): MeetingPlatform | null {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (matches("meet.google.com")) return "google_meet";
  if (matches("teams.microsoft.com") || matches("teams.live.com")) return "teams";
  if (matches("zoom.us")) return "zoom";
  if (host === "meet.jit.si") return "jitsi";
  return null;
}

/** The video platform behind an event, from the API's platform field or its join link. */
export function meetingPlatform(event: Pick<CachedCalendarEvent, "platform" | "meeting_url">): MeetingPlatform | null {
  return platformAliases[(event.platform ?? "").toLowerCase()] ?? platformFromUrl(event.meeting_url ?? "");
}

function normalisedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch { return url.trim().toLowerCase(); }
}

function normalisedTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function sameMeeting(a: CachedCalendarEvent, b: CachedCalendarEvent): boolean {
  if (a.connection_id === b.connection_id) return false;
  if (new Date(a.starts_at).getTime() !== new Date(b.starts_at).getTime()) return false;
  const urlA = a.meeting_url ? normalisedUrl(a.meeting_url) : "";
  return (urlA !== "" && urlA === normalisedUrl(b.meeting_url ?? "")) || normalisedTitle(a.title) === normalisedTitle(b.title);
}

/** Collapse copies of one meeting that came from different accounts, sorted by start time. */
export function mergeCalendarEvents(events: readonly CachedCalendarEvent[]): CalendarEntry[] {
  const sorted = [...events].sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  return sorted.reduce<CalendarEntry[]>((entries, event) => {
    const index = entries.findIndex((entry) => entry.sources.every((source) => sameMeeting(source, event)));
    if (index === -1) return [...entries, { id: event.id, event, sources: [event] }];
    const match = entries[index];
    return entries.map((entry, position) => position === index ? { ...match, sources: [...match.sources, event] } : entry);
  }, []);
}

/** The entry that contains an event id (any of its copies). */
export function findEntry(entries: readonly CalendarEntry[], eventId: string | null | undefined): CalendarEntry | null {
  if (!eventId) return null;
  return entries.find((entry) => entry.sources.some((source) => source.id === eventId)) ?? null;
}

/** Human name for one source copy: "Google Calendar · Work calendar". */
export function sourceLabel(source: Pick<CachedCalendarEvent, "provider" | "connection_id">, connections: readonly CalendarConnection[]): string {
  const account = connections.find((item) => item.id === source.connection_id)?.label;
  const provider = calendarProviderNames[source.provider];
  return account && account !== provider ? `${provider} · ${account}` : provider;
}

/** True when the entry was booked through Calendly (alone or alongside a calendar copy). */
export function viaCalendly(entry: CalendarEntry): boolean {
  return entry.sources.some((source) => source.provider === "calendly");
}

/** Lower-case text used by meeting search: title, organizer, invitees and their email domains. */
/** True when a merged meeting matches the query by title, organizer, invitee name, email or company (any source). */
export function entryMatches(entry: CalendarEntry, query: string, ...extra: SearchField[]): boolean {
  return matchesQuery(query, entry.sources.map(eventSearchText), extra);
}

export function eventSearchText(event: CachedCalendarEvent): string {
  const people = (event.invitees ?? []).flatMap((person) => {
    const domain = person.email?.split("@")[1] ?? "";
    return [person.name, person.email ?? "", domain, domain.split(".")[0] ?? ""];
  });
  return [event.title, event.organizer ?? "", ...people].join(" ").toLowerCase();
}
