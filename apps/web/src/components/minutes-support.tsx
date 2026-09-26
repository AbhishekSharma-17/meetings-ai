"use client";

import { X } from "lucide-react";
import type { ActionItem, AttributedQuestion, MeetingMinutes, MinutesDraft, SpeakerContribution, TranscriptSegment } from "@/lib/types";
import { UiSelect } from "./ui-select";

export type EditableDraft = {
  title: string;
  summary: string;
  discussion: string;
  decisions: string;
  actions: ActionItem[];
  questions: string;
  contributions: SpeakerContribution[];
  questionsAsked: AttributedQuestion[];
};

const EVIDENCE_PREVIEW_LENGTH = 80;

export function readableText(value: string): string {
  return value.replace(/\[[^\]]*csrc-[^\]]+\]/g, "").replace(/csrc-[A-Za-z0-9:._-]+/g, "transcript source").replace(/\s{2,}/g, " ").trim();
}

export function toEditable(minutes: MeetingMinutes): EditableDraft {
  return {
    title: readableText(minutes.title),
    summary: readableText(minutes.executive_summary),
    discussion: minutes.discussion_points.map(readableText).join("\n"),
    decisions: minutes.decisions.map(readableText).join("\n"),
    actions: minutes.action_items.map((item) => ({ ...item, description: readableText(item.description) })),
    questions: minutes.open_questions.map(readableText).join("\n"),
    contributions: (minutes.speaker_contributions ?? []).map((item) => ({ ...item, summary: readableText(item.summary) })),
    questionsAsked: (minutes.questions_asked ?? []).map((item) => ({ ...item, question: readableText(item.question) })),
  };
}

export function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function toPayload(draft: EditableDraft): MinutesDraft {
  return {
    title: draft.title.trim(),
    executive_summary: draft.summary.trim(),
    discussion_points: lines(draft.discussion),
    decisions: lines(draft.decisions),
    action_items: draft.actions.filter((item) => item.description.trim()).map((item) => ({ ...item, description: item.description.trim(), owner: item.owner?.trim() || null, due_date: item.due_date?.trim() || null })),
    open_questions: lines(draft.questions),
    speaker_contributions: draft.contributions,
    questions_asked: draft.questionsAsked,
  };
}

export function evidenceTime(id: string, segments: TranscriptSegment[]): string {
  const segment = segments.find((item) => item.segmentId === id);
  const first = segments.find((item) => item.startedAt !== null);
  if (!segment || !first) return "View transcript";
  const numeric = (value: string | number | null): number | null => typeof value === "number" ? value : value ? Date.parse(value) / 1000 : null;
  const at = numeric(segment.startedAt);
  const start = numeric(first.startedAt);
  if (at === null || start === null || !Number.isFinite(at - start)) return "View transcript";
  const seconds = Math.max(0, Math.floor(at - start));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

/** Evidence chips linking a MOM claim to its transcript turns, with optional remove and add controls. */
export function EvidenceChips({ ids, segments, onRemove, onAdd, addId, emptyLabel }: {
  ids: string[];
  segments: TranscriptSegment[];
  onRemove?(id: string): void;
  onAdd?(id: string): void;
  addId?: string;
  emptyLabel?: string;
}) {
  const options = segments.filter((segment) => segment.isFinal).map((segment) => ({ value: segment.segmentId, label: `${evidenceTime(segment.segmentId, segments)} · ${segment.speaker} · ${segment.text.slice(0, EVIDENCE_PREVIEW_LENGTH)}` }));
  return <div className="mom-evidence">
    <span className="mom-evidence-label" title="Elapsed from the first captured turn">Evidence</span>
    {ids.map((id) => {
      const segment = segments.find((item) => item.segmentId === id);
      const time = evidenceTime(id, segments);
      return <span className="mom-chip" key={id}>
        <a href={`#transcript-${encodeURIComponent(id)}`} title={segment ? `Open ${segment.speaker}'s transcript turn: ${segment.text.slice(0, 100)}` : "Open transcript evidence"}>At {time}</a>
        {onRemove ? <button type="button" aria-label={`Remove ${time} evidence`} onClick={() => onRemove(id)}><X aria-hidden="true" /></button> : null}
      </span>;
    })}
    {!ids.length && emptyLabel ? <span className="mom-evidence-empty">{emptyLabel}</span> : null}
    {onAdd && addId ? <UiSelect id={addId} label="Add transcript evidence" hideLabel size="sm" value="" placeholder="Add evidence" options={options} onChange={(value) => { if (value) onAdd(value); }} className="mom-evidence-add" /> : null}
  </div>;
}
