"use client";

import { CalendarCheck2, CalendarClock, CalendarX2, Hourglass, LogIn, Trash2, TriangleAlert } from "lucide-react";
import type { ScheduleState } from "@/lib/meeting-status";
import type { CalendarSchedule, MeetingSchedule } from "@/lib/types";
import { formatFullDateTime } from "@/lib/time-preferences";
import { LastChecked, providerLabel } from "./calendar-change-history";

/** The panel's schedule: the fresh schedule record, with when its status changed from the meeting. */
export function toMeetingSchedule(schedule: CalendarSchedule, changedAt: string | null | undefined): MeetingSchedule {
  return {
    status: schedule.status, provider: schedule.provider ?? "manual", startsAt: schedule.starts_at, endsAt: schedule.ends_at,
    note: schedule.last_error ?? null, changedAt: changedAt ?? schedule.starts_at, rescheduledFrom: schedule.rescheduled_from ?? null,
  };
}

function when(value: string): string {
  return formatFullDateTime(value);
}

function source(provider: string): string {
  return provider === "manual" ? "your schedule" : providerLabel(provider);
}

/**
 * What happens with this meeting's automatic join, in plain words: when the assistant joins, that
 * the meeting moved, or that it was cancelled or missed (so nothing was recorded), with what to do.
 */
export function ScheduleStatusPanel({ state, schedule, lastCheckedAt, busy, onCancelAutoJoin, onJoinAnyway, onDelete }: {
  state: ScheduleState;
  schedule: MeetingSchedule;
  lastCheckedAt?: string | null;
  busy: boolean;
  onCancelAutoJoin(): void;
  onJoinAnyway?(): void;
  onDelete?(): void;
}) {
  const from = source(schedule.provider);
  // A calendar note like "Couldn't re-check with Outlook Calendar: reconnect the calendar".
  const attention = state === "scheduled" || state === "moved" ? schedule.note : null;

  if (state === "waiting") {
    return <section className="schedule-panel warning" aria-labelledby="schedule-panel-title">
      <span className="schedule-panel-icon" aria-hidden="true"><Hourglass /></span>
      <div className="schedule-panel-copy">
        <h2 id="schedule-panel-title">Waiting for a free assistant</h2>
        <p>Every assistant is in another call. This one joins as soon as one is free, for up to 10 minutes after {when(schedule.startsAt)}.</p>
      </div>
      <div className="schedule-panel-actions">
        <button className="button secondary sm" type="button" disabled={busy} onClick={onCancelAutoJoin}>Stop waiting</button>
      </div>
    </section>;
  }

  if (state === "scheduled" || state === "moved") {
    return <section className={`schedule-panel ${attention ? "warning" : "info"}`} aria-labelledby="schedule-panel-title">
      <span className="schedule-panel-icon" aria-hidden="true">{attention ? <TriangleAlert /> : state === "moved" ? <CalendarClock /> : <CalendarCheck2 />}</span>
      <div className="schedule-panel-copy">
        <h2 id="schedule-panel-title">{state === "moved" ? "Rescheduled" : "Scheduled"} · the assistant joins {when(schedule.startsAt)}</h2>
        {state === "moved" && schedule.rescheduledFrom ? <p>Moved in {from} from {when(schedule.rescheduledFrom)}. The assistant follows the new time.</p> : null}
        <p>{attention ?? (schedule.provider === "manual"
          ? "It joins at the start time."
          : `It checks ${from} before joining, so another move or a cancellation is followed automatically.`)}</p>
        <LastChecked provider={schedule.provider} at={lastCheckedAt} />
      </div>
      <div className="schedule-panel-actions">
        <button className="button secondary sm" type="button" disabled={busy} onClick={onCancelAutoJoin}>Cancel auto-join</button>
      </div>
    </section>;
  }

  const cancelled = state === "cancelled";
  const title = cancelled
    ? schedule.note ?? "Auto-join cancelled"
    : state === "missed" ? "Missed · the assistant didn't join" : "The assistant couldn't join";
  const detail = cancelled
    ? `It was planned for ${when(schedule.startsAt)}. The assistant didn't join and nothing was recorded, so there's no transcript or MOM.`
    : state === "missed"
      ? `It was planned for ${when(schedule.startsAt)}, and the start time passed before the assistant could join. Nothing was recorded.`
      : `It was planned for ${when(schedule.startsAt)}.${schedule.note ? ` ${schedule.note}` : ""}`;
  return <section className={`schedule-panel ${cancelled ? "cancelled" : "warning"}`} aria-labelledby="schedule-panel-title">
    <span className="schedule-panel-icon" aria-hidden="true">{cancelled ? <CalendarX2 /> : <TriangleAlert />}</span>
    <div className="schedule-panel-copy">
      <h2 id="schedule-panel-title">{title}</h2>
      <p>{detail}</p>
      {cancelled ? <small>{schedule.provider === "manual" ? "Cancelled" : "Noticed"} {when(schedule.changedAt)}.</small> : null}
    </div>
    <div className="schedule-panel-actions">
      {onJoinAnyway ? <button className="button secondary sm" type="button" disabled={busy} onClick={onJoinAnyway}><LogIn aria-hidden="true" />{cancelled ? "It's on after all — join now" : "Join now"}</button> : null}
      {onDelete ? <button className="button ghost sm destructive" type="button" disabled={busy} onClick={onDelete}><Trash2 aria-hidden="true" />Delete this record</button> : null}
    </div>
  </section>;
}
