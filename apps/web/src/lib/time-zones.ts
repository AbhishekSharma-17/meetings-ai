import { canonicalZone, formatterFor, isValidZone, offsetLabel, offsetMinutes, zoneAbbreviation, zoneCity } from "./time-format";
import { matchesQuery } from "./search";

/** One choosable time zone, described at a given moment (offsets and names follow DST). */
export type TimeZoneOption = {
  id: string;
  city: string;
  /** "Asia · Kolkata" style region path for disambiguation. */
  region: string;
  abbreviation: string;
  offset: number;
  offsetLabel: string;
  longName: string;
  search: string;
};

/** Used only when the platform cannot list zones (very old browsers). */
const FALLBACK_ZONES = [
  "UTC", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Sao_Paulo",
  "Europe/London", "Europe/Berlin", "Europe/Paris", "Africa/Johannesburg", "Asia/Dubai", "Asia/Kolkata",
  "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
];

function platformZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
    return list?.length ? list : FALLBACK_ZONES;
  } catch { return FALLBACK_ZONES; }
}

function describe(id: string, at: Date): TimeZoneOption {
  const offset = offsetMinutes(at, id);
  const abbreviation = zoneAbbreviation(id, at);
  const longName = formatterFor({ timeZoneName: "long" }, { timeZone: id, timeFormat: "auto" }, "en-US")
    .formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "";
  const region = id === "UTC" ? "Coordinated Universal Time" : id.split("/").map((part) => part.replaceAll("_", " ")).join(" · ");
  const label = offsetLabel(offset);
  return {
    id, city: zoneCity(id), region, abbreviation, offset, offsetLabel: label, longName,
    search: [id, region, abbreviation, longName, label, label.replace("UTC", "GMT")].join(" ").toLowerCase(),
  };
}

let cached: { hour: number; options: TimeZoneOption[] } | null = null;

/** Every zone this browser knows, sorted west to east, then by city. Cached per hour (DST). */
export function timeZoneOptions(extra: string[] = [], now: Date = new Date()): TimeZoneOption[] {
  const hour = Math.floor(now.getTime() / 3_600_000);
  if (!cached || cached.hour !== hour) {
    const ids = [...new Set(["UTC", ...platformZones().map(canonicalZone)])].filter(isValidZone);
    cached = { hour, options: ids.map((id) => describe(id, now)) };
  }
  const known = new Set(cached.options.map((option) => option.id));
  const missing = extra.map(canonicalZone).filter((id) => id && !known.has(id) && isValidZone(id)).map((id) => describe(id, now));
  return [...cached.options, ...missing].sort((a, b) => a.offset - b.offset || a.city.localeCompare(b.city));
}

/** Options matching every word typed (city, region, abbreviation, long name or offset). */
export function filterTimeZones(options: TimeZoneOption[], query: string): TimeZoneOption[] {
  return query.trim() ? options.filter((option) => matchesQuery(query, option.search)) : options;
}
