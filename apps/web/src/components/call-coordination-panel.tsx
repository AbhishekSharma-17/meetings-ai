"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Users } from "lucide-react";
import { coordinationService, coveringList, firstName, ONE_AT_A_TIME, possessive, type MeetingCoordination, type TeammateAssistant } from "@/lib/coordination";
import { formatDateTime } from "@/lib/time-preferences";
import { WEEKDAY_DATE_TIME } from "@/lib/time-format";
import { Avatar } from "./ui/avatar";
import { Alert, Badge } from "./ui/feedback";

const stateLabel: Record<TeammateAssistant["state"], string> = {
  scheduled: "Scheduled", joining: "Joining", in_call: "In the call", ended: "Recorded", idle: "Not joining",
};

function when(item: { state: TeammateAssistant["state"]; starts_at: string }): string {
  if (item.state === "in_call") return "in the call now";
  if (item.state === "joining") return "joining now";
  if (item.state === "ended") return `recorded ${formatDateTime(item.starts_at, WEEKDAY_DATE_TIME)}`;
  return `joins ${formatDateTime(item.starts_at, WEEKDAY_DATE_TIME)}`;
}

/** Whether a coordination view has anything worth showing on the meeting page. */
export function hasCoordination(view: MeetingCoordination): boolean {
  return Boolean(view.covering.length || view.other_assistants.length || view.handed_to || view.teammates_on_calendar
    || view.your_role === "sharing" || view.kept_own);
}

export function useMeetingCoordination(meetingId: string, reloadKey = "") {
  const [view, setView] = useState<MeetingCoordination | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => coordinationService.forMeeting(meetingId)
    .then((next) => { setView(next); setError(null); return next; })
    .catch((cause: unknown) => {
      // 404: this meeting does not cover the viewer; nothing to coordinate.
      if ((cause as { status?: number }).status === 404) { setView(null); return null; }
      setError(cause instanceof Error ? cause.message : "Call coordination is unavailable.");
      return null;
    }), [meetingId]);
  useEffect(() => { void reload(); }, [reload, reloadKey]);
  return { view, setView, error, reload };
}

/**
 * "Assistant from Asha · also covering: you, Ben". Who brings the assistant to this call, who it
 * covers, other assistants set for the same call and the decisions available to the viewer.
 */
export function CallCoordinationPanel({ meetingId, reloadKey, onOpenMeeting, onChanged }: {
  meetingId: string;
  reloadKey?: string;
  onOpenMeeting?(id: string): void;
  onChanged?(): void;
}) {
  const { view, setView, error, reload } = useMeetingCoordination(meetingId, reloadKey);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [receiveRecap, setReceiveRecap] = useState(true);

  async function run(key: string, action: () => Promise<MeetingCoordination>) {
    setBusy(key); setActionError(null);
    try {
      const next = await action();
      if (next.meeting_id === meetingId) setView(next); else await reload();
      onChanged?.();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "That did not work. Try again.");
    } finally { setBusy(null); }
  }

  if (error) return <section className="card coordination-card" aria-label="Call coordination"><div className="card-body"><p className="form-error" role="alert">{error} <button type="button" className="text-button" onClick={() => void reload()}>Retry</button></p></div></section>;
  if (!view || !hasCoordination(view)) return null;
  const owner = view.owner;
  const covering = coveringList(view.covering);
  const mine = view.your_role === "owner";
  return <section className="card coordination-card" aria-labelledby={`coordination-${meetingId}`}>
    <div className="card-header"><div><h2 id={`coordination-${meetingId}`}>Call coordination</h2><p>Teammates on this call and whose assistant brings the notes.</p></div></div>
    <div className="card-body coordination-body">
      <div className="coordination-bringer">
        <Avatar name={owner?.display_name ?? "Teammate"} size="sm" />
        <p><b>Assistant from {owner ? (owner.is_you ? "you" : owner.display_name) : "this workspace"}</b>{covering ? <small> · also covering: {covering}</small> : null}</p>
        <Badge tone={view.state === "in_call" ? "brand" : view.state === "idle" ? "neutral" : "info"} dot>{stateLabel[view.state]}</Badge>
      </div>
      {view.covering.length ? <div className="coordination-others" aria-label="People sharing this assistant">
        <h3>Sharing this assistant · {view.covering.length}</h3>
        <ul>{view.covering.map((person) => <li key={person.user_id}><Avatar name={person.display_name} size="sm" /><span className="coordination-other-copy"><b>{person.display_name}{person.is_you ? " · You" : ""}</b><small>Same transcript · can create a separate MOM</small></span></li>)}</ul>
      </div> : null}
      {view.your_role === "sharing" ? <p className="coordination-note">You&apos;re sharing {possessive(firstName(owner))} assistant: you can read its transcript and approved minutes{view.receive_recap ? " and you'll get the recap email" : ""}. {owner?.display_name ?? "The owner"} and admins manage the meeting and its delivery.</p> : null}
      {view.handed_to ? <Alert tone="info" title={`Handed over to ${possessive(firstName(view.handed_to.owner))} assistant`}
        actions={view.handed_to.can_open && onOpenMeeting ? <button type="button" className="button secondary sm" onClick={() => onOpenMeeting(view.handed_to!.meeting_id)}>Open</button> : undefined}>
        This record won&apos;t join; the notes come from the assistant that {when(view.handed_to)}.
      </Alert> : null}
      {view.other_assistants.length ? <div className="coordination-others">
        <h3>Also set for this call</h3>
        <ul>{view.other_assistants.map((item) => <li key={item.meeting_id}>
          <Avatar name={item.owner?.display_name ?? "Teammate"} size="sm" />
          <span className="coordination-other-copy"><b>{item.owner?.is_you ? "Your other assistant" : `${item.owner?.display_name ?? "A teammate"}'s assistant`}</b>
            <small>{when(item)}{item.kept_own ? " · kept their own" : ""}{item.covering.length ? ` · covering ${coveringList(item.covering)}` : ""}</small></span>
          <span className="coordination-other-actions">
            {mine && view.state === "scheduled" && !item.owner?.is_you ? <button type="button" className="button secondary sm" disabled={busy !== null}
              onClick={() => void run(item.meeting_id, () => coordinationService.share(item.meeting_id, true))}>{busy === item.meeting_id ? "Handing over…" : `Let ${possessive(firstName(item.owner))} assistant cover it`}</button> : null}
            {item.can_open && onOpenMeeting ? <button type="button" className="icon-button" aria-label={`Open ${item.owner?.display_name ?? "teammate"}'s meeting`} onClick={() => onOpenMeeting(item.meeting_id)}><ArrowRight aria-hidden="true" /></button> : null}
          </span>
        </li>)}</ul>
        {mine ? <p className="field-hint">{ONE_AT_A_TIME}</p> : null}
      </div> : null}
      {view.teammates_on_calendar ? <p className="coordination-note"><Users aria-hidden="true" />{view.teammates_on_calendar} teammate{view.teammates_on_calendar === 1 ? " also has" : "s also have"} this meeting on their calendar.</p> : null}
      {actionError ? <p className="form-error" role="alert">{actionError}</p> : null}
      {view.can_share ? <div className="coordination-actions">
        <label className="check-label"><input type="checkbox" checked={receiveRecap} onChange={(event) => setReceiveRecap(event.target.checked)} />Email me the recap</label>
        <button type="button" className="button secondary sm" disabled={busy !== null} onClick={() => void run("share", () => coordinationService.share(meetingId, receiveRecap))}>{busy === "share" ? "Sharing…" : "Share this assistant's notes"}</button>
      </div> : null}
      {view.can_stop_sharing ? <div className="coordination-actions">
        <button type="button" className="button ghost sm" disabled={busy !== null} onClick={() => void run("stop", () => coordinationService.stopSharing(meetingId))}>{busy === "stop" ? "Stopping…" : "Stop sharing"}</button>
      </div> : null}
    </div>
  </section>;
}
