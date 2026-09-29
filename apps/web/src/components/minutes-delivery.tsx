"use client";

import type { ReactNode } from "react";
import { Send } from "lucide-react";
import type { ResendStatus, Team, WorkspaceMember } from "@/lib/types";
import { EmailChips } from "./ui/email-chips";
import { TeamRecipientChips } from "./team-recipient-chips";
import { Alert } from "./ui/feedback";
import { SwitchField } from "./ui/switch";

/** The panel keeps recipients as one comma-separated string; the chips edit it as a list. */
const toList = (value: string) => [...new Set(value.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean))];
const toText = (list: string[]) => list.join(", ");

function senderProblem(status: ResendStatus | null, statusError: boolean): string {
  if (statusError) return "Could not check email delivery configuration. Refresh and try again.";
  if (!status) return "Checking email delivery configuration…";
  if (!status.api_key_configured) return "Resend API key is missing. Set RESEND_API_KEY on the API service.";
  return "Sender address is missing. Set RESEND_FROM_EMAIL on the API service.";
}

/** Recipients and options for sending the approved recap. Only the approved version is ever sent. */
export function RecapDeliveryCard({ recipients, participantRecipients, shareParticipants, includeTranscript, resendStatus, resendStatusError, busy, canSend, messages, onRecipientsChange, onParticipantRecipientsChange, onShareParticipantsChange, onIncludeTranscriptChange, onSave, onSend, teams = [], members = [], groupIds = [], onGroupIdsChange }: {
  recipients: string;
  /** Internal teams targeted by reference; expanded to their current members at send time. */
  teams?: Team[];
  members?: WorkspaceMember[];
  groupIds?: string[];
  onGroupIdsChange?(next: string[]): void;
  participantRecipients: string;
  shareParticipants: boolean;
  includeTranscript: boolean;
  resendStatus: ResendStatus | null;
  resendStatusError: boolean;
  busy: string | null;
  canSend: boolean;
  messages: ReactNode;
  onRecipientsChange(value: string): void;
  onParticipantRecipientsChange(value: string): void;
  onShareParticipantsChange(value: boolean): void;
  onIncludeTranscriptChange(value: boolean): void;
  onSave(): void;
  onSend(): void;
}) {
  return <section className="card mom-delivery" aria-labelledby="mom-delivery-title">
    <div className="card-header">
      <div><h2 id="mom-delivery-title">Send approved recap</h2><p>Only this approved version is sent. Choose teammates, a team, the participants, or any mix. Participants receive it only if you turn that on.</p></div>
    </div>
    <div className="card-body form-stack">
      {!resendStatus?.can_attempt_send ? <Alert tone="warning" role="status">{senderProblem(resendStatus, resendStatusError)}</Alert>
        : <p className="field-hint" role="status">Sender: {resendStatus.sender}. Domain verification is confirmed only when Resend accepts a send.</p>}
      <div className="field-row">
        <TeamRecipientChips id="mom-internal-recipients" label="Internal team recipients" labelSuffix={<span className="optional">optional</span>} value={toList(recipients)} onChange={(list) => onRecipientsChange(toText(list))}
          groupIds={groupIds} onGroupIdsChange={onGroupIdsChange ?? (() => undefined)} teams={teams} members={members}
          placeholder={teams.length ? "team@company.com or @team" : "team@company.com"} />
        <EmailChips id="mom-participant-recipients" label="Participant recipients" labelSuffix={<span className="optional">optional</span>} value={toList(participantRecipients)} onChange={(list) => onParticipantRecipientsChange(toText(list))} placeholder="Exact addresses only" />
      </div>
      <div className="mom-delivery-switches">
        <SwitchField id="mom-share-participants" label="Also send to listed participants" checked={shareParticipants} onChange={onShareParticipantsChange} />
        <SwitchField id="mom-include-transcript" label="Attach the full timestamped transcript (.md)" checked={includeTranscript} onChange={onIncludeTranscriptChange} />
      </div>
    </div>
    <div className="card-footer mom-footer">
      {messages ? <div className="mom-footer-messages">{messages}</div> : null}
      <div className="button-group end">
        <button className="button secondary" disabled={busy !== null} onClick={onSave}>Save recipients</button>
        <button className="button primary" disabled={busy !== null || !canSend} onClick={onSend}><Send aria-hidden="true" />{busy === "send" ? "Sending…" : "Send recap"}</button>
      </div>
    </div>
  </section>;
}
