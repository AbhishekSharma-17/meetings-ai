import type { ApolloCreditLine, ApolloIntegration, ApolloPerson, ApolloSnapshot, PrepReportV2, PrepSourceV2 } from "../../types";

/*
 * Sample Apollo data for the demo workspace: a connected workspace key, credit balances and realistic
 * (fictional) company and people facts attached to demo briefings. Nothing is sent anywhere.
 */

export type DemoApolloState = { connected: boolean; hint: string; connectedAt: string; checkedAt: string };

export function demoApollo(now: number): DemoApolloState {
  const connectedAt = new Date(now - 12 * 86_400_000).toISOString();
  return { connected: true, hint: "••••7Q2m", connectedAt, checkedAt: new Date(now - 40 * 60_000).toISOString() };
}

export const demoCredits: ApolloCreditLine[] = [
  { credit_type: "email", label: "Email credits", used: 412, limit: 1000, remaining: 588, unit: "credits" },
  { credit_type: "export", label: "Export credits", used: 921, limit: 1000, remaining: 79, unit: "credits" },
  { credit_type: "mobile", label: "Mobile credits", used: 3, limit: 50, remaining: 47, unit: "credits" },
  { credit_type: "dialer", label: "Dialer minutes", used: 0, limit: 120, remaining: 120, unit: "minutes" },
];

export function apolloView(state: DemoApolloState, withCredits = false): ApolloIntegration {
  if (!state.connected) return { provider: "apollo", available: true, connected: false, status: null, hint: null, connected_by: null, connected_at: null, updated_at: null, last_checked_at: null, last_error: null, credits: [] };
  return { provider: "apollo", available: true, connected: true, status: "active", hint: state.hint, connected_by: "Alex Morgan", connected_at: state.connectedAt, updated_at: state.connectedAt, last_checked_at: state.checkedAt, last_error: null, credits: withCredits ? demoCredits : [] };
}

type Sample = Omit<ApolloSnapshot, "calls" | "cached_results" | "notice" | "fetched_at">;

const person = (name: string, fields: Partial<ApolloPerson>): ApolloPerson => ({
  name, title: null, seniority: null, departments: [], company: null, role_started: null, past_roles: [], linkedin_url: null, location: null, matched_by: "email", source_id: null, ...fields,
});

export const acmeApollo: Sample = {
  company: {
    apollo_id: "5f2a9c-acme", name: "Acme Robotics", domain: "acme-robotics.example", website: "https://www.acme-robotics.example", linkedin_url: "https://www.linkedin.com/company/acme-robotics-example",
    description: "Autonomous mobile robots and fleet software for warehouses and ports.", industry: "Industrial automation", employee_count: 540, revenue_band: "$50M–$100M",
    total_funding: "$212M", latest_funding_stage: "Series C", latest_funding_date: "2026-05-02", latest_funding_amount: "$120M", headquarters: "Austin, Texas, United States", founded_year: 2016,
    tech_stack: ["AWS", "Kubernetes", "ROS 2", "Snowflake", "Salesforce", "Zendesk"], source_id: null,
  },
  people: [
    person("Asha Patel", { title: "Chief Technology Officer", seniority: "c_suite", departments: ["engineering technical"], company: "Acme Robotics", role_started: "2022-03-01", linkedin_url: "https://www.linkedin.com/in/asha-patel-robotics", location: "Austin, Texas",
      past_roles: [{ company: "Globex", title: "VP Data Platforms", start_date: "2018-01-01", end_date: "2022-02-01", current: false }, { company: "Initech", title: "Principal Engineer", start_date: "2014-06-01", end_date: "2017-12-01", current: false }] }),
    person("Chen Li", { title: "Director of Operations, North America", seniority: "director", departments: ["operations"], company: "Acme Robotics", role_started: "2023-09-01", linkedin_url: "https://www.linkedin.com/in/chenli-ops", location: "Reno, Nevada",
      past_roles: [{ company: "Contoso Logistics", title: "Warehouse Operations Manager", start_date: "2019-02-01", end_date: "2023-08-01", current: false }] }),
    person("Jeroen Visser", { title: "Site Lead, Rotterdam", seniority: "manager", departments: ["operations"], company: "Acme Robotics", role_started: "2026-07-01", location: "Rotterdam, Netherlands", matched_by: "email",
      past_roles: [{ company: "Port of Rotterdam", title: "Terminal Automation Engineer", start_date: "2020-01-01", end_date: "2026-06-01", current: false }] }),
  ],
  news: [
    { title: "Acme Robotics opens Rotterdam service hub ahead of port pilot", url: "https://port-news.example.com/acme-rotterdam-hub", published_at: "2026-09-10", snippet: "A 40-person maintenance team will support the December demo.", source_id: null },
    { title: "Acme Robotics named to logistics tech top 50", url: "https://techwire.example.com/logistics-50", published_at: "2026-08-22", snippet: null, source_id: null },
  ],
  hiring: {
    open_roles: 23, themes: [{ theme: "Engineering", count: 9 }, { theme: "Operations", count: 6 }, { theme: "AI & data", count: 4 }, { theme: "Customer success", count: 4 }],
    examples: [
      { title: "Head of Field Service, Europe", url: "https://careers.acme-robotics.example/field-service-europe", location: "Rotterdam, Netherlands", posted_at: "2026-09-02" },
      { title: "Senior Machine Learning Engineer, Perception", url: null, location: "Austin, Texas", posted_at: "2026-09-15" },
      { title: "Technical Writer (Dutch)", url: null, location: "Rotterdam, Netherlands", posted_at: "2026-09-18" },
    ],
    source_id: null,
  },
  relationship: { account_name: "Acme Robotics", stage: "Active opportunity", owner: "Alex Morgan", last_activity_at: "2026-09-24", contacts: [{ name: "Asha Patel", title: "CTO", stage: "Engaged", last_activity_at: "2026-09-24" }, { name: "Chen Li", title: "Director of Operations", stage: "Engaged", last_activity_at: "2026-09-12" }], source_id: null },
};

function companySample(name: string, domain: string, website: string, attendees: { name: string }[]): Sample {
  return {
    company: { apollo_id: `demo-${domain}`, name, domain, website, linkedin_url: `https://www.linkedin.com/company/${domain.split(".")[0]}`, description: null, industry: "Not confirmed", employee_count: 2400, revenue_band: "$250M–$500M",
      total_funding: null, latest_funding_stage: null, latest_funding_date: null, latest_funding_amount: null, headquarters: null, founded_year: 2004, tech_stack: ["Microsoft 365", "Salesforce", "ServiceNow"], source_id: null },
    people: attendees.slice(0, 2).map((item, index) => person(item.name, { title: index === 0 ? "VP Operations" : "Program Manager", seniority: index === 0 ? "vp" : "manager", departments: ["operations"], company: name, role_started: index === 0 ? "2021-04-01" : "2024-01-01" })),
    news: [], hiring: { open_roles: 11, themes: [{ theme: "Operations", count: 5 }, { theme: "Engineering", count: 4 }, { theme: "Other", count: 2 }], examples: [{ title: "Automation Program Lead", url: null, location: null, posted_at: null }], source_id: null },
    relationship: null,
  };
}

/** A generated demo briefing for a workspace with Apollo connected: company and people facts from the sample. */
export function genericApollo(report: PrepReportV2): Sample {
  const website = report.company_website ?? "https://www.example.com";
  const domain = (() => { try { return new URL(website).hostname.replace(/^www\./, ""); } catch { return "example.com"; } })();
  return companySample(report.target_company ?? "The client", domain, website, report.attendees);
}

/** Adds Apollo sources (A1…), the snapshot and enriched attendee cards to a demo briefing. */
export function withApollo(report: PrepReportV2, sample: Sample, calls = 7): PrepReportV2 {
  const sources: PrepSourceV2[] = [];
  const add = (title: string, url: string | null, published: string | null = null) => {
    const id = `A${sources.length + 1}`;
    sources.push({ id, title: `Apollo · ${title}`, url, publisher: url ? new URL(url).hostname.replace(/^www\./, "") : null, published_date: published ?? report.generated_at.slice(0, 10), origin: "apollo" });
    return id;
  };
  const company = sample.company ? { ...sample.company, source_id: add(`${sample.company.name ?? "Company"} company profile`, sample.company.linkedin_url) } : null;
  const people = sample.people.map((item) => ({ ...item, source_id: add(item.title ? `${item.name} (${item.title})` : item.name, item.linkedin_url) }));
  const news = sample.news.map((item) => ({ ...item, source_id: add(`News: ${item.title}`, item.url, item.published_at) }));
  const hiring = sample.hiring ? { ...sample.hiring, source_id: add(`${company?.name ?? "Company"} open roles`, null) } : null;
  const relationship = sample.relationship ? { ...sample.relationship, source_id: add(`${sample.relationship.account_name ?? "Account"} in your Apollo CRM`, null) } : null;
  const byName = new Map(people.map((item) => [item.name.toLowerCase(), item]));
  const attendees = report.attendees.map((attendee) => {
    const found = byName.get(attendee.name.toLowerCase());
    if (!found) return attendee;
    return { ...attendee, apollo: found, title: attendee.title ?? found.title, match_confidence: attendee.match_confidence === "unconfirmed" ? "confirmed" as const : attendee.match_confidence,
      source_ids: [...attendee.source_ids, found.source_id as string] };
  });
  return {
    ...report, attendees, sources: [...sources, ...report.sources],
    company: { ...report.company, source_ids: company?.source_id ? [company.source_id, ...report.company.source_ids] : report.company.source_ids },
    apollo: { company, people, news, hiring, relationship, calls, cached_results: 0, notice: null, fetched_at: report.generated_at },
    usage: { ...report.usage, apollo_calls: calls },
    research_steps: [{ stage: "apollo", purpose: "organization", query: null, category: null, results: 1, status: "succeeded" }, ...report.research_steps],
  };
}
