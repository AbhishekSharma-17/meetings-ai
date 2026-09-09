export type MeetingStatus = "live" | "ready" | "processing";

export type Meeting = {
  id: string;
  title: string;
  startsAt: string;
  duration: string;
  participants: number;
  status: MeetingStatus;
  platform: "Google Meet" | "Zoom" | "Microsoft Teams";
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
