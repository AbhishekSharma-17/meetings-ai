import { DEMO_ID_PREFIX } from "../../demo-mode";

/** Stable, valid UUIDs for sample records: de300000-0000-4000-8GGG-NNNNNNNNNNNN. */
export function demoId(group: number, index: number): string {
  return `${DEMO_ID_PREFIX}0000-4000-8${group.toString(16).padStart(3, "0")}-${index.toString(16).padStart(12, "0")}`;
}

export const ORG_MAIN = demoId(1, 1);
export const ORG_VENTURES = demoId(1, 2);
export const userId = (index: number) => demoId(2, index);
export const meetingId = (index: number) => demoId(3, index);
export const baseId = (index: number) => demoId(4, index);
export const conversationId = (index: number) => demoId(5, index);
export const calendarEventId = (index: number) => demoId(6, index);
export const reportId = (index: number) => demoId(7, index);
export const documentId = (index: number) => demoId(8, index);
export const usageEventId = (index: number) => demoId(9, index);
export const auditId = (index: number) => demoId(10, index);
export const credentialId = (index: number) => demoId(11, index);
export const profileId = (index: number) => demoId(12, index);

let sequence = 1000;
/** A fresh id for records created during the demo session. */
export function newId(group: number): string {
  sequence += 1;
  return demoId(group, sequence);
}

/** Timestamps are relative to when the demo started, so the sample data is always current. */
export type Clock = { start: number };

export function createClock(): Clock {
  return { start: Date.now() };
}

export const minutesFrom = (clock: Clock, minutes: number): string => new Date(clock.start + minutes * 60_000).toISOString();

/** A local wall-clock time `dayOffset` days from today, e.g. tomorrow at 10:30. */
export function localTime(clock: Clock, dayOffset: number, hour: number, minute = 0): Date {
  const date = new Date(clock.start);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date;
}

export const localIso = (clock: Clock, dayOffset: number, hour: number, minute = 0): string => localTime(clock, dayOffset, hour, minute).toISOString();

/** Small deterministic pseudo-random generator so generated ledgers look varied but stable. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
