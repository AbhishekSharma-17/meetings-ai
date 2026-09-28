"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, FilePenLine, FileText, RotateCcw, Trash2 } from "lucide-react";
import { jobService, meetingsService, serviceErrorStatus } from "@/lib/meetings-service";
import type { MeetingDeliverySettings, MeetingDetail, MeetingMinutes, MomGuidance, PostMeetingJob, ResendStatus, Team, TranscriptSegment, WorkspaceMember } from "@/lib/types";
import { Alert, EmptyState } from "./ui/feedback";
import { MinutesEditor, MinutesDocument } from "./minutes-editor";
import { MinutesFormat } from "./minutes-format";
import { RecapDeliveryCard } from "./minutes-delivery";
import { toEditable, toPayload, type EditableDraft } from "./minutes-support";
import { BackgroundJobHint } from "./background-job-hint";
import { useBackgroundJob } from "./use-background-job";
import type { BackgroundJob } from "@/lib/types";

const captureInProgress = new Set<MeetingDetail["status"]>([
  "created", "joining", "waiting_room", "live", "needs_attention", "stopping", "processing",
]);
const defaultMomGuidance: MomGuidance = { template: "standard", instructions: "", focus_fields: [] };

export function MinutesPanel({ meeting, transcriptCount, segments }: { meeting: MeetingDetail; transcriptCount: number; segments: TranscriptSegment[] }) {
  const [minutes, setMinutes] = useState<MeetingMinutes | null>(null);
  const [draft, setDraft] = useState<EditableDraft | null>(null);
  const [busy, setBusy] = useState<"generate" | "retry" | "save" | "approve" | "send" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [momDeleted, setMomDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recipients, setRecipients] = useState("");
  const [participantRecipients, setParticipantRecipients] = useState("");
  const [shareParticipants, setShareParticipants] = useState(false);
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [resendStatus, setResendStatus] = useState<ResendStatus | null>(null);
  const [resendStatusError, setResendStatusError] = useState(false);
  const [postMeetingJob, setPostMeetingJob] = useState<PostMeetingJob | null>(null);
  const [momGuidance, setMomGuidance] = useState<MomGuidance>(defaultMomGuidance);
  const [momFocusInput, setMomFocusInput] = useState("");
  const [savingGuidance, setSavingGuidance] = useState(false);
  const [messageAt, setMessageAt] = useState<"mom" | "delivery">("mom");
  // Manual drafts run as a server-side job: leaving the meeting does not stop it, and coming back resumes it.
  const minutesJob = useBackgroundJob("minutes_draft", meeting.id, {
    onResume: () => { setBusy("generate"); setMessageAt("mom"); },
    onFinish: (job) => finishMinutesJob(job),
  });

  useEffect(() => {
    let current = true;
    void meetingsService.getMomGuidance(meeting.id).then((value) => {
      if (current) { setMomGuidance(value); setMomFocusInput(value.focus_fields.join(", ")); }
    }).catch(() => { if (current) setError("Could not load MOM format settings."); });
    return () => { current = false; };
  }, [meeting.id]);

  async function saveGuidance() {
    setSavingGuidance(true); setMessageAt("mom"); setError(null);
    try {
      const saved = await meetingsService.saveMomGuidance(meeting.id, { ...momGuidance, focus_fields: momFocusInput.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean) });
      setMomGuidance(saved); setMomFocusInput(saved.focus_fields.join(", "));
      setNotice("MOM format saved. Regenerate an existing draft to apply it.");
    } catch (cause) { setError(messageFor(cause)); }
    finally { setSavingGuidance(false); }
  }

  useEffect(() => {
    let current = true;
    void meetingsService.getMinutes(meeting.id).then((value) => {
      if (!current) return;
      setMinutes(value);
      setDraft(value ? toEditable(value) : null);
    }).catch((requestError) => {
      if (current) setError(messageFor(requestError));
    });
    return () => { current = false; };
  }, [meeting.id]);

  useEffect(() => {
    let current = true;
    void meetingsService.getDeliverySettings(meeting.id).then((settings) => {
      if (!current) return;
      setRecipients(settings.internal_recipients.join(", "));
      setParticipantRecipients(settings.participant_recipients.join(", "));
      setShareParticipants(settings.send_to_participants);
      setIncludeTranscript(settings.include_transcript);
      setGroupIds(settings.internal_group_ids ?? []);
    }).catch((requestError) => { if (current) setError(messageFor(requestError)); });
    return () => { current = false; };
  }, [meeting.id]);

  // Teams and teammates for recipient suggestions; recipients still work by address without them.
  useEffect(() => {
    let current = true;
    void meetingsService.listTeams().then((items) => { if (current) setTeams(items); }).catch(() => undefined);
    void meetingsService.listWorkspaceMembers().then((items) => { if (current) setMembers(items); }).catch(() => undefined);
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (minutes || captureInProgress.has(meeting.status)) return;
    const poll = () => {
      void meetingsService.getMinutes(meeting.id).then((value) => {
        if (value) { setMinutes(value); setDraft(toEditable(value)); }
      }).catch(() => undefined);
      void meetingsService.getPostMeetingJob(meeting.id).then(setPostMeetingJob).catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 8000);
    return () => window.clearInterval(timer);
  }, [meeting.id, meeting.status, minutes]);

  useEffect(() => {
    if (!minutes) return;
    const timer = window.setInterval(() => {
      void meetingsService.getMinutes(meeting.id).then((next) => {
        if (next && next.status !== minutes.status) {
          setMinutes(next);
          setDraft(toEditable(next));
          if (next.status === "draft" && minutes.status === "approved") {
            setMessageAt("mom");
            setNotice("The transcript changed. Review and regenerate the MOM before approval.");
          }
        }
      }).catch(() => undefined);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [meeting.id, minutes]);

  useEffect(() => {
    let current = true;
    void meetingsService.getResendStatus().then((value) => {
      if (current) setResendStatus(value);
    }).catch(() => {
      if (current) setResendStatusError(true);
    });
    return () => { current = false; };
  }, []);

  const canGenerate = minutes?.status !== "sent" && !captureInProgress.has(meeting.status) && transcriptCount > 0;
  const recipientList = useMemo(
    () => [...new Set(recipients.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean))],
    [recipients],
  );
  const participantList = useMemo(
    () => [...new Set(participantRecipients.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean))],
    [participantRecipients],
  );

  function settingsPayload(): MeetingDeliverySettings {
    return {
      internal_recipients: recipientList,
      participant_recipients: participantList,
      send_to_participants: shareParticipants,
      include_transcript: includeTranscript,
      internal_group_ids: groupIds,
    };
  }

  async function saveDeliverySettings() {
    setMessageAt("delivery"); setError(null); setNotice(null);
    try {
      await meetingsService.saveDeliverySettings(meeting.id, settingsPayload());
      setNotice("Recipient choices saved for this meeting.");
    } catch (requestError) { setError(messageFor(requestError)); }
  }

  function accept(next: MeetingMinutes) {
    setMinutes(next);
    setDraft(toEditable(next));
    setMomDeleted(false);
  }

  async function deleteDraft() {
    setBusy("delete"); setMessageAt("mom"); setError(null); setNotice(null);
    try {
      await meetingsService.deleteMinutes(meeting.id);
      setMinutes(null); setDraft(null); setMomDeleted(true); setConfirmDelete(false);
      setPostMeetingJob(await meetingsService.getPostMeetingJob(meeting.id));
      setNotice("MOM deleted. Its indexed facts and saved AI answers citing this meeting were cleared; the transcript remains.");
    } catch (cause) { setError(messageFor(cause)); }
    finally { setBusy(null); }
  }

  async function generate() {
    setBusy("generate"); setMessageAt("mom"); setError(null); setNotice(null);
    let background = false;
    try {
      await meetingsService.saveMomGuidance(meeting.id, { ...momGuidance, focus_fields: momFocusInput.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean) });
      try {
        minutesJob.track(await jobService.startMinutes(meeting.id));
        background = true;
        return;
      } catch (cause) {
        const status = serviceErrorStatus(cause);
        if (status !== 404 && status !== 405) throw cause; // an API without background jobs drafts synchronously
      }
      accept(await meetingsService.generateMinutes(meeting.id));
      setNotice("MOM draft generated. Review every field before approval.");
    } catch (requestError) { setError(messageFor(requestError)); }
    finally { if (!background) setBusy(null); }
  }

  function finishMinutesJob(job: BackgroundJob) {
    setBusy(null); setMessageAt("mom");
    if (job.status === "failed") { setError(job.error ?? "MOM generation failed."); return; }
    if (job.status !== "succeeded") return;
    void meetingsService.getMinutes(meeting.id).then((value) => {
      if (value) { accept(value); setNotice("MOM draft generated. Review every field before approval."); }
    }).catch((requestError) => setError(messageFor(requestError)));
  }

  async function retryAutomaticDraft() {
    setBusy("retry"); setMessageAt("mom"); setError(null); setNotice(null);
    try {
      const job = await meetingsService.retryPostMeetingJob(meeting.id);
      setPostMeetingJob(job);
      const result = await meetingsService.getMinutes(meeting.id);
      if (result) {
        accept(result);
        setNotice("MOM draft recovered. Review every field before approval.");
      } else if (job.last_error) {
        setError(`Drafting still failed: ${job.last_error}`);
      }
    } catch (requestError) { setError(messageFor(requestError)); }
    finally { setBusy(null); }
  }

  async function save(): Promise<MeetingMinutes | null> {
    if (!draft) return null;
    setBusy("save"); setMessageAt("mom"); setError(null); setNotice(null);
    try {
      const saved = await meetingsService.saveMinutes(meeting.id, toPayload(draft));
      accept(saved);
      setNotice("Draft saved.");
      return saved;
    } catch (requestError) { setError(messageFor(requestError)); return null; }
    finally { setBusy(null); }
  }

  async function approve() {
    if (!draft) return;
    setBusy("approve"); setMessageAt("mom"); setError(null); setNotice(null);
    try {
      await meetingsService.saveMinutes(meeting.id, toPayload(draft));
      accept(await meetingsService.approveMinutes(meeting.id));
      setNotice("MOM approved and ready to send.");
    } catch (requestError) { setError(messageFor(requestError)); }
    finally { setBusy(null); }
  }

  async function send() {
    setMessageAt("delivery");
    if (!resendStatus?.can_attempt_send) { setError("Email delivery is not configured yet."); return; }
    if (!recipientList.length && !groupIds.length) { setError("Enter at least one recipient email address or team."); return; }
    setBusy("send"); setError(null); setNotice(null);
    try {
      await meetingsService.saveDeliverySettings(meeting.id, settingsPayload());
      const delivery = await meetingsService.sendConfiguredMinutes(meeting.id);
      const refreshed = await meetingsService.getMinutes(meeting.id);
      if (refreshed) accept(refreshed);
      setMessageAt("mom");
      const viaTeams = delivery.groups?.length ? ` (including ${delivery.groups.map((group) => group.name).join(", ")})` : "";
      setNotice(`Recap sent to ${delivery.recipients.length} recipient${delivery.recipients.length === 1 ? "" : "s"}${viaTeams}.`);
    } catch (requestError) { setError(messageFor(requestError)); }
    finally { setBusy(null); }
  }

  const locked = minutes?.status === "sent";
  const editable = Boolean(minutes && draft && !locked);
  const messages = error || notice ? <>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="form-success" role="status">{notice}</p> : null}
  </> : null;
  const inDelivery = messageAt === "delivery" && minutes?.status === "approved";
  const inFooter = editable && !inDelivery;

  return <div className="mom-stack">
    <section className="card mom-card" aria-labelledby="minutes-title">
      <div className="card-header">
        <div><h2 id="minutes-title">MOM & follow-up</h2><p>{minutes ? minutesSubtitle[minutes.status] : "Drafted automatically after capture. Nothing is sent until you approve it."}</p></div>
        {minutes ? <span className={`status ${minutes.status}`}>{minutesStatusLabel[minutes.status]}</span> : null}
      </div>
      <div className="card-body mom-body">
        {!inFooter && !inDelivery ? messages : null}
        {minutesJob.running ? <BackgroundJobHint>Drafting in the background — you can leave this page. We’ll notify you when it’s ready.</BackgroundJobHint> : null}
        {locked ? <Alert tone="success" title="Recap sent">This delivered MOM is locked. Corrections require a future versioned workflow.</Alert> : null}
        <MinutesFormat guidance={momGuidance} focusInput={momFocusInput} locked={locked} saving={savingGuidance} onGuidanceChange={setMomGuidance} onFocusInputChange={setMomFocusInput} onSave={() => void saveGuidance()} />
        {!minutes || !draft ? <EmptyState plain icon={<FileText />} title="No MOM draft yet." action={<div className="button-group">
          <button className="button primary" disabled={!canGenerate || busy !== null} onClick={() => void generate()}><FilePenLine aria-hidden="true" />{busy === "generate" ? "Generating…" : "Generate MOM"}</button>
          {postMeetingJob?.enabled && postMeetingJob.last_error && meeting.status === "ready" ? <button className="button secondary" disabled={busy !== null} onClick={() => void retryAutomaticDraft()}>{busy === "retry" ? "Retrying…" : "Retry automatic draft"}</button> : null}
        </div>}>{emptyMessage({ momDeleted, postMeetingJob, canGenerate, transcriptCount, capturing: captureInProgress.has(meeting.status) })}</EmptyState>
          : locked ? <MinutesDocument draft={draft} segments={segments} />
            : <MinutesEditor draft={draft} segments={segments} onChange={setDraft} />}
        {minutes && locked ? <p className="field-hint">Generated with {minutes.provider ?? "configured provider"} · {minutes.model ?? "selected model"}</p> : null}
        {editable ? <div className="mom-delete">{confirmDelete ? <div className="mom-delete-confirm" role="group" aria-label="Confirm MOM deletion">
          <p><b>Delete this MOM?</b> The transcript stays. The draft, approval, indexed facts and saved AI answers citing this meeting are removed.</p>
          <div className="button-group end">
            <button className="button ghost sm" disabled={busy !== null} onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button className="button danger sm" disabled={busy !== null} onClick={() => void deleteDraft()}>{busy === "delete" ? "Deleting…" : "Confirm delete MOM"}</button>
          </div>
        </div> : <button className="text-button destructive" disabled={busy !== null} onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden="true" /> Delete MOM draft</button>}</div> : null}
      </div>
      {editable && minutes ? <div className="card-footer mom-footer">
        {inFooter ? <div className="mom-footer-messages">{messages}</div> : null}
        <div className="mom-footer-row">
          <span className="mom-generator">Generated with {minutes.provider ?? "configured provider"} · {minutes.model ?? "selected model"}<button className="text-button" disabled={!canGenerate || busy !== null} onClick={() => void generate()}><RotateCcw aria-hidden="true" /> Regenerate draft</button></span>
          <div className="button-group end">
            <button className="button secondary" disabled={busy !== null} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save draft"}</button>
            <button className={minutes.status === "approved" ? "button secondary" : "button primary"} disabled={busy !== null} onClick={() => void approve()}><Check aria-hidden="true" />{busy === "approve" ? "Approving…" : minutes.status === "approved" ? "Reapprove changes" : "Save & approve"}</button>
          </div>
        </div>
      </div> : null}
    </section>
    {minutes?.status === "approved" ? <RecapDeliveryCard recipients={recipients} participantRecipients={participantRecipients} shareParticipants={shareParticipants} includeTranscript={includeTranscript}
      resendStatus={resendStatus} resendStatusError={resendStatusError} busy={busy} canSend={Boolean((recipientList.length || groupIds.length) && !(shareParticipants && !participantList.length) && resendStatus?.can_attempt_send)}
      messages={inDelivery ? messages : null} onRecipientsChange={setRecipients} teams={teams} members={members} groupIds={groupIds} onGroupIdsChange={setGroupIds} onParticipantRecipientsChange={setParticipantRecipients} onShareParticipantsChange={setShareParticipants} onIncludeTranscriptChange={setIncludeTranscript}
      onSave={() => void saveDeliverySettings()} onSend={() => void send()} /> : null}
  </div>;
}

const minutesStatusLabel: Record<MeetingMinutes["status"], string> = { draft: "Draft", approved: "Approved", sent: "Sent" };
const minutesSubtitle: Record<MeetingMinutes["status"], string> = {
  draft: "Review every field against the transcript, then approve.",
  approved: "Approved and ready to send. Edits need reapproval.",
  sent: "Delivered to recipients and locked.",
};

function emptyMessage({ momDeleted, postMeetingJob, canGenerate, transcriptCount, capturing }: { momDeleted: boolean; postMeetingJob: PostMeetingJob | null; canGenerate: boolean; transcriptCount: number; capturing: boolean }): string {
  if (momDeleted) return "The MOM was deleted. Generate a new draft manually if needed.";
  if (postMeetingJob?.last_error) return `Automatic drafting ${postMeetingJob.exhausted ? "stopped after repeated failures" : "will retry"}: ${postMeetingJob.last_error}. You can try Generate MOM manually.`;
  if (postMeetingJob?.enabled === false) return "This meeting predates automatic drafting. Generate its MOM manually.";
  if (canGenerate) return `Automatic drafting is in progress. ${transcriptCount} transcript segment${transcriptCount === 1 ? " is" : "s are"} available; you can also generate manually.`;
  if (capturing) return "The MOM will be drafted after capture completes.";
  return "A finalized transcript is required.";
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The MOM workflow could not be completed.";
}
