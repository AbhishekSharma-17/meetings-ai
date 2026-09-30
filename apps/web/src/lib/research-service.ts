import { api } from "./meetings-service";
import type {
  CompanySearchInput, CompanySearchResponse, LookupResponse, PeopleSearchInput, PeopleSearchResponse, PrepareResult, ProfileHistory, ProfileKind,
  ResearchChatResponse, ResearchConversation, ResearchConversationSummary, ResearchProfile, ResearchStatus, SaveProfileResponse,
} from "./research-types";

const profile = (id: string) => `/v1/research/profiles/${encodeURIComponent(id)}`;
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** Research (Apollo Explorer). Apollo calls count toward a per-person daily cap; the server enforces it. */
export const researchService = {
  status: () => api<ResearchStatus>("/v1/research/status"),
  searchCompanies: (input: CompanySearchInput) => api<CompanySearchResponse>("/v1/research/search/companies", post(input)),
  searchPeople: (input: PeopleSearchInput) => api<PeopleSearchResponse>("/v1/research/search/people", post(input)),
  lookUp: (apolloIds: string[], confirm = false) => api<LookupResponse>("/v1/research/people/lookup", post({ apollo_ids: apolloIds, confirm })),
  listProfiles: (kind?: ProfileKind) => api<ResearchProfile[]>(`/v1/research/profiles${kind ? `?kind=${kind}` : ""}`),
  saveProfile: (input: { kind: ProfileKind; apollo_id: string | null; domain?: string | null; name?: string | null }) =>
    api<SaveProfileResponse>("/v1/research/profiles", post(input)),
  getProfile: (id: string) => api<ResearchProfile>(profile(id)),
  refreshProfile: (id: string) => api<SaveProfileResponse>(`${profile(id)}/refresh`, { method: "POST" }),
  deleteProfile: (id: string) => api<void>(profile(id), { method: "DELETE" }),
  history: (id: string) => api<ProfileHistory>(`${profile(id)}/history`),
  people: (id: string) => api<ResearchProfile[]>(`${profile(id)}/people`),
  ask: (id: string, question: string, conversationId: string | null, includeWeb: boolean) =>
    api<ResearchChatResponse>(`${profile(id)}/chat`, post({ question, conversation_id: conversationId, include_web: includeWeb })),
  conversations: (id: string) => api<ResearchConversationSummary[]>(`${profile(id)}/conversations`),
  conversation: (id: string, conversationId: string) => api<ResearchConversation>(`${profile(id)}/conversations/${encodeURIComponent(conversationId)}`),
  deleteConversation: (id: string, conversationId: string) => api<void>(`${profile(id)}/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" }),
  prepare: (id: string, calendarEventId: string, personProfileIds: string[]) =>
    api<PrepareResult>(`${profile(id)}/prepare`, post({ calendar_event_id: calendarEventId, person_profile_ids: personProfileIds })),
  saveToKnowledge: (id: string, knowledgeBaseId: string) => api<{ id: string; filename: string }>(`${profile(id)}/knowledge`, post({ knowledge_base_id: knowledgeBaseId })),
};
