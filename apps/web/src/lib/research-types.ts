import type { ApolloCompany, ApolloPerson, ApolloSnapshot } from "./types";

/* Research (Apollo Explorer): shapes of /v1/research/*. Contact details are never part of any response. */

export type ProfileKind = "company" | "person";
export type ApolloUsage = { used_today: number; daily_limit: number };
export type ResearchStatus = {
  connected: boolean; status: "active" | "invalid" | "out_of_credit" | null;
  can_manage: boolean; can_use: boolean; usage: ApolloUsage | null; bulk_confirm_over: number;
};

export const EMPLOYEE_RANGES = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"] as const;
export type EmployeeRange = typeof EMPLOYEE_RANGES[number];
export const SENIORITIES = [
  { value: "c_suite", label: "C-suite" }, { value: "vp", label: "VP" }, { value: "head", label: "Head" },
  { value: "director", label: "Director" }, { value: "manager", label: "Manager" }, { value: "senior", label: "Senior" },
  { value: "entry", label: "Entry" }, { value: "owner", label: "Owner" }, { value: "founder", label: "Founder" },
  { value: "partner", label: "Partner" }, { value: "intern", label: "Intern" },
] as const;
export type Seniority = typeof SENIORITIES[number]["value"];

export type CompanySearchInput = { name?: string | null; domains: string[]; industry_keywords: string[]; locations: string[]; employee_ranges: EmployeeRange[]; page: number };
export type PeopleSearchInput = { domains: string[]; titles: string[]; seniorities: Seniority[]; locations: string[]; keywords?: string | null; page: number };

export type CompanyHit = {
  apollo_id: string | null; name: string; domain: string | null; website: string | null; linkedin_url: string | null;
  logo_url: string | null; industry: string | null; employee_count: number | null; headquarters: string | null;
  in_apollo_account: boolean; saved_profile_id: string | null;
};
export type PersonHit = {
  apollo_id: string; name: string; name_partial: boolean; title: string | null; seniority: string | null; company: string | null;
  company_domain: string | null; location: string | null; linkedin_url: string | null; in_apollo_contacts: boolean; saved_profile_id: string | null;
};
type SearchPage = { page: number; per_page: number; total: number | null; total_pages: number | null; cached: boolean; usage: ApolloUsage };
export type CompanySearchResponse = SearchPage & { items: CompanyHit[] };
export type PeopleSearchResponse = SearchPage & { items: PersonHit[] };
export type LookupResponse = { items: { apollo_id: string; person: ApolloPerson | null; company_domain: string | null }[]; usage: ApolloUsage };

export type ResearchProfile = {
  id: string; kind: ProfileKind; apollo_id: string | null; domain: string | null; name: string; title: string | null; company: string | null;
  logo_url: string | null; company_facts: ApolloCompany | null; person: ApolloPerson | null;
  news: ApolloSnapshot["news"]; hiring: ApolloSnapshot["hiring"]; job_groups: JobGroup[];
  created_by: { id: string | null; name: string } | null; created_at: string; updated_at: string; fetched_at: string;
  apollo_calls: number; can_delete: boolean;
  /** Set once an admin saved (or linked) this profile to the team's Apollo CRM. */
  apollo_crm?: ApolloCrmLink | null;
};

/* "Save to Apollo": a person becomes an Apollo contact, a company an Apollo account. Owners and admins only. */
export type ApolloRecordType = "contact" | "account";
export type ApolloCrmLink = {
  record_type: ApolloRecordType; record_id: string; record_name: string | null; action: "created" | "linked";
  url: string; by: { id: string | null; name: string } | null; at: string;
};
export type ApolloCrmOption = { id: string; name: string };
export type ApolloCrmMatch = { id: string; name: string; detail: string | null; url: string };
export type ApolloSavePreview = {
  record_type: ApolloRecordType; fields: { label: string; value: string }[]; not_sent: string[]; matches: ApolloCrmMatch[];
  stages: ApolloCrmOption[]; stages_note: string | null; owners: ApolloCrmOption[]; owners_note: string | null; usage: ApolloUsage;
};
export type ApolloSaveInput = { action: "create" | "link"; record_id?: string | null; create_anyway?: boolean; stage_id?: string | null; owner_id?: string | null };
export type JobGroup = { theme: string; count: number; jobs: NonNullable<ApolloSnapshot["hiring"]>["examples"] };
export type SaveProfileResponse = { profile: ResearchProfile; created: boolean; usage: ApolloUsage };

export type HistoryMeeting = { meeting_id: string; title: string; date: string; status: string; reasons: string[] };
export type SaidQuote = { segment_id: string | null; start_seconds: number; text: string };
export type PersonMeeting = HistoryMeeting & { speaker: string | null; quotes: SaidQuote[] };
export type HistoryBriefing = { calendar_event_id: string; title: string; starts_at: string; briefing_at: string | null; executive_brief: string | null; reasons: string[] };
export type HistoryDocument = { document_id: string; knowledge_base_id: string; knowledge_base_name: string; filename: string; summary: string | null };
export type CompanyHistory = { meetings: HistoryMeeting[]; briefings: HistoryBriefing[]; documents: HistoryDocument[]; our_company: boolean };
export type PersonHistory = { meetings: PersonMeeting[] };
export type ProfileHistory = CompanyHistory | PersonHistory;

export type ResearchCitation = {
  id: string; kind: "apollo" | "meeting" | "briefing" | "web"; title: string; snippet: string | null; url: string | null; date: string | null;
  meeting_id: string | null; segment_id: string | null; calendar_event_id: string | null;
};
export type ResearchChatResponse = {
  answer: string; citations: ResearchCitation[]; conversation_id: string; provider: string | null; model: string | null;
  web_searches: number; note: string | null;
};
export type ResearchMessage = { id: string; role: "user" | "assistant"; content: string; citations: ResearchCitation[]; provider: string | null; model: string | null; created_at: string };
export type ResearchConversationSummary = { id: string; profile_id: string; title: string; created_at: string; updated_at: string };
export type ResearchConversation = ResearchConversationSummary & { messages: ResearchMessage[] };

export type PrepareResult = {
  calendar_event_id: string; target_company: string | null; company_website: string | null;
  attendee_sides: Record<string, "ours" | "theirs">; matched_people: string[]; unmatched_people: string[];
};
