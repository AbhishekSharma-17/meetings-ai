import type { ApolloPerson } from "../../types";
import type { CompanyHit, PersonHit, ResearchProfile } from "../../research-types";
import { acmeApollo } from "./apollo";
import { type Clock, minutesFrom } from "./ids";
import { OWNER_ID } from "./people";

/*
 * Research (Apollo Explorer) sample data: a connected demo Apollo with a few realistic, fictional companies
 * and people, one saved company (Acme Robotics) with news and open roles, and one saved person. Nothing is
 * sent anywhere and no contact details exist in this data.
 */

export type DemoResearchState = {
  profiles: ResearchProfile[];
  conversations: { id: string; profile_id: string; title: string; created_at: string; updated_at: string; messages: DemoResearchMessage[] }[];
  lookups: string[];
  usedToday: number;
};
export type DemoResearchMessage = { id: string; role: "user" | "assistant"; content: string; citations: unknown[]; provider: string | null; model: string | null; created_at: string };

const LOGO = null;
export const DAILY_LIMIT = 100;

export const companyHits: CompanyHit[] = [
  { apollo_id: "5f2a9c-acme", name: "Acme Robotics", domain: "acme-robotics.example", website: "https://www.acme-robotics.example", linkedin_url: "https://www.linkedin.com/company/acme-robotics-example", logo_url: LOGO, industry: "Industrial automation", employee_count: 540, headquarters: "Austin, Texas, United States", in_apollo_account: true, saved_profile_id: null },
  { apollo_id: "demo-globex", name: "Globex Logistics", domain: "globex.example", website: "https://www.globex.example", linkedin_url: null, logo_url: LOGO, industry: "Logistics and supply chain", employee_count: 2400, headquarters: "Rotterdam, Netherlands", in_apollo_account: true, saved_profile_id: null },
  { apollo_id: "demo-initech", name: "Initech", domain: "initech.example", website: "https://www.initech.example", linkedin_url: null, logo_url: LOGO, industry: "Enterprise software", employee_count: 1250, headquarters: "Dallas, Texas, United States", in_apollo_account: false, saved_profile_id: null },
  { apollo_id: "demo-umbrella", name: "Umbrella Freight", domain: "umbrella-freight.example", website: "https://www.umbrella-freight.example", linkedin_url: null, logo_url: LOGO, industry: "Transportation", employee_count: 820, headquarters: "Hamburg, Germany", in_apollo_account: false, saved_profile_id: null },
  { apollo_id: "demo-vandelay", name: "Vandelay Automation", domain: "vandelay.example", website: "https://www.vandelay.example", linkedin_url: null, logo_url: LOGO, industry: "Industrial automation", employee_count: 160, headquarters: "Toronto, Ontario, Canada", in_apollo_account: false, saved_profile_id: null },
];

const person = (name: string, fields: Partial<ApolloPerson>): ApolloPerson => ({
  name, title: null, seniority: null, departments: [], company: null, role_started: null, past_roles: [], linkedin_url: null, location: null, matched_by: "name", source_id: null, ...fields,
});

/** Full (looked-up) records by Apollo id; searches show the partial view below until someone looks a person up. */
export const peopleRecords: Record<string, { person: ApolloPerson; domain: string }> = {
  "demo-asha": { person: acmeApollo.people[0], domain: "acme-robotics.example" },
  "demo-chen": { person: acmeApollo.people[1], domain: "acme-robotics.example" },
  "demo-jeroen": { person: acmeApollo.people[2], domain: "acme-robotics.example" },
  "demo-grace": { person: person("Grace Liu", { title: "Head of Information Security", seniority: "head", departments: ["information technology"], company: "Acme Robotics", role_started: "2021-06-01", location: "Austin, Texas",
    past_roles: [{ company: "Initech", title: "Security Architect", start_date: "2016-02-01", end_date: "2021-05-01", current: false }] }), domain: "acme-robotics.example" },
  "demo-maria": { person: person("Maria Gonzalez", { title: "VP Operations", seniority: "vp", departments: ["operations"], company: "Globex Logistics", role_started: "2020-09-01", location: "Rotterdam, Netherlands" }), domain: "globex.example" },
};

export const peopleHits: PersonHit[] = [
  { apollo_id: "demo-asha", name: "Asha Pa***l", name_partial: true, title: "Chief Technology Officer", seniority: "c_suite", company: "Acme Robotics", company_domain: "acme-robotics.example", location: "Austin, Texas", linkedin_url: null, in_apollo_contacts: true, saved_profile_id: null },
  { apollo_id: "demo-chen", name: "Chen L*", name_partial: true, title: "Director of Operations, North America", seniority: "director", company: "Acme Robotics", company_domain: "acme-robotics.example", location: "Reno, Nevada", linkedin_url: null, in_apollo_contacts: true, saved_profile_id: null },
  { apollo_id: "demo-grace", name: "Grace L*u", name_partial: true, title: "Head of Information Security", seniority: "head", company: "Acme Robotics", company_domain: "acme-robotics.example", location: "Austin, Texas", linkedin_url: null, in_apollo_contacts: false, saved_profile_id: null },
  { apollo_id: "demo-jeroen", name: "Jeroen V****r", name_partial: true, title: "Site Lead, Rotterdam", seniority: "manager", company: "Acme Robotics", company_domain: "acme-robotics.example", location: "Rotterdam, Netherlands", linkedin_url: null, in_apollo_contacts: false, saved_profile_id: null },
  { apollo_id: "demo-maria", name: "Maria G******z", name_partial: true, title: "VP Operations", seniority: "vp", company: "Globex Logistics", company_domain: "globex.example", location: "Rotterdam, Netherlands", linkedin_url: null, in_apollo_contacts: false, saved_profile_id: null },
];

export const ACME_PROFILE_ID = "00000000-0000-4000-8000-00000000ac01";
export const ASHA_PROFILE_ID = "00000000-0000-4000-8000-00000000ac02";

export function companyProfile(id: string, hit: CompanyHit, fetchedAt: string, createdBy: { id: string; name: string } | null): ResearchProfile {
  const acme = hit.apollo_id === "5f2a9c-acme";
  const company = acme ? acmeApollo.company! : {
    apollo_id: hit.apollo_id, name: hit.name, domain: hit.domain, website: hit.website, linkedin_url: hit.linkedin_url, description: null, industry: hit.industry,
    employee_count: hit.employee_count, revenue_band: "$100M–$250M", total_funding: null, latest_funding_stage: null, latest_funding_date: null, latest_funding_amount: null,
    headquarters: hit.headquarters, founded_year: 2008, tech_stack: ["Microsoft 365", "Salesforce"], source_id: null,
  };
  const hiring = acme ? acmeApollo.hiring : { open_roles: 6, themes: [{ theme: "Operations", count: 3 }, { theme: "Engineering", count: 3 }], examples: [{ title: "Operations Manager", url: null, location: hit.headquarters, posted_at: null }, { title: "Senior Software Engineer", url: null, location: null, posted_at: null }], source_id: null };
  return {
    id, kind: "company", apollo_id: hit.apollo_id, domain: hit.domain, name: hit.name, title: null, company: hit.name, logo_url: hit.logo_url, company_facts: company, person: null,
    news: acme ? acmeApollo.news : [], hiring, job_groups: jobGroups(hiring),
    created_by: createdBy, created_at: fetchedAt, updated_at: fetchedAt, fetched_at: fetchedAt, apollo_calls: 3, can_delete: true,
  };
}

export function personProfile(id: string, apolloId: string, fetchedAt: string, createdBy: { id: string; name: string } | null): ResearchProfile | null {
  const record = peopleRecords[apolloId];
  if (!record) return null;
  return {
    id, kind: "person", apollo_id: apolloId, domain: record.domain, name: record.person.name, title: record.person.title, company: record.person.company, logo_url: null,
    company_facts: null, person: record.person, news: [], hiring: null, job_groups: [], created_by: createdBy, created_at: fetchedAt, updated_at: fetchedAt, fetched_at: fetchedAt, apollo_calls: 1, can_delete: true,
  };
}

const THEME_WORDS: [string, RegExp][] = [["AI & data", /machine learning|\bml\b|\bai\b|data/i], ["Engineering", /engineer|developer|software|writer/i], ["Operations", /operations|field service|site/i], ["Customer success", /customer|support/i]];

function jobGroups(hiring: ResearchProfile["hiring"]): ResearchProfile["job_groups"] {
  if (!hiring) return [];
  const groups = hiring.themes.map((theme) => ({ theme: theme.theme, count: theme.count, jobs: [] as NonNullable<ResearchProfile["hiring"]>["examples"] }));
  for (const job of hiring.examples) {
    const theme = THEME_WORDS.find(([, pattern]) => pattern.test(job.title))?.[0] ?? "Other";
    let group = groups.find((item) => item.theme === theme);
    if (!group) { group = { theme, count: 0, jobs: [] }; groups.push(group); }
    group.jobs.push(job);
    group.count = Math.max(group.count, group.jobs.length);
  }
  return groups;
}

export function demoResearch(clock: Clock): DemoResearchState {
  const owner = { id: OWNER_ID, name: "Alex Morgan" };
  const acme = companyProfile(ACME_PROFILE_ID, companyHits[0], minutesFrom(clock, -3 * 24 * 60), owner);
  const asha = personProfile(ASHA_PROFILE_ID, "demo-asha", minutesFrom(clock, -3 * 24 * 60 + 5), owner);
  return { profiles: asha ? [acme, asha] : [acme], conversations: [], lookups: [], usedToday: 7 };
}
