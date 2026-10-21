import { api } from "./meetings-service";
import type { CalendarEvent, MomGuidance } from "./types";

export type AutomationSettings = {
  enabled: boolean;
  connection_ids: string[];
  meeting_types: "all" | "one_off" | "recurring";
  enrolment_scope: "upcoming" | "newly_discovered";
  bot_name: string;
  recording_disclosure_acknowledged: boolean;
  mom_mode: "draft" | "send_automatically";
  mom_guidance: MomGuidance;
  delivery: { internal_group_ids: string[]; include_transcript: boolean };
  knowledge_enabled: boolean;
  knowledge_base_id: string | null;
};
export type AutomationView = AutomationSettings & {
  availability: { calendar_configured: boolean; scheduler_enabled: boolean; auto_mom_enabled?: boolean };
  last_scan_at: string | null; next_scan_at: string | null; last_error: string | null;
  can_edit: boolean; can_manage_policy: boolean; can_auto_send: boolean;
};
export type AutomationPolicy = { automatic_delivery_enabled: boolean; allowed_group_ids: string[]; can_manage: boolean };
export type AutomationPreview = { eligible: { event: CalendarEvent; reason: string }[]; excluded: { event: CalendarEvent; reason: string }[]; truncated: boolean };
export type MeetingAutomation = {
  automated: boolean; can_edit: boolean; skip: boolean; hold_delivery: boolean;
  mom_mode: "inherit" | "draft" | "send_automatically";
  internal_group_ids: string[] | null; knowledge_base_id: string | null;
  delivery_status: string | null; last_error: string | null;
};

export const calendarAutomationService = {
  get: () => api<AutomationView>("/v1/calendar/automation"),
  save: (settings: AutomationSettings) => api<AutomationView>("/v1/calendar/automation", { method: "PUT", body: JSON.stringify(settings) }),
  policy: () => api<AutomationPolicy>("/v1/workspace/automation-policy"),
  savePolicy: (policy: AutomationPolicy) => api<AutomationPolicy>("/v1/workspace/automation-policy", { method: "PUT", body: JSON.stringify({ automatic_delivery_enabled: policy.automatic_delivery_enabled, allowed_group_ids: policy.allowed_group_ids }) }),
  preview: (settings: AutomationSettings) => api<AutomationPreview>("/v1/calendar/automation/preview", { method: "POST", body: JSON.stringify(settings) }),
  reconcile: () => api<{ scheduled: number; excluded: number; errors: string[] }>("/v1/calendar/automation/reconcile", { method: "POST" }),
  meeting: (id: string) => api<MeetingAutomation>(`/v1/meetings/${encodeURIComponent(id)}/automation`),
  override: (id: string, settings: Partial<Pick<MeetingAutomation, "skip" | "hold_delivery" | "mom_mode" | "internal_group_ids" | "knowledge_base_id">>) => api<MeetingAutomation>(`/v1/meetings/${encodeURIComponent(id)}/automation`, { method: "PATCH", body: JSON.stringify(settings) }),
};

/** Only persisted rule fields are sent back; runtime capabilities remain server-owned. */
export function automationSettings(view: AutomationSettings): AutomationSettings {
  const { enabled, connection_ids, meeting_types, enrolment_scope, bot_name, recording_disclosure_acknowledged, mom_mode, mom_guidance, delivery, knowledge_enabled, knowledge_base_id } = view;
  return { enabled, connection_ids, meeting_types, enrolment_scope, bot_name, recording_disclosure_acknowledged, mom_mode, mom_guidance, delivery, knowledge_enabled, knowledge_base_id };
}

/** Session drafts are untrusted and may have been written by an older app version. */
export function isAutomationSettings(value: unknown): value is AutomationSettings {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const strings = (candidate: unknown) => Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string");
  const guidance = item.mom_guidance as Record<string, unknown> | null;
  const delivery = item.delivery as Record<string, unknown> | null;
  return typeof item.enabled === "boolean" && strings(item.connection_ids)
    && ["all", "one_off", "recurring"].includes(String(item.meeting_types))
    && ["upcoming", "newly_discovered"].includes(String(item.enrolment_scope))
    && typeof item.bot_name === "string" && typeof item.recording_disclosure_acknowledged === "boolean"
    && ["draft", "send_automatically"].includes(String(item.mom_mode))
    && !!guidance && ["standard", "actions", "client", "discovery", "custom"].includes(String(guidance.template))
    && typeof guidance.instructions === "string" && strings(guidance.focus_fields)
    && !!delivery && strings(delivery.internal_group_ids) && typeof delivery.include_transcript === "boolean"
    && typeof item.knowledge_enabled === "boolean" && (item.knowledge_base_id === null || typeof item.knowledge_base_id === "string");
}

export function automationError(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  const status = (cause as Error & { status?: number }).status;
  // Validation and permission responses contain user-facing explanations. Server failures
  // and network errors use the safe fallback instead of exposing infrastructure details.
  return status && status >= 400 && status < 500 && !/traceback|\n|\/home\/|\/app\//i.test(cause.message)
    ? cause.message.slice(0, 500) : fallback;
}
