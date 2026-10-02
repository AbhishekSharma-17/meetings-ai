export type MeetingStatus = "created" | "joining" | "waiting_room" | "live" | "needs_attention" | "stopping" | "processing" | "ready" | "stopped" | "failed";

export type Meeting = {
  id: string;
  title: string;
  botName?: string;
  startsAt: string;
  duration: string;
  participants: number;
  status: MeetingStatus;
  platform: "Google Meet" | "Zoom" | "Microsoft Teams" | "In person";
  /** Where the minutes are once drafted; null until then (older APIs omit it). */
  minutesStatus?: MinutesStatus | null;
  /** The scheduled join behind the meeting (calendar or manual schedule); null for direct joins. */
  schedule?: MeetingSchedule | null;
};

/** Assistants that can be in calls at once (shared by every workspace), in use and waiting. */
export type AssistantCapacity = {
  limit: number | null; in_use: number | null; available: number | null; waiting: number;
  tested_capacity: number | null; checked_at: string; error: string | null;
};

/** A meeting's automatic join: lets every list say Scheduled, Moved, Cancelled or Missed. */
export type MeetingSchedule = {
  status: "pending" | "joining" | "joined" | "cancelled" | "missed" | "failed" | string;
  provider: string;
  startsAt: string;
  endsAt: string;
  /** Why it changed, in the calendar's words ("Cancelled in Outlook Calendar"). */
  note: string | null;
  /** When the status last changed (for a cancel: when it was noticed). */
  changedAt: string;
  /** The start before the first detected move, while the meeting is at another time. */
  rescheduledFrom: string | null;
};

export type MeetingDetail = Meeting & {
  meetingUrl: string;
  botName: string;
  createdAt: string | null;
  updatedAt: string | null;
  joinedAt: string | null;
  stoppedAt: string | null;
  errorMessage: string | null;
  tags: string[];
  knowledgeEnabled: boolean;
  knowledgeBaseId: string | null;
};

export type TranscriptionRoute = {
  mode: "pending" | "profile" | "vexa_deployment";
  profile_id: string | null;
  profile_name: string | null;
  provider_type: string | null;
  model: string | null;
  endpoint_host: string | null;
  selected_at: string | null;
};

export type Workspace = {
  id: string;
  slug: string;
  display_name: string;
  contact_email: string | null;
  status: "active" | string;
  created_at: string;
  updated_at: string;
  tenant_isolation_enabled: boolean;
};

export type WorkspaceOption = {
  id: string;
  slug: string;
  display_name: string;
  role: CurrentAccount["role"];
  /** The workspace a new sign-in opens in; when none is set, the last active workspace is used. */
  is_default?: boolean;
};

export type WorkspaceMember = {
  user_id: string;
  display_name: string;
  email: string | null;
  role: "owner" | "admin" | "member" | "viewer";
  status: string;
  /** Versioned, same-origin API path to the member's profile photo, or null. */
  photo_url?: string | null;
  /** When the latest invitation link expires; null when none is outstanding. */
  invite_expires_at?: string | null;
};

export type AuditEvent = {
  id: string;
  actor_user_id: string | null;
  action: string;
  resource_path: string;
  resource_id: string | null;
  status_code: number;
  created_at: string;
};

export type WorkspaceOperations = {
  people: number;
  meetings_captured: number;
  completed_meetings: number;
  saved_chats: number;
  active_captures: number;
  failed_captures: number;
  failed_mom_jobs: number;
  pending_index_jobs: number;
  failed_index_jobs: number;
  failed_email_deliveries: number;
  latest_audit_at: string | null;
};

export type UsageSummary = {
  total_requests: number;
  input_tokens: number;
  output_tokens: number;
  estimated_usd: number;
  unpriced_requests: number;
  recent: Array<{ id: string; meeting_id: string | null; knowledge_base_id: string | null; purpose: string; provider: string; model: string; input_tokens: number | null; output_tokens: number | null; estimated_usd: number | null; created_at: string }>;
  by_meeting: Array<{ meeting_id: string; requests: number; input_tokens: number; output_tokens: number; estimated_usd: number; unpriced_requests: number }>;
  by_purpose: Array<{ name: string; requests: number; input_tokens: number; output_tokens: number; estimated_usd: number; unpriced_requests: number }>;
  by_provider: Array<{ name: string; requests: number; input_tokens: number; output_tokens: number; estimated_usd: number; unpriced_requests: number }>;
};

export type RetentionPolicy = {
  enabled: boolean;
  meeting_days: number | null;
  chat_days: number | null;
  audit_days: number | null;
};

export type CurrentAccount = {
  user_id: string;
  organization_id: string;
  email: string | null;
  display_name: string;
  role: "owner" | "admin" | "member" | "viewer";
  must_change_password: boolean;
  photo_url?: string | null;
};

export type InviteResult = {
  account: CurrentAccount;
  /** Always null: people set their own password from a single-use link. Kept for older APIs. */
  temporary_password: string | null;
  note: string;
  email_sent: boolean;
  /** The one-time link, only when it could not be emailed. A credential: show once, never store. */
  accept_url?: string | null;
  link_expires_at?: string | null;
};

export type AccountLinkPurpose = "invite" | "password_reset";
export type AccountLinkState = "valid" | "expired" | "used" | "revoked" | "invalid";

export type AccountLinkPreview = {
  state: AccountLinkState;
  purpose: AccountLinkPurpose | null;
  email: string | null;
  display_name: string | null;
  workspace_name: string | null;
  expires_at: string | null;
};

export type KnowledgeSource = {
  source_id: string;
  kind: "transcript" | "question" | "action" | "contribution" | "decision" | "summary";
  meeting_id: string;
  knowledge_base_id: string | null;
  meeting_title: string;
  meeting_created_at: string;
  meeting_joined_at: string | null;
  segment_id: string;
  start_seconds: number;
  end_seconds: number;
  speaker: string | null;
  text: string;
  tags: string[];
  evidence_segment_ids: string[];
};

export type KnowledgeSearchResponse = {
  sources: KnowledgeSource[];
  count: number;
  retrieval_mode: "lexical" | "hybrid";
  truncated_meeting_scope: boolean;
};

export type KnowledgeIndexStatus = {
  knowledge_base_id: string;
  indexed_sources: number;
  profile_id: string | null;
  model: string | null;
  last_indexed_at: string | null;
  job_status: "pending" | "running" | "succeeded" | "failed" | null;
  requested_at: string | null;
  next_retry_at: string | null;
  last_error: string | null;
};

export type KnowledgeMapEntry = {
  key: string;
  label: string;
  meeting_count: number;
  source_count: number;
  verified_identity: boolean;
  email: string | null;
  sources: KnowledgeSource[];
};

export type KnowledgeMap = {
  knowledge_base_id: string;
  topics: KnowledgeMapEntry[];
  speaker_labels: KnowledgeMapEntry[];
  truncated_meeting_scope: boolean;
};

export type KnowledgeChatResponse = {
  answer: string;
  citations: KnowledgeSource[];
  conversation_id: string | null;
  provider: string | null;
  model: string | null;
  retrieval_mode: "lexical" | "hybrid";
  note: string;
};

export type KnowledgeTextProfile = {
  id: string;
  name: string;
  provider_type: "openai" | "openai_compatible" | "vexa_native";
  base_url: string | null;
  capabilities: Array<{ capability: string; model: string }>;
};

export type TextModelCatalog = {
  profile_id: string;
  provider: string;
  configured_model: string;
  live_catalog: boolean;
  models: Array<{ id: string; name: string; input_per_million_usd: number | null; output_per_million_usd: number | null }>;
};

export type KnowledgeBase = {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  created_by: string;
  visibility: "private" | "organization" | "specific";
  text_profile_id: string | null;
  meeting_count: number;
  shared_user_ids: string[];
  created_at: string;
  updated_at: string;
};

export type KnowledgeWikiOverview = {
  knowledge_base_id: string;
  name: string;
  meetings: Array<{
    id: string;
    title: string;
    created_at: string;
    tags: string[];
    summary: string | null;
    decisions: string[];
    action_items: string[];
    related_meeting_ids: string[];
    related_meetings: Array<{ meeting_id: string; title: string; reasons: string[] }>;
  }>;
};

export type KnowledgeMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: KnowledgeSource[];
  provider: string | null;
  model: string | null;
  created_at: string;
};

export type KnowledgeConversation = {
  id: string;
  knowledge_base_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: KnowledgeMessage[];
};

export type TranscriptSegment = {
  id: string;
  segmentId: string;
  speaker: string;
  rawSpeaker: string | null;
  speakerReviewed: boolean;
  attributionSource: string | null;
  startedAt: string | number | null;
  endedAt: string | number | null;
  text: string;
  isFinal: boolean;
};

export type MeetingParticipant = {
  name: string;
  email: string | null;
  source: "invite" | "speaker" | string;
  response_status: string | null;
};

export type MeetingParticipants = {
  meeting_id: string;
  participants: MeetingParticipant[];
  observed_roster: string;
  upstream_available: boolean;
};

export type SpeakerIdentity = {
  speaker: string;
  email: string;
  confirmed_at: string;
};

export type SpeakerSuggestionSource = "invite" | "organizer" | "workspace_member";

/** An advisory speaker → email match. Only a person's approval links the email. */
export type SpeakerSuggestion = {
  speaker: string;
  status: "suggested" | "ambiguous";
  email: string | null;
  display_name: string | null;
  source: SpeakerSuggestionSource | null;
  confidence: "high" | "medium" | "low" | null;
  reason: string;
  alternatives: { email: string; display_name: string; source: SpeakerSuggestionSource }[];
};

export type MinutesStatus = "draft" | "approved" | "sent";

export type ActionItem = {
  description: string;
  owner: string | null;
  due_date: string | null;
  evidence_segment_ids?: string[];
};

export type SpeakerContribution = {
  speaker: string;
  summary: string;
  evidence_segment_ids: string[];
};

export type AttributedQuestion = {
  speaker: string | null;
  question: string;
  evidence_segment_ids: string[];
};

export type MeetingMinutes = {
  meeting_id: string;
  status: MinutesStatus;
  title: string;
  executive_summary: string;
  discussion_points: string[];
  decisions: string[];
  action_items: ActionItem[];
  open_questions: string[];
  speaker_contributions: SpeakerContribution[];
  questions_asked: AttributedQuestion[];
  provider_profile_id: string | null;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  sent_at: string | null;
  last_error: string | null;
};

export type MinutesDraft = Pick<MeetingMinutes, "title" | "executive_summary" | "discussion_points" | "decisions" | "action_items" | "open_questions" | "speaker_contributions" | "questions_asked">;

export type EmailDelivery = {
  id: string;
  meeting_id: string;
  recipients: string[];
  status: "sent" | "failed";
  provider_message_id: string | null;
  error: string | null;
  created_at: string;
  /** Teams expanded into `recipients`, as named and sized at send time. */
  groups?: DeliveryGroupUsed[];
};

export type DeliveryGroupUsed = { id: string; name: string; member_count: number };

export type ResendStatus = {
  api_key_configured: boolean;
  sender_configured: boolean;
  sender: string | null;
  can_attempt_send: boolean;
  domain_verification: "not_checked";
};

export type CreateMeetingInput = {
  meetingUrl: string;
  title?: string;
  botName?: string;
  deliverySettings?: MeetingDeliverySettings;
  tags?: string[];
  knowledgeEnabled?: boolean;
  knowledgeBaseId?: string | null;
  momGuidance?: MomGuidance;
  /** "own": bring my own assistant although a teammate's is already set for this call. */
  coordination?: "own";
};

export type MomGuidance = {
  template: "standard" | "actions" | "client" | "discovery" | "custom";
  instructions: string;
  focus_fields: string[];
};

export type CalendarConnection = {
  id: string; provider: "googlecalendar" | "outlook" | "calendly" | "zoom"; status: string; label: string; identity?: string | null;
  /** Outlook only: a work/school (Microsoft 365) or a personal Microsoft account; null when unknown. */
  account_type?: "work" | "personal" | null;
  /** Meetings with a join link found by the last sync (null: never synced). */
  meetings_found?: number | null;
  last_synced_at?: string | null;
  /** Pending assistants scheduled from this account. */
  scheduled?: number;
  /** Another connection id for the same mailbox (connected twice). */
  same_account_as?: string | null;
};
export type ScheduledOnDisconnect = "keep" | "cancel";
export type CalendarDisconnectResult = { cancelled: number; kept: number };
export type WorkspaceCalendarConnection = CalendarConnection & { user_id: string; user_name: string; user_email: string | null };
export type CalendarPeriod = "today" | "tomorrow" | "this_week" | "next_week";
export type CalendarInvitee = { name: string; email: string | null; response_status: string | null };
export type CalendarEvent = {
  connection_id: string; provider: CalendarConnection["provider"]; event_id: string;
  title: string; starts_at: string; ends_at: string; meeting_url: string; platform: string;
  agenda?: string | null; organizer?: string | null; invitees?: CalendarInvitee[];
};
/** `rescheduled_from`: the start before the first detected move, while the event is at another time now. */
export type CachedCalendarEvent = CalendarEvent & { id: string; synced_at: string; rescheduled_from?: string | null };
export type CalendarSyncState = { connection_id: string; last_synced_at: string; range_start: string; range_end: string; truncated: boolean };
export type CalendarSnapshot = { events: CachedCalendarEvent[]; syncs: CalendarSyncState[]; errors?: Record<string, string> };
export type OrganizationBrief = {
  website: string | null; overview: string; services: string[]; products: string[];
  differentiators: string; positioning: string; updated_at: string | null;
};
export type BriefDocument = { id: string; filename: string; content_type: string; character_count: number; uploaded_at: string };
export type PrepSource = { id: string; title: string; url: string };
export type PrepReport = {
  id: string; calendar_event_id: string; target_company: string | null;
  executive_brief: string; findings: { statement: string; source_ids: string[] }[];
  relevant_offerings: string[]; talking_points: string[]; questions_to_ask: string[];
  watchouts: string[]; people_notes: string[]; sources: PrepSource[];
  public_research_performed: boolean; generated_at: string; provider: string; model: string;
};
export type CalendarSchedule = {
  meeting_id: string; connection_id: string; event_id: string; starts_at: string; ends_at: string;
  provider?: string;
  status: "pending" | "joining" | "joined" | "failed" | "cancelled" | "missed"; last_error: string | null;
  /** The start before the first detected reschedule (only while the join is at another time now). */
  rescheduled_from?: string | null;
  /** When the calendar watcher last confirmed this event with its calendar. */
  last_checked_at?: string | null;
};
/** One detected change to a followed calendar event. Links carry no query string (passcodes stay out). */
export type CalendarEventChange = {
  id: string; kind: "moved" | "cancelled" | "link_changed" | "restored"; provider: string; source: "watcher" | "sync";
  detected_at: string; old_starts_at: string | null; new_starts_at: string | null; old_ends_at: string | null; new_ends_at: string | null;
  old_meeting_url: string | null; new_meeting_url: string | null; meeting_id: string | null; cache_event_id: string | null;
};
export type CalendarChangeHistory = { items: CalendarEventChange[]; provider: string | null; last_checked_at: string | null };

export type MeetingDeliverySettings = {
  internal_recipients: string[];
  participant_recipients: string[];
  send_to_participants: boolean;
  include_transcript: boolean;
  /** Internal teams targeted by reference; expanded to their current members when the recap is sent. */
  internal_group_ids?: string[];
};

/** A workspace member or external address in an internal team. */
export type TeamMember = {
  email: string;
  user_id: string | null;
  display_name: string | null;
  photo_url?: string | null;
  /** False once the account has left the workspace; such entries are skipped when sending. */
  active: boolean;
};

/** An internal team (recipient group) that recaps can target. */
export type Team = {
  id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  member_count: number;
  /** Meetings that currently target this team for their recap. */
  meeting_count: number;
  members: TeamMember[];
};

export type TeamInput = {
  name: string;
  description: string | null;
  members: Array<{ user_id: string } | { email: string }>;
};

export type PostMeetingJob = {
  enabled: boolean;
  attempts: number;
  next_retry_at: string | null;
  last_error: string | null;
  completed_at: string | null;
  exhausted: boolean;
};

export type Capability = "transcription" | "text_generation" | "embeddings";
export type ProfileKind = "transcription" | "mom" | "embedding";
export type ConnectionState = "configured" | "not_configured" | "checking" | "failed";
export type ExecutionLocation = "local" | "cloud";

export type ProviderProfile = {
  id: string;
  kind: ProfileKind;
  label: string;
  provider: string;
  executionLocation: ExecutionLocation;
  endpoint: string;
  model: string;
  capabilities: Capability[];
  connectionState: ConnectionState;
  isDefault: boolean;
  apiKeyConfigured: boolean;
  credentialHint: string | null;
  /** Set when the profile uses a saved workspace key (vault) instead of its own. */
  credentialId?: string | null;
  credentialLabel?: string | null;
};

export type VaultProviderType = "openai" | "openrouter" | "openai_compatible" | "exa" | BillingKeyType;

/** Billing-only saved keys: they read balances and spend, never make model or research calls. */
export type BillingKeyType = "openrouter_management" | "openai_admin" | "exa_service";

/** A saved workspace API key. The secret itself is write-only and never returned. */
export type VaultCredential = {
  id: string;
  label: string;
  provider_type: VaultProviderType;
  base_url: string | null;
  hint: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  used_by_profiles: number;
  used_by_settings: boolean;
  /** True for billing keys (never selectable for model calls or research). */
  billing_only?: boolean;
};

export type BalanceProvider = "openrouter" | "openai" | "exa" | "apollo";
export type BalanceState = "ok" | "low" | "exhausted" | "unknown" | "invalid_key" | "error";

/** Credit status of one saved key, as reported by the provider (or estimated from this app's own ledger). */
export type ProviderBalance = {
  credential_id: string;
  provider: BalanceProvider;
  label: string;
  hint: string;
  balance_usd: number | null;
  limit_usd: number | null;
  remaining_usd: number | null;
  spent_usd: number | null;
  spent_period: "this_month" | "all_time" | null;
  our_tracked_spend_usd: number;
  status: BalanceState;
  source: "provider_api" | "admin_key" | "our_ledger";
  checked_at: string;
  note: string;
  dashboard_url: string;
  /** Apollo only: credits per credit type for the billing cycle (the `dialer` line is minutes). */
  credits?: ApolloCreditLine[];
};

/* ---------- Apollo research source (workspace integration via Composio) ---------- */
export type ApolloCreditLine = { credit_type: string; label: string; used: number | null; limit: number | null; remaining: number | null; unit: "credits" | "minutes" };
/** GET/PUT /v1/workspace/integrations/apollo (owners/admins). The key itself is never returned. */
export type ApolloIntegration = {
  provider: "apollo"; available: boolean; connected: boolean; status: "active" | "invalid" | "out_of_credit" | null;
  hint: string | null; connected_by: string | null; connected_at: string | null; updated_at: string | null;
  last_checked_at: string | null; last_error: string | null; credits: ApolloCreditLine[];
};
export type ApolloCompany = {
  apollo_id: string | null; name: string | null; domain: string | null; website: string | null; linkedin_url: string | null;
  description: string | null; industry: string | null; employee_count: number | null; revenue_band: string | null;
  total_funding: string | null; latest_funding_stage: string | null; latest_funding_date: string | null; latest_funding_amount: string | null;
  headquarters: string | null; founded_year: number | null; tech_stack: string[]; source_id: string | null;
};
export type ApolloRole = { company: string | null; title: string | null; start_date: string | null; end_date: string | null; current: boolean };
export type ApolloPerson = {
  name: string; title: string | null; seniority: string | null; departments: string[]; company: string | null;
  role_started: string | null; past_roles: ApolloRole[]; linkedin_url: string | null; location: string | null;
  matched_by: "email" | "name"; source_id: string | null;
};
export type ApolloSnapshot = {
  company: ApolloCompany | null; people: ApolloPerson[];
  news: { title: string; url: string | null; published_at: string | null; snippet: string | null; source_id: string | null }[];
  hiring: { open_roles: number; themes: { theme: string; count: number }[]; examples: { title: string; url: string | null; location: string | null; posted_at: string | null }[]; source_id: string | null } | null;
  relationship: { account_name: string | null; stage: string | null; owner: string | null; last_activity_at: string | null; contacts: { name: string; title: string | null; stage: string | null; last_activity_at: string | null }[]; source_id: string | null } | null;
  calls: number; cached_results: number; notice: string | null; fetched_at: string | null;
};

export type BillingKeyInfo = {
  provider_type: BillingKeyType;
  provider: BalanceProvider;
  configured: boolean;
  credential_id: string | null;
  label: string | null;
  hint: string | null;
  unlocks: string;
};

export type BalanceOverview = {
  items: ProviderBalance[];
  billing_keys: BillingKeyInfo[];
  low_balance_threshold_usd: number;
  checked_at: string | null;
};

export type VaultCredentialInput = { label: string; provider_type: VaultProviderType; secret: string; base_url?: string | null };

export type CredentialTestResult = {
  credential_id: string;
  status: "valid" | "invalid" | "unverified";
  network_call_performed: boolean;
  message: string;
};

export type AiRouteView = {
  profile_id: string | null;
  profile_name: string | null;
  provider: string | null;
  model: string | null;
  source: "workspace_settings" | "workspace_default" | "not_configured";
};

/** Owner-controlled workspace AI settings; ids are null for non-owners (can_edit false). */
export type AiSettingsView = {
  can_edit: boolean;
  chat_profile_id: string | null;
  chat_model: string | null;
  vision_profile_id: string | null;
  vision_model: string | null;
  research_credential_id: string | null;
  research_credential_label: string | null;
  research_profile_id: string | null;
  research_model: string | null;
  updated_at: string | null;
  updated_by: string | null;
  vision_configured: boolean;
  research_configured: boolean;
  effective_chat: AiRouteView;
  /** Owner only: what "Automatic" vision resolves to from the default LLM right now. */
  automatic_vision?: AiRouteView | null;
};

/** Full replacement for PUT /v1/ai/settings: send every field; null clears it. */
export type AiSettingsInput = {
  chat_profile_id: string | null;
  chat_model: string | null;
  vision_profile_id: string | null;
  vision_model: string | null;
  research_credential_id: string | null;
  research_profile_id: string | null;
  research_model: string | null;
};

/** How a profile save treats its key: link a saved key, unlink (null), or also save a pasted key to the vault. */
export type ProfileKeyChoice = { credentialId?: string | null; saveToVaultLabel?: string };

/* ---------- Meeting prep v2 (report_version 2, Exa research) ---------- */
export type PrepSourceOrigin = "web" | "provided_link" | "our_documents" | "prep_upload" | "organization_brief" | "apollo";
export type PrepSourceV2 = { id: string; title: string; url: string | null; publisher: string | null; published_date: string | null; origin: PrepSourceOrigin };
export type PrepCitedClaim = { statement: string; source_ids: string[] };
export type PrepPersona = "technical" | "business" | "sales" | "executive" | "unknown";
export type PrepMatchConfidence = "confirmed" | "likely" | "unconfirmed";
export type PrepDevelopmentType = "deal" | "mou" | "partnership" | "funding" | "product" | "hiring" | "news";
export type PrepUsageTotals = { exa_calls: number; llm_calls: number; input_tokens: number; output_tokens: number; estimated_usd: number; unpriced_calls: number; apollo_calls?: number };
export type PrepAttendee = {
  name: string; email: string | null; title: string | null; linkedin_url: string | null; match_confidence: PrepMatchConfidence;
  background: string; likely_interests: string[]; persona: PrepPersona; angle: string; source_ids: string[];
  /** Set by the API's who's-who resolver (older reports omit it). */
  side?: Exclude<PartySide, "ours"> | null;
  /** Verified work profile from Apollo, when the workspace has Apollo connected. */
  apollo?: ApolloPerson | null;
};
/* Who's who: our company vs. the target, and which side each attendee is on. */
export type PartySide = "ours" | "theirs" | "other_external" | "unknown";
export type PartyCompany = { name: string | null; aliases: string[]; domains: string[]; website: string | null; source: "identity" | "workspace" | "inputs" | "email_domain" | "event_title" | "none" | string; reason: string };
export type PartyPerson = { key: string; name: string; email: string | null; side: PartySide; reason: string; overridden: boolean };
export type PartyWarning = { code: "target_is_us" | "no_target" | "identity_missing"; message: string };
export type WhosWho = { our_company: PartyCompany; target: PartyCompany; attendees: PartyPerson[]; ignored: string[]; warnings: PartyWarning[] };
/** Organizer corrections: attendee key (lowercased email or `name:<words>`) → side. */
export type AttendeeSides = Record<string, "ours" | "theirs">;
export type WhosWhoInput = { target_company: string | null; company_website: string | null; attendee_sides: AttendeeSides };
/** GET/PUT /v1/workspace/identity — who WE are, so prep never mistakes us for the client. */
export type OrganizationIdentity = {
  company_name: string | null; aliases: string[]; domains: string[]; configured: boolean; can_edit: boolean; updated_at: string | null;
  suggestions: { company_name: string | null; domains: string[] };
};
export type OrganizationIdentityInput = { company_name: string | null; aliases: string[]; domains: string[] };
export type PrepReportV2 = {
  report_version: 2; id: string; calendar_event_id: string; target_company: string | null; company_website: string | null;
  executive_brief: string;
  company: { name: string | null; website: string | null; what_they_do: string; industry: string; size_signals: string; headquarters: string; source_ids: string[] };
  recent_developments: { title: string; date: string | null; type: PrepDevelopmentType; summary: string; source_ids: string[] }[];
  ai_landscape: { summary: string; initiatives: PrepCitedClaim[]; vendors: PrepCitedClaim[]; end_clients: PrepCitedClaim[]; source_ids: string[] };
  alignment: { fit_summary: string; relevant_services: { service: string; why: string; talking_point: string; source_ids: string[] }[] };
  attendees: PrepAttendee[];
  meeting_narrative: { recommended_focus: string; by_persona: { persona: PrepPersona; focus: string }[]; opening: string; agenda_suggestions: string[] };
  talking_points: string[]; questions_to_ask: string[]; watchouts: string[];
  sources: PrepSourceV2[]; public_research_performed: boolean;
  research_steps: { stage: string; purpose: string; query: string | null; category: string | null; results: number; status: "succeeded" | "failed" | "skipped"; note?: string | null }[];
  usage: PrepUsageTotals; started_at: string | null; generated_at: string; provider: string; model: string;
  findings: PrepCitedClaim[]; relevant_offerings: string[]; people_notes: string[];
  whos_who?: WhosWho | null;
  /** Structured Apollo facts (older reports and workspaces without Apollo omit it). */
  apollo?: ApolloSnapshot | null;
};
/** GET /prep returns either shape; v1 rows have no report_version. */
export type AnyPrepReport = PrepReport | PrepReportV2;
export type PrepInputs = { target_company: string | null; company_website: string | null; links: string[]; notes: string; updated_at?: string | null };
export type PrepHistoryItem = { id: string; report_version: number; target_company: string | null; generated_at: string; provider: string; model: string; public_research_performed: boolean; usage: PrepUsageTotals };
export type PrepHistory = { calendar_event_id: string; items: PrepHistoryItem[]; totals: PrepUsageTotals };
export type PrepStage = "queued" | "planning" | "searching" | "reading" | "writing" | "done";
export type PrepGenerateInput = { context: string; target_company: string | null; company_website: string | null; profile_urls: string[]; text_profile_id: string | null; research_enabled: boolean; attendee_sides?: AttendeeSides; apollo_refresh?: boolean };
/** A document uploaded for one meeting's prep (POST /v1/documents, scope=prep). */
export type PrepDocument = {
  id: string; scope: string; scope_id: string | null; filename: string; content_type: string; source_url: string | null;
  size_bytes: number; page_count: number | null; ocr_page_count: number; status: "pending" | "processing" | "indexed" | "failed" | string;
  error: string | null; summary: string | null; chunk_count: number; character_count: number; created_at: string;
};

/* ---------- Usage & cost transparency (GET /v1/workspace/usage*, admin + owner) ---------- */
export type UsageGroupTotal = { name: string; requests: number; input_tokens: number; output_tokens: number; estimated_usd: number; unpriced_requests: number };
export type UsageModelTotal = UsageGroupTotal & { kind: string; provider: string; model: string; units: number; unit_type: string | null; failed_requests: number };
export type PrepUsageSummary = { sessions: number; events_prepared: number; briefings_generated: number; requests: number; input_tokens: number; output_tokens: number; estimated_usd: number; unpriced_requests: number; searches: number };
export type TranscriptionUsageSummary = { meetings: number; audio_seconds: number; estimated_usd: number; unpriced: number };
/** The richer summary; every addition is optional so an older API still renders. */
export type UsageSummaryDetail = UsageSummary & {
  by_kind?: UsageGroupTotal[];
  by_model?: UsageModelTotal[];
  prep?: PrepUsageSummary;
  transcription?: TranscriptionUsageSummary;
  failed_requests?: number;
  since?: string | null;
  until?: string | null;
};
export type UsageRange = { since: string | null; until: string | null };
export type UsageEventFilters = UsageRange & { kind?: string; purpose?: string; provider?: string; model?: string; status?: string; meeting_id?: string; q?: string };
export type UsageEvent = {
  id: string; created_at: string; kind: string; purpose: string; provider: string; model: string;
  input_tokens: number | null; output_tokens: number | null; units: number | null; unit_type: string | null;
  estimated_usd: number | null; price_source: string | null; duration_ms: number | null; status: string;
  meeting_id: string | null; meeting_title: string | null; knowledge_base_id: string | null; knowledge_base_name: string | null;
  prep_event_id: string | null; prep_event_title: string | null; actor_user_id: string | null; actor_display_name: string | null;
  details: Record<string, unknown>;
};
export type UsageEventPage = { items: UsageEvent[]; next_cursor: string | null; total: number };

/* ---------- Workspace storage (GET/POST /v1/workspace/storage*, admin + owner) ---------- */
export type StorageCategoryKey = "meetings" | "meeting_preps" | "documents" | "search_index" | "knowledge_bases" | "ai_chats" | "calendar_cache" | "logs";
export type StorageCategory = { key: StorageCategoryKey | "workspace"; label: string; description: string; rows: number; bytes: number; purgeable: boolean; tables: Array<{ name: string; rows: number; bytes: number }> };
export type CaptureStorage = { status: "not_requested" | "measured" | "partial" | "unavailable" | "not_configured"; recording_bytes: number | null; recordings: number; meetings_checked: number; meetings_with_capture: number; note: string };
export type StorageSummary = {
  organization_id: string; measured_at: string; total_bytes: number; total_rows: number; categories: StorageCategory[];
  database: { dialect: string; size_bytes: number | null; note: string }; capture: CaptureStorage; method: string;
};
export type StorageItem = { id: string; label: string; created_at: string | null; bytes: number; rows: number; detail: string | null };
export type StoragePurgeRequest = { category: StorageCategoryKey; ids?: string[]; older_than_days?: number; reindex?: boolean; confirm: "DELETE" };
export type StoragePurgeResult = {
  category: StorageCategoryKey; deleted: Record<string, number>; skipped: Array<{ id: string; reason: string }>; remaining: number;
  reindex_queued: number; kept: Record<string, number>; bytes_before: number; bytes_after: number; bytes_freed_estimate: number;
};

/* ---------- Model catalog (GET /v1/model-catalog) ---------- */
export type CatalogCapability = "text_generation" | "transcription" | "embeddings" | "vision";
export type CatalogProviderType = "openai" | "openrouter" | "openai_compatible";
export type CatalogModel = {
  id: string;
  name: string;
  vendor: string | null;
  input_per_million_usd: number | null;
  output_per_million_usd: number | null;
  usd_per_minute: number | null;
  context_length: number | null;
  accepts_images: boolean | null;
};
export type ModelCatalog = {
  provider: CatalogProviderType;
  capability: CatalogCapability;
  live_catalog: boolean;
  fetched_at: string;
  note: string | null;
  models: CatalogModel[];
};
/** Where to list models: a saved profile, a saved key, or a provider (+ endpoint for compatible servers). */
export type ModelCatalogQuery = {
  capability: CatalogCapability;
  provider?: CatalogProviderType;
  profileId?: string;
  credentialId?: string;
  baseUrl?: string;
};

/* ---------- Notification center and background jobs ---------- */
export type NotificationSeverity = "info" | "success" | "warning" | "danger";
/** Where a notification leads: a shell view plus an optional record id (meeting, calendar event, knowledge base). */
export type NotificationLinkView = "meeting" | "prep" | "knowledge" | "workspace" | "calendar" | "meetings" | string;
export type AppNotification = {
  id: string;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  link_view: NotificationLinkView | null;
  link_id: string | null;
  meeting_id: string | null;
  created_at: string;
  read_at: string | null;
};
export type NotificationPage = { items: AppNotification[]; next_cursor: string | null; unread_count: number };
export type BackgroundJobKind = "prep_briefing" | "minutes_draft" | "knowledge_reindex" | string;
export type BackgroundJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type BackgroundJob = {
  id: string;
  kind: BackgroundJobKind;
  subject_id: string | null;
  status: BackgroundJobStatus;
  stage: string | null;
  message: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  user_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

/** Personal time zone and clock (`/v1/me/preferences`). `timezone` is the effective IANA zone. */
export type TimePreferencesPayload = {
  timezone: string;
  timezone_source: "browser" | "manual";
  detected_timezone: string | null;
  time_format: "auto" | "12h" | "24h";
};

/** When the assistant leaves a call (`/v1/workspace/leave-policy`). Minutes, except `max_hours`. */
export type LeavePolicyValues = {
  silence_minutes: number;
  quiet_after_end_minutes: number;
  no_one_joined_minutes: number;
  max_hours: number;
};

export type LeavePolicy = LeavePolicyValues & {
  /** The meeting-bot service ends every call after this many hours, whatever `max_hours` says. */
  service_max_hours: number;
  /** The safety cap in force: min(max_hours, service_max_hours). */
  effective_max_hours: number;
  configured: boolean;
  can_edit: boolean;
  updated_at: string | null;
  defaults: LeavePolicyValues;
  limits: Record<keyof LeavePolicyValues, [number, number]>;
};

export type LeaveReason =
  | "ended_quiet_after_schedule" | "silent" | "no_one_joined" | "everyone_left" | "time_limit"
  | "host_ended" | "user_stopped" | "not_admitted" | "capture_ended" | "capture_failed" | "bot_lost";

/** A meeting's planned automatic leave (while in a call) or why it ended (`/v1/meetings/{id}/leave`). */
export type MeetingLeave = {
  meeting_id: string;
  in_call: boolean;
  policy: LeavePolicyValues;
  effective_max_hours: number;
  service_max_hours: number;
  /** True when the meeting-bot service's limit (not the workspace setting) sets the safety cap. */
  cap_is_service_limit: boolean;
  joined_at: string | null;
  scheduled_end: string | null;
  last_speech_at: string | null;
  safety_cap_at: string | null;
  keep_until: string | null;
  /** Owners/admins can make it leave; `can_keep` is false once keeping can't help (near the safety cap). */
  can_manage: boolean;
  can_keep: boolean;
  next_leave: { leave_at: string; reason: LeaveReason; quiet_since: string | null; heads_up_sent: boolean } | null;
  ended: { reason: LeaveReason; ended_by: "auto" | "user" | "host" | "vexa" | null; ended_at: string | null; quiet_since: string | null } | null;
  last_error: string | null;
};
