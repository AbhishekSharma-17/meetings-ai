import type { CachedCalendarEvent, CalendarConnection } from "@/lib/types";
import { CalendarBrandIcon, PlatformBrandIcon, type BrandIconSize } from "./brand-icons";
import { meetingPlatform, sourceLabel, type CalendarEntry } from "./calendar-events";
import { calendarProviderNames, platformLabel } from "./calendar-providers";

const MAX_STACKED_SOURCES = 3;

/** One copy per connected account, so two accounts of the same provider both show. */
export function uniqueByAccount(sources: readonly CachedCalendarEvent[]): CachedCalendarEvent[] {
  return sources.filter((source, index) => sources.findIndex((item) => item.connection_id === source.connection_id) === index);
}

/** Overlapping calendar-source marks for one meeting (or one day), each named for assistive tech. */
export function SourceStack({ sources, connections, size = "xs", decorative = false }: {
  sources: readonly CachedCalendarEvent[];
  connections: readonly CalendarConnection[];
  size?: BrandIconSize;
  decorative?: boolean;
}) {
  const unique = uniqueByAccount(sources);
  const shown = unique.slice(0, MAX_STACKED_SOURCES);
  const names = unique.map((source) => sourceLabel(source, connections));
  return <span className={shown.length > 1 ? "source-stack stacked" : "source-stack"} title={names.join("\n")}>
    {shown.map((source) => <CalendarBrandIcon key={source.connection_id} provider={source.provider} size={size} label={decorative ? undefined : sourceLabel(source, connections)} />)}
  </span>;
}

/** The video platform mark, labelled unless the platform name is printed next to it. */
export function PlatformMark({ event, size = "xs", decorative = false }: {
  event: Pick<CachedCalendarEvent, "platform" | "meeting_url">;
  size?: BrandIconSize;
  decorative?: boolean;
}) {
  const platform = meetingPlatform(event);
  const name = platform ? platformLabel(platform) : "No video link";
  return <PlatformBrandIcon platform={platform} size={size} label={decorative ? undefined : name} className="platform-mark" />;
}

/** Short origin line for lists: account name, "Scheduled via Calendly" or "N accounts". */
export function entryOrigin(entry: CalendarEntry, connections: readonly CalendarConnection[]): string {
  const accounts = uniqueByAccount(entry.sources);
  if (accounts.length > 1) return `${accounts.length} accounts`;
  const [source] = accounts;
  if (source.provider === "calendly") return "Via Calendly";
  return connections.find((item) => item.id === source.connection_id)?.label ?? calendarProviderNames[source.provider];
}

/** Pill naming the video platform, e.g. [Meet] Google Meet. */
export function PlatformPill({ event }: { event: Pick<CachedCalendarEvent, "platform" | "meeting_url"> }) {
  const platform = meetingPlatform(event);
  return <span className="calendar-pill"><PlatformMark event={event} size="xs" decorative />{platform ? platformLabel(platform) : "No video link"}</span>;
}

/** Marker for events booked through Calendly; the platform pill beside it shows where it runs. */
export function CalendlyPill() {
  return <span className="calendar-pill via"><CalendarBrandIcon provider="calendly" size="xs" />Scheduled via Calendly</span>;
}

