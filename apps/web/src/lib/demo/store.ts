import type {
  AuditEvent, BriefDocument, CachedCalendarEvent, CalendarConnection, CalendarSchedule, CalendarSyncState, KnowledgeBase, KnowledgeConversation,
  MeetingDeliverySettings, MeetingMinutes, MomGuidance, OrganizationBrief, OrganizationIdentity, PostMeetingJob, PrepDocument, PrepInputs, PrepReportV2, RetentionPolicy,
  SpeakerIdentity, StorageCategoryKey, StorageItem, UsageEvent, VaultCredential, Workspace, WorkspaceMember,
} from "../types";
import { DEMO_CALENDARS_KEY, DEMO_WORKSPACE_KEY } from "../demo-mode";
import { auditEvents } from "./fixtures/audit";
import { CAL_CALENDLY, CAL_GOOGLE, CAL_OUTLOOK, calendarConnections, calendarEvents, calendarSchedules, calendarSyncs } from "./fixtures/calendar";
import { type Clock, createClock, documentId, minutesFrom, ORG_MAIN, ORG_VENTURES, reportId } from "./fixtures/ids";
import { conversations, knowledgeBases } from "./fixtures/knowledge";
import { meetingSeeds, type MeetingSeed } from "./fixtures/meetings";
import { minutesContent } from "./fixtures/minutes-content";
import { briefDocuments, defaultRetention, memberRecords, organizationBrief, personByName, team, workspaceRecord } from "./fixtures/people";
import { acmeReport, acmeUsage, initechReport, initechUsage } from "./fixtures/prep-reports";
import { aiSettings, type AiSettingsState, type BackendDefault, type BackendProfile, credentials, profiles, providerDefaults } from "./fixtures/providers";
import { generateLedger } from "./fixtures/usage";

export type DemoStore = {
  clock: Clock; orgId: string; displayName: string; photoUrl: string | null; defaultWorkspaceId: string | null;
  workspace: Workspace; members: WorkspaceMember[]; brief: OrganizationBrief; briefDocuments: BriefDocument[]; retention: RetentionPolicy;
  /** Saved "our company" identity; null until the visitor saves it (suggestions are shown instead). */
  companyIdentity: OrganizationIdentity | null;
  seeds: MeetingSeed[]; minutes: Record<string, MeetingMinutes | null>; guidance: Record<string, MomGuidance>;
  delivery: Record<string, MeetingDeliverySettings>; jobs: Record<string, PostMeetingJob>; identities: Record<string, SpeakerIdentity[]>;
  /** When the visitor sent the assistant to a meeting (ms), so its status can advance over time. */
  joinRequests: Record<string, number>;
  connections: CalendarConnection[]; events: CachedCalendarEvent[]; syncs: CalendarSyncState[]; schedules: CalendarSchedule[];
  reports: Record<string, PrepReportV2[]>; prepInputs: Record<string, PrepInputs>; prepDocuments: PrepDocument[];
  bases: KnowledgeBase[]; conversations: KnowledgeConversation[]; reindexedAt: Record<string, number>;
  profiles: BackendProfile[]; defaults: BackendDefault[]; credentials: VaultCredential[]; ai: AiSettingsState;
  usage: UsageEvent[]; audit: AuditEvent[]; purged: Partial<Record<StorageCategoryKey, string[]>>;
};

const dueFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

function minutesFor(clock: Clock, seed: MeetingSeed, key: MeetingSeed["minutes"] & object): MeetingMinutes {
  const ended = new Date(seed.meeting.stopped_at ?? seed.meeting.updated_at).getTime();
  const due = (days: number) => dueFormatter.format(new Date(ended + days * 86_400_000));
  const after = (minutes: number) => new Date(ended + minutes * 60_000).toISOString();
  return {
    meeting_id: seed.meeting.id, status: key.status, ...minutesContent(key.key, due),
    provider_profile_id: null, provider: "openrouter", model: "openai/gpt-6-sol", created_at: after(3), updated_at: after(key.status === "draft" ? 3 : 45),
    approved_at: key.status === "draft" ? null : after(40), sent_at: key.status === "sent" ? after(45) : null, last_error: null,
  };
}

function deliveryFor(seed: MeetingSeed): MeetingDeliverySettings {
  const external = seed.invitees.filter((person) => person.email && !team.some((member) => member.email === person.email)).map((person) => person.email as string);
  const internal = seed.invitees.filter((person) => team.some((member) => member.email === person.email)).map((person) => person.email as string);
  return { internal_recipients: internal, participant_recipients: external, send_to_participants: seed.minutes?.status === "sent", include_transcript: false };
}

function jobFor(clock: Clock, seed: MeetingSeed): PostMeetingJob {
  if (seed.draftFailed) return { enabled: true, attempts: 3, next_retry_at: null, last_error: "The minutes model timed out three times. The transcript is saved; retry when the provider is available.", completed_at: null, exhausted: true };
  const done = seed.meeting.stopped_at ? new Date(new Date(seed.meeting.stopped_at).getTime() + 3 * 60_000).toISOString() : null;
  return { enabled: true, attempts: done ? 1 : 0, next_retry_at: null, last_error: null, completed_at: done ?? (seed.meeting.status === "completed" ? minutesFrom(clock, -60) : null), exhausted: false };
}

function readSession<T>(key: string, fallback: T): T {
  try { const raw = window.sessionStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}

function prepState(clock: Clock, events: CachedCalendarEvent[]) {
  const find = (title: string) => events.find((event) => event.title === title);
  const acme = find("Acme Robotics — Rotterdam demo planning");
  const initech = find("Initech — pilot scoping workshop");
  const globexQbr = find("Globex — quarterly business review");
  const reports: Record<string, PrepReportV2[]> = {};
  const inputs: Record<string, PrepInputs> = {};
  const documents: PrepDocument[] = [];
  const frame = (index: number, eventId: string, hoursAgo: number, usage: PrepReportV2["usage"]) => ({ id: reportId(index), eventId, generatedAt: minutesFrom(clock, -hoursAgo * 60), startedAt: minutesFrom(clock, -hoursAgo * 60 - 2), usage });
  const doc = (index: number, eventId: string, filename: string, status: string, size: number, pages: number | null, hoursAgo: number): PrepDocument => ({
    id: documentId(100 + index), scope: "prep", scope_id: eventId, filename, content_type: filename.endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    source_url: null, size_bytes: size, page_count: pages, ocr_page_count: pages ? 2 : 0, status, error: null, summary: null, chunk_count: status === "indexed" ? 18 : 0, character_count: status === "indexed" ? 36_000 : 0, created_at: minutesFrom(clock, -hoursAgo * 60),
  });
  if (acme) {
    reports[acme.id] = [acmeReport(frame(2, acme.id, 3, acmeUsage)), acmeReport(frame(1, acme.id, 50, { ...acmeUsage, exa_calls: 0, input_tokens: 7200, output_tokens: 2100, estimated_usd: 0.0354 }))].map((report, index) => index ? { ...report, public_research_performed: false } : report);
    inputs[acme.id] = { target_company: "Acme Robotics", company_website: "https://www.acme-robotics.example", links: ["https://www.acme-robotics.example/press/rotterdam-mou"], notes: "Goal: agree a Dutch-language extension for the Rotterdam demo. Understand demo date, yard-truck models and who evaluates in Dutch.", updated_at: minutesFrom(clock, -3 * 60 - 5) };
    documents.push(doc(1, acme.id, "fieldguide-evaluation-template.pdf", "indexed", 1_243_000, 12, 4), doc(2, acme.id, "rotterdam-yard-truck-manual-index.docx", "processing", 88_000, null, 0.05));
  }
  if (initech) {
    reports[initech.id] = [initechReport(frame(3, initech.id, 20, initechUsage))];
    inputs[initech.id] = { target_company: "Initech", company_website: "https://www.initech.example", links: ["https://www.initech.example/trust/ai-policy"], notes: "Close pilot scope for billing agent assist in English and Spanish, under $50k. Confirm success metrics and data export.", updated_at: minutesFrom(clock, -20 * 60 - 4) };
    documents.push(doc(3, initech.id, "initech-pilot-plan-draft.docx", "indexed", 64_000, null, 21));
  }
  if (globexQbr) {
    inputs[globexQbr.id] = { target_company: "Globex", company_website: "https://www.globex.example", links: [], notes: "Present month-end performance and confirm renewal signature timing.", updated_at: minutesFrom(clock, -60 * 30) };
    documents.push(doc(4, globexQbr.id, "globex-month-end-report-draft.pdf", "failed", 2_400_000, 22, 30));
  }
  return { reports, inputs, documents };
}

/** Accounts "connected" during the demo, restored after the simulated OAuth return reloads the page. */
export type AddedCalendar = { id: string; provider: CalendarConnection["provider"]; label: string };

function addedCalendars(): AddedCalendar[] {
  const list = readSession<unknown>(DEMO_CALENDARS_KEY, []);
  return Array.isArray(list) ? list.filter((item): item is AddedCalendar => Boolean(item && typeof item === "object" && "id" in item && "provider" in item)) : [];
}

export function createStore(): DemoStore {
  const clock = createClock();
  const stored = readSession<string | null>(DEMO_WORKSPACE_KEY, null);
  const orgId = stored === ORG_VENTURES ? ORG_VENTURES : ORG_MAIN;
  const seeds = meetingSeeds(clock, orgId);
  const minutes: Record<string, MeetingMinutes | null> = {};
  const guidance: Record<string, MomGuidance> = {};
  const delivery: Record<string, MeetingDeliverySettings> = {};
  const jobs: Record<string, PostMeetingJob> = {};
  const identities: Record<string, SpeakerIdentity[]> = {};
  for (const seed of seeds) {
    const id = seed.meeting.id;
    minutes[id] = seed.minutes ? minutesFor(clock, seed, seed.minutes) : null;
    guidance[id] = { template: seed.key.startsWith("initech") ? "discovery" : seed.key === "leadership" ? "actions" : "client", instructions: seed.key === "acme-roadmap" ? "Call out anything Acme's security team must approve." : "", focus_fields: seed.key === "globex-renewal" ? ["pricing", "SLA"] : [] };
    delivery[id] = deliveryFor(seed);
    jobs[id] = jobFor(clock, seed);
    const confirmed = seed.segments.map((segment) => segment.speaker).filter((name, index, all): name is string => Boolean(name) && all.indexOf(name) === index && name !== "Meetings AI");
    identities[id] = confirmed.flatMap((name) => {
      const invitee = seed.invitees.find((person) => person.name === name && person.email);
      const member = personByName(name);
      const email = member?.email ?? (seed.key === "acme-roadmap" && invitee ? invitee.email : null);
      return email ? [{ speaker: name, email, confirmed_at: seed.meeting.stopped_at ?? seed.meeting.updated_at }] : [];
    });
  }
  const extra = addedCalendars();
  const connections = [...calendarConnections(), ...extra.map((item): CalendarConnection => ({ id: item.id, provider: item.provider, status: "ACTIVE", label: item.label, identity: `alex.morgan@${item.provider === "outlook" ? "outlook" : "gmail"}.example` }))];
  const events = calendarEvents(clock, seeds);
  const prep = prepState(clock, events);
  const bases = knowledgeBases(clock, orgId, seeds);
  return {
    clock, orgId, displayName: "Alex Morgan", photoUrl: team[0].photo, defaultWorkspaceId: ORG_MAIN,
    workspace: workspaceRecord(clock, orgId), members: memberRecords(orgId), brief: organizationBrief(clock), briefDocuments: briefDocuments(clock), retention: defaultRetention,
    companyIdentity: null,
    seeds, minutes, guidance, delivery, jobs, identities, joinRequests: {},
    connections, events, syncs: calendarSyncs(clock, [CAL_GOOGLE, CAL_OUTLOOK, CAL_CALENDLY]), schedules: calendarSchedules(seeds, events),
    reports: prep.reports, prepInputs: prep.inputs, prepDocuments: prep.documents,
    bases, conversations: conversations(clock, seeds), reindexedAt: {},
    profiles: profiles(), defaults: providerDefaults(), credentials: credentials(clock), ai: aiSettings(clock),
    usage: generateLedger(clock, {
      meetings: seeds.filter((seed) => seed.meeting.status === "completed").map((seed) => ({ id: seed.meeting.id, title: seed.meeting.title })),
      bases: bases.map((base) => ({ id: base.id, name: base.name })),
      preps: events.filter((event) => new Date(event.starts_at).getTime() > clock.start && !event.title.startsWith("Northwind")).slice(0, 8).map((event) => ({ id: event.id, title: event.title })),
    }),
    audit: auditEvents(clock), purged: {},
  };
}

export function storageItems(store: DemoStore): Record<StorageCategoryKey, StorageItem[]> {
  const kb = (bytes: number) => Math.round(bytes);
  const drop = <T extends { id: string }>(key: StorageCategoryKey, items: T[]) => items.filter((item) => !(store.purged[key] ?? []).includes(item.id));
  const byMonth = new Map<string, number>();
  for (const event of store.usage) byMonth.set(event.created_at.slice(0, 7), (byMonth.get(event.created_at.slice(0, 7)) ?? 0) + 1);
  return {
    meetings: store.seeds.map((seed) => ({ id: seed.meeting.id, label: seed.meeting.title, created_at: seed.meeting.created_at, bytes: kb(seed.segments.length * 2_900 + 18_000), rows: seed.segments.length + 12, detail: `${seed.meeting.status} · ${seed.meeting.platform}` })),
    search_index: drop("search_index", store.bases.map((base) => ({ id: base.id, label: `${base.name} index`, created_at: base.created_at, bytes: kb(base.meeting_count * 1_400_000 + 220_000), rows: base.meeting_count * 180, detail: "Chunks and embedding vectors" }))),
    documents: store.briefDocuments.map((doc) => ({ id: doc.id, label: doc.filename, created_at: doc.uploaded_at, bytes: doc.character_count * 3, rows: Math.ceil(doc.character_count / 1_500), detail: "Company reference document" })),
    meeting_preps: Object.values(store.reports).flat().map((report) => ({ id: report.id, label: `Briefing · ${report.target_company ?? "Meeting"}`, created_at: report.generated_at, bytes: 46_000, rows: 1 + report.sources.length, detail: `${report.sources.length} sources` })),
    ai_chats: store.conversations.map((item) => ({ id: item.id, label: item.title, created_at: item.created_at, bytes: item.messages.length * 6_200, rows: item.messages.length + 1, detail: `${item.messages.length} messages` })),
    knowledge_bases: store.bases.map((base) => ({ id: base.id, label: base.name, created_at: base.created_at, bytes: 3_600, rows: 2 + base.shared_user_ids.length, detail: base.visibility })),
    calendar_cache: drop("calendar_cache", store.connections.map((connection) => {
      const count = store.events.filter((event) => event.connection_id === connection.id).length;
      return { id: connection.id, label: connection.label, created_at: store.syncs.find((sync) => sync.connection_id === connection.id)?.last_synced_at ?? null, bytes: count * 4_100, rows: count, detail: connection.provider };
    })),
    logs: drop("logs", [...byMonth.entries()].map(([month, count]) => ({ id: `logs-${month}`, label: `Usage and audit log · ${month}`, created_at: `${month}-01T00:00:00.000Z`, bytes: count * 1_900 + 60_000, rows: count + 40, detail: "Ledger and audit rows" }))),
  };
}
