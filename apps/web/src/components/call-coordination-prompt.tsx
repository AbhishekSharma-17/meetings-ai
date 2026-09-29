"use client";

import { useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import { coordinationService, firstName, ONE_AT_A_TIME, possessive, type CallCheck, type TeammateAssistant } from "@/lib/coordination";
import { meetingsService } from "@/lib/meetings-service";
import type { MeetingDetail } from "@/lib/types";
import { formatDateTime } from "@/lib/time-preferences";
import { WEEKDAY_DATE_TIME } from "@/lib/time-format";
import { Alert } from "./ui/feedback";

/** "share:<meeting id>" relies on that teammate's assistant; "own" brings mine as well. */
export type CoordinationChoice = `share:${string}` | "own";

function assistantLine(item: TeammateAssistant): string {
  const who = item.owner?.display_name ?? "A teammate";
  if (item.state === "in_call") return `${who} already has the assistant in this call.`;
  if (item.state === "joining") return `${who}'s assistant is joining this call now.`;
  return `${who} already has the assistant joining this call at ${formatDateTime(item.starts_at, WEEKDAY_DATE_TIME)}.`;
}

/**
 * Before a second assistant is created for a call: ask whether to share a teammate's assistant
 * or bring my own. Checks once per link and start time; a failed check never blocks scheduling.
 */
export function useCallCoordination() {
  const [check, setCheck] = useState<CallCheck | null>(null);
  const [askedFor, setAskedFor] = useState<string | null>(null);
  const [choice, setChoice] = useState<CoordinationChoice>("own");
  const [receiveRecap, setReceiveRecap] = useState(true);

  function reset() { setCheck(null); setAskedFor(null); setChoice("own"); setReceiveRecap(true); }

  /** "ask" shows the prompt (nothing is created); "go" continues with the current choice. */
  async function evaluate(meetingUrl: string, startsAt: string | null, endsAt: string | null): Promise<"ask" | "go"> {
    const signature = `${meetingUrl.trim()}|${startsAt ?? "now"}`;
    if (askedFor === signature) return "go";
    let result: CallCheck;
    try { result = await coordinationService.check(meetingUrl, startsAt, endsAt); }
    catch { return "go"; }
    if (!result.assistants.length && !result.your_assistants.length) { setCheck(null); return "go"; }
    setCheck(result);
    setAskedFor(signature);
    const recommended = result.assistants.find((item) => item.state === "in_call" || item.state === "joining") ?? result.assistants[0];
    setChoice(recommended ? `share:${recommended.meeting_id}` : "own");
    return "ask";
  }

  const sharingWith = choice.startsWith("share:") ? check?.assistants.find((item) => `share:${item.meeting_id}` === choice) ?? null : null;

  /** Share the chosen teammate's assistant; returns that meeting to open. */
  async function share(): Promise<MeetingDetail> {
    if (!sharingWith) throw new Error("Choose whose assistant to share.");
    await coordinationService.share(sharingWith.meeting_id, receiveRecap);
    return meetingsService.getMeeting(sharingWith.meeting_id);
  }

  const conflict = Boolean(check?.assistants.length);
  return { check, choice, setChoice, receiveRecap, setReceiveRecap, reset, evaluate, share, sharingWith, decision: conflict && choice === "own" ? "own" as const : undefined };
}

export type CallCoordinationState = ReturnType<typeof useCallCoordination>;

export function submitLabel(state: CallCoordinationState, willSchedule: boolean, fallback: string): string {
  if (state.sharingWith) return `Share ${possessive(firstName(state.sharingWith.owner))} assistant`;
  if (state.check?.assistants.length) return willSchedule ? "Schedule my own anyway" : "Send my own anyway";
  if (state.check?.your_assistants.length) return willSchedule ? "Schedule anyway" : "Send anyway";
  return fallback;
}

/** The inline "someone is already bringing an assistant" block for schedule, import and send-now. */
export function CallCoordinationPrompt({ state, disabled }: { state: CallCoordinationState; disabled: boolean }) {
  const { check } = state;
  const ref = useRef<HTMLElement>(null);
  // The prompt appears after "Send"; bring it into view in a long dialog.
  useEffect(() => { if (check) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [check]);
  if (!check) return null;
  if (!check.assistants.length) {
    const mine = check.your_assistants[0];
    return <section ref={ref} className="nm-section coordination-prompt" aria-label="Call coordination">
      <Alert tone="info" title="You already have an assistant set for this call.">
        {mine ? `It joins ${formatDateTime(mine.starts_at, WEEKDAY_DATE_TIME)}. ` : null}Only one of your records ever joins, so a duplicate won&apos;t bring a second assistant.
      </Alert>
    </section>;
  }
  const first = check.assistants[0];
  const covering = first.covering.filter((person) => !person.is_you).map((person) => person.display_name);
  return <section ref={ref} className="nm-section coordination-prompt" aria-labelledby="coordination-prompt-title">
    <Alert tone="warning" role="status" title={<span id="coordination-prompt-title">{assistantLine(first)}</span>}>
      {covering.length ? <>Also covering: {covering.join(", ")}. </> : null}
      {check.assistants.length > 1 ? <>{check.assistants.length - 1} more teammate{check.assistants.length > 2 ? "s have" : " has"} an assistant set for it too. </> : null}
      {check.teammates_on_calendar ? <><Users aria-hidden="true" className="coordination-inline-icon" />{check.teammates_on_calendar} other teammate{check.teammates_on_calendar === 1 ? " has" : "s have"} this meeting on their calendar.</> : null}
    </Alert>
    <fieldset className="coordination-choices" disabled={disabled}>
      <legend className="nm-section-title">Who brings the assistant?</legend>
      {check.assistants.map((item, index) => <label key={item.meeting_id} className="choice-card">
        <input type="radio" name="call-coordination" value={`share:${item.meeting_id}`} checked={state.choice === `share:${item.meeting_id}`} onChange={() => state.setChoice(`share:${item.meeting_id}`)} />
        <span>
          <b>Share {possessive(firstName(item.owner))} assistant{index === 0 ? <span className="coordination-recommended">Recommended</span> : null}</b>
          <small>No second assistant joins. You get its transcript and approved minutes; {item.owner?.display_name ?? "the owner"} and admins keep editing and delivery. Nothing new is created for you.</small>
        </span>
      </label>)}
      {state.sharingWith ? <label className="check-label coordination-recap">
        <input type="checkbox" checked={state.receiveRecap} onChange={(event) => state.setReceiveRecap(event.target.checked)} />
        Email me the recap when it&apos;s sent
      </label> : null}
      <label className="choice-card">
        <input type="radio" name="call-coordination" value="own" checked={state.choice === "own"} onChange={() => state.setChoice("own")} />
        <span>
          <b>Send my own assistant anyway</b>
          <small>For a personal note-taker. {ONE_AT_A_TIME} {first.owner?.display_name ?? "Your teammate"} is told that two assistants are set.</small>
        </span>
      </label>
    </fieldset>
  </section>;
}
