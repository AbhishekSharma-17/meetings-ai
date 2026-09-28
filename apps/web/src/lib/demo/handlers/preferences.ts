import type { TimePreferencesPayload } from "../../types";
import { canonicalZone, isValidZone, TIME_FORMATS } from "../../time-format";
import { json, problem } from "../http";
import type { DemoRequest, DemoRouter } from "../router";
import type { DemoStore } from "../store";

/**
 * The visitor's time zone and clock (`/v1/me/preferences`), kept with this tab's demo store
 * like the API keeps them per person: a pinned zone wins over the zone the browser reports.
 */
type DemoTimePreferences = { timezone: string | null; detected: string | null; timeFormat: TimePreferencesPayload["time_format"] };

const state = new WeakMap<DemoStore, DemoTimePreferences>();
const INVALID_ZONE = "choose a valid time zone, for example Asia/Kolkata or America/New_York";

function preferencesOf(store: DemoStore): DemoTimePreferences {
  let current = state.get(store);
  if (!current) { current = { timezone: null, detected: null, timeFormat: "auto" }; state.set(store, current); }
  return current;
}

function publicPreferences(value: DemoTimePreferences): TimePreferencesPayload {
  return {
    timezone: value.timezone ?? value.detected ?? "UTC", timezone_source: value.timezone ? "manual" : "browser",
    detected_timezone: value.detected, time_format: value.timeFormat,
  };
}

function zoneFrom(value: unknown): string | null {
  return typeof value === "string" && value.length <= 64 && isValidZone(value.trim()) ? canonicalZone(value.trim()) : null;
}

function update({ store, body }: DemoRequest): Response {
  const current = preferencesOf(store);
  const next = { ...current };
  if ("timezone" in body) {
    if (body.timezone === null) next.timezone = null;
    else {
      const zone = zoneFrom(body.timezone);
      if (!zone) return problem(422, INVALID_ZONE);
      next.timezone = zone;
    }
  }
  if ("time_format" in body && body.time_format !== null) {
    if (!(TIME_FORMATS as readonly unknown[]).includes(body.time_format)) return problem(422, "choose auto, 12h or 24h");
    next.timeFormat = body.time_format as DemoTimePreferences["timeFormat"];
  }
  state.set(store, next);
  return json(publicPreferences(next));
}

export function registerPreferences(router: DemoRouter): void {
  router
    .on("GET", "/v1/me/preferences", ({ store }) => json(publicPreferences(preferencesOf(store))))
    .on("PUT", "/v1/me/preferences", update)
    .on("POST", "/v1/me/preferences/detected", ({ store, body }) => {
      const zone = zoneFrom(body.timezone);
      if (!zone) return problem(422, INVALID_ZONE);
      const next = { ...preferencesOf(store), detected: zone };
      state.set(store, next);
      return json(publicPreferences(next));
    });
}
