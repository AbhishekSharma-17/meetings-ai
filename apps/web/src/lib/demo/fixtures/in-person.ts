import type { InPersonSession, SpeakerNameEvidence } from "../../in-person-types";
import { type Clock, baseId, localTime, meetingId } from "./ids";
import type { MeetingSeed } from "./meetings";
import { OWNER_ID } from "./people";
import type { BackendSegment } from "./transcript-kit";

export const IN_PERSON_DEMO_ID = meetingId(11);
const WORDS_PER_SECOND = 2.6;

export type ScriptLine = readonly [label: string, text: string];
export type DemoSuggestion = { name: string; confidence: "high" | "medium" | "low"; reason: string; evidence: SpeakerNameEvidence[] };

/** The finished sample: a face-to-face workshop recorded on the owner's phone. */
const WORKSHOP: ScriptLine[] = [
  ["Speaker A", "Thanks for hosting us, everyone. I'm Alex from Northwind Labs, and I'll keep notes today."],
  ["Speaker B", "Welcome to Rotterdam, Alex. Chen and I want to walk you through the yard trucks first."],
  ["Speaker C", "The maintenance crew mostly works in Dutch, so the assistant has to answer in Dutch too."],
  ["Speaker A", "Understood, Chen. Let's agree that the pilot includes Dutch answers from day one."],
  ["Speaker B", "Agreed. I'll send the manual index for the three truck models by Friday."],
  ["Speaker C", "Can we test it on the night shift? That's where the questions pile up."],
  ["Speaker A", "Yes. I'll draft a night-shift test plan and share it with Asha next week."],
  ["Speaker B", "Great. Let's review the results together on the next site visit."],
];

/** What a new demo recording "hears": captions while recording, then the transcript. */
export const RECORDING_SCRIPT: ScriptLine[] = [
  ["Speaker A", "Okay, we're recording. I'm Alex, and this is a short sample of an in-person meeting."],
  ["Speaker B", "Thanks, Alex. Should we go through the proposal timeline first?"],
  ["Speaker A", "Yes. Let's agree the proposal goes out on Friday with a two-week pilot option."],
  ["Speaker B", "I'll draft the pilot section and send it to you by Thursday."],
  ["Speaker A", "Great. Who should review the pricing before it goes out?"],
  ["Speaker B", "Marcus should. I'll ask him to check the pricing table on Thursday."],
  ["Speaker A", "Perfect. When I stop, the transcript and speaker suggestions appear in a few seconds."],
];

/** Backend-shaped turns with raw "Speaker A/B/C" labels (no names until someone approves them). */
export function scriptSegments(key: string, lines: readonly ScriptLine[], gap = 2): BackendSegment[] {
  let clock = 2;
  return lines.map(([label, text], index) => {
    const duration = Math.max(3, Math.round(text.split(/\s+/).length / WORDS_PER_SECOND));
    const start = clock;
    clock = start + duration + gap;
    return { segment_id: `${key}:${index + 1}`, speaker: label, raw_speaker: label, speaker_reviewed: false, attribution_source: null, text, start_seconds: start, end_seconds: start + duration, completed: true };
  });
}

const at = (segments: BackendSegment[], line: number) => segments[line - 1]?.start_seconds ?? 0;

export function workshopSuggestions(segments: BackendSegment[]): Record<string, DemoSuggestion> {
  return {
    "Speaker A": { name: "Alex Morgan", confidence: "high", reason: "Introduced themselves as Alex, and others called them Alex.", evidence: [
      { quote: "I'm Alex from Northwind Labs", at_seconds: at(segments, 1), kind: "self_introduction" },
      { quote: "Welcome to Rotterdam, Alex.", at_seconds: at(segments, 2), kind: "addressed" },
    ] },
    "Speaker B": { name: "Asha Patel", confidence: "medium", reason: "Speaker A mentions sharing the plan with Asha, and Asha Patel was expected.", evidence: [
      { quote: "share it with Asha next week", at_seconds: at(segments, 7), kind: "addressed" },
      { quote: "Asha Patel", at_seconds: at(segments, 2), kind: "expected_person" },
    ] },
    "Speaker C": { name: "Chen Li", confidence: "medium", reason: "Speaker A answered them with “Understood, Chen”.", evidence: [
      { quote: "Understood, Chen.", at_seconds: at(segments, 4), kind: "addressed" },
    ] },
  };
}

/** Suggestions for a new demo recording: the owner, and the first expected person (or a teammate). */
export function recordingSuggestions(segments: BackendSegment[], ownerName: string, expected: string[]): Record<string, DemoSuggestion> {
  const other = expected.find((name) => name.trim() && !ownerName.startsWith(name.trim().split(/\s+/)[0]));
  return {
    "Speaker A": { name: ownerName, confidence: "high", reason: "Introduced themselves as Alex, and Speaker B called them Alex.", evidence: [
      { quote: "I'm Alex", at_seconds: at(segments, 1), kind: "self_introduction" },
      { quote: "Thanks, Alex.", at_seconds: at(segments, 2), kind: "addressed" },
    ] },
    "Speaker B": other
      ? { name: other, confidence: "low", reason: `${other} was on the expected list; nobody said their name.`, evidence: [{ quote: other, at_seconds: at(segments, 2), kind: "expected_person" }] }
      : { name: "Priya Shah", confidence: "low", reason: "Offers to draft the pilot section, which Priya usually owns. Check before approving.", evidence: [{ quote: "I'll draft the pilot section", at_seconds: at(segments, 4), kind: "addressed" }] },
  };
}

export function workshopSeed(clock: Clock): MeetingSeed {
  const segments = scriptSegments("acme-onsite", WORKSHOP, 4);
  const started = localTime(clock, -1, 10, 30);
  const minutes = 26;
  const stopped = new Date(started.getTime() + minutes * 60_000);
  return {
    key: "acme-onsite", live: false, invitees: [], minutes: null, draftFailed: false, fromCalendar: false,
    organizer: "alex.morgan@northwindlabs.example", agenda: "On-site walkthrough of the Rotterdam yard trucks and the Dutch-language pilot.",
    segments,
    meeting: {
      id: IN_PERSON_DEMO_ID, title: "Acme Robotics — on-site workshop in Rotterdam", meeting_url: "", platform: "in_person", status: "completed", bot_name: "Meetings AI",
      created_at: started.toISOString(), updated_at: stopped.toISOString(), joined_at: started.toISOString(), stopped_at: stopped.toISOString(), duration: `${minutes} min`,
      participant_count: 3, error_message: null, tags: ["acme", "on-site", "fieldguide"], knowledge_enabled: true, knowledge_base_id: baseId(1),
    },
  };
}

export function sessionRecord(seed: MeetingSeed, patch: Partial<InPersonSession> & Pick<InPersonSession, "status">): InPersonSession {
  const meeting = seed.meeting;
  return {
    meeting_id: meeting.id, title: meeting.title, device: "phone", recorded_by: { user_id: OWNER_ID, display_name: "Alex Morgan" }, is_recorder: true,
    consent: { everyone_agreed: true, notice_shown: true, agreed_at: meeting.joined_at ?? meeting.created_at },
    mime_type: "audio/webm", started_at: meeting.joined_at ?? meeting.created_at, stopped_at: meeting.stopped_at,
    last_seq: -1, received_chunks: 0, duration_ms: 0, total_bytes: 0, captions: [], moments: [], finalize: null, speaker_labels: null, error: null,
    limits: { max_chunk_bytes: 8_000_000, max_total_bytes: 600_000_000, max_duration_ms: 4 * 3_600_000, chunk_ms: 15_000 },
    ...patch,
  };
}
