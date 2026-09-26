import {
  Archive, BookOpen, CalendarCheck, CalendarClock, CalendarPlus, CalendarX, CircleCheck, Cpu, Database, FilePen, FileText,
  FileUp, KeyRound, LogIn, type LucideIcon, MessageSquare, MessageSquareX, Mic, MicOff, PenLine, RefreshCw, Search, Send,
  Settings2, ShieldAlert, ShieldCheck, Trash2, UserCog, UserMinus, UserPen, UserPlus, Users, Video,
} from "lucide-react";
import type { AuditEvent } from "@/lib/types";

/** Business-language rendering of workspace audit events. Raw endpoints are never shown. */
export type ActivityCategory = "meetings" | "minutes" | "knowledge" | "people" | "security" | "integrations" | "settings";

export const activityCategories: Record<ActivityCategory, { label: string; icon: LucideIcon }> = {
  meetings: { label: "Meetings", icon: Video },
  minutes: { label: "Minutes", icon: FileText },
  knowledge: { label: "Knowledge", icon: BookOpen },
  people: { label: "People", icon: Users },
  security: { label: "Security", icon: ShieldCheck },
  integrations: { label: "Integrations", icon: CalendarCheck },
  settings: { label: "Settings", icon: Settings2 },
};
export const activityCategoryOrder = Object.keys(activityCategories) as ActivityCategory[];

type TargetKind = "meeting" | "knowledge" | "member";
type Rule = {
  method?: string;
  path: string;
  category: ActivityCategory;
  icon: LucideIcon;
  /** Verb phrase after the actor, e.g. "approved the minutes for". */
  verb: string;
  target?: TargetKind;
  /** Used when the target cannot be resolved, e.g. a deleted meeting. */
  fallback?: string;
  /** Whole phrase used instead of verb + fallback when that would repeat itself. */
  unresolved?: string;
  suffix?: string;
};

/** Keyed by normalised path; ids appear as {id}. First match wins, so method-specific rules come first. */
const rules: Rule[] = [
  { method: "POST", path: "/v1/meetings", category: "meetings", icon: Video, verb: "added a meeting" },
  { method: "POST", path: "/v1/meetings/schedules", category: "meetings", icon: CalendarClock, verb: "scheduled the assistant for a meeting" },
  { method: "POST", path: "/v1/meetings/{id}/join", category: "meetings", icon: Mic, verb: "sent the assistant to", target: "meeting", fallback: "a meeting" },
  { method: "POST", path: "/v1/meetings/{id}/stop", category: "meetings", icon: MicOff, verb: "stopped the assistant in", target: "meeting", fallback: "a meeting" },
  { method: "POST", path: "/v1/meetings/{id}/refresh", category: "meetings", icon: RefreshCw, verb: "refreshed the status of", target: "meeting", fallback: "a meeting" },
  { method: "POST", path: "/v1/meetings/{id}/post-meeting-job/retry", category: "meetings", icon: RefreshCw, verb: "retried processing for", target: "meeting", fallback: "a meeting" },
  { method: "DELETE", path: "/v1/meetings/{id}", category: "meetings", icon: Trash2, verb: "deleted the meeting", target: "meeting", unresolved: "deleted a meeting" },
  { path: "/v1/meetings/{id}/speaker-identities", category: "meetings", icon: UserPen, verb: "confirmed speaker identities in", target: "meeting", fallback: "a meeting" },
  { path: "/v1/meetings/{id}/transcript/segments/{id}/speaker", category: "meetings", icon: PenLine, verb: "corrected a speaker label in", target: "meeting", fallback: "a meeting" },
  { path: "/v1/meetings/{id}/knowledge", category: "knowledge", icon: Database, verb: "changed AI knowledge settings for", target: "meeting", fallback: "a meeting" },
  { path: "/v1/meetings/{id}/minutes/generate", category: "minutes", icon: FilePen, verb: "generated draft minutes for", target: "meeting", fallback: "a meeting" },
  { path: "/v1/meetings/{id}/minutes/approve", category: "minutes", icon: CircleCheck, verb: "approved the minutes for", target: "meeting", fallback: "a meeting" },
  { path: "/v1/meetings/{id}/minutes/send", category: "minutes", icon: Send, verb: "sent the recap for", target: "meeting", fallback: "a meeting" },
  { path: "/v1/meetings/{id}/minutes/send-configured", category: "minutes", icon: Send, verb: "sent the recap for", target: "meeting", fallback: "a meeting" },
  { method: "DELETE", path: "/v1/meetings/{id}/minutes", category: "minutes", icon: Trash2, verb: "discarded the draft minutes for", target: "meeting", fallback: "a meeting" },
  { path: "/v1/meetings/{id}/minutes", category: "minutes", icon: FilePen, verb: "edited the minutes for", target: "meeting", fallback: "a meeting" },
  { path: "/v1/meetings/{id}/delivery-settings", category: "minutes", icon: Send, verb: "updated recap recipients for", target: "meeting", fallback: "a meeting" },
  { path: "/v1/meetings/{id}/mom-guidance", category: "minutes", icon: FileText, verb: "changed the minutes format for", target: "meeting", fallback: "a meeting" },
  { method: "POST", path: "/v1/calendar/meetings", category: "meetings", icon: Mic, verb: "sent the assistant to a calendar meeting" },
  { method: "POST", path: "/v1/calendar/schedules", category: "meetings", icon: CalendarClock, verb: "scheduled the assistant for a calendar meeting" },
  { path: "/v1/calendar/schedules/{id}/cancel", category: "meetings", icon: CalendarX, verb: "cancelled the scheduled assistant for", target: "meeting", fallback: "a calendar meeting" },
  { path: "/v1/calendar/events/{id}/prep", category: "meetings", icon: FileText, verb: "prepared a meeting brief" },
  { method: "POST", path: "/v1/knowledge-bases", category: "knowledge", icon: Database, verb: "created a knowledge base" },
  { path: "/v1/knowledge-bases/{id}/sharing", category: "knowledge", icon: Users, verb: "changed who can access", target: "knowledge", fallback: "a knowledge base" },
  { path: "/v1/knowledge-bases/{id}/reindex", category: "knowledge", icon: RefreshCw, verb: "re-indexed", target: "knowledge", fallback: "a knowledge base" },
  { path: "/v1/knowledge-bases/{id}/conversations/{id}", category: "knowledge", icon: MessageSquareX, verb: "deleted a saved AI chat in", target: "knowledge", fallback: "a knowledge base" },
  { method: "DELETE", path: "/v1/knowledge-bases/{id}", category: "knowledge", icon: Trash2, verb: "deleted the knowledge base", target: "knowledge", unresolved: "deleted a knowledge base" },
  { path: "/v1/knowledge-bases/{id}", category: "knowledge", icon: Database, verb: "updated the knowledge base", target: "knowledge", unresolved: "updated a knowledge base" },
  { path: "/v1/knowledge/chat", category: "knowledge", icon: MessageSquare, verb: "asked AI knowledge a question" },
  { path: "/v1/knowledge/chat/stream", category: "knowledge", icon: MessageSquare, verb: "asked AI knowledge a question" },
  { path: "/v1/knowledge/search", category: "knowledge", icon: Search, verb: "searched AI knowledge" },
  { path: "/v1/workspace/invite", category: "people", icon: UserPlus, verb: "invited a new teammate" },
  { path: "/v1/workspace/members/{id}/role", category: "people", icon: UserCog, verb: "changed the role of", target: "member", fallback: "a teammate" },
  { path: "/v1/workspace/members/{id}/temporary-password", category: "security", icon: KeyRound, verb: "reset sign-in access for", target: "member", fallback: "a teammate" },
  { method: "DELETE", path: "/v1/workspace/members/{id}", category: "people", icon: UserMinus, verb: "removed", target: "member", fallback: "a teammate", suffix: "from the workspace" },
  { path: "/v1/auth/change-password", category: "security", icon: KeyRound, verb: "changed their password" },
  { path: "/v1/auth/me", category: "people", icon: UserPen, verb: "updated their profile" },
  { path: "/v1/calendar/connect/{id}", category: "integrations", icon: CalendarPlus, verb: "connected a calendar account" },
  { method: "DELETE", path: "/v1/calendar/connections/{id}", category: "integrations", icon: CalendarX, verb: "disconnected a calendar account" },
  { path: "/v1/calendar/connections/{id}", category: "integrations", icon: PenLine, verb: "renamed a calendar connection" },
  { path: "/v1/calendar/sync", category: "integrations", icon: RefreshCw, verb: "synced calendars" },
  { method: "POST", path: "/v1/provider-profiles", category: "integrations", icon: Cpu, verb: "added an AI provider configuration" },
  { path: "/v1/provider-profiles/{id}/test", category: "integrations", icon: Cpu, verb: "validated an AI provider configuration" },
  { method: "DELETE", path: "/v1/provider-profiles/{id}", category: "integrations", icon: Trash2, verb: "deleted an AI provider configuration" },
  { path: "/v1/provider-profiles/{id}", category: "integrations", icon: Cpu, verb: "updated an AI provider configuration" },
  { path: "/v1/provider-defaults/{id}", category: "integrations", icon: Cpu, verb: "changed a default AI provider" },
  { path: "/v1/workspace", category: "settings", icon: Settings2, verb: "updated the workspace profile" },
  { path: "/v1/workspace/brief", category: "settings", icon: FilePen, verb: "updated the company profile" },
  { method: "DELETE", path: "/v1/workspace/brief/documents/{id}", category: "settings", icon: Trash2, verb: "removed a company reference document" },
  { path: "/v1/workspace/brief/documents", category: "settings", icon: FileUp, verb: "added a company reference document" },
  { path: "/v1/workspace/retention", category: "settings", icon: Archive, verb: "changed the data retention policy" },
  { path: "/v1/workspaces", category: "settings", icon: Settings2, verb: "created a new workspace" },
  { path: "/v1/workspaces/{id}/switch", category: "settings", icon: Settings2, verb: "switched to another workspace" },
];

export type ActivityLookup = {
  actorName(userId: string): string | null;
  meetingTitle(id: string): string | null;
  knowledgeName(id: string): string | null;
};

export type ActivityEntry = {
  id: string;
  at: Date;
  category: ActivityCategory;
  icon: LucideIcon;
  failed: boolean;
  /** Bold lead-in (a person), or null when the sentence stands alone. */
  actor: string | null;
  text: string;
  target: string | null;
  suffix: string | null;
  /** Plain sentence for search and screen readers. */
  sentence: string;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function normalisePath(path: string): string {
  return path.split("?")[0].replace(/\{[^}]+\}/g, "{id}").replace(new RegExp(`/${UUID.source}`, "gi"), "/{id}").replace(/\/+$/, "") || "/";
}

function parseAction(event: AuditEvent): { method: string | null; path: string } {
  const [first, second] = event.action.split(" ");
  if (METHODS.has(first) && second) return { method: first, path: normalisePath(second) };
  return { method: null, path: normalisePath(event.resource_path) };
}

const capitalise = (value: string) => value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;

function humanise(method: string | null, path: string, action: string): string {
  const words = path.split("/").filter((part) => part && part !== "v1" && part !== "{id}").map((part) => part.replaceAll(/[-_]/g, " "));
  if (!method) {
    const parts = action.split(/[._]/).filter(Boolean);
    const last = parts.pop() ?? "";
    return /ed$/.test(last) ? `${last} ${parts.join(" ")}`.trim() : parts.concat(last).join(" ").trim() || "made a change";
  }
  const noun = words.join(" ") === "workspace" ? "workspace settings" : words.join(" ") || "the workspace";
  const verb = method === "DELETE" ? "deleted" : "updated";
  return `${verb} ${noun}`;
}

function special(event: AuditEvent, lookup: ActivityLookup, actor: string | null): Omit<ActivityEntry, "id" | "at" | "sentence"> | null {
  const targetId = event.resource_id ?? event.resource_path.match(UUID)?.[0] ?? null;
  switch (event.action) {
    case "auth.login.succeeded": return { category: "security", icon: LogIn, failed: false, actor, text: "signed in", target: null, suffix: null };
    case "auth.login.denied": return { category: "security", icon: ShieldAlert, failed: true, actor: null, text: "Sign-in failed — wrong email or password", target: null, suffix: null };
    case "auth.login.throttled": return { category: "security", icon: ShieldAlert, failed: true, actor: null, text: "Sign-in paused after repeated failed attempts", target: null, suffix: null };
    case "retention.meeting.deleted": return { category: "meetings", icon: Archive, failed: false, actor: null, text: "Automatic retention deleted", target: (targetId && lookup.meetingTitle(targetId)) || "an older meeting", suffix: null };
    case "retention.chats.deleted": return { category: "knowledge", icon: Archive, failed: false, actor: null, text: "Automatic retention deleted older saved AI chats", target: null, suffix: null };
    default: return null;
  }
}

function resolveTarget(kind: TargetKind | undefined, id: string | null, lookup: ActivityLookup): string | null {
  if (!kind || !id) return null;
  if (kind === "meeting") return lookup.meetingTitle(id);
  if (kind === "knowledge") return lookup.knowledgeName(id);
  return lookup.actorName(id);
}

function sentenceOf(parts: Pick<ActivityEntry, "actor" | "text" | "target" | "suffix" | "failed">): string {
  const body = [parts.actor, parts.text, parts.target, parts.suffix].filter(Boolean).join(" ");
  return parts.failed && parts.actor ? `${body} (failed)` : body;
}

export function describeAuditEvent(event: AuditEvent, lookup: ActivityLookup): ActivityEntry {
  const actor = event.actor_user_id ? (lookup.actorName(event.actor_user_id) ?? "A former teammate") : null;
  const base = { id: event.id, at: new Date(event.created_at) };
  const fixed = special(event, lookup, actor);
  if (fixed) return { ...base, ...fixed, sentence: sentenceOf(fixed) };

  const { method, path } = parseAction(event);
  const rule = rules.find((item) => item.path === path && (!item.method || !method || item.method === method));
  const failed = event.status_code >= 400;
  const targetId = event.resource_id ?? event.resource_path.match(UUID)?.[0] ?? null;
  const resolved = rule?.target ? resolveTarget(rule.target, targetId, lookup) : null;
  const unresolved = rule?.target && !resolved ? rule.unresolved : undefined;
  const verb = unresolved ?? rule?.verb ?? humanise(method, path, event.action);
  const target = rule?.target && !unresolved ? (resolved ?? rule.fallback ?? null) : null;
  const entry = {
    category: rule?.category ?? "settings",
    icon: rule?.icon ?? Settings2,
    failed,
    actor,
    text: actor ? verb : capitalise(verb),
    target,
    suffix: rule?.suffix ?? null,
  };
  return { ...base, ...entry, sentence: sentenceOf(entry) };
}

/** "Today", "Yesterday", or a short date — used to group the feed. */
export function dayLabel(date: Date, now = new Date()): string {
  const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
