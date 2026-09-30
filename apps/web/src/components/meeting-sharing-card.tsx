"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { History, Mail, Send, Share2, UserMinus } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import { activeShares, sharingService, type MeetingSharing, type RecapDelivery } from "@/lib/sharing-service";
import { formatDateTime } from "@/lib/time-preferences";
import type { Team, WorkspaceMember } from "@/lib/types";
import { Avatar } from "./ui/avatar";
import { isValidEmail } from "./ui/email-chips";
import { Alert, Badge, EmptyState } from "./ui/feedback";
import { SwitchField } from "./ui/switch";
import { TeamRecipientChips } from "./team-recipient-chips";

/** Recipients shown before "Show all" in the history. */
const RECIPIENTS_SHOWN = 6;

function messageFor(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

/** Everyone the chosen addresses and teams reach (teams: their current active members). */
function reach(emails: string[], teamIds: string[], teams: Team[]): string[] {
  const fromTeams = teams.filter((team) => teamIds.includes(team.id)).flatMap((team) => team.members.filter((member) => member.active).map((member) => member.email));
  const seen = new Set<string>();
  return [...emails, ...fromTeams].filter((email) => {
    const key = email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Owners and admins: give teammates read access to this meeting's transcript and approved MOM,
 * email the sent recap again, and see who it was shared with and every recap email.
 */
export function MeetingSharingCard({ meetingId, revision = 0 }: { meetingId: string; revision?: number }) {
  const [sharing, setSharing] = useState<MeetingSharing | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [shareWith, setShareWith] = useState<string[]>([]);
  const [shareTeams, setShareTeams] = useState<string[]>([]);
  const [resendTeams, setResendTeams] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [resendTo, setResendTo] = useState<string[]>([]);
  const [attachTranscript, setAttachTranscript] = useState(false);
  const [busy, setBusy] = useState<"share" | "resend" | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => sharingService.history(meetingId).then(setSharing).catch((cause) => setError(messageFor(cause, "Could not load sharing."))), [meetingId]);
  useEffect(() => { void load(); }, [load, revision]);
  useEffect(() => {
    void meetingsService.listWorkspaceMembers().then(setMembers).catch(() => setMembers([]));
    void meetingsService.listTeams().then(setTeams).catch(() => setTeams([]));
  }, []);

  const active = activeShares(sharing);
  // Owners and admins already see every meeting; invites that aren't accepted yet can't sign in.
  const shareable = useMemo(() => members.filter((member) => member.status === "active" && member.role !== "owner" && member.role !== "admin"
    && !active.some((share) => share.person.user_id === member.user_id)), [members, active]);
  const recapSent = Boolean(sharing?.deliveries.some((delivery) => delivery.status === "sent"));

  async function share() {
    const byEmail = new Map(shareable.filter((member) => member.email).map((member) => [member.email!.toLowerCase(), member]));
    const unknown = shareWith.filter((email) => !byEmail.has(email.toLowerCase()));
    if (unknown.length) { setError(`${unknown.join(", ")} ${unknown.length === 1 ? "isn't a teammate" : "aren't teammates"} who can be given access. Choose people from this workspace.`); return; }
    // A team shares with its members who don't already see the meeting (admins always do).
    const people = [...new Set(reach(shareWith, shareTeams, teams).map((email) => byEmail.get(email.toLowerCase())?.user_id).filter((id): id is string => Boolean(id)))];
    if (!people.length) { setError("Everyone you chose can already see this meeting."); return; }
    setBusy("share"); setError(null); setNotice(null);
    try {
      setSharing(await sharingService.share(meetingId, people, note));
      setNotice(`Shared with ${people.length} ${people.length === 1 ? "person" : "people"}. They were notified.`);
      setShareWith([]); setShareTeams([]); setNote("");
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
      const delivery = await sharingService.resend(meetingId, reach(resendTo, resendTeams, teams), attachTranscript);
      setNotice(`Recap sent again to ${delivery.recipients.length === 1 ? delivery.recipients[0] : `${delivery.recipients.length} people`}.`);
      setResendTo([]); setResendTeams([]);
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
        <TeamRecipientChips id="share-people" label="Teammates" value={shareWith} onChange={setShareWith} groupIds={shareTeams} onGroupIdsChange={setShareTeams}
          teams={teams} members={shareable} placeholder="Type @ or a name to pick teammates or a team" disabled={busy !== null}
          hint="Type @ to pick people or a whole team. They can read the transcript and the approved MOM; they can't edit, send or share it." />
        <div className="field">
          <label htmlFor="share-note">Note <span className="optional">optional</span></label>
          <input id="share-note" value={note} maxLength={500} placeholder="e.g. Please check the action items before Friday" disabled={busy !== null} onChange={(event) => setNote(event.target.value)} />
        </div>
        <div className="button-group end">
          <button type="button" className="button primary" disabled={busy !== null || (!shareWith.length && !shareTeams.length)} onClick={() => void share()}><Share2 aria-hidden="true" />{busy === "share" ? "Sharing…" : "Share"}</button>
        </div>
      </div>

      <div className="sharing-block">
        <h3><Mail aria-hidden="true" /> Email the recap again</h3>
        {recapSent ? <>
          <TeamRecipientChips id="resend-recipients" label="Send to" value={resendTo} onChange={setResendTo} groupIds={resendTeams} onGroupIdsChange={setResendTeams}
            teams={teams} members={members.filter((member) => member.status === "active" && member.email)} placeholder="name@company.com or type @" disabled={busy !== null}
            hint="Type @ for teammates or a team, or enter anyone's address. The MOM itself doesn't change." />
          <SwitchField id="resend-transcript" label="Attach the full timestamped transcript (.md)" checked={attachTranscript} onChange={setAttachTranscript} />
          <div className="button-group end">
            <button type="button" className="button secondary" disabled={busy !== null || (!resendTo.length && !resendTeams.length) || invalidResend} onClick={() => void resend()}><Send aria-hidden="true" />{busy === "resend" ? "Sending…" : "Send again"}</button>
          </div>
        </> : <Alert tone="info">Send the recap from MOM & follow-up first. After that you can email it again to anyone who missed it.</Alert>}
      </div>

      <SharingHistory sharing={sharing} members={members} busy={busy} onRevoke={(id, name) => void revoke(id, name)} />
    </div>
  </section>;
}

function SharingHistory({ sharing, members, busy, onRevoke }: { sharing: MeetingSharing | null; members: WorkspaceMember[]; busy: string | null; onRevoke(id: string, name: string): void }) {
  const names = useMemo(() => new Map(members.filter((member) => member.email).map((member) => [member.email!.toLowerCase(), member.display_name])), [members]);
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
      {sharing.deliveries.map((delivery) => <DeliveryRow key={delivery.id} delivery={delivery} names={names} />)}
    </ul> : null}
  </div>;
}

/** Every recipient, by name when they are a teammate; long lists collapse behind "Show all". */
function DeliveryRow({ delivery, names }: { delivery: RecapDelivery; names: Map<string, string> }) {
  const [expanded, setExpanded] = useState(false);
  const failed = delivery.status !== "sent";
  const shown = expanded ? delivery.recipients : delivery.recipients.slice(0, RECIPIENTS_SHOWN);
  const hidden = delivery.recipients.length - shown.length;
  return <li className={failed ? "failed" : undefined}>
    <span className="sharing-mail-icon" aria-hidden="true"><Mail /></span>
    <div className="sharing-line">
      <b className="sr-only">{delivery.recipients.length} recipient{delivery.recipients.length === 1 ? "" : "s"}</b>
      <ul className="sharing-recipients" aria-label="Recipients">
        {shown.map((email) => { const name = names.get(email.toLowerCase()); return <li key={email} title={email}>{name ? <>{name} <span>{email}</span></> : email}</li>; })}
        {hidden > 0 ? <li><button type="button" className="text-button" onClick={() => setExpanded(true)}>Show all {delivery.recipients.length}</button></li> : null}
        {expanded && delivery.recipients.length > RECIPIENTS_SHOWN ? <li><button type="button" className="text-button" onClick={() => setExpanded(false)}>Show fewer</button></li> : null}
      </ul>
      <small>{delivery.kind === "resend" ? "Sent again" : "Recap sent"} {formatDateTime(delivery.created_at)}{delivery.sent_by ? ` by ${delivery.sent_by.display_name}` : ""}{delivery.include_transcript ? " · transcript attached" : ""}</small>
      {failed && delivery.error ? <small className="inline-error">{delivery.error}</small> : null}
    </div>
    <Badge tone={failed ? "danger" : delivery.kind === "resend" ? "info" : "success"}>{failed ? "Failed" : delivery.kind === "resend" ? "Resent" : "Recap"}</Badge>
  </li>;
}
