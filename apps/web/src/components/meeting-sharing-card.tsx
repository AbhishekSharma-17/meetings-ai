"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { History, Mail, Send, Share2, UserMinus } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import { activeShares, sharingService, type MeetingSharing, type RecapDelivery } from "@/lib/sharing-service";
import { formatDateTime } from "@/lib/time-preferences";
import type { WorkspaceMember } from "@/lib/types";
import { Avatar } from "./ui/avatar";
import type { ChipSuggestion } from "./ui/chip-input";
import { EmailChips, isValidEmail } from "./ui/email-chips";
import { Alert, Badge, EmptyState } from "./ui/feedback";
import { SwitchField } from "./ui/switch";

const MAX_SHOWN_RECIPIENTS = 3;

function recipientsText(list: string[]): string {
  const shown = list.slice(0, MAX_SHOWN_RECIPIENTS).join(", ");
  return list.length > MAX_SHOWN_RECIPIENTS ? `${shown} +${list.length - MAX_SHOWN_RECIPIENTS}` : shown;
}

function messageFor(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function suggestionsFor(members: WorkspaceMember[]): ChipSuggestion[] {
  return members.map((member) => ({ id: member.email ?? member.user_id, label: member.display_name, detail: member.email ?? undefined, keywords: member.email ? [member.email] : [] }));
}

/**
 * Owners and admins: give teammates read access to this meeting's transcript and approved MOM,
 * email the sent recap again, and see who it was shared with and every recap email.
 */
export function MeetingSharingCard({ meetingId, revision = 0 }: { meetingId: string; revision?: number }) {
  const [sharing, setSharing] = useState<MeetingSharing | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [shareWith, setShareWith] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [resendTo, setResendTo] = useState<string[]>([]);
  const [attachTranscript, setAttachTranscript] = useState(false);
  const [busy, setBusy] = useState<"share" | "resend" | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => sharingService.history(meetingId).then(setSharing).catch((cause) => setError(messageFor(cause, "Could not load sharing."))), [meetingId]);
  useEffect(() => { void load(); }, [load, revision]);
  useEffect(() => { void meetingsService.listWorkspaceMembers().then(setMembers).catch(() => setMembers([])); }, []);

  const active = activeShares(sharing);
  // Owners and admins already see every meeting; invites that aren't accepted yet can't sign in.
  const shareable = useMemo(() => members.filter((member) => member.status === "active" && member.role !== "owner" && member.role !== "admin"
    && !active.some((share) => share.person.user_id === member.user_id)), [members, active]);
  const recapSent = Boolean(sharing?.deliveries.some((delivery) => delivery.status === "sent"));

  async function share() {
    const byEmail = new Map(shareable.filter((member) => member.email).map((member) => [member.email!.toLowerCase(), member]));
    const unknown = shareWith.filter((email) => !byEmail.has(email.toLowerCase()));
    if (unknown.length) { setError(`${unknown.join(", ")} ${unknown.length === 1 ? "isn't a teammate" : "aren't teammates"} who can be given access. Choose people from this workspace.`); return; }
    setBusy("share"); setError(null); setNotice(null);
    try {
      setSharing(await sharingService.share(meetingId, shareWith.map((email) => byEmail.get(email.toLowerCase())!.user_id), note));
      setNotice(`Shared with ${shareWith.length} ${shareWith.length === 1 ? "person" : "people"}. They were notified.`);
      setShareWith([]); setNote("");
    } catch (cause) { setError(messageFor(cause, "Could not share this meeting.")); }
    finally { setBusy(null); }
  }

  async function revoke(shareId: string, name: string) {
    setBusy(shareId); setError(null); setNotice(null);
    try { setSharing(await sharingService.revoke(meetingId, shareId)); setNotice(`${name} no longer has access.`); }
    catch (cause) { setError(messageFor(cause, "Could not remove access.")); }
    finally { setBusy(null); }
  }

  async function resend() {
    setBusy("resend"); setError(null); setNotice(null);
    try {
      const delivery = await sharingService.resend(meetingId, resendTo, attachTranscript);
      setNotice(`Recap sent again to ${recipientsText(delivery.recipients)}.`);
      setResendTo([]);
    } catch (cause) { setError(messageFor(cause, "Could not send the recap again.")); }
    finally { setBusy(null); void load(); }
  }

  const invalidResend = resendTo.some((email) => !isValidEmail(email));
  return <section className="card sharing-card" aria-labelledby="sharing-title">
    <div className="card-header">
      <div><h2 id="sharing-title">Sharing</h2><p>Give teammates the transcript and approved MOM in the app, or email the recap again.</p></div>
      {active.length ? <span className="section-count">{active.length} with access</span> : null}
    </div>
    <div className="card-body sharing-body">
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className="form-success" role="status">{notice}</p> : null}

      <div className="sharing-block">
        <h3><Share2 aria-hidden="true" /> Share in the app</h3>
        <EmailChips id="share-people" label="Teammates" value={shareWith} onChange={setShareWith} placeholder="Type a name or pick a teammate" disabled={busy !== null}
          suggestions={suggestionsFor(shareable)} suggestionsLabel="People in this workspace" onPick={(pick) => setShareWith((current) => current.includes(pick.id) ? current : [...current, pick.id])}
          hint="They can read the transcript and the approved MOM. They can't edit, send or share it." />
        <div className="field">
          <label htmlFor="share-note">Note <span className="optional">optional</span></label>
          <input id="share-note" value={note} maxLength={500} placeholder="e.g. Please check the action items before Friday" disabled={busy !== null} onChange={(event) => setNote(event.target.value)} />
        </div>
        <div className="button-group end">
          <button type="button" className="button primary" disabled={busy !== null || !shareWith.length} onClick={() => void share()}><Share2 aria-hidden="true" />{busy === "share" ? "Sharing…" : "Share"}</button>
        </div>
      </div>

      <div className="sharing-block">
        <h3><Mail aria-hidden="true" /> Email the recap again</h3>
        {recapSent ? <>
          <EmailChips id="resend-recipients" label="Send to" value={resendTo} onChange={setResendTo} disabled={busy !== null}
            suggestions={suggestionsFor(members.filter((member) => member.status === "active" && member.email))} suggestionsLabel="Teammates' addresses"
            onPick={(pick) => setResendTo((current) => current.includes(pick.id) ? current : [...current, pick.id])}
            hint="Anyone who missed it, inside or outside the workspace. The MOM itself doesn't change." />
          <SwitchField id="resend-transcript" label="Attach the full timestamped transcript (.md)" checked={attachTranscript} onChange={setAttachTranscript} />
          <div className="button-group end">
            <button type="button" className="button secondary" disabled={busy !== null || !resendTo.length || invalidResend} onClick={() => void resend()}><Send aria-hidden="true" />{busy === "resend" ? "Sending…" : "Send again"}</button>
          </div>
        </> : <Alert tone="info">Send the recap from MOM & follow-up first. After that you can email it again to anyone who missed it.</Alert>}
      </div>

      <SharingHistory sharing={sharing} busy={busy} onRevoke={(id, name) => void revoke(id, name)} />
    </div>
  </section>;
}

function SharingHistory({ sharing, busy, onRevoke }: { sharing: MeetingSharing | null; busy: string | null; onRevoke(id: string, name: string): void }) {
  if (!sharing) return null;
  const empty = !sharing.shares.length && !sharing.deliveries.length;
  return <div className="sharing-block sharing-history">
    <h3><History aria-hidden="true" /> History</h3>
    {empty ? <EmptyState plain icon={<History />} title="Not shared yet">Shares and recap emails appear here.</EmptyState> : null}
    {sharing.shares.length ? <ul className="sharing-list" aria-label="Shared with">
      {sharing.shares.map((share) => <li key={share.id} className={share.revoked_at ? "revoked" : undefined}>
        <Avatar name={share.person.display_name} size="sm" />
        <div className="sharing-line">
          <b>{share.person.display_name}</b>
          <small>{share.revoked_at
            ? `Access removed ${formatDateTime(share.revoked_at)}${share.revoked_by ? ` by ${share.revoked_by.display_name}` : ""}`
            : `Shared ${formatDateTime(share.created_at)}${share.shared_by ? ` by ${share.shared_by.display_name}` : ""}`}</small>
          {share.note ? <small className="sharing-note">“{share.note}”</small> : null}
        </div>
        {share.revoked_at ? <Badge tone="neutral">Removed</Badge>
          : <button type="button" className="button ghost sm" disabled={busy !== null} onClick={() => onRevoke(share.id, share.person.display_name)}><UserMinus aria-hidden="true" />{busy === share.id ? "Removing…" : "Remove access"}</button>}
      </li>)}
    </ul> : null}
    {sharing.deliveries.length ? <ul className="sharing-list" aria-label="Recap emails">
      {sharing.deliveries.map((delivery) => <DeliveryRow key={delivery.id} delivery={delivery} />)}
    </ul> : null}
  </div>;
}

function DeliveryRow({ delivery }: { delivery: RecapDelivery }) {
  const failed = delivery.status !== "sent";
  return <li className={failed ? "failed" : undefined}>
    <span className="sharing-mail-icon" aria-hidden="true"><Mail /></span>
    <div className="sharing-line">
      <b title={delivery.recipients.join(", ")}>{recipientsText(delivery.recipients)}</b>
      <small>{delivery.kind === "resend" ? "Sent again" : "Recap sent"} {formatDateTime(delivery.created_at)}{delivery.sent_by ? ` by ${delivery.sent_by.display_name}` : ""}{delivery.include_transcript ? " · transcript attached" : ""}</small>
      {failed && delivery.error ? <small className="inline-error">{delivery.error}</small> : null}
    </div>
    <Badge tone={failed ? "danger" : delivery.kind === "resend" ? "info" : "success"}>{failed ? "Failed" : delivery.kind === "resend" ? "Resent" : "Recap"}</Badge>
  </li>;
}
