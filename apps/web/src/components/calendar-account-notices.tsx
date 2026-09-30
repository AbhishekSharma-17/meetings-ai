"use client";

import type { CalendarConnection, ScheduledOnDisconnect } from "@/lib/types";
import { Alert } from "./ui/feedback";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "3 meetings found · 1 assistant scheduled" under an account, once it has been synced. */
export function accountFacts(connection: CalendarConnection): string | null {
  const facts = [
    typeof connection.meetings_found === "number" ? plural(connection.meetings_found, "meeting") + " found" : null,
    connection.scheduled ? plural(connection.scheduled, "assistant") + " scheduled" : null,
  ].filter(Boolean);
  return facts.length ? facts.join(" · ") : null;
}

/** Why an account may not be showing the meetings someone expects, and what to do about it. */
export function AccountNotices({ connection, connections }: { connection: CalendarConnection; connections: CalendarConnection[] }) {
  if (connection.status !== "ACTIVE") return null;
  const twin = connection.same_account_as ? connections.find((item) => item.id === connection.same_account_as) : undefined;
  const personal = connection.provider === "outlook" && connection.account_type === "personal";
  const empty = connection.meetings_found === 0 && !personal;
  if (!twin && !personal && !empty) return null;
  return <div className="calendar-account-notices">
    {personal ? <Alert tone="warning" role="note" title="This is a personal Microsoft account">
      Meetings sent to a work or school address (Microsoft 365) won’t show up here. If that’s where your invites go, connect Outlook Calendar again and sign in with that work account, then disconnect this one.
    </Alert> : null}
    {twin ? <Alert tone="warning" role="note" title={`Same account as “${twin.label}”`}>
      Its meetings would show up twice. Disconnect one of them.
    </Alert> : null}
    {empty ? <Alert tone="info" role="note">
      No meetings with a join link were found in the synced dates. Only events with a Google Meet, Teams, Zoom or Jitsi link are shown.
    </Alert> : null}
  </div>;
}

/** The disconnect question: what happens to assistants scheduled from this account. */
export function DisconnectConfirm({ connection, busy, onCancel, onConfirm }: {
  connection: CalendarConnection;
  busy: boolean;
  onCancel(): void;
  onConfirm(scheduled: ScheduledOnDisconnect): void;
}) {
  const scheduled = connection.scheduled ?? 0;
  return <div className="calendar-row-panel calendar-disconnect-confirm" role="group" aria-label={`Disconnect ${connection.label}`}>
    {scheduled ? <p>
      <b>Disconnect this account?</b>{" "}
      <span>{plural(scheduled, "assistant")} {scheduled === 1 ? "is" : "are"} scheduled from it. Keep them and they join at the saved time and link; reconnect this account later and they follow calendar changes again. Or cancel them now.</span>
    </p> : <p>
      <b>Disconnect this account?</b> <span>Saved meetings and briefings remain. Its meetings leave the calendar until you reconnect it.</span>
    </p>}
    <div className="button-group">
      <button type="button" className="button ghost sm" disabled={busy} onClick={onCancel}>{scheduled ? "Not now" : "Cancel"}</button>
      {scheduled ? <>
        <button type="button" className="button secondary sm" disabled={busy} onClick={() => onConfirm("keep")}>{busy ? "Disconnecting…" : `Keep ${scheduled === 1 ? "assistant" : "assistants"}`}</button>
        <button type="button" className="button danger sm" disabled={busy} onClick={() => onConfirm("cancel")}>{`Cancel ${scheduled === 1 ? "assistant" : plural(scheduled, "assistant")}`}</button>
      </> : <button type="button" className="button danger sm" disabled={busy} onClick={() => onConfirm("keep")}>{busy ? "Disconnecting…" : "Confirm"}</button>}
    </div>
  </div>;
}
