import type { PrepReportV2, PrepSourceV2, PrepUsageTotals } from "../../types";
import { acmeApollo, withApollo } from "./apollo";

type Frame = { id: string; eventId: string; generatedAt: string; startedAt: string; usage: PrepUsageTotals };

const src = (id: string, title: string, url: string | null, origin: PrepSourceV2["origin"], published: string | null = null): PrepSourceV2 => ({
  id, title, url, origin, published_date: published, publisher: url ? new URL(url).hostname.replace(/^www\./, "") : null,
});

export const acmeUsage: PrepUsageTotals = { exa_calls: 12, llm_calls: 3, input_tokens: 21_480, output_tokens: 3_120, estimated_usd: 0.1356, unpriced_calls: 0 };
export const initechUsage: PrepUsageTotals = { exa_calls: 9, llm_calls: 3, input_tokens: 17_950, output_tokens: 2_860, estimated_usd: 0.1093, unpriced_calls: 0 };

const steps = (company: string): PrepReportV2["research_steps"] => [
  { stage: "planning", purpose: "Plan research questions from the invite, inputs and company profile", query: null, category: null, results: 0, status: "succeeded" },
  { stage: "searching", purpose: "Company overview", query: `${company} company overview`, category: "company", results: 8, status: "succeeded" },
  { stage: "searching", purpose: "Recent news and deals", query: `${company} news partnership MOU 2026`, category: "news", results: 10, status: "succeeded" },
  { stage: "searching", purpose: "AI initiatives", query: `${company} artificial intelligence automation initiative`, category: "news", results: 7, status: "succeeded" },
  { stage: "searching", purpose: "Attendee public profiles", query: `${company} leadership LinkedIn`, category: "linkedin profile", results: 6, status: "succeeded" },
  { stage: "reading", purpose: "Read the most relevant pages", query: null, category: null, results: 9, status: "succeeded" },
  { stage: "writing", purpose: "Write the cited briefing", query: null, category: null, results: 0, status: "succeeded" },
];

export function acmeReport(frame: Frame): PrepReportV2 {
  return withApollo({
    report_version: 2, id: frame.id, calendar_event_id: frame.eventId, target_company: "Acme Robotics", company_website: "https://www.acme-robotics.example",
    executive_brief: "Acme Robotics is scaling autonomous yard and warehouse logistics after its August MOU with the Port of Rotterdam. The December demo raises the stakes for maintenance at a new site with Dutch documentation. Lead with a short, evaluated extension of the FieldGuide pilot rather than a new programme, and give Asha Patel the architecture and security detail she will ask for.",
    company: {
      name: "Acme Robotics", website: "https://www.acme-robotics.example", what_they_do: "Designs autonomous mobile robots (the R7 picker) and fleet software for large warehouses and ports.",
      industry: "Robotics and logistics automation", size_signals: "About 500 employees; Series C ($120M, May 2026)", headquarters: "Austin, Texas, with sites in Reno and Rotterdam", source_ids: ["W1", "W4"],
    },
    recent_developments: [
      { title: "MOU with the Port of Rotterdam for autonomous yard trucks", date: "2026-08-12", type: "mou", summary: "Two-year memorandum to pilot autonomous yard logistics, with a public demo planned for December.", source_ids: ["W3", "L1"] },
      { title: "$120M Series C led by Northwind Capital", date: "2026-05-02", type: "funding", summary: "Funds earmarked for AI perception and international expansion.", source_ids: ["W4"] },
      { title: "Fleet analytics partnership with Globex Cloud", date: "2026-03-18", type: "partnership", summary: "Moves robot telemetry onto Globex's data platform.", source_ids: ["W5"] },
      { title: "Hiring a Head of Field Service, Europe", date: "2026-09-02", type: "hiring", summary: "Job post mentions building a maintenance organisation for the Rotterdam fleet.", source_ids: ["W6"] },
    ],
    ai_landscape: {
      summary: "Invests heavily in perception and fleet optimisation; relies on partners for data platforms and has no in-house knowledge tooling for maintenance.",
      initiatives: [{ statement: "Vision-based picking pilot across three US sites.", source_ids: ["W2"] }, { statement: "Predictive maintenance models for robot fleets.", source_ids: ["W5"] }],
      vendors: [{ statement: "Globex Cloud for telemetry and analytics.", source_ids: ["W5"] }, { statement: "Azure OpenAI in Acme's own tenant (from our pilot notes).", source_ids: ["D1"] }],
      end_clients: [{ statement: "Port of Rotterdam", source_ids: ["W3"] }, { statement: "Large US grocery distributors", source_ids: ["W1"] }],
      source_ids: ["W2", "W5"],
    },
    alignment: {
      fit_summary: "The FieldGuide pilot already addresses maintenance knowledge at US sites; Rotterdam needs the same capability in Dutch before the December demo.",
      relevant_services: [
        { service: "Retrieval (RAG) assistants over manuals and tickets", why: "Dutch yard-truck manuals are the gap for the Rotterdam demo.", talking_point: "Propose a two-week Dutch extension after the November 4 readout, evaluated by their Rotterdam lead.", source_ids: ["D1", "B1"] },
        { service: "MLOps and model evaluation", why: "Asha asked for failure cases, not demos.", talking_point: "Bring the evaluation report template and the red-team set.", source_ids: ["D2", "B1"] },
      ],
    },
    attendees: [
      { name: "Asha Patel", email: "asha.patel@acme-robotics.example", title: "Chief Technology Officer", linkedin_url: "https://www.linkedin.com/in/asha-patel-robotics", match_confidence: "confirmed", background: "Leads platform engineering and perception; previously led data platforms at Globex.", likely_interests: ["Architecture", "Security in own tenant", "Evaluation rigour"], persona: "technical", angle: "Go deep on the deployment, data flows and how the Dutch evaluation works.", source_ids: ["P1"] },
      { name: "Chen Li", email: "chen.li@acme-robotics.example", title: "Director of Operations", linkedin_url: "https://www.linkedin.com/in/chenli-ops", match_confidence: "likely", background: "Runs warehouse operations for North America; owns technician productivity targets.", likely_interests: ["Time to repair", "First-time fix rate", "Budget timing"], persona: "business", angle: "Tie the extension to downtime at the Rotterdam launch.", source_ids: ["P2"] },
      { name: "Jeroen Visser", email: "jeroen.visser@acme-robotics.example", title: null, linkedin_url: null, match_confidence: "unconfirmed", background: "", likely_interests: [], persona: "unknown", angle: "Named in the weekly sync as the Rotterdam lead; confirm his role and availability for evaluation.", source_ids: [] },
    ],
    meeting_narrative: {
      recommended_focus: "Agree a Dutch-language extension with a clear evaluation plan, sequenced after the November readout.",
      by_persona: [{ persona: "technical", focus: "West Europe deployment, Dutch embeddings, evaluation with a native-speaking technician." }, { persona: "business", focus: "Readiness of the Rotterdam maintenance team for the December demo." }],
      opening: "Congratulate them on the Rotterdam MOU and ask what a successful December demo looks like to the port.",
      agenda_suggestions: ["Demo goals and date", "Dutch documentation inventory", "Extension scope and evaluation", "Security for West Europe hosting", "Next steps"],
    },
    talking_points: ["The pilot already cites service bulletins in seconds (SB-214 example).", "Dutch retrieval is a small technical change; evaluation is the real work.", "West Europe deployment mirrors the approved US setup."],
    questions_to_ask: ["Which yard-truck models will be in the December demo?", "Who in Rotterdam can write Dutch test questions, and when?", "Does the port expect to see the maintenance workflow live?"],
    watchouts: ["Scope growth needs a written change note — procurement will ask.", "Asha rejects demos without failure analysis.", "Budget planning closes in November."],
    sources: [
      src("W1", "Acme Robotics — About", "https://www.acme-robotics.example/about", "web"),
      src("W2", "Acme expands vision-based picking pilot", "https://news.example.com/acme-vision-picking", "web", "2026-07-03"),
      src("W3", "Port of Rotterdam signs autonomy MOU with Acme Robotics", "https://port-news.example.com/rotterdam-acme-mou", "web", "2026-08-12"),
      src("W4", "Acme Robotics raises $120M Series C", "https://techwire.example.com/acme-series-c", "web", "2026-05-02"),
      src("W5", "Globex Cloud and Acme partner on fleet analytics", "https://www.globex.example/press/acme-fleet", "web", "2026-03-18"),
      src("W6", "Head of Field Service, Europe — Acme Robotics careers", "https://careers.acme-robotics.example/field-service-europe", "web", "2026-09-02"),
      src("P1", "Asha Patel — CTO at Acme Robotics | LinkedIn", "https://www.linkedin.com/in/asha-patel-robotics", "web"),
      src("P2", "Chen Li — Director of Operations | LinkedIn", "https://www.linkedin.com/in/chenli-ops", "web"),
      src("L1", "Rotterdam MOU press release", "https://www.acme-robotics.example/press/rotterdam-mou", "provided_link", "2026-08-12"),
      src("D1", "Acme Robotics — Q4 automation roadmap (meeting minutes)", null, "our_documents"),
      src("D2", "fieldguide-evaluation-template.pdf", null, "prep_upload"),
      src("B1", "Northwind Labs company profile", null, "organization_brief"),
    ],
    public_research_performed: true, research_steps: steps("Acme Robotics"), usage: frame.usage,
    started_at: frame.startedAt, generated_at: frame.generatedAt, provider: "openrouter", model: "openai/gpt-6-sol",
    findings: [], relevant_offerings: ["Retrieval (RAG) assistants", "MLOps and model evaluation"], people_notes: [],
  }, acmeApollo);
}

export function initechReport(frame: Frame): PrepReportV2 {
  return {
    report_version: 2, id: frame.id, calendar_event_id: frame.eventId, target_company: "Initech", company_website: "https://www.initech.example",
    executive_brief: "Initech wants to cut support response times without adding headcount, and has ruled out a customer-facing bot this year. The scoping workshop should lock an agent-assist pilot on the billing queue in English and Spanish, under the $50k threshold Omar can approve this quarter. Bring measurable success criteria and a data-handling plan for the Zendesk export.",
    company: { name: "Initech", website: "https://www.initech.example", what_they_do: "Subscription billing and payroll software for mid-size businesses in North and Latin America.", industry: "B2B SaaS (billing and payroll)", size_signals: "About 1,200 employees; public since 2019", headquarters: "Dallas, Texas", source_ids: ["W1"] },
    recent_developments: [
      { title: "Acquired Payflow to expand into Mexico", date: "2026-06-20", type: "deal", summary: "Adds 4,000 Spanish-speaking customers and a support team in Monterrey.", source_ids: ["W2"] },
      { title: "New CIO appointed", date: "2026-02-11", type: "hiring", summary: "Omar Haddad joined from a fintech to modernise internal systems.", source_ids: ["W3", "P1"] },
      { title: "Customer satisfaction dip noted in Q2 earnings call", date: "2026-08-05", type: "news", summary: "Management cited support backlog after the Payflow migration.", source_ids: ["W4"] },
    ],
    ai_landscape: {
      summary: "Early stage: an internal AI policy and a Zendesk AI trial that was paused over accuracy concerns.",
      initiatives: [{ statement: "Internal AI usage policy published in April.", source_ids: ["W5"] }, { statement: "Paused a customer-facing chatbot trial after wrong refund answers.", source_ids: ["D1"] }],
      vendors: [{ statement: "Zendesk for ticketing; Salesforce for CRM.", source_ids: ["W1"] }],
      end_clients: [{ statement: "Mid-size employers in the US and Mexico", source_ids: ["W2"] }],
      source_ids: ["W5"],
    },
    alignment: {
      fit_summary: "Agent assist with cited drafts matches their risk appetite and the bilingual volume from the Payflow acquisition.",
      relevant_services: [
        { service: "Support automation and agent assist", why: "Billing and password tickets are 40% of volume.", talking_point: "Pilot drafts replies on the billing queue with a human approving every one.", source_ids: ["D1", "B1"] },
        { service: "MLOps and model evaluation", why: "They paused a bot over accuracy.", talking_point: "Show the Spanish evaluation set approach and per-intent accuracy.", source_ids: ["B1"] },
      ],
    },
    attendees: [
      { name: "Omar Haddad", email: "omar.haddad@initech.example", title: "Chief Information Officer", linkedin_url: "https://www.linkedin.com/in/omar-haddad-cio", match_confidence: "confirmed", background: "Joined in February from a fintech; sponsor for support modernisation.", likely_interests: ["Risk control", "Business case", "Budget limits"], persona: "executive", angle: "Lead with risk controls and a go/no-go decision point.", source_ids: ["P1", "W3"] },
      { name: "Nina Brooks", email: "nina.brooks@initech.example", title: "Head of Customer Support", linkedin_url: "https://www.linkedin.com/in/ninabrooks-support", match_confidence: "likely", background: "Runs support across English and Spanish queues.", likely_interests: ["CSAT", "Agent experience", "Spanish quality"], persona: "business", angle: "Show how agents stay in control and what changes in their day.", source_ids: ["P2"] },
      { name: "Raj Mehta", email: "raj.mehta@initech.example", title: "Support operations analyst", linkedin_url: null, match_confidence: "unconfirmed", background: "Owns Zendesk configuration and exports.", likely_interests: ["Data export", "Redaction"], persona: "technical", angle: "Walk through the redaction step and export format.", source_ids: ["D1"] },
    ],
    meeting_narrative: {
      recommended_focus: "Close the pilot scope: billing queue, bilingual, agent assist, three success metrics, under $50k.",
      by_persona: [{ persona: "executive", focus: "Risk controls and a clear go/no-go." }, { persona: "business", focus: "Agent workflow, CSAT recovery." }, { persona: "technical", focus: "Export, redaction, Zendesk integration." }],
      opening: "Recap what we heard in discovery and confirm the decision to start with agent assist.",
      agenda_suggestions: ["Confirm scope and success metrics", "Spanish evaluation plan", "Data export and redaction", "Timeline and budget", "Next steps"],
    },
    talking_points: ["Agents approve every draft — no customer-facing automation.", "Targets: first response −30%, handle time −20%, CSAT above 85%.", "Spanish evaluated by their own bilingual lead."],
    questions_to_ask: ["Who signs off the redacted sample?", "Which Zendesk macros should the drafts replace first?", "How will agents give feedback on drafts?"],
    watchouts: ["Anything above $50k goes to the January steering committee.", "Customer-facing bot is off the table this year — don't propose it."],
    sources: [
      src("W1", "Initech — Company", "https://www.initech.example/company", "web"),
      src("W2", "Initech completes Payflow acquisition", "https://business-news.example.com/initech-payflow", "web", "2026-06-20"),
      src("W3", "Initech names Omar Haddad CIO", "https://www.initech.example/news/new-cio", "web", "2026-02-11"),
      src("W4", "Initech Q2 earnings call highlights", "https://markets.example.com/initech-q2-2026", "web", "2026-08-05"),
      src("W5", "Initech responsible AI policy", "https://www.initech.example/trust/ai-policy", "web", "2026-04-02"),
      src("P1", "Omar Haddad — CIO at Initech | LinkedIn", "https://www.linkedin.com/in/omar-haddad-cio", "web"),
      src("P2", "Nina Brooks — Head of Customer Support | LinkedIn", "https://www.linkedin.com/in/ninabrooks-support", "web"),
      src("D1", "Initech — support automation discovery (meeting minutes)", null, "our_documents"),
      src("B1", "Northwind Labs company profile", null, "organization_brief"),
    ],
    public_research_performed: true, research_steps: steps("Initech"), usage: frame.usage,
    started_at: frame.startedAt, generated_at: frame.generatedAt, provider: "openrouter", model: "openai/gpt-6-sol",
    findings: [], relevant_offerings: ["Support automation and agent assist", "MLOps and model evaluation"], people_notes: [],
  };
}
