import type { AppNotification, BackgroundJob, NotificationSeverity } from "../../types";
import { minutesFrom, newId } from "../fixtures/ids";
import { bool, json, noContent, notify, problem, str } from "../http";
import type { DemoRequest, DemoRouter } from "../router";
import type { DemoStore } from "../store";

/**
 * Demo notification center and background jobs. State lives beside the store (keyed by it), so
 * the sample workspace keeps its notifications for the whole tab session. Jobs advance on timers
 * and run the same sample endpoints a person would call, through the demo fetch interceptor.
 */
type ActivityState = { notifications: AppNotification[]; jobs: BackgroundJob[] };
type Stage = { stage: string; message: string; afterMs: number };
type Outcome = { result: Record<string, unknown> } | { error: string; status: number };

const states = new WeakMap<DemoStore, ActivityState>();

function stateOf(store: DemoStore): ActivityState {
  let state = states.get(store);
  if (!state) { state = { notifications: seedNotifications(store), jobs: [] }; states.set(store, state); }
  return state;
}

type Seed = { minutesAgo: number; kind: string; severity: NotificationSeverity; title: string; body: string | null; view: string | null; id: string | null; read: boolean };

function seedNotifications(store: DemoStore): AppNotification[] {
  const clock = store.clock;
  const meeting = (key: string) => store.seeds.find((seed) => seed.key === key)?.meeting ?? null;
  const event = (title: string) => store.events.find((item) => item.title === title) ?? null;
  const base = store.bases[0] ?? null;
  const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const quoted = (text: string) => `“${text}”`;
  const seeds: Seed[] = [];
  const add = (seed: Seed | null) => { if (seed) seeds.push(seed); };
  const procurement = meeting("globex-procurement");
  const weekly = meeting("acme-weekly");
  const roadmap = meeting("acme-roadmap");
  const discovery = meeting("initech-discovery");
  const renewal = meeting("globex-renewal");
  const golive = meeting("globex-golive");
  const security = meeting("acme-security");
  const workshop = meeting("globex-workshop");
  const scoping = meeting("initech-scoping");
  const rotterdam = event("Acme Robotics — Rotterdam demo planning");
  const initechPrep = event("Initech — pilot scoping workshop");
  const globexQbr = event("Globex — quarterly business review prep");
  add(procurement && { minutesAgo: 1, kind: "assistant.lobby", severity: "warning", title: "Assistant is waiting in the lobby", body: `Admit Meetings AI to ${quoted(procurement.title ?? "the meeting")} so it can start capturing.`, view: "meeting", id: procurement.id, read: false });
  add(weekly && { minutesAgo: 14, kind: "assistant.joined", severity: "success", title: `Assistant joined ${quoted(weekly.title ?? "")}`, body: "Recording and transcription are running.", view: "meeting", id: weekly.id, read: false });
  add(weekly && { minutesAgo: 24, kind: "meeting.reminder", severity: "info", title: `${quoted(weekly.title ?? "")} starts in 10 min`, body: `The assistant joins automatically at ${time(minutesFrom(clock, -14))}.`, view: "meeting", id: weekly.id, read: true });
  add(scoping && { minutesAgo: 95, kind: "assistant.scheduled", severity: "info", title: `Assistant scheduled for ${quoted(scoping.title ?? "")}`, body: "It joins automatically tomorrow at 10:00.", view: "meeting", id: scoping.id, read: true });
  add(rotterdam && { minutesAgo: 180, kind: "prep.ready", severity: "success", title: `Briefing ready for ${quoted(rotterdam.title)}`, body: "Researched briefing on Acme Robotics.", view: "prep", id: rotterdam.id, read: false });
  add(rotterdam && { minutesAgo: 240, kind: "document.processed", severity: "success", title: "fieldguide-evaluation-template.pdf is ready", body: "Its text is indexed for briefings and AI answers.", view: "prep", id: rotterdam.id, read: true });
  add(initechPrep && { minutesAgo: 20 * 60, kind: "prep.ready", severity: "success", title: `Briefing ready for ${quoted(initechPrep.title)}`, body: "Researched briefing on Initech.", view: "prep", id: initechPrep.id, read: true });
  add(roadmap && { minutesAgo: 22 * 60, kind: "minutes.ready", severity: "success", title: `Draft minutes ready for ${quoted(roadmap.title ?? "")}`, body: "Review every field before approving and sending the recap.", view: "meeting", id: roadmap.id, read: false });
  add(roadmap && { minutesAgo: 22 * 60 + 4, kind: "assistant.capture_finished", severity: "success", title: `Capture finished for ${quoted(roadmap.title ?? "")}`, body: "The transcript is saved and ready for review.", view: "meeting", id: roadmap.id, read: true });
  add(globexQbr && { minutesAgo: 30 * 60, kind: "document.failed", severity: "danger", title: "Could not process globex-month-end-report-draft.pdf", body: "OCR could not read the scanned pages. Upload a text-based PDF or retry later.", view: "prep", id: globexQbr.id, read: false });
  add(discovery && { minutesAgo: 2 * 24 * 60, kind: "minutes.ready", severity: "success", title: `Draft minutes ready for ${quoted(discovery.title ?? "")}`, body: "Review every field before approving and sending the recap.", view: "meeting", id: discovery.id, read: true });
  add(base && { minutesAgo: 2 * 24 * 60 + 30, kind: "knowledge.indexed", severity: "success", title: `${quoted(base.name)} is indexed`, body: "New meetings in this knowledge base are searchable in AI chat.", view: "knowledge", id: base.id, read: true });
  add(renewal && { minutesAgo: 3 * 24 * 60, kind: "minutes.ready", severity: "success", title: `Draft minutes ready for ${quoted(renewal.title ?? "")}`, body: "Review every field before approving and sending the recap.", view: "meeting", id: renewal.id, read: true });
  add(security && { minutesAgo: 5 * 24 * 60, kind: "minutes.failed", severity: "danger", title: `Draft minutes failed for ${quoted(security.title ?? "")}`, body: "The minutes model timed out three times. The transcript is saved; retry when the provider is available.", view: "meeting", id: security.id, read: true });
  add(golive && { minutesAgo: 6 * 24 * 60 - 20, kind: "recap.sent", severity: "success", title: `Recap sent for ${quoted(golive.title ?? "")}`, body: "Delivered to 4 recipients.", view: "meeting", id: golive.id, read: true });
  add(workshop && { minutesAgo: 8 * 24 * 60, kind: "assistant.join_failed", severity: "danger", title: `Assistant could not join ${quoted(workshop.title ?? "")}`, body: "The host did not admit the assistant from the lobby within 10 minutes.", view: "meeting", id: workshop.id, read: true });
  return seeds.map((seed) => ({
    id: newId(13), kind: seed.kind, severity: seed.severity, title: seed.title, body: seed.body, link_view: seed.view, link_id: seed.id,
    meeting_id: seed.view === "meeting" ? seed.id : null, created_at: minutesFrom(clock, -seed.minutesAgo),
    read_at: seed.read ? minutesFrom(clock, -seed.minutesAgo + 1) : null,
  })).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function push(store: DemoStore, item: Omit<AppNotification, "id" | "created_at" | "read_at">): void {
  const state = stateOf(store);
  state.notifications = [{ ...item, id: newId(13), created_at: new Date().toISOString(), read_at: null }, ...state.notifications];
}

function updateJob(store: DemoStore, id: string, patch: Partial<BackgroundJob>): BackgroundJob | null {
  const state = stateOf(store);
  const now = new Date().toISOString();
  let updated: BackgroundJob | null = null;
  state.jobs = state.jobs.map((job) => {
    if (job.id !== id || (job.status !== "running" && job.status !== "queued")) return job;
    updated = { ...job, ...patch, updated_at: now };
    return updated;
  });
  return updated;
}

/** Starts a simulated job: stages advance on timers, then `run` does the real sample work. */
function startJob(store: DemoStore, kind: string, subjectId: string, stages: Stage[], run: () => Promise<Outcome>,
  announce: (job: BackgroundJob) => void): BackgroundJob {
  const state = stateOf(store);
  const active = state.jobs.find((job) => job.kind === kind && job.subject_id === subjectId && (job.status === "running" || job.status === "queued"));
  if (active) return active;
  const now = new Date().toISOString();
  const job: BackgroundJob = {
    id: newId(14), kind, subject_id: subjectId, status: "running", stage: stages[0]?.stage ?? "queued", message: stages[0]?.message ?? null,
    result: null, error: null, attempts: 1, user_id: store.members[0]?.user_id ?? null, created_at: now, started_at: now, finished_at: null, updated_at: now,
  };
  state.jobs = [job, ...state.jobs];
  for (const step of stages.slice(1)) window.setTimeout(() => updateJob(store, job.id, { stage: step.stage, message: step.message }), step.afterMs);
  const total = stages.at(-1)?.afterMs ?? 0;
  window.setTimeout(() => {
    if (stateOf(store).jobs.find((item) => item.id === job.id)?.status !== "running") return; // cancelled meanwhile
    void run().catch((): Outcome => ({ error: "The sample job could not finish.", status: 500 })).then((outcome) => {
      const finished = new Date().toISOString();
      const done = "result" in outcome
        ? updateJob(store, job.id, { status: "succeeded", stage: "done", message: "Done", result: outcome.result, finished_at: finished })
        : updateJob(store, job.id, { status: "failed", stage: "failed", message: null, error: outcome.error, result: { error_status: outcome.status }, finished_at: finished });
      if (done) announce(done);
    });
  }, total + 400);
  return job;
}

async function callSample(path: string, body?: unknown): Promise<Outcome> {
  const response = await window.fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) return { error: typeof payload?.detail === "string" ? payload.detail : "The sample job failed.", status: response.status };
  return { result: payload ?? {} };
}

const prepStages = (research: boolean, company: string): Stage[] => [
  { stage: "queued", message: "Queued", afterMs: 0 },
  { stage: "planning", message: "Planning research", afterMs: 900 },
  ...(research ? [
    { stage: "searching", message: `Searching the web for ${company}`, afterMs: 2_200 },
    { stage: "reading", message: "Reading the most relevant pages", afterMs: 4_200 },
  ] : [{ stage: "reading", message: "Reading your documents", afterMs: 2_000 }]),
  { stage: "writing", message: "Writing the cited briefing", afterMs: research ? 5_600 : 3_400 },
];

function startPrep({ store, params, body }: DemoRequest): Response {
  const event = store.events.find((item) => item.id === params.id);
  if (!event) return problem(404, "calendar event not found");
  const research = bool(body.research_enabled, true);
  const company = str(body.target_company) || store.prepInputs[event.id]?.target_company || event.title.split("—")[0].trim();
  if (research) notify("Demo: no web searches or AI calls are made — progress and results are simulated from sample data.");
  const job = startJob(store, "prep_briefing", event.id, prepStages(research, company),
    async () => {
      const outcome = await callSample(`/v1/calendar/events/${event.id}/prep`, body);
      return "result" in outcome ? { result: { report_id: outcome.result.id, calendar_event_id: event.id, target_company: outcome.result.target_company } } : outcome;
    },
    (done) => push(store, done.status === "succeeded"
      ? { kind: "prep.ready", severity: "success", title: `Briefing ready for “${event.title}”`, body: `Researched briefing on ${String(done.result?.target_company ?? company)}.`, link_view: "prep", link_id: event.id, meeting_id: null }
      : { kind: "prep.failed", severity: "danger", title: `Briefing failed for “${event.title}”`, body: done.error, link_view: "prep", link_id: event.id, meeting_id: null }));
  return json(job, 202);
}

function startMinutes({ store, params }: DemoRequest): Response {
  const seed = store.seeds.find((item) => item.meeting.id === params.id);
  if (!seed) return problem(404, "meeting not found");
  const title = seed.meeting.title ?? "your meeting";
  const job = startJob(store, "minutes_draft", seed.meeting.id, [
    { stage: "reading", message: "Fetching the final transcript", afterMs: 0 },
    { stage: "writing", message: "Drafting the minutes", afterMs: 1_200 },
  ], async () => {
    const outcome = await callSample(`/v1/meetings/${seed.meeting.id}/minutes/generate`);
    return "result" in outcome ? { result: { meeting_id: seed.meeting.id, minutes_status: outcome.result.status } } : outcome;
  }, (done) => push(store, done.status === "succeeded"
    ? { kind: "minutes.ready", severity: "success", title: `Draft minutes ready for “${title}”`, body: "Review every field before approving and sending the recap.", link_view: "meeting", link_id: seed.meeting.id, meeting_id: seed.meeting.id }
    : { kind: "minutes.failed", severity: "danger", title: `Draft minutes failed for “${title}”`, body: done.error, link_view: "meeting", link_id: seed.meeting.id, meeting_id: seed.meeting.id }));
  return json(job, 202);
}

function startReindex({ store, params }: DemoRequest): Response {
  const base = store.bases.find((item) => item.id === params.id);
  if (!base) return problem(404, "knowledge base not found");
  const job = startJob(store, "knowledge_reindex", base.id, [{ stage: "indexing", message: "Chunking and embedding meeting sources", afterMs: 0 }],
    () => callSample(`/v1/knowledge-bases/${base.id}/reindex`),
    (done) => push(store, done.status === "succeeded"
      ? { kind: "knowledge.indexed", severity: "success", title: `“${base.name}” is indexed`, body: "New meetings in this knowledge base are searchable in AI chat.", link_view: "knowledge", link_id: base.id, meeting_id: null }
      : { kind: "knowledge.index_failed", severity: "danger", title: `Indexing failed for “${base.name}”`, body: done.error, link_view: "knowledge", link_id: base.id, meeting_id: null }));
  return json(job, 202);
}

function listNotifications({ store, query }: DemoRequest): Response {
  const state = stateOf(store);
  const unreadOnly = query.get("unread") === "true";
  const limit = Math.min(100, Math.max(1, Number(query.get("limit")) || 30));
  const offset = Math.max(0, Number(query.get("cursor")) || 0);
  const all = unreadOnly ? state.notifications.filter((item) => !item.read_at) : state.notifications;
  const items = all.slice(offset, offset + limit);
  return json({ items, next_cursor: offset + limit < all.length ? String(offset + limit) : null, unread_count: state.notifications.filter((item) => !item.read_at).length });
}

export function registerActivity(router: DemoRouter): void {
  router
    .on("GET", "/v1/notifications", listNotifications)
    .on("GET", "/v1/notifications/unread-count", ({ store }) => json({ unread_count: stateOf(store).notifications.filter((item) => !item.read_at).length }))
    .on("POST", "/v1/notifications/read-all", ({ store }) => {
      const state = stateOf(store);
      const now = new Date().toISOString();
      state.notifications = state.notifications.map((item) => item.read_at ? item : { ...item, read_at: now });
      return json({ unread_count: 0 });
    })
    .on("POST", "/v1/notifications/:id/read", ({ store, params }) => {
      const state = stateOf(store);
      const found = state.notifications.find((item) => item.id === params.id);
      if (!found) return problem(404, "notification not found");
      const read = found.read_at ? found : { ...found, read_at: new Date().toISOString() };
      state.notifications = state.notifications.map((item) => item.id === read.id ? read : item);
      return json(read);
    })
    .on("DELETE", "/v1/notifications", ({ store, query }) => {
      const state = stateOf(store);
      const readOnly = query.get("read_only") === "true";
      const kept = state.notifications.filter((item) => readOnly && !item.read_at);
      const cleared = state.notifications.length - kept.length;
      state.notifications = kept;
      return json({ cleared, unread_count: kept.filter((item) => !item.read_at).length });
    })
    .on("DELETE", "/v1/notifications/:id", ({ store, params }) => {
      const state = stateOf(store);
      if (!state.notifications.some((item) => item.id === params.id)) return problem(404, "notification not found");
      state.notifications = state.notifications.filter((item) => item.id !== params.id);
      return noContent();
    })
    .on("GET", "/v1/background-jobs", ({ store, query }) => {
      const kind = query.get("kind");
      const subject = query.get("subject_id");
      const active = query.get("active");
      const limit = Math.min(50, Math.max(1, Number(query.get("limit")) || 20));
      return json(stateOf(store).jobs.filter((job) => (!kind || job.kind === kind) && (!subject || job.subject_id === subject)
        && (active === null || (active === "true" || active === "1") === (job.status === "running" || job.status === "queued"))).slice(0, limit));
    })
    .on("GET", "/v1/background-jobs/:id", ({ store, params }) => {
      const job = stateOf(store).jobs.find((item) => item.id === params.id);
      return job ? json(job) : problem(404, "job not found");
    })
    .on("POST", "/v1/background-jobs/:id/cancel", ({ store, params }) => {
      const cancelled = updateJob(store, params.id, { status: "cancelled", stage: "cancelled", message: "Cancelled", finished_at: new Date().toISOString() });
      const job = cancelled ?? stateOf(store).jobs.find((item) => item.id === params.id);
      return job ? json(job) : problem(404, "job not found");
    })
    .on("POST", "/v1/calendar/events/:id/prep/jobs", startPrep)
    .on("POST", "/v1/meetings/:id/minutes/jobs", startMinutes)
    .on("POST", "/v1/knowledge-bases/:id/reindex/jobs", startReindex);
}
