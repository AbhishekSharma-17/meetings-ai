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
