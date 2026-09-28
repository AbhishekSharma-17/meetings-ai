import type { AttendeeSides, CachedCalendarEvent, OrganizationIdentity, PrepDocument, PrepGenerateInput, PrepHistory, PrepInputs, PrepReportV2, PrepUsageTotals, UsageEvent } from "../../types";
import { newId } from "../fixtures/ids";
import { generatedReport } from "../fixtures/prep-generate";
import { bool, json, noContent, notify, problem, sse, type SseFrame, str, strList, wait } from "../http";
import type { DemoRequest, DemoRouter } from "../router";
import type { DemoStore } from "../store";
import { demoIdentity, demoWhosWho } from "../whos-who";

const DOCUMENT_PROCESSING_MS = 4_000;

const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PERSONAL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "aol.com", "proton.me"]);

function sidesOf(value: unknown): AttendeeSides {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, side]) => side === "ours" || side === "theirs").slice(0, 100)
    .map(([key, side]) => [key.trim().toLowerCase(), side as "ours" | "theirs"]));
}

function inputOf(body: Record<string, unknown>): PrepGenerateInput {
  return {
    context: str(body.context) ?? "", target_company: str(body.target_company), company_website: str(body.company_website),
    profile_urls: strList(body.profile_urls), text_profile_id: str(body.text_profile_id), research_enabled: bool(body.research_enabled, true),
    attendee_sides: sidesOf(body.attendee_sides),
  };
}

/** The same who's who the API would compute; generated briefings never treat the sample company as the client. */
function partiesFor(store: DemoStore, event: CachedCalendarEvent, input: PrepGenerateInput) {
  const stored = store.prepInputs[event.id];
  return demoWhosWho(store, event, {
    target_company: input.target_company ?? stored?.target_company ?? null, company_website: input.company_website ?? stored?.company_website ?? null,
    attendee_sides: input.attendee_sides ?? {},
  });
}

function withParties(store: DemoStore, report: PrepReportV2 | undefined): PrepReportV2 | null {
  if (!report) return null;
  const event = store.events.find((item) => item.id === report.calendar_event_id);
  if (report.whos_who || !event) return report;
  return { ...report, whos_who: demoWhosWho(store, event, { target_company: report.target_company, company_website: report.company_website, attendee_sides: {} }) };
}

function saveIdentity(store: DemoStore, body: Record<string, unknown>): Response {
  const domains: string[] = [];
  for (const raw of strList(body.domains)) {
    const domain = raw.trim().toLowerCase().replace(/^@/, "").replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0].replace(/^www\./, "");
    if (!DOMAIN.test(domain)) return problem(422, `“${raw}” is not a valid email domain, e.g. yourcompany.com`);
    if (PERSONAL.has(domain)) return problem(422, `${domain} is a personal email provider; add your company's own domain`);
    if (!domains.includes(domain)) domains.push(domain);
  }
  const name = str(body.company_name)?.trim() || null;
  const aliases = [...new Map(strList(body.aliases).map((alias) => alias.trim()).filter((alias) => alias && alias.toLowerCase() !== name?.toLowerCase()).map((alias) => [alias.toLowerCase(), alias])).values()].slice(0, 20);
  const saved: OrganizationIdentity = { ...demoIdentity(store), company_name: name, aliases, domains: domains.slice(0, 30), configured: true, can_edit: true, updated_at: new Date().toISOString() };
  store.companyIdentity = saved;
  return json(saved);
}

function usageFor(research: boolean): PrepUsageTotals {
  const input = 14_000 + Math.round(Math.random() * 6_000);
  const output = 2_200 + Math.round(Math.random() * 900);
  const exa = research ? 9 + Math.round(Math.random() * 4) : 0;
  return { exa_calls: exa, llm_calls: 3, input_tokens: input, output_tokens: output, estimated_usd: Math.round((input * 2e-6 + output * 10e-6 + exa * 0.005) * 1e4) / 1e4, unpriced_calls: 0 };
}

function recordUsage(store: DemoStore, eventId: string, title: string, usage: PrepUsageTotals) {
  const now = new Date().toISOString();
  const base = { created_at: now, provider: "openrouter", model: "openai/gpt-6-sol", unit_type: "tokens", price_source: "catalog_list_price", status: "succeeded", meeting_id: null, meeting_title: null, knowledge_base_id: null, knowledge_base_name: null, prep_event_id: eventId, prep_event_title: title, actor_user_id: store.members[0]?.user_id ?? null, actor_display_name: store.displayName, details: { profile_name: "GPT-6 via OpenRouter", endpoint_host: "openrouter.ai", request_type: "llm", execution_location: "cloud", demo: true } };
  const llm: UsageEvent = { ...base, id: newId(9), kind: "llm", purpose: "meeting_prep", input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, units: null, estimated_usd: Math.round((usage.estimated_usd - usage.exa_calls * 0.005) * 1e6) / 1e6, duration_ms: 9_800 };
  const searches: UsageEvent[] = Array.from({ length: usage.exa_calls }, () => ({ ...base, id: newId(9), kind: "search", purpose: "meeting_prep_research", provider: "exa", model: "auto", input_tokens: null, output_tokens: null, units: 10, unit_type: "results", estimated_usd: 0.005, duration_ms: 900, details: { ...base.details, profile_name: "Exa research", endpoint_host: "api.exa.ai", request_type: "search" } }));
  store.usage = [llm, ...searches, ...store.usage];
}

function buildReport(store: DemoStore, eventId: string, input: PrepGenerateInput): PrepReportV2 | null {
  const event = store.events.find((item) => item.id === eventId);
  if (!event) return null;
  const usage = usageFor(input.research_enabled);
  const generatedAt = new Date().toISOString();
  const parties = partiesFor(store, event, input);
  // Research the resolved client, never the sample company itself (a target that looked like us is dropped).
  const safeInput: PrepGenerateInput = { ...input, target_company: parties.target.name ?? parties.target.domains[0] ?? null, company_website: parties.target.website };
  const sideOf = new Map(parties.attendees.map((person) => [person.email?.toLowerCase() ?? person.name, person.side]));
  const generated = generatedReport({ id: newId(7), event, input: safeInput, startedAt: new Date(Date.now() - 8_000).toISOString(), generatedAt, usage });
  const report: PrepReportV2 = { ...generated, whos_who: parties, attendees: generated.attendees
    .map((person) => ({ ...person, side: sideOf.get(person.email?.toLowerCase() ?? person.name) ?? "unknown" }))
    .filter((person) => person.side !== "ours") as PrepReportV2["attendees"] };
  const known = store.reports[eventId]?.[0];
  // Known sample accounts keep their curated briefing content, refreshed with a new id and timestamp.
  const next = known && !parties.warnings.length && (!input.target_company || known.target_company?.toLowerCase() === input.target_company.toLowerCase()) ? { ...known, id: report.id, generated_at: generatedAt, started_at: report.started_at, usage, public_research_performed: input.research_enabled, whos_who: parties } : report;
  store.reports = { ...store.reports, [eventId]: [next, ...(store.reports[eventId] ?? [])] };
  recordUsage(store, eventId, event.title, usage);
  return next;
}

function stages(company: string, research: boolean): SseFrame[] {
  const progress = (stage: string, message: string, delayMs: number): SseFrame => ({ event: "progress", data: { stage, message }, delayMs });
  return [
    progress("queued", "Queued", 150),
    progress("planning", "Planning research from the invite, your inputs and the company profile", 900),
    ...(research ? [
      progress("searching", `Searching the web for ${company} news, deals and AI initiatives`, 1_300),
      progress("searching", "Looking up attendees' public profiles", 1_100),
      progress("reading", "Reading the most relevant pages", 1_300),
    ] : []),
    progress("writing", "Writing the cited briefing", 1_500),
    progress("done", "Briefing saved", 700),
  ];
}

function withEvent(handler: (eventId: string, request: DemoRequest) => Response | Promise<Response>) {
  return (request: DemoRequest) => request.store.events.some((event) => event.id === request.params.id) ? handler(request.params.id, request) : problem(404, "calendar event not found");
}

function documents(store: DemoStore, scopeId: string | null): PrepDocument[] {
  const now = Date.now();
  return store.prepDocuments.filter((doc) => !scopeId || doc.scope_id === scopeId).map((doc) => doc.status === "processing" && now - new Date(doc.created_at).getTime() > DOCUMENT_PROCESSING_MS
    ? { ...doc, status: "indexed", chunk_count: Math.max(3, Math.round(doc.size_bytes / 4_000)), character_count: Math.round(doc.size_bytes / 2.5), summary: null } : doc);
}

export function registerPrep(router: DemoRouter): void {
  router
    .on("GET", "/v1/calendar/events/:id/prep", withEvent((id, { store }) => json(withParties(store, store.reports[id]?.[0]))))
    .on("POST", "/v1/calendar/events/:id/prep/whos-who", withEvent((id, { store, body }) => {
      const event = store.events.find((item) => item.id === id)!;
      return json(demoWhosWho(store, event, { target_company: str(body.target_company), company_website: str(body.company_website), attendee_sides: sidesOf(body.attendee_sides) }));
    }))
    .on("GET", "/v1/workspace/identity", ({ store }) => json(demoIdentity(store)))
    .on("PUT", "/v1/workspace/identity", ({ store, body }) => saveIdentity(store, body))
    .on("POST", "/v1/calendar/events/:id/prep", withEvent(async (id, { store, body }) => {
      await wait(2_500);
      const report = buildReport(store, id, inputOf(body));
      return report ? json(report) : problem(404, "calendar event not found");
    }))
    .on("POST", "/v1/calendar/events/:id/prep/stream", withEvent((id, { store, body }) => {
      const input = inputOf(body);
      const event = store.events.find((item) => item.id === id);
      const company = input.target_company || store.prepInputs[id]?.target_company || event?.title.split("—")[0].trim() || "the company";
      if (input.research_enabled) notify("Demo: no web searches or AI calls are made — progress and results are simulated from sample data.");
      return sse(async function* () {
        for (const frame of stages(company, input.research_enabled)) yield frame;
        const report = buildReport(store, id, input);
        yield report ? { event: "final", data: report, delayMs: 200 } : { event: "error", data: { detail: "calendar event not found", status: 404 } };
      });
    }))
    .on("GET", "/v1/calendar/events/:id/prep/inputs", withEvent((id, { store }) => json(store.prepInputs[id] ?? { target_company: null, company_website: null, links: [], notes: "", updated_at: null })))
    .on("PUT", "/v1/calendar/events/:id/prep/inputs", withEvent((id, { store, body }) => {
      const saved: PrepInputs = { target_company: str(body.target_company), company_website: str(body.company_website), links: strList(body.links), notes: str(body.notes) ?? "", updated_at: new Date().toISOString() };
      store.prepInputs = { ...store.prepInputs, [id]: saved };
      return json(saved);
    }))
    .on("GET", "/v1/calendar/events/:id/prep/history", withEvent((id, { store }) => {
      const items = (store.reports[id] ?? []).map((report) => ({ id: report.id, report_version: report.report_version, target_company: report.target_company, generated_at: report.generated_at, provider: report.provider, model: report.model, public_research_performed: report.public_research_performed, usage: report.usage }));
      const totals = items.reduce<PrepUsageTotals>((sum, item) => ({
        exa_calls: sum.exa_calls + item.usage.exa_calls, llm_calls: sum.llm_calls + item.usage.llm_calls, input_tokens: sum.input_tokens + item.usage.input_tokens,
        output_tokens: sum.output_tokens + item.usage.output_tokens, estimated_usd: Math.round((sum.estimated_usd + item.usage.estimated_usd) * 1e4) / 1e4, unpriced_calls: sum.unpriced_calls + item.usage.unpriced_calls,
      }), { exa_calls: 0, llm_calls: 0, input_tokens: 0, output_tokens: 0, estimated_usd: 0, unpriced_calls: 0 });
      return json({ calendar_event_id: id, items, totals } satisfies PrepHistory);
    }))
    .on("GET", "/v1/documents", ({ store, query }) => json(documents(store, query.get("scope_id"))))
    .on("POST", "/v1/documents", ({ store, form }) => {
      const file = form?.get("file");
      if (!(file instanceof File)) return problem(422, "Choose a file to upload.");
      const record: PrepDocument = {
        id: newId(8), scope: String(form?.get("scope") ?? "prep"), scope_id: String(form?.get("scope_id") ?? ""), filename: file.name, content_type: file.type || "application/octet-stream",
        source_url: null, size_bytes: file.size, page_count: null, ocr_page_count: 0, status: "processing", error: null, summary: null, chunk_count: 0, character_count: 0, created_at: new Date().toISOString(),
      };
      store.prepDocuments = [record, ...store.prepDocuments];
      notify("Demo: the file stays in this browser tab; nothing was uploaded or read by an AI model.");
      return json(record, 201);
    })
    .on("DELETE", "/v1/documents/:id", ({ store, params }) => { store.prepDocuments = store.prepDocuments.filter((doc) => doc.id !== params.id); return noContent(); });
}
