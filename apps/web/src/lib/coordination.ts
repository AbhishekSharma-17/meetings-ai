import { api } from "./meetings-service";
import type { MeetingMinutes } from "./types";

/**
 * Call coordination: several teammates set an assistant for the same call.
 * Only names and the fact that a teammate's assistant is set for the same link are shared;
 * other people's calendars are only ever a count.
 */
export type AssistantState = "scheduled" | "joining" | "in_call" | "ended" | "idle";
export type CoverageRole = "owner" | "sharing";

export type CoordinationPerson = { user_id: string; display_name: string; is_you: boolean };

export type TeammateAssistant = {
  meeting_id: string;
  owner: CoordinationPerson | null;
  starts_at: string;
  state: AssistantState;
  covering: CoordinationPerson[];
  kept_own: boolean;
  can_open: boolean;
};

export type CallCheck = {
  supported: boolean;
  platform: string | null;
  assistants: TeammateAssistant[];
  your_assistants: TeammateAssistant[];
  teammates_on_calendar: number;
};

export type MeetingCoordination = {
  meeting_id: string;
  state: AssistantState;
  starts_at: string;
  owner: CoordinationPerson | null;
  covering: CoordinationPerson[];
  your_role: CoverageRole | null;
  receive_recap: boolean;
  kept_own: boolean;
  handed_to: TeammateAssistant | null;
  other_assistants: TeammateAssistant[];
  teammates_on_calendar: number;
  can_share: boolean;
  can_stop_sharing: boolean;
  can_manage: boolean;
};

export type CalendarCoordination = {
  event_id: string;
  assistants: TeammateAssistant[];
  your_role: CoverageRole | null;
  your_meeting_id: string | null;
  shared_from: CoordinationPerson | null;
  teammates_on_calendar: number;
};

export type CoverageSummary = {
  meeting_id: string;
  owner: CoordinationPerson | null;
  covering: CoordinationPerson[];
  your_role: CoverageRole | null;
  kept_own: boolean;
  handed_to_owner: CoordinationPerson | null;
  other_assistants: number;
};

function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export const coordinationService = {
  /** Before scheduling or sending: teammates' assistants already set for this call. */
  async check(meetingUrl: string, startsAt?: string | null, endsAt?: string | null): Promise<CallCheck> {
    return api<CallCheck>("/v1/call-coordination/check", {
      method: "POST",
      body: JSON.stringify({ meeting_url: meetingUrl, ...(startsAt ? { starts_at: startsAt } : {}), ...(endsAt ? { ends_at: endsAt } : {}) }),
    });
  },
  async forMeeting(meetingId: string): Promise<MeetingCoordination> {
    return api<MeetingCoordination>(`/v1/meetings/${meetingId}/coordination`);
  },
  async share(meetingId: string, receiveRecap: boolean): Promise<MeetingCoordination> {
    return api<MeetingCoordination>(`/v1/meetings/${meetingId}/coverage`, { method: "POST", body: JSON.stringify({ receive_recap: receiveRecap }) });
  },
  async stopSharing(meetingId: string): Promise<MeetingCoordination> {
    return api<MeetingCoordination>(`/v1/meetings/${meetingId}/coverage`, { method: "DELETE" });
  },
  async forCalendar(start: string, end: string): Promise<CalendarCoordination[]> {
    return asList<CalendarCoordination>(await api<unknown>(`/v1/call-coordination/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`));
  },
  async summaries(): Promise<CoverageSummary[]> {
    return asList<CoverageSummary>(await api<unknown>("/v1/call-coordination/meetings"));
  },
  /** Approved or sent minutes for someone the meeting covers; null while they are still a draft. */
  async sharedMinutes(meetingId: string): Promise<MeetingMinutes | null> {
    try { return await api<MeetingMinutes>(`/v1/meetings/${meetingId}/coverage/minutes`); }
    catch (cause) { if ((cause as { status?: number }).status === 404) return null; throw cause; }
  },
};

/** "Asha Patel" → "Asha"; the first name reads naturally in buttons. */
export function firstName(person: CoordinationPerson | null | undefined): string {
  if (!person) return "A teammate";
  if (person.is_you) return "You";
  return person.display_name.split(/\s+/)[0] || person.display_name;
}

export function possessive(name: string): string {
  if (name === "You") return "Your";
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

/** "you, Ben Ortiz" — the people an assistant also covers. */
export function coveringList(people: CoordinationPerson[]): string {
  return people.map((person) => person.is_you ? "you" : person.display_name).join(", ");
}

export const ONE_AT_A_TIME = "Only one assistant can be in a call at a time. Whichever joins first records it; the other stands down and its owner gets those notes automatically.";
