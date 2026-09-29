import type { LeavePolicyValues, LeaveReason, MeetingLeave } from "../../types";
import type { MeetingSeed } from "../fixtures/meetings";
import { json, problem } from "../http";
import type { DemoRouter } from "../router";
import type { DemoStore } from "../store";
import { findSeed } from "./meetings";

/** When the assistant leaves a call, answered from sample data (policy, the live call's plan, why calls ended). */
const DEFAULTS: LeavePolicyValues = { silence_minutes: 10, quiet_after_end_minutes: 5, no_one_joined_minutes: 10, max_hours: 4 };
/** The sample meeting-bot service ends every call after 4 hours, like production. */
const SERVICE_MAX_HOURS = 4;
const LIMITS: Record<keyof LeavePolicyValues, [number, number]> = {
  silence_minutes: [3, 60], quiet_after_end_minutes: [2, 30], no_one_joined_minutes: [2, 60], max_hours: [2, 12],
};
const MINUTE = 60_000;
const KEEP_MS = 30 * MINUTE;
const IN_CALL = new Set(["live", "needs_attention", "needs_human_help", "active"]);
const ENDED = new Set(["completed", "stopped", "failed"]);

/** How each finished sample meeting ended (anything else the visitor stopped themselves). */
const SAMPLE_ENDINGS: Record<string, { reason: LeaveReason; ended_by: "auto" | "user" | "host" | "vexa"; quietBeforeEnd?: number }> = {
  "acme-roadmap": { reason: "ended_quiet_after_schedule", ended_by: "auto", quietBeforeEnd: 5 },
  "initech-discovery": { reason: "everyone_left", ended_by: "vexa" },
  "globex-renewal": { reason: "host_ended", ended_by: "host" },
  "leadership": { reason: "ended_quiet_after_schedule", ended_by: "auto", quietBeforeEnd: 5 },
  "globex-golive": { reason: "user_stopped", ended_by: "user" },
  "acme-security": { reason: "silent", ended_by: "auto", quietBeforeEnd: 15 },
  "globex-workshop": { reason: "capture_failed", ended_by: "vexa" },
};

type LeaveDemoState = { policy: LeavePolicyValues; configured: boolean; keeps: Record<string, number> };
const states = new WeakMap<DemoStore, LeaveDemoState>();

function stateOf(store: DemoStore): LeaveDemoState {
  const existing = states.get(store);
  if (existing) return existing;
  const created: LeaveDemoState = { policy: { ...DEFAULTS }, configured: false, keeps: {} };
  states.set(store, created);
  return created;
}

const iso = (ms: number) => new Date(ms).toISOString();

function inCallView(seed: MeetingSeed, state: LeaveDemoState, now: number): Partial<MeetingLeave> {
  const joined = seed.meeting.joined_at ? new Date(seed.meeting.joined_at).getTime() : now;
  const keep = state.keeps[seed.meeting.id] && state.keeps[seed.meeting.id] > now ? state.keeps[seed.meeting.id] : null;
  const scheduledEnd = joined - MINUTE + 30 * MINUTE;
  const lastSpeech = now - 20_000;
  const quietLeave = Math.min(lastSpeech + (state.policy.silence_minutes + 5) * MINUTE,
    Math.max(lastSpeech + state.policy.quiet_after_end_minutes * MINUTE, scheduledEnd));
  // Keep in call never moves the safety cap.
  const cap = joined + Math.min(state.policy.max_hours, SERVICE_MAX_HOURS) * 60 * MINUTE;
  return {
    scheduled_end: iso(scheduledEnd), last_speech_at: iso(lastSpeech), safety_cap_at: iso(cap), keep_until: keep ? iso(keep) : null,
    can_keep: cap - now > 10 * MINUTE,
    next_leave: { leave_at: iso(Math.max(quietLeave, keep ?? 0)), reason: now >= scheduledEnd ? "ended_quiet_after_schedule" : "silent", quiet_since: iso(lastSpeech), heads_up_sent: false },
  };
}

function endedView(seed: MeetingSeed): Partial<MeetingLeave> {
  const stopped = seed.meeting.stopped_at ? new Date(seed.meeting.stopped_at).getTime() : Date.now();
  const sample = SAMPLE_ENDINGS[seed.key];
  if (!sample) return { ended: { reason: "user_stopped", ended_by: "user", ended_at: iso(stopped), quiet_since: null } };
  const quietSince = sample.quietBeforeEnd ? stopped - sample.quietBeforeEnd * MINUTE : null;
  const scheduledEnd = sample.reason === "ended_quiet_after_schedule" && quietSince ? quietSince - 3 * MINUTE : null;
  return {
    scheduled_end: scheduledEnd ? iso(scheduledEnd) : null,
    ended: { reason: sample.reason, ended_by: sample.ended_by, ended_at: iso(stopped), quiet_since: quietSince ? iso(quietSince) : null },
  };
}

function view(store: DemoStore, seed: MeetingSeed): MeetingLeave {
  const state = stateOf(store);
  const now = Date.now();
  const inCall = IN_CALL.has(seed.meeting.status);
  return {
    meeting_id: seed.meeting.id, in_call: inCall, policy: { ...state.policy }, joined_at: seed.meeting.joined_at,
    effective_max_hours: Math.min(state.policy.max_hours, SERVICE_MAX_HOURS), service_max_hours: SERVICE_MAX_HOURS,
    cap_is_service_limit: SERVICE_MAX_HOURS <= state.policy.max_hours,
    scheduled_end: null, last_speech_at: null, safety_cap_at: null, keep_until: null, can_manage: true, can_keep: false,
    next_leave: null, ended: null, last_error: null,
    ...(inCall ? inCallView(seed, state, now) : ENDED.has(seed.meeting.status) ? endedView(seed) : {}),
  };
}

function policyView(store: DemoStore) {
  const state = stateOf(store);
  return { ...state.policy, service_max_hours: SERVICE_MAX_HOURS, effective_max_hours: Math.min(state.policy.max_hours, SERVICE_MAX_HOURS), configured: state.configured, can_edit: true, updated_at: null, defaults: { ...DEFAULTS }, limits: LIMITS };
}

function parsePolicy(body: Record<string, unknown>): LeavePolicyValues | string {
  const values = { ...DEFAULTS };
  for (const key of Object.keys(LIMITS) as Array<keyof LeavePolicyValues>) {
    const value = body[key];
    const [low, high] = LIMITS[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) return `${key} must be a whole number from ${low} to ${high}.`;
    values[key] = value;
  }
  return values;
}

export function registerLeave(router: DemoRouter): void {
  router
    .on("GET", "/v1/workspace/leave-policy", ({ store }) => json(policyView(store)))
    .on("PUT", "/v1/workspace/leave-policy", ({ store, body }) => {
      const parsed = parsePolicy(body);
      if (typeof parsed === "string") return problem(422, parsed);
      const state = stateOf(store);
      state.policy = parsed;
      state.configured = true;
      return json(policyView(store));
    })
    .on("GET", "/v1/meetings/:id/leave", ({ store, params }) => {
      const seed = findSeed(store, params.id);
      return seed ? json(view(store, seed)) : problem(404, "meeting not found");
    })
    .on("POST", "/v1/meetings/:id/keep", ({ store, params }) => {
      const seed = findSeed(store, params.id);
      if (!seed) return problem(404, "meeting not found");
      if (!IN_CALL.has(seed.meeting.status)) return problem(409, "the assistant is not in this call any more");
      const state = stateOf(store);
      const now = Date.now();
      const joined = seed.meeting.joined_at ? new Date(seed.meeting.joined_at).getTime() : now;
      const cap = joined + Math.min(state.policy.max_hours, SERVICE_MAX_HOURS) * 60 * MINUTE;
      if (cap - now <= 10 * MINUTE) return problem(409, "the assistant is about to reach the limit for one call and can't stay longer");
      state.keeps[seed.meeting.id] = Math.min(Math.max(now, state.keeps[seed.meeting.id] ?? 0) + KEEP_MS, cap);
      return json(view(store, seed));
    });
}
