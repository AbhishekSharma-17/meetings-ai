"use client";

import { useEffect, useSyncExternalStore } from "react";
import { preferencesService } from "./meetings-service";
import { canonicalZone, detectBrowserZone, type TimeFormat } from "./time-format";
import { bindToPerson, current, fromServer, SERVER_STATE, setState, subscribe, type TimePreferencesState } from "./time-store";

export {
  currentTimeSettings, formatDate, formatDateTime, formatDayHeading, formatFullDateTime, formatTime, todayKey, zonedDayKey, zoneLabel,
  type TimePreferencesState,
} from "./time-store";

/**
 * The single source of truth for how times are shown: the signed-in person's time zone and
 * 12/24-hour clock. A small external store (so plain helpers outside React read the same
 * values), synced with `/v1/me/preferences`. AppShell subscribes, so a change re-renders the app.
 */
export function useTimePreferences(): TimePreferencesState {
  return useSyncExternalStore(subscribe, current, () => SERVER_STATE);
}

/** Reports this browser's zone and loads the saved preferences whenever the signed-in person changes. */
export function useTimePreferencesSync(identity: string | null): void {
  useEffect(() => {
    bindToPerson(identity);
    if (!identity) return;
    let cancelled = false;
    const browserTimeZone = detectBrowserZone();
    setState({ browserTimeZone });
    preferencesService.reportDetected(browserTimeZone)
      .catch(() => preferencesService.get())
      .then((payload) => { if (!cancelled) setState(fromServer(payload)); })
      .catch(() => { if (!cancelled) setState({ status: "error" }); });
    return () => { cancelled = true; };
  }, [identity]);
}

async function save(optimistic: Partial<TimePreferencesState>, patch: Parameters<typeof preferencesService.update>[0], failure: string): Promise<boolean> {
  const previous = current();
  setState({ ...optimistic, saving: true, error: null });
  try {
    const saved = await preferencesService.update(patch);
    setState({ ...fromServer(saved), saving: false });
    return true;
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
    setState({ manualTimeZone: previous.manualTimeZone, timeFormat: previous.timeFormat, saving: false, error: `${failure}${detail}` });
    return false;
  }
}

/** Pins a zone, or follows the browser again with `null`. Optimistic; rolls back on failure. */
export function saveTimeZone(zone: string | null): Promise<boolean> {
  const next = zone ? canonicalZone(zone) : null;
  return save({ manualTimeZone: next }, { timezone: next }, "Could not save your time zone.");
}

export function saveTimeFormat(format: TimeFormat): Promise<boolean> {
  return save({ timeFormat: format }, { time_format: format }, "Could not save your clock format.");
}

export function dismissTimePreferencesError(): void {
  setState({ error: null });
}
