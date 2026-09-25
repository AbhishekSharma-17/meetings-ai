export type MeetingStatus = "created" | "joining" | "waiting_room" | "live" | "needs_attention" | "stopping" | "processing" | "ready" | "stopped" | "failed";

export type Meeting = {
  id: string;
  title: string;
  startsAt: string;
  duration: string;
  participants: number;
  status: MeetingStatus;
  platform: "Google Meet" | "Zoom" | "Microsoft Teams";
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
};

export type WorkspaceMember = {
  user_id: string;
  display_name: string;
  email: string | null;
  role: "owner" | "admin" | "member" | "viewer";
  status: string;
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
  active_captures: number;
  failed_captures: number;
  failed_mom_jobs: number;
  pending_index_jobs: number;
  failed_index_jobs: number;
  failed_email_deliveries: number;
  latest_audit_at: string | null;
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
};

export type InviteResult = {
  account: CurrentAccount;
  temporary_password: string | null;
  note: string;
};

export type KnowledgeSource = {
  source_id: string;
  kind: "transcript" | "question" | "action" | "contribution";
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
};

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
};

export type CalendarConnection = { id: string; provider: "googlecalendar" | "outlook"; status: string; label: string };
export type CalendarPeriod = "today" | "tomorrow" | "this_week" | "next_week";
export type CalendarEvent = {
  connection_id: string; provider: CalendarConnection["provider"]; event_id: string;
  title: string; starts_at: string; ends_at: string; meeting_url: string; platform: string;
};
export type CalendarSchedule = {
  meeting_id: string; connection_id: string; event_id: string; starts_at: string; ends_at: string;
  status: "pending" | "joining" | "joined" | "failed" | "cancelled" | "missed"; last_error: string | null;
};

export type MeetingDeliverySettings = {
  internal_recipients: string[];
  participant_recipients: string[];
  send_to_participants: boolean;
  include_transcript: boolean;
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
};
