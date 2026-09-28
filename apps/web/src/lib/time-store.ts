/**
 * The time zone and clock store behind `time-preferences.tsx`: plain module state (no React,
 * no API calls) so any code, including data mappers, formats times the same way the UI does.
 */
import type { TimePreferencesPayload } from "./types";
import {
  canonicalZone, dayKeyIn, DEFAULT_SETTINGS, detectBrowserZone, formatDayKey, formatIn, isValidZone, MEDIUM_DATE, MEDIUM_DATE_TIME,
  SHORT_DATE_TIME, TIME, TIME_FORMATS, zoneAbbreviation, zoneCity, type DateInput, type TimeFormat, type TimeSettings,
} from "./time-format";

export type TimePreferencesState = TimeSettings & {
  /** Where `timeZone` comes from: this browser, or a zone the person pinned. */
  source: "browser" | "manual";
  manualTimeZone: string | null;
  browserTimeZone: string;
  status: "local" | "ready" | "error";
  saving: boolean;
  error: string | null;
};

const CACHE_KEY = "meetings-ai:time-preferences";
export const SERVER_STATE: TimePreferencesState = {
  ...DEFAULT_SETTINGS, source: "browser", manualTimeZone: null, browserTimeZone: "UTC", status: "local", saving: false, error: null,
};

/** The last signed-in person's choice; `owner` stops it leaking to the next person on a shared browser. */
type Cached = { owner: string | null; manualTimeZone: string | null; timeFormat: TimeFormat };
const isFormat = (value: unknown): value is TimeFormat => typeof value === "string" && (TIME_FORMATS as readonly string[]).includes(value);

function readCache(): Cached {
  try {
    const raw = JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "null") as Partial<Cached> | null;
    const zone = typeof raw?.manualTimeZone === "string" && isValidZone(raw.manualTimeZone) ? raw.manualTimeZone : null;
    const owner = typeof raw?.owner === "string" ? raw.owner : null;
    return { owner, manualTimeZone: zone, timeFormat: isFormat(raw?.timeFormat) ? raw.timeFormat : "auto" };
  } catch { return { owner: null, manualTimeZone: null, timeFormat: "auto" }; }
}

let cacheOwner: string | null = null;

function writeCache(state: TimePreferencesState) {
  if (!cacheOwner) return; // Nothing is remembered for a signed-out browser.
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ owner: cacheOwner, manualTimeZone: state.manualTimeZone, timeFormat: state.timeFormat }));
  } catch { /* The server copy is authoritative; the cache only avoids a flash on reload. */ }
}

function clearCache() {
  try { window.localStorage.removeItem(CACHE_KEY); } catch { /* Storage may be unavailable. */ }
}

function derive(base: Omit<TimePreferencesState, "timeZone" | "source">): TimePreferencesState {
  return { ...base, timeZone: base.manualTimeZone ?? base.browserTimeZone, source: base.manualTimeZone ? "manual" : "browser" };
}

function initialState(): TimePreferencesState {
  if (typeof window === "undefined") return SERVER_STATE;
  const cached = readCache();
  cacheOwner = cached.owner;
  return derive({ ...SERVER_STATE, browserTimeZone: detectBrowserZone(), manualTimeZone: cached.manualTimeZone, timeFormat: cached.timeFormat });
}

let state: TimePreferencesState | null = null;
const listeners = new Set<() => void>();

export function current(): TimePreferencesState {
  state ??= initialState();
  return state;
}

export function setState(patch: Partial<Omit<TimePreferencesState, "timeZone" | "source">>) {
  state = derive({ ...current(), ...patch });
  writeCache(state);
  for (const listener of listeners) listener();
}

/**
 * Binds the store to the signed-in person (null when signed out). A different person, or signing
 * out, drops the previous person's zone and clock so they are never shown to someone else.
 */
export function bindToPerson(identity: string | null) {
  current();
  if (identity === cacheOwner) return;
  const previousOwner = cacheOwner;
  cacheOwner = identity;
  if (previousOwner !== null || identity === null) clearCache();
  if (previousOwner !== null) {
    state = derive({ ...current(), manualTimeZone: null, timeFormat: "auto", status: "local", error: null, saving: false });
    for (const listener of listeners) listener();
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function fromServer(payload: TimePreferencesPayload): Partial<TimePreferencesState> {
  const manual = payload.timezone_source === "manual" && isValidZone(payload.timezone) ? canonicalZone(payload.timezone) : null;
  return { manualTimeZone: manual, timeFormat: isFormat(payload.time_format) ? payload.time_format : "auto", status: "ready", error: null };
}

/** Current settings, for code outside React (the same values the hooks see). */
export function currentTimeSettings(): TimeSettings {
  const { timeZone, timeFormat } = current();
  return { timeZone, timeFormat };
}

// ----- Formatting helpers bound to the current settings ----------------------------------

/** "4:12 PM" or "16:12". */
export function formatTime(value: DateInput | null | undefined): string {
  return formatIn(value, TIME, currentTimeSettings());
}

/** "Sep 28, 4:12 PM" by default; pass options for other shapes (the clock and zone always apply). */
export function formatDateTime(value: DateInput | null | undefined, options: Intl.DateTimeFormatOptions = SHORT_DATE_TIME): string {
  return formatIn(value, options, currentTimeSettings());
}

/** "Sep 28, 2026, 4:12 PM". */
export function formatFullDateTime(value: DateInput | null | undefined): string {
  return formatIn(value, MEDIUM_DATE_TIME, currentTimeSettings());
}

/** The date a moment falls on in the person's zone: "Sep 28, 2026" by default. */
export function formatDate(value: DateInput | null | undefined, options: Intl.DateTimeFormatOptions = MEDIUM_DATE): string {
  return formatIn(value, options, currentTimeSettings());
}

/** A calendar day key ("YYYY-MM-DD") as a heading: "Monday, September 28" by default. */
export function formatDayHeading(key: string, options: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" }): string {
  return formatDayKey(key, options);
}

/** The calendar day ("YYYY-MM-DD") a moment falls on in the person's zone. */
export function zonedDayKey(value: DateInput): string {
  return dayKeyIn(value, currentTimeSettings().timeZone);
}

/** Today's date ("YYYY-MM-DD") in the person's zone. */
export function todayKey(now: DateInput = Date.now()): string {
  return zonedDayKey(now);
}

/** "IST (Kolkata)" style label for a zone. */
export function zoneLabel(timeZone: string, at: Date = new Date()): string {
  const abbreviation = zoneAbbreviation(timeZone, at);
  const city = zoneCity(timeZone);
  return abbreviation === city ? city : `${abbreviation} (${city})`;
}
