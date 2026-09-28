/**
 * Pure, zone-aware date and time helpers. Every function takes the time zone (and clock) it
 * should use explicitly, so nothing here depends on the machine's local zone. Components use
 * the bound versions in `time-preferences.tsx`, which supply the signed-in person's settings.
 */

export type TimeFormat = "auto" | "12h" | "24h";
export type TimeSettings = { timeZone: string; timeFormat: TimeFormat };
export type DateInput = Date | string | number;

export const TIME_FORMATS: readonly TimeFormat[] = ["auto", "12h", "24h"];
export const DEFAULT_SETTINGS: TimeSettings = { timeZone: "UTC", timeFormat: "auto" };

export const TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
export const SHORT_DATE_TIME: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
export const WEEKDAY_DATE_TIME: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
export const MEDIUM_DATE_TIME: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
export const MEDIUM_DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

/** Names some browsers still report, mapped to the current IANA name the API stores. */
const ZONE_ALIASES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata", "Asia/Katmandu": "Asia/Kathmandu", "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon", "Europe/Kiev": "Europe/Kyiv", "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "Etc/UTC": "UTC", "Etc/GMT": "UTC", "GMT": "UTC", "Etc/Universal": "UTC", "Universal": "UTC", "Zulu": "UTC",
};

export function canonicalZone(zone: string): string {
  return ZONE_ALIASES[zone] ?? zone;
}

export function isValidZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

/** The zone this browser is in, or UTC when the platform does not say. */
export function detectBrowserZone(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidZone(zone) ? canonicalZone(zone) : "UTC";
  } catch { return "UTC"; }
}

const cache = new Map<string, Intl.DateTimeFormat>();
/** Building a formatter is costly; the zone list alone needs ~2 per zone. Bounded so memory stays flat. */
const CACHE_LIMIT = 3_000;

function hourCycle(format: TimeFormat): Pick<Intl.DateTimeFormatOptions, "hourCycle"> {
  return format === "12h" ? { hourCycle: "h12" } : format === "24h" ? { hourCycle: "h23" } : {};
}

/** A cached formatter; `hourCycle` is applied only when the options include a time. */
export function formatterFor(options: Intl.DateTimeFormatOptions, settings: TimeSettings, locale?: string): Intl.DateTimeFormat {
  const zone = isValidZone(settings.timeZone) ? settings.timeZone : "UTC";
  const showsTime = Boolean(options.hour || options.timeStyle);
  const resolved = { ...options, timeZone: zone, ...(showsTime ? hourCycle(settings.timeFormat) : {}) };
  const key = `${locale ?? ""}|${JSON.stringify(resolved)}`;
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, resolved);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, formatter);
  }
  return formatter;
}

export function toDate(value: DateInput): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Formats a moment in the given zone and clock; "—" for a missing or invalid value. */
export function formatIn(value: DateInput | null | undefined, options: Intl.DateTimeFormatOptions, settings: TimeSettings): string {
  const date = value === null || value === undefined ? null : toDate(value);
  return date ? formatterFor(options, settings).format(date) : "—";
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function zonedParts(value: Date, timeZone: string): ZonedParts {
  const parts = formatterFor({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" },
    { timeZone, timeFormat: "24h" }, "en-US").formatToParts(value);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The calendar day ("YYYY-MM-DD") a moment falls on in the given zone. */
export function dayKeyIn(value: DateInput, timeZone: string): string {
  const date = toDate(value);
  if (!date) return "";
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Minutes the zone is ahead of UTC at that moment (DST aware). */
export function offsetMinutes(value: Date, timeZone: string): number {
  const parts = zonedParts(value, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(value.getTime() / 1000) * 1000) / 60_000);
}

/**
 * The moment a wall-clock time ("YYYY-MM-DDTHH:MM", as from a datetime-local input) names in a
 * zone. A time skipped by a DST jump resolves forward; a repeated hour resolves to the first one.
 */
export function wallTimeToDate(wallTime: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(wallTime);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const HALF_DAY = 43_200_000;
  // One candidate per offset in force around that day: before and after any DST change.
  const [before, after] = [asUtc - HALF_DAY, asUtc + HALF_DAY].map((probe) => asUtc - offsetMinutes(new Date(probe), timeZone) * 60_000);
  const exact = [before, after].filter((candidate) => dateToWallTime(candidate, timeZone) === wallTime);
  return new Date(exact.length ? Math.min(...exact) : before);
}

/** A moment as the "YYYY-MM-DDTHH:MM" wall-clock value of a datetime-local input in the zone. */
export function dateToWallTime(value: DateInput, timeZone: string): string {
  const date = toDate(value);
  if (!date) return "";
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Formats a calendar day key ("YYYY-MM-DD") without shifting it through any zone. */
export function formatDayKey(key: string, options: Intl.DateTimeFormatOptions): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return "—";
  return formatIn(`${key}T12:00:00Z`, options, { timeZone: "UTC", timeFormat: "auto" });
}

export function addDaysToKey(key: string, days: number): string {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const OFFSET_ONLY = /^(?:GMT|UTC)(?:[+-]\d{1,2}(?::\d{2})?)?$/;
const ABBREVIATION_LOCALES = ["en-US", "en-GB", "en-IN", "en-AU"];

/** "IST", "EDT", "CEST"… or "UTC+4" where no common abbreviation exists. */
export function zoneAbbreviation(timeZone: string, at: Date = new Date()): string {
  if (timeZone === "UTC") return "UTC";
  for (const locale of ABBREVIATION_LOCALES) {
    const name = formatterFor({ timeZoneName: "short" }, { timeZone, timeFormat: "auto" }, locale)
      .formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "";
    if (name && !OFFSET_ONLY.test(name)) return name;
  }
  return offsetLabel(offsetMinutes(at, timeZone));
}

/** "UTC+5:30", "UTC-4", "UTC". */
export function offsetLabel(minutes: number): string {
  if (!minutes) return "UTC";
  const sign = minutes > 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(minutes) / 60), rest = Math.abs(minutes) % 60;
  return `UTC${sign}${hours}${rest ? `:${pad(rest)}` : ""}`;
}

/** "Kolkata", "New York", "Buenos Aires", "UTC". */
export function zoneCity(timeZone: string): string {
  if (timeZone === "UTC") return "UTC";
  return (timeZone.split("/").pop() ?? timeZone).replaceAll("_", " ");
}

/** "just now", "5 min ago", "in 2 h", "3 d ago" (short, zone independent). */
export function formatRelative(value: DateInput, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return "—";
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "just now";
  const [amount, unit] = abs < 3_600 ? [Math.round(abs / 60), "min"] : abs < 86_400 ? [Math.round(abs / 3_600), "h"] : [Math.round(abs / 86_400), "d"];
  return seconds < 0 ? `${amount} ${unit} ago` : `in ${amount} ${unit}`;
}
