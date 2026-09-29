import type { LeavePolicyValues, LeaveReason, MeetingLeave } from "./types";

/**
 * Plain-language copy for when the assistant leaves a call. Pure: every function takes the clock
 * formatter (`formatTime` from the time preferences in the app) so it renders in the reader's zone.
 */
export type ClockFormatter = (value: string | Date) => string;

/** Quiet stretches longer than this read better as "since 11:04" than as a count of minutes. */
const LONG_QUIET_MINUTES = 60;
const MINUTE_MS = 60_000;

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
const minutesBetween = (from: string | Date, to: string | Date) =>
  Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / MINUTE_MS));

export const LEAVE_FIELDS: ReadonlyArray<{ key: keyof LeavePolicyValues; label: string; unit: "minutes" | "hours"; hint: string }> = [
  { key: "quiet_after_end_minutes", label: "Quiet time after the scheduled end", unit: "minutes",
    hint: "Once a meeting is past its calendar end time, leave after this long with no one speaking. New speech restarts the wait." },
  { key: "silence_minutes", label: "Silence before the scheduled end", unit: "minutes",
    hint: "Before the end time, or in meetings without a calendar time, leave after this long with no one speaking." },
  { key: "no_one_joined_minutes", label: "If no one speaks after it joins", unit: "minutes",
    hint: "Leave an empty call after this long, counted from the meeting start." },
  { key: "max_hours", label: "Safety limit for one call", unit: "hours",
    hint: "A safety net for a forgotten assistant, not a meeting length. Keep in call can't go past it." },
];

/** The safety cap in force: the workspace value, never more than the meeting-bot service allows. */
export const effectiveHours = (values: LeavePolicyValues, serviceMaxHours: number): number => Math.min(values.max_hours, serviceMaxHours);

/** "the 4-hour limit of the meeting-bot service" or "the workspace's 3-hour limit for one call". */
export function limitPhrase(hours: number, isServiceLimit: boolean): string {
  return isServiceLimit ? `the ${hours}-hour limit of the meeting-bot service` : `the workspace's ${hours}-hour limit for one call`;
}

/** Shown when the workspace asks for longer than the meeting-bot service allows. */
export function serviceLimitNote(serviceMaxHours: number): string {
  return `The meeting-bot service currently ends any call after ${plural(serviceMaxHours, "hour")}, so a longer safety limit only applies if that service limit is raised.`;
}

/** A worked example with the workspace values, e.g. a 10:30–11:00 meeting that runs until 11:40. */
export function policyPreview(values: LeavePolicyValues, serviceMaxHours: number): string {
  const leaveMinute = 40 + values.quiet_after_end_minutes;
  const leaveAt = leaveMinute >= 60 ? `12:${String(leaveMinute - 60).padStart(2, "0")}` : `11:${leaveMinute}`;
  return `For example, a meeting booked for 10:30–11:00 where people keep talking until 11:40: the assistant stays the whole time and leaves at ${leaveAt}, ${plural(values.quiet_after_end_minutes, "minute")} after the last words. It never leaves just because the end time passed, and always leaves after ${plural(effectiveHours(values, serviceMaxHours), "hour")} in one call.`;
}

/** "Leaves automatically after 10 min of silence · no later than 6:31 PM (8-hour safety limit)". */
export function autoLeaveLine(leave: MeetingLeave, time: ClockFormatter, now: Date = new Date()): string {
  const { policy, scheduled_end: end, safety_cap_at: cap, keep_until: keep } = leave;
  const quiet = end && new Date(end) <= now
    ? `Past its ${time(end)} end, so it leaves after ${policy.quiet_after_end_minutes} min with no one speaking`
    : end
      ? `Leaves after ${policy.silence_minutes} min of silence (${policy.quiet_after_end_minutes} min once the ${time(end)} end has passed)`
      : `Leaves automatically after ${policy.silence_minutes} min of silence`;
  const kept = keep && new Date(keep) > now ? ` · kept in the call until ${time(keep)}` : "";
  const limit = cap ? ` · no later than ${time(cap)} (${leave.effective_max_hours}-hour ${leave.cap_is_service_limit ? "limit of the meeting-bot service" : "safety limit"})` : "";
  return `${quiet}${kept}${limit}`;
}

/** Heads-up banner title and detail for an automatic leave that is about to happen. */
export function headsUpCopy(leave: MeetingLeave, time: ClockFormatter): { title: string; detail: string } | null {
  const next = leave.next_leave;
  if (!leave.in_call || !next?.heads_up_sent) return null;
  const title = `The assistant will leave at ${time(next.leave_at)}`;
  if (next.reason === "time_limit") return { title, detail: `It reaches ${limitPhrase(leave.effective_max_hours, leave.cap_is_service_limit)}. Everything captured so far is kept.` };
  if (next.reason === "no_one_joined") return { title, detail: `No one has spoken since it joined${leave.joined_at ? ` at ${time(leave.joined_at)}` : ""}.` };
  return { title, detail: next.quiet_since ? `It's been quiet since ${time(next.quiet_since)}.` : "It's been quiet for a while." };
}

function quietClause(leave: MeetingLeave, endedAt: string, time: ClockFormatter): string | null {
  const since = leave.ended?.quiet_since;
  if (!since || (leave.ended?.reason !== "silent" && leave.ended?.reason !== "ended_quiet_after_schedule")) return null;
  const end = leave.scheduled_end;
  if (leave.ended?.reason === "ended_quiet_after_schedule" && end) {
    const from = new Date(Math.max(new Date(since).getTime(), new Date(end).getTime()));
    const minutes = minutesBetween(from, endedAt);
    return minutes > LONG_QUIET_MINUTES
      ? `no one had spoken since ${time(since)}, after the scheduled end (${time(end)})`
      : `no one had spoken for ${plural(minutes, "minute")} after the scheduled end (${time(end)})`;
  }
  const minutes = minutesBetween(since, endedAt);
  return minutes > LONG_QUIET_MINUTES ? `no one had spoken since ${time(since)}` : `no one had spoken for ${plural(minutes, "minute")}`;
}

const reasonClause: Record<LeaveReason, (leave: MeetingLeave, time: ClockFormatter) => string> = {
  ended_quiet_after_schedule: () => "no one was speaking after the scheduled end",
  silent: () => "no one was speaking",
  no_one_joined: (leave, time) => `no one spoke after it joined${leave.joined_at ? ` at ${time(leave.joined_at)}` : ""}`,
  everyone_left: () => "no one could be heard any more, so everyone seems to have left",
  host_ended: () => "the host ended the meeting",
  time_limit: (leave) => `it reached ${limitPhrase(leave.effective_max_hours, leave.cap_is_service_limit)}`,
  user_stopped: () => "someone asked it to leave",
  not_admitted: () => "no one admitted it from the waiting room",
  capture_ended: () => "the call ended",
  capture_failed: () => "capture stopped with an error",
  bot_lost: () => "the meeting-bot service lost track of the call",
};

/** "Ended 11:12 · the assistant left because no one had spoken for 5 minutes after the scheduled end (11:00)". */
export function endedLine(leave: MeetingLeave, time: ClockFormatter): string | null {
  const ended = leave.ended;
  if (!ended) return null;
  const at = ended.ended_at ? `Ended ${time(ended.ended_at)} · ` : "";
  if (ended.reason === "capture_failed") return `${at}capture stopped with an error`;
  const because = (ended.ended_at ? quietClause(leave, ended.ended_at, time) : null) ?? reasonClause[ended.reason](leave, time);
  return `${at}the assistant left because ${because}`;
}
