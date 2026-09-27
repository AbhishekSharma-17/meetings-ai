import type { UsageEvent, UsageEventFilters, UsageGroupTotal, UsageModelTotal, UsageSummaryDetail } from "../../types";
import { type Clock, seeded, usageEventId } from "./ids";
import { team } from "./people";

export type LedgerContext = {
  meetings: Array<{ id: string; title: string }>;
  bases: Array<{ id: string; name: string }>;
  preps: Array<{ id: string; title: string }>;
};

type Template = { kind: string; purpose: string; provider: string; model: string; weight: number; tokens?: [number, number]; units?: [number, string]; price: (input: number, output: number, units: number) => number };

const TEMPLATES: Template[] = [
  { kind: "llm", purpose: "mom_generation", provider: "openrouter", model: "openai/gpt-6-sol", weight: 14, tokens: [9000, 1400], price: (i, o) => i * 2e-6 + o * 10e-6 },
  { kind: "llm", purpose: "knowledge_answer", provider: "openrouter", model: "openai/gpt-6-luna", weight: 22, tokens: [5200, 520], price: (i, o) => i * 0.1e-6 + o * 0.5e-6 },
  { kind: "llm", purpose: "knowledge_query_plan", provider: "openrouter", model: "openai/gpt-6-luna", weight: 10, tokens: [1400, 160], price: (i, o) => i * 0.1e-6 + o * 0.5e-6 },
  { kind: "llm", purpose: "meeting_prep", provider: "openrouter", model: "openai/gpt-6-sol", weight: 8, tokens: [15000, 2600], price: (i, o) => i * 2e-6 + o * 10e-6 },
  { kind: "embedding", purpose: "knowledge_index", provider: "openai", model: "text-embedding-3-small", weight: 18, tokens: [14000, 0], price: (i) => i * 0.02e-6 },
  { kind: "embedding", purpose: "document_embedding", provider: "openai", model: "text-embedding-3-small", weight: 5, tokens: [22000, 0], price: (i) => i * 0.02e-6 },
  { kind: "vision", purpose: "document_vision", provider: "openrouter", model: "openai/gpt-6-luna", weight: 4, tokens: [3800, 700], units: [3, "pages"], price: (i, o) => i * 0.1e-6 + o * 0.5e-6 },
  { kind: "transcription", purpose: "meeting_transcription", provider: "openai", model: "gpt-4o-transcribe", weight: 9, units: [2400, "audio_seconds"], price: (_i, _o, u) => (u / 60) * 0.006 },
  { kind: "search", purpose: "meeting_prep_research", provider: "exa", model: "auto", weight: 12, units: [10, "results"], price: () => 0.005 },
  { kind: "contents", purpose: "meeting_prep_research", provider: "exa", model: "contents", weight: 8, units: [4, "pages"], price: (_i, _o, u) => u * 0.001 },
];

const TOTAL_WEIGHT = TEMPLATES.reduce((sum, item) => sum + item.weight, 0);

function pick(random: () => number): Template {
  let value = random() * TOTAL_WEIGHT;
  for (const template of TEMPLATES) { value -= template.weight; if (value <= 0) return template; }
  return TEMPLATES[0];
}

export function generateLedger(clock: Clock, context: LedgerContext, count = 156): UsageEvent[] {
  const random = seeded(20260927);
  const actors = team.filter((person) => person.status === "active");
  return Array.from({ length: count }, (_, index) => {
    const template = pick(random);
    const vary = 0.6 + random() * 0.8;
    const input = template.tokens ? Math.round(template.tokens[0] * vary) : null;
    const output = template.tokens ? Math.round(template.tokens[1] * vary) : null;
    const units = template.units ? Math.max(1, Math.round(template.units[0] * vary)) : null;
    const failed = random() < 0.035;
    const unpriced = !failed && template.provider === "openrouter" && random() < 0.05;
    const meeting = context.meetings[Math.floor(random() * context.meetings.length)];
    const base = context.bases[Math.floor(random() * context.bases.length)];
    const prep = context.preps[Math.floor(random() * context.preps.length)];
    const forMeeting = template.purpose === "mom_generation" || template.purpose === "meeting_transcription";
    const forKnowledge = template.purpose.startsWith("knowledge");
    const forPrep = template.purpose.startsWith("meeting_prep");
    const privateBase = forKnowledge && base?.name === "Leadership notes";
    const actor = forMeeting && template.kind === "transcription" ? null : privateBase ? actors[0] : actors[Math.floor(random() * actors.length)];
    const minutesAgo = Math.round((index / count) * 29.5 * 24 * 60 + random() * 90);
    return {
      id: usageEventId(index + 1), created_at: new Date(clock.start - minutesAgo * 60_000).toISOString(),
      kind: template.kind, purpose: template.purpose, provider: template.provider, model: template.model,
      input_tokens: input, output_tokens: output, units, unit_type: template.units?.[1] ?? (template.tokens ? "tokens" : null),
      estimated_usd: failed || unpriced ? null : Math.round(template.price(input ?? 0, output ?? 0, units ?? 0) * 1e6) / 1e6,
      price_source: failed || unpriced ? null : "catalog_list_price",
      duration_ms: template.kind === "transcription" ? (units ?? 0) * 1000 : Math.round(600 + random() * 5200), status: failed ? "failed" : "succeeded",
      meeting_id: forMeeting && meeting ? meeting.id : null, meeting_title: forMeeting && meeting ? meeting.title : null,
      knowledge_base_id: forKnowledge && base ? base.id : null, knowledge_base_name: forKnowledge && base ? base.name : null,
      prep_event_id: forPrep && prep ? prep.id : null, prep_event_title: forPrep && prep ? prep.title : null,
      actor_user_id: actor?.id ?? null, actor_display_name: actor?.name ?? null,
      details: {
        profile_name: template.provider === "openai" ? "OpenAI production" : template.provider === "exa" ? "Exa research" : "GPT-6 via OpenRouter",
        endpoint_host: template.provider === "openai" ? "api.openai.com" : template.provider === "exa" ? "api.exa.ai" : "openrouter.ai",
        request_type: template.kind, execution_location: "cloud", ...(failed ? { error: "Provider timeout after 60 s; retried automatically." } : {}),
      },
    };
  });
}

export function filterLedger(events: UsageEvent[], filters: Partial<UsageEventFilters>): UsageEvent[] {
  const q = filters.q?.trim().toLowerCase();
  return events.filter((event) => {
    if (filters.since && event.created_at < filters.since) return false;
    if (filters.until && event.created_at >= filters.until) return false;
    for (const key of ["kind", "purpose", "provider", "model", "status", "meeting_id"] as const) {
      const value = filters[key];
      if (value && event[key] !== value) return false;
    }
    if (q && !JSON.stringify([event.purpose, event.model, event.provider, event.meeting_title, event.prep_event_title, event.knowledge_base_name, event.actor_display_name]).toLowerCase().includes(q)) return false;
    return true;
  });
}

type Totals = Omit<UsageGroupTotal, "name">;
const empty = (): Totals => ({ requests: 0, input_tokens: 0, output_tokens: 0, estimated_usd: 0, unpriced_requests: 0 });

function add(totals: Totals, event: UsageEvent): Totals {
  return {
    requests: totals.requests + 1, input_tokens: totals.input_tokens + (event.input_tokens ?? 0), output_tokens: totals.output_tokens + (event.output_tokens ?? 0),
    estimated_usd: totals.estimated_usd + (event.estimated_usd ?? 0), unpriced_requests: totals.unpriced_requests + (event.estimated_usd === null && event.status !== "failed" ? 1 : 0),
  };
}

function groupBy(events: UsageEvent[], key: (event: UsageEvent) => string | null): UsageGroupTotal[] {
  const groups = new Map<string, Totals>();
  for (const event of events) {
    const name = key(event);
    if (name) groups.set(name, add(groups.get(name) ?? empty(), event));
  }
  return [...groups.entries()].map(([name, totals]) => ({ name, ...totals })).sort((a, b) => b.estimated_usd - a.estimated_usd);
}

export function summarize(events: UsageEvent[], since: string | null, until: string | null): UsageSummaryDetail {
  const all = events.reduce(add, empty());
  const byModel: UsageModelTotal[] = groupBy(events, (event) => `${event.provider}/${event.model}`).map((group) => {
    const rows = events.filter((event) => `${event.provider}/${event.model}` === group.name);
    return { ...group, kind: rows[0].kind, provider: rows[0].provider, model: rows[0].model, units: rows.reduce((sum, event) => sum + (event.units ?? 0), 0), unit_type: rows[0].unit_type, failed_requests: rows.filter((event) => event.status === "failed").length };
  });
  const prepEvents = events.filter((event) => event.purpose.startsWith("meeting_prep"));
  const prepTotals = prepEvents.reduce(add, empty());
  const transcription = events.filter((event) => event.kind === "transcription");
  const round = (value: number) => Math.round(value * 1e4) / 1e4;
  return {
    ...all, total_requests: all.requests, estimated_usd: round(all.estimated_usd), failed_requests: events.filter((event) => event.status === "failed").length,
    recent: events.slice(0, 10).map((event) => ({ id: event.id, meeting_id: event.meeting_id, knowledge_base_id: event.knowledge_base_id, purpose: event.purpose, provider: event.provider, model: event.model, input_tokens: event.input_tokens, output_tokens: event.output_tokens, estimated_usd: event.estimated_usd, created_at: event.created_at })),
    by_meeting: groupBy(events, (event) => event.meeting_id).map(({ name, ...totals }) => ({ meeting_id: name, ...totals })),
    by_purpose: groupBy(events, (event) => event.purpose), by_provider: groupBy(events, (event) => event.provider),
    by_kind: groupBy(events, (event) => event.kind), by_model: byModel,
    prep: {
      sessions: new Set(prepEvents.map((event) => event.prep_event_id)).size + 2, events_prepared: new Set(prepEvents.map((event) => event.prep_event_id)).size,
      briefings_generated: prepEvents.filter((event) => event.purpose === "meeting_prep" && event.status === "succeeded").length,
      requests: prepTotals.requests, input_tokens: prepTotals.input_tokens, output_tokens: prepTotals.output_tokens, estimated_usd: round(prepTotals.estimated_usd),
      unpriced_requests: prepTotals.unpriced_requests, searches: prepEvents.filter((event) => event.kind === "search").length,
    },
    transcription: {
      meetings: new Set(transcription.map((event) => event.meeting_id)).size, audio_seconds: transcription.reduce((sum, event) => sum + (event.units ?? 0), 0),
      estimated_usd: round(transcription.reduce((sum, event) => sum + (event.estimated_usd ?? 0), 0)), unpriced: transcription.filter((event) => event.estimated_usd === null).length,
    },
    since, until,
  };
}

export function ledgerCsv(events: UsageEvent[]): string {
  const header = ["created_at", "kind", "purpose", "provider", "model", "input_tokens", "output_tokens", "units", "unit_type", "estimated_usd", "status", "meeting", "knowledge_base", "prep_event", "actor"];
  const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = events.map((event) => [event.created_at, event.kind, event.purpose, event.provider, event.model, event.input_tokens, event.output_tokens, event.units, event.unit_type, event.estimated_usd, event.status, event.meeting_title, event.knowledge_base_name, event.prep_event_title, event.actor_display_name].map(cell).join(","));
  return [header.join(","), ...rows].join("\n");
}
