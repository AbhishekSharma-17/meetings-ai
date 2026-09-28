"use client";

import { useState } from "react";
import { formatFullDateTime } from "@/lib/time-preferences";
import { Trash2 } from "lucide-react";
import type { CalendarEvent, MeetingDetail, TranscriptionRoute } from "@/lib/types";

const DELETE_CONFIRMATION = "DELETE";
const calendarNames: Record<CalendarEvent["provider"], string> = { googlecalendar: "Google Calendar", outlook: "Outlook Calendar", calendly: "Calendly", zoom: "Zoom" };

export function formatTimestamp(value: string | number | null): string {
  if (value === null || value === "") return "—";
  if (typeof value === "number") {
    const minutes = Math.floor(value / 60);
    return `${minutes}:${Math.floor(value % 60).toString().padStart(2, "0")}`;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatFullDateTime(date);
}

function Metadata({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function routeLabel(route: TranscriptionRoute): string {
  if (route.mode === "profile") return `${route.profile_name} · ${route.model} · ${route.endpoint_host}`;
  return route.mode === "vexa_deployment" ? "Vexa deployment default" : "Chosen when the assistant joins";
}

export function MeetingDetailsCard({ meeting, route }: { meeting: MeetingDetail; route: TranscriptionRoute | null }) {
  return <section className="card" aria-labelledby="meeting-details-title">
    <div className="card-header"><div><h2 id="meeting-details-title">Meeting details</h2></div></div>
    <div className="card-body">
      <dl className="meta-list">
        <Metadata label="Platform" value={meeting.platform} />
        <Metadata label="Assistant" value={meeting.botName} />
        <Metadata label="Joined" value={formatTimestamp(meeting.joinedAt)} />
        <Metadata label="Stopped" value={formatTimestamp(meeting.stoppedAt)} />
        <Metadata label="Duration" value={meeting.duration} />
        <Metadata label="Last update" value={formatTimestamp(meeting.updatedAt)} />
      </dl>
      {route ? <section className="record-runtime" aria-label="Transcription runtime route">
        <h3>Transcription runtime</h3>
        <p>{routeLabel(route)}</p>
        <p className="field-hint">Fixed for this bot run. New provider defaults apply to the next join.</p>
      </section> : null}
    </div>
  </section>;
}

export function MeetingSourceCard({ source }: { source: CalendarEvent }) {
  return <section className="card" aria-labelledby="meeting-source-title">
    <div className="card-header">
      <div><h2 id="meeting-source-title">Calendar source</h2><p>{calendarNames[source.provider] ?? source.provider} · {formatTimestamp(source.starts_at)}</p></div>
    </div>
    <div className="card-body stack">
      <dl className="meta-list">
        <Metadata label="Listed invitees" value={String(source.invitees?.length ?? 0)} />
        {source.organizer ? <Metadata label="Organizer" value={source.organizer} /> : null}
      </dl>
      {source.agenda ? <div className="record-agenda"><span className="field-label">Agenda</span><p>{source.agenda}</p></div> : null}
      <p className="field-hint">Saved at import time. The invitee list is not proof of attendance.</p>
    </div>
  </section>;
}

/** Quiet destructive area with a typed confirmation. */
export function MeetingDangerZone({ deleting, onDelete }: { deleting: boolean; onDelete(): void }) {
  const [confirming, setConfirming] = useState(false);
  const [text, setText] = useState("");
  const confirmed = text === DELETE_CONFIRMATION;
  return <section className="card record-danger" aria-labelledby="meeting-delete-title">
    <div className="card-header plain">
      <div><h2 id="meeting-delete-title">Delete meeting</h2><p>Removes capture artifacts, the transcript, MOM, indexed knowledge and saved AI chats citing it.</p></div>
    </div>
    <div className="card-body">
      {confirming ? <div className="record-danger-confirm" role="group" aria-label="Confirm meeting deletion">
        <p><b>Delete this meeting and its data?</b> Emails already sent cannot be recalled. This cannot be undone.</p>
        <label className="field">Type DELETE to confirm<input value={text} onChange={(event) => setText(event.target.value)} autoComplete="off" /></label>
        <div className="button-group end">
          <button type="button" className="button ghost sm" disabled={deleting} onClick={() => { setConfirming(false); setText(""); }}>Cancel</button>
          <button type="button" className="button danger sm" disabled={deleting || !confirmed} onClick={() => { if (confirmed) onDelete(); }}>{deleting ? "Deleting…" : "Permanently delete"}</button>
        </div>
      </div> : <button className="button danger-outline sm" type="button" onClick={() => setConfirming(true)}><Trash2 aria-hidden="true" /> Delete meeting and data</button>}
    </div>
  </section>;
}
