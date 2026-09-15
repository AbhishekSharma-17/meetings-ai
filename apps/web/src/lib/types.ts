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
};

export type TranscriptSegment = {
  id: string;
  speaker: string;
  startedAt: string | number | null;
  endedAt: string | number | null;
  text: string;
  isFinal: boolean;
};

export type MinutesStatus = "draft" | "approved" | "sent";

export type ActionItem = {
  description: string;
  owner: string | null;
  due_date: string | null;
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
  provider_profile_id: string | null;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  sent_at: string | null;
  last_error: string | null;
};

export type MinutesDraft = Pick<MeetingMinutes, "title" | "executive_summary" | "discussion_points" | "decisions" | "action_items" | "open_questions">;

export type EmailDelivery = {
  id: string;
  meeting_id: string;
  recipients: string[];
  status: "sent" | "failed";
  provider_message_id: string | null;
  error: string | null;
  created_at: string;
};

export type CreateMeetingInput = {
  meetingUrl: string;
  title?: string;
  botName?: string;
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
};
