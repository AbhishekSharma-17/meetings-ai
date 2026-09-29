"use client";

import { useCallback, useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Clock3, LogOut, X } from "lucide-react";
import { leaveService } from "@/lib/meetings-service";
import { autoLeaveLine, endedLine, headsUpCopy } from "@/lib/leave-copy";
import { formatTime, useTimePreferences } from "@/lib/time-preferences";
import type { MeetingDetail, MeetingLeave } from "@/lib/types";
import { Alert } from "./ui/feedback";

const IN_CALL: ReadonlySet<MeetingDetail["status"]> = new Set(["live", "needs_attention"]);
const ENDED: ReadonlySet<MeetingDetail["status"]> = new Set(["ready", "stopped", "failed", "processing", "stopping"]);
const POLL_MS = 10_000;

/** The meeting's planned automatic leave (polled while in a call) or why it ended. Best effort. */
export function useMeetingLeave(meetingId: string, status: MeetingDetail["status"] | null) {
  const [leave, setLeave] = useState<MeetingLeave | null>(null);
  const load = useCallback(async () => {
    try { setLeave(await leaveService.getMeetingLeave(meetingId)); } catch { /* the rest of the page still works */ }
  }, [meetingId]);
  useEffect(() => {
    if (!status || (!IN_CALL.has(status) && !ENDED.has(status))) return;
    const first = window.setTimeout(() => void load(), 0);
    const timer = IN_CALL.has(status) ? window.setInterval(() => void load(), POLL_MS) : undefined;
    return () => { window.clearTimeout(first); if (timer) window.clearInterval(timer); };
  }, [load, status]);
  return { leave, setLeave, reload: load };
}

/** "Leaves automatically after 10 min of silence · no later than 6:31 PM (8-hour safety limit)". */
export function MeetingLeaveLine({ leave }: { leave: MeetingLeave | null }) {
  useTimePreferences();
  if (!leave?.in_call) return null;
  return <p className="leave-line" data-testid="auto-leave-line"><Clock3 aria-hidden="true" /><span>{autoLeaveLine(leave, formatTime)}</span></p>;
}

/** The heads-up before an automatic leave, with Keep in call (+30 min) and Leave now. */
export function MeetingLeaveBanner({ leave, busy, onKeep, onLeaveNow }: {
  leave: MeetingLeave | null; busy: boolean; onKeep(): void; onLeaveNow(): void;
}) {
  useTimePreferences();
  const copy = leave ? headsUpCopy(leave, formatTime) : null;
  if (!leave || !copy) return null;
  // Keeping only postpones quiet-based leaves; it can never push past the safety cap.
  const keepable = leave.can_keep && leave.next_leave?.reason !== "time_limit";
  const hint = leave.next_leave?.reason === "time_limit" ? ""
    : keepable ? "Still talking? Keep it in the call." : leave.can_manage ? "" : "Ask a workspace admin to keep it in the call if the meeting is still going.";
  return <Alert tone="warning" title={copy.title} className="leave-banner" actions={leave.can_manage ? <>
    {keepable ? <button type="button" className="button secondary sm" disabled={busy} onClick={onKeep}>{busy ? "Keeping…" : "Keep in call (+30 min)"}</button> : null}
    <button type="button" className="button ghost sm" disabled={busy} onClick={onLeaveNow}>Leave now</button>
  </> : undefined}>{hint ? `${copy.detail} ${hint}` : copy.detail}</Alert>;
}

/** "Ended 11:12 · the assistant left because …" on a finished meeting. */
export function MeetingEndedLine({ leave }: { leave: MeetingLeave | null }) {
  useTimePreferences();
  const line = leave ? endedLine(leave, formatTime) : null;
  if (!line) return null;
  return <Alert tone="neutral" role="note" className="leave-ended">{line.charAt(0).toUpperCase() + line.slice(1)}</Alert>;
}

/** Confirm step for making the assistant leave the call now. */
export function LeaveNowDialog({ open, busy, botName, onCancel, onConfirm }: {
  open: boolean; busy: boolean; botName: string; onCancel(): void; onConfirm(): void;
}) {
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog leave-dialog" role="alertdialog">
        <Dialog.Close className="close-button" aria-label="Cancel" disabled={busy}><X /></Dialog.Close>
        <Dialog.Title className="dialog-title">Make {botName} leave the call now?</Dialog.Title>
        <Dialog.Description className="dialog-intro">It stops recording and transcribing straight away. Everything captured so far is kept, and the minutes are drafted as usual.</Dialog.Description>
        <div className="dialog-footer">
          <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>Stay in call</button>
          <button type="button" className="button danger" disabled={busy} onClick={onConfirm}><LogOut aria-hidden="true" />{busy ? "Leaving…" : "Leave now"}</button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
