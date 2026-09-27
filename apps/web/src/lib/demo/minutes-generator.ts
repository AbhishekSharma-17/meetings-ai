import type { MeetingMinutes, MinutesDraft } from "../types";
import type { MeetingSeed } from "./fixtures/meetings";
import { minutesContent } from "./fixtures/minutes-content";
import type { BackendSegment, Line } from "./fixtures/transcript-kit";

/** Minutes for any sample meeting: curated content when it exists, otherwise drafted from the transcript. */
export function draftMinutes(seed: MeetingSeed, segments: BackendSegment[]): MinutesDraft {
  const curated = seed.key === "acme-security" ? "security" : seed.minutes?.key;
  if (curated) {
    const formatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
    return minutesContent(curated, (days) => formatter.format(new Date(Date.now() + days * 86_400_000)));
  }
  const spoken = segments.filter((segment) => segment.speaker !== "Meetings AI");
  const pick = (pattern: RegExp, limit: number) => spoken.filter((segment) => pattern.test(segment.text)).slice(0, limit);
  const sentence = (text: string) => text.replace(/^(so|okay|ok|yes|great|good)[,.]?\s+/i, "").replace(/\s+/g, " ").trim();
  const decisions = pick(/\b(let's|we'll keep|agree|decid|propose|commit)\b/i, 3);
  const actions = pick(/\b(I'll|I will|I can|we'll send|will do)\b/i, 4);
  const questions = spoken.filter((segment) => segment.text.trim().endsWith("?")).slice(0, 3);
  const speakers = Array.from(new Set(spoken.map((segment) => segment.speaker).filter((name): name is string => Boolean(name))));
  return {
    title: seed.meeting.title,
    executive_summary: `${speakers.slice(0, 4).join(", ")} discussed ${seed.meeting.tags.slice(0, 3).join(", ") || "the agenda"}. ${decisions[0] ? sentence(decisions[0].text) : "No firm decisions were recorded."} This draft was generated from ${spoken.length} transcript turns; review every field before approval.`,
    discussion_points: spoken.slice(1, 5).map((segment) => sentence(segment.text)).map((text) => text.length > 160 ? `${text.slice(0, 157)}…` : text),
    decisions: decisions.map((segment) => sentence(segment.text)),
    action_items: actions.map((segment) => ({ description: sentence(segment.text).replace(/^I('ll| will| can)\s+/i, "").replace(/^./, (first) => first.toUpperCase()), owner: segment.speaker, due_date: null, evidence_segment_ids: [segment.segment_id] })),
    open_questions: questions.map((segment) => segment.text),
    speaker_contributions: speakers.slice(0, 4).map((speaker) => {
      const turns = spoken.filter((segment) => segment.speaker === speaker);
      return { speaker, summary: `Spoke ${turns.length} times; opened with: “${turns[0].text.slice(0, 90)}${turns[0].text.length > 90 ? "…" : ""}”`, evidence_segment_ids: turns.slice(0, 2).map((segment) => segment.segment_id) };
    }),
    questions_asked: questions.map((segment) => ({ speaker: segment.speaker, question: segment.text, evidence_segment_ids: [segment.segment_id] })),
  };
}

export function asMinutes(seed: MeetingSeed, draft: MinutesDraft, status: MeetingMinutes["status"] = "draft"): MeetingMinutes {
  const now = new Date().toISOString();
  return { meeting_id: seed.meeting.id, status, ...draft, provider_profile_id: null, provider: "openrouter", model: "openai/gpt-6-sol", created_at: now, updated_at: now, approved_at: null, sent_at: null, last_error: null };
}

/** A short generic call used when the visitor sends the assistant to a new meeting. */
export const SAMPLE_CALL: Line[] = [
  ["Meetings AI", "Meetings AI has joined and will record and transcribe this conversation."],
  ["Alex Morgan", "Thanks for joining. This is a short sample call so you can see live transcription in the demo."],
  ["Priya Shah", "Happy to help. Should we agree the next steps for the proposal while we're here?"],
  ["Alex Morgan", "Yes. Let's agree that the proposal goes out on Friday with a two-week pilot option."],
  ["Priya Shah", "I'll draft the pilot section and send it to you by Thursday afternoon."],
  ["Alex Morgan", "Great. Who should review the pricing before it goes out?"],
  ["Priya Shah", "Marcus should. I'll ask him to review the pricing table on Thursday."],
  ["Alex Morgan", "Perfect. When you stop the assistant, draft minutes appear for review in a few seconds."],
];
