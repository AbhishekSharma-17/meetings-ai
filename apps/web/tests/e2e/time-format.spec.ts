import { expect, test } from "@playwright/test";
import {
  addDaysToKey, canonicalZone, dateToWallTime, dayKeyIn, formatDayKey, formatIn, offsetLabel, offsetMinutes, TIME, wallTimeToDate, zoneAbbreviation,
} from "../../src/lib/time-format";
import { filterTimeZones, timeZoneOptions } from "../../src/lib/time-zones";

/** Pure time-zone helpers (run in Node, no page): DST edges, day placement and clock formats. */
const NEW_YORK = "America/New_York";

test.describe("time-format helpers", () => {
  test("wall-clock input in a zone becomes the right instant across DST changes", () => {
    expect(wallTimeToDate("2026-09-28T16:12", "Asia/Kolkata")?.toISOString()).toBe("2026-09-28T10:42:00.000Z");
    expect(wallTimeToDate("2026-07-01T09:00", NEW_YORK)?.toISOString()).toBe("2026-07-01T13:00:00.000Z"); // EDT
    expect(wallTimeToDate("2026-12-01T09:00", NEW_YORK)?.toISOString()).toBe("2026-12-01T14:00:00.000Z"); // EST
    // 02:30 does not exist on 8 March 2026 in New York: it resolves forward to 03:30 EDT.
    expect(wallTimeToDate("2026-03-08T02:30", NEW_YORK)?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    // 01:30 happens twice on 1 November 2026: the first (EDT) one is used.
    expect(wallTimeToDate("2026-11-01T01:30", NEW_YORK)?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(wallTimeToDate("not a time", NEW_YORK)).toBeNull();
    expect(dateToWallTime("2026-11-01T06:30:00Z", NEW_YORK)).toBe("2026-11-01T01:30");
  });

  test("offsets and day keys follow the zone, not the machine", () => {
    expect(offsetMinutes(new Date("2026-10-31T16:00:00Z"), NEW_YORK)).toBe(-240);
    expect(offsetMinutes(new Date("2026-11-02T16:00:00Z"), NEW_YORK)).toBe(-300);
    expect(offsetMinutes(new Date("2026-09-28T10:00:00Z"), "Asia/Kathmandu")).toBe(345);
    expect(dayKeyIn("2026-09-28T20:00:00Z", "Asia/Kolkata")).toBe("2026-09-29");
    expect(dayKeyIn("2026-09-28T20:00:00Z", NEW_YORK)).toBe("2026-09-28");
    expect(addDaysToKey("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDaysToKey("2026-03-08", 1)).toBe("2026-03-09");
    expect(formatDayKey("2026-09-28", { weekday: "long", month: "long", day: "numeric" })).toBe("Monday, September 28");
  });

  test("12 and 24-hour clocks and zone labels", () => {
    const moment = "2026-09-28T03:42:00Z";
    expect(formatIn(moment, TIME, { timeZone: "Asia/Kolkata", timeFormat: "12h" })).toBe("9:12 AM");
    expect(formatIn(moment, TIME, { timeZone: "Asia/Kolkata", timeFormat: "24h" })).toBe("09:12");
    expect(formatIn("2026-11-02T16:00:00Z", TIME, { timeZone: NEW_YORK, timeFormat: "12h" })).toBe("11:00 AM");
    expect(formatIn(null, TIME, { timeZone: "UTC", timeFormat: "24h" })).toBe("—");
    expect(zoneAbbreviation("Asia/Kolkata", new Date(moment))).toBe("IST");
    expect(zoneAbbreviation(NEW_YORK, new Date("2026-12-01T12:00:00Z"))).toBe("EST");
    expect(zoneAbbreviation("Asia/Kathmandu", new Date(moment))).toBe("UTC+5:45");
    expect(offsetLabel(-210)).toBe("UTC-3:30");
    expect(canonicalZone("Asia/Calcutta")).toBe("Asia/Kolkata");
  });

  test("zone list is searchable by name, abbreviation and offset", () => {
    const options = timeZoneOptions([], new Date("2026-09-28T10:00:00Z"));
    expect(options.some((option) => option.id === "UTC")).toBe(true);
    expect(filterTimeZones(options, "+5:45").map((option) => option.id)).toEqual(["Asia/Kathmandu"]);
    expect(filterTimeZones(options, "india standard").map((option) => option.id)).toContain("Asia/Kolkata");
    expect(filterTimeZones(options, "new york").map((option) => option.id)).toEqual([NEW_YORK]);
  });
});
