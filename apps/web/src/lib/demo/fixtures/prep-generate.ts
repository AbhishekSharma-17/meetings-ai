import type { CachedCalendarEvent, PrepAttendee, PrepGenerateInput, PrepReportV2, PrepSourceV2, PrepUsageTotals } from "../../types";
import { DOMAIN } from "./people";

type Profile = { name: string; website: string; what: string; industry: string; size: string; hq: string; news: { title: string; type: PrepReportV2["recent_developments"][number]["type"]; summary: string }; ai: string; fit: string; service: string };

const PROFILES: Record<string, Profile> = {
  fabrikam: { name: "Fabrikam Health", website: "https://www.fabrikam-health.example", what: "Runs 40 outpatient clinics and a care-coordination service for chronic conditions.", industry: "Healthcare providers", size: "About 2,300 staff", hq: "Denver, Colorado",
    news: { title: "Signed a regional deal with a state Medicaid plan", type: "deal", summary: "Adds 60,000 members to its care-coordination programme from January." },
    ai: "Uses ambient scribing in two clinics; no AI for care-coordination notes yet.", fit: "Care coordinators summarise long clinical documents by hand — a retrieval assistant with citations fits, with strict PHI controls.", service: "Retrieval (RAG) assistants over clinical documentation" },
  contoso: { name: "Contoso Logistics", website: "https://www.contoso-logistics.example", what: "Third-party logistics with 18 warehouses across the Midwest.", industry: "Logistics and warehousing", size: "About 3,000 employees", hq: "Columbus, Ohio",
    news: { title: "Partnership with a national grocery chain", type: "partnership", summary: "Takes over two regional distribution centres in Q1." },
    ai: "Piloting demand forecasting; dispatchers still plan routes in spreadsheets.", fit: "A dispatcher copilot and slotting optimisation map directly to our workflow automation work.", service: "Workflow automation and integrations" },
  woodgrove: { name: "Woodgrove Bank", website: "https://www.woodgrove.example", what: "Regional retail and commercial bank.", industry: "Banking", size: "About 6,000 employees", hq: "Charlotte, North Carolina",
    news: { title: "Announced a three-year digital transformation programme", type: "news", summary: "Budget includes AI for customer service and compliance review." },
    ai: "Has an AI governance board and a small data science team; no production LLM use yet.", fit: "A governed first use case with evaluation built in suits their compliance posture.", service: "AI strategy workshops" },
};

const TEAM_DOMAIN = `@${DOMAIN}`;

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

function companyFrom(event: CachedCalendarEvent, input: PrepGenerateInput): Profile {
  const text = `${input.target_company ?? ""} ${event.title} ${(event.invitees ?? []).map((person) => person.email ?? "").join(" ")}`.toLowerCase();
  const known = Object.entries(PROFILES).find(([key]) => text.includes(key));
  if (known) return known[1];
  const domain = (event.invitees ?? []).map((person) => person.email ?? "").find((email) => email && !email.endsWith(TEAM_DOMAIN))?.split("@")[1];
  const guessed = input.target_company?.trim() || (domain ? domain.split(".")[0].split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ") : event.title.split("—")[0].trim());
  const website = input.company_website?.trim() || (domain ? `https://www.${domain}` : "https://www.example.com");
  return { name: guessed, website, what: `${guessed} is the organisation you are meeting; public sources describe its core business and recent priorities.`, industry: "Not confirmed from public sources", size: "Not confirmed", hq: "Not confirmed",
    news: { title: `${guessed} announced a new operations initiative`, type: "news", summary: "Recent coverage points to efficiency and automation priorities for the coming year." },
    ai: "Early exploration of AI; no public production deployments found.", fit: "Start with discovery: map where knowledge work is repetitive and measurable.", service: "AI strategy workshops" };
}

function attendeesFrom(event: CachedCalendarEvent): PrepAttendee[] {
  const external = (event.invitees ?? []).filter((person) => !(person.email ?? "").endsWith(TEAM_DOMAIN));
  return external.slice(0, 4).map((person, index) => ({
    name: person.name, email: person.email, title: index === 0 ? "Likely meeting sponsor" : null,
    linkedin_url: index === 0 ? `https://www.linkedin.com/in/${person.name.toLowerCase().replace(/[^a-z]+/g, "-")}` : null,
    match_confidence: index === 0 ? "likely" : "unconfirmed", background: index === 0 ? "Public profile suggests a leadership role in operations." : "",
    likely_interests: index === 0 ? ["Operational efficiency", "Risk and compliance"] : [], persona: index === 0 ? "business" : "unknown",
    angle: index === 0 ? "Anchor the conversation on measurable outcomes for their team." : "Confirm role and priorities early in the call.", source_ids: index === 0 ? ["P1"] : [],
  }));
}

export function generatedReport(options: { id: string; event: CachedCalendarEvent; input: PrepGenerateInput; startedAt: string; generatedAt: string; usage: PrepUsageTotals }): PrepReportV2 {
  const { event, input } = options;
  const company = companyFrom(event, input);
  const research = input.research_enabled;
  const firstAttendee = attendeesFrom(event)[0];
  const web: PrepSourceV2[] = research ? [
    { id: "W1", title: `${company.name} — About`, url: `${company.website}/about`, publisher: hostOf(company.website), published_date: null, origin: "web" },
    { id: "W2", title: company.news.title, url: `https://news.example.com/${company.name.toLowerCase().replace(/[^a-z]+/g, "-")}`, publisher: "news.example.com", published_date: new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10), origin: "web" },
    ...(firstAttendee ? [{ id: "P1", title: `${firstAttendee.name} | LinkedIn`, url: firstAttendee.linkedin_url, publisher: "linkedin.com", published_date: null, origin: "web" as const }] : []),
  ] : [];
  const provided: PrepSourceV2[] = input.profile_urls.slice(0, 3).map((url, index) => ({ id: `L${index + 1}`, title: url.replace(/^https?:\/\/(www\.)?/, ""), url, publisher: null, published_date: null, origin: "provided_link" }));
  const brief: PrepSourceV2 = { id: "B1", title: "Northwind Labs company profile", url: null, publisher: null, published_date: null, origin: "organization_brief" };
  const cite = (ids: string[]) => ids.filter((id) => [...web, ...provided, brief].some((source) => source.id === id));
  return {
    report_version: 2, id: options.id, calendar_event_id: event.id, target_company: company.name, company_website: company.website,
    executive_brief: `${company.name}: ${company.what} ${research ? company.news.summary : "Public research was off, so this briefing uses your inputs and company profile only."} ${company.fit}${input.context.trim() ? ` Your goal: ${input.context.trim().slice(0, 180)}` : ""}`,
    company: { name: company.name, website: company.website, what_they_do: company.what, industry: company.industry, size_signals: company.size, headquarters: company.hq, source_ids: cite(["W1"]) },
    recent_developments: research ? [{ title: company.news.title, date: web[1]?.published_date ?? null, type: company.news.type, summary: company.news.summary, source_ids: ["W2"] }] : [],
    ai_landscape: { summary: company.ai, initiatives: research ? [{ statement: company.ai, source_ids: ["W2"] }] : [], vendors: [], end_clients: [], source_ids: cite(["W2"]) },
    alignment: { fit_summary: company.fit, relevant_services: [{ service: company.service, why: company.fit, talking_point: "Offer a two-week pilot with success criteria agreed up front.", source_ids: ["B1"] }] },
    attendees: attendeesFrom(event),
    meeting_narrative: {
      recommended_focus: "Understand their priorities, then propose one small, measurable first step.",
      by_persona: [{ persona: "business", focus: "Outcomes and timeline." }, { persona: "technical", focus: "Data access and security." }],
      opening: research ? `Open with their recent news: “${company.news.title}”.` : "Open by confirming the goals they shared when booking.",
      agenda_suggestions: ["Their goals and constraints", "Where work is repetitive today", "A candidate pilot", "Next steps"],
    },
    talking_points: ["Two-week pilots with measurable success criteria.", "Deployments inside the client's own cloud.", "Evaluation reports that show failure cases."],
    questions_to_ask: ["What would make this meeting a success for you?", "Who else needs to be involved in a decision?", "What data could a pilot use?"],
    watchouts: ["Attendee roles below are not all confirmed — verify early.", ...(research ? [] : ["No public research was run for this briefing."])],
    sources: [...web, ...provided, brief], public_research_performed: research,
    research_steps: [
      { stage: "planning", purpose: "Plan research from the invite and your inputs", query: null, category: null, results: 0, status: "succeeded" },
      { stage: "searching", purpose: "Company overview and news", query: research ? `${company.name} news 2026` : null, category: "news", results: research ? 9 : 0, status: research ? "succeeded" : "skipped" },
      { stage: "reading", purpose: "Read the most relevant pages", query: null, category: null, results: research ? 5 : 0, status: research ? "succeeded" : "skipped" },
      { stage: "writing", purpose: "Write the cited briefing", query: null, category: null, results: 0, status: "succeeded" },
    ],
    usage: options.usage, started_at: options.startedAt, generated_at: options.generatedAt, provider: "openrouter", model: "openai/gpt-6-sol",
    findings: [], relevant_offerings: [company.service], people_notes: [],
  };
}
