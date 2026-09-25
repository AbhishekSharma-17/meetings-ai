"use client";

import { useEffect, useMemo, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { AttributedQuestion, MeetingDeliverySettings, MeetingDetail, MeetingMinutes, MinutesDraft, PostMeetingJob, ResendStatus, SpeakerContribution, TranscriptSegment } from "@/lib/types";

type EditableDraft = {
  title: string;
  summary: string;
  discussion: string;
  decisions: string;
  actions: string;
  questions: string;
  contributions: SpeakerContribution[];
  questionsAsked: AttributedQuestion[];
};

const captureInProgress = new Set<MeetingDetail["status"]>([
  "created", "joining", "waiting_room", "live", "needs_attention", "stopping", "processing",
]);

export function MinutesPanel({ meeting, transcriptCount, segments }: { meeting: MeetingDetail; transcriptCount: number; segments: TranscriptSegment[] }) {
  const [minutes, setMinutes] = useState<MeetingMinutes | null>(null);
  const [draft, setDraft] = useState<EditableDraft | null>(null);
  const [busy, setBusy] = useState<"generate" | "retry" | "save" | "approve" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recipients, setRecipients] = useState("");
  const [participantRecipients, setParticipantRecipients] = useState("");
  const [shareParticipants, setShareParticipants] = useState(false);
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [resendStatus, setResendStatus] = useState<ResendStatus | null>(null);
  const [resendStatusError, setResendStatusError] = useState(false);
  const [postMeetingJob, setPostMeetingJob] = useState<PostMeetingJob | null>(null);

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
    }).catch((requestError) => { if (current) setError(messageFor(requestError)); });
    return () => { current = false; };
  }, [meeting.id]);

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
    };
  }

  async function saveDeliverySettings() {
    setError(null); setNotice(null);
    try {
      await meetingsService.saveDeliverySettings(meeting.id, settingsPayload());
      setNotice("Recipient choices saved for this meeting.");
    } catch (requestError) { setError(messageFor(requestError)); }
  }

  function accept(next: MeetingMinutes) {
    setMinutes(next);
    setDraft(toEditable(next));
  }

  async function generate() {
    setBusy("generate"); setError(null); setNotice(null);
    try {
      accept(await meetingsService.generateMinutes(meeting.id));
      setNotice("MOM draft generated. Review every field before approval.");
    } catch (requestError) { setError(messageFor(requestError)); }
    finally { setBusy(null); }
  }

  async function retryAutomaticDraft() {
    setBusy("retry"); setError(null); setNotice(null);
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
    setBusy("save"); setError(null); setNotice(null);
    try {
      const saved = await meetingsService.saveMinutes(meeting.id, toPayload(draft, minutes));
      accept(saved);
      setNotice("Draft saved.");
      return saved;
    } catch (requestError) { setError(messageFor(requestError)); return null; }
    finally { setBusy(null); }
  }

  async function approve() {
    if (!draft) return;
    setBusy("approve"); setError(null); setNotice(null);
    try {
      await meetingsService.saveMinutes(meeting.id, toPayload(draft, minutes));
      accept(await meetingsService.approveMinutes(meeting.id));
      setNotice("MOM approved and ready to send.");
    } catch (requestError) { setError(messageFor(requestError)); }
    finally { setBusy(null); }
  }

  async function send() {
    if (!resendStatus?.can_attempt_send) { setError("Email delivery is not configured yet."); return; }
    if (!recipientList.length) { setError("Enter at least one recipient email address."); return; }
    setBusy("send"); setError(null); setNotice(null);
    try {
      await meetingsService.saveDeliverySettings(meeting.id, settingsPayload());
      const delivery = await meetingsService.sendConfiguredMinutes(meeting.id);
      const refreshed = await meetingsService.getMinutes(meeting.id);
      if (refreshed) accept(refreshed);
      setNotice(`Recap sent to ${delivery.recipients.length} recipient${delivery.recipients.length === 1 ? "" : "s"}.`);
    } catch (requestError) { setError(messageFor(requestError)); }
    finally { setBusy(null); }
  }

  return <section className="minutes-panel" aria-labelledby="minutes-title">
    <div className="minutes-heading">
      <div><p className="eyebrow">POST-MEETING WORKFLOW</p><h2 id="minutes-title">MOM & follow-up</h2><p>A draft appears automatically after capture completes. Review and approve before sending.</p></div>
      {minutes ? <span className={`minutes-status ${minutes.status}`}>{minutes.status}</span> : null}
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="mom-notice" role="status">{notice}</p> : null}

    {!minutes || !draft ? <div className="mom-empty">
      <div><b>No MOM draft yet.</b><p>{postMeetingJob?.last_error ? `Automatic drafting ${postMeetingJob.exhausted ? "stopped after repeated failures" : "will retry"}: ${postMeetingJob.last_error}. You can try Generate MOM manually.` : postMeetingJob?.enabled === false ? "This meeting predates automatic drafting. Generate its MOM manually." : canGenerate ? `Automatic drafting is in progress. ${transcriptCount} transcript segment${transcriptCount === 1 ? " is" : "s are"} available; you can also generate manually.` : captureInProgress.has(meeting.status) ? "The MOM will be drafted after capture completes." : "A finalized transcript is required."}</p></div>
      <div className="mom-review-actions">
        <button className="button primary" disabled={!canGenerate || busy !== null} onClick={() => void generate()}>{busy === "generate" ? "Generating…" : "Generate MOM"}</button>
        {postMeetingJob?.enabled && postMeetingJob.last_error && meeting.status === "ready" ? <button className="button secondary" disabled={busy !== null} onClick={() => void retryAutomaticDraft()}>{busy === "retry" ? "Retrying…" : "Retry automatic draft"}</button> : null}
      </div>
    </div> : <div className="mom-editor">
      <label>Title<input value={draft.title} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>Executive summary<textarea rows={5} value={draft.summary} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label>
      <div className="mom-columns">
        <label>Discussion points <span>one per line</span><textarea rows={6} value={draft.discussion} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, discussion: event.target.value })} /></label>
        <label>Decisions <span>one per line</span><textarea rows={6} value={draft.decisions} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, decisions: event.target.value })} /></label>
      </div>
      <label>Action items <span>description | owner | due date | evidence IDs — one per line</span><textarea rows={6} value={draft.actions} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, actions: event.target.value })} /></label>
      <details className="evidence-picker"><summary>Find transcript evidence IDs</summary><ul>{segments.filter((segment) => segment.isFinal).map((segment) => <li key={segment.segmentId}><code>{segment.segmentId}</code> · {segment.speaker}: {segment.text}</li>)}</ul></details>
      <label>Open questions <span>one per line</span><textarea rows={5} value={draft.questions} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, questions: event.target.value })} /></label>
      <div className="attribution-review"><h3>Who said what</h3><p>Each claim links to transcript evidence. Correct a speaker in the transcript and regenerate if attribution is wrong.</p>{draft.contributions.length ? draft.contributions.map((item, index) => <div className="attribution-item" key={`${item.speaker}-${index}`}><b>{item.speaker}</b><textarea aria-label={`Contribution by ${item.speaker}`} rows={2} value={item.summary} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, contributions: draft.contributions.map((entry, position) => position === index ? { ...entry, summary: event.target.value } : entry) })} /><EvidenceLinks ids={item.evidence_segment_ids} segments={segments} />{minutes.status !== "sent" ? <button className="text-button" onClick={() => setDraft({ ...draft, contributions: draft.contributions.filter((_, position) => position !== index) })}>Remove claim</button> : null}</div>) : <p>No named-speaker contributions were extracted.</p>}</div>
      <div className="attribution-review"><h3>Questions asked</h3>{draft.questionsAsked.length ? draft.questionsAsked.map((item, index) => <div className="attribution-item" key={`${item.speaker ?? "unknown"}-${index}`}><b>{item.speaker ?? "Unidentified speaker"}</b><textarea aria-label={`Question asked by ${item.speaker ?? "unidentified speaker"}`} rows={2} value={item.question} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, questionsAsked: draft.questionsAsked.map((entry, position) => position === index ? { ...entry, question: event.target.value } : entry) })} /><EvidenceLinks ids={item.evidence_segment_ids} segments={segments} />{minutes.status !== "sent" ? <button className="text-button" onClick={() => setDraft({ ...draft, questionsAsked: draft.questionsAsked.filter((_, position) => position !== index) })}>Remove question</button> : null}</div>) : <p>No direct questions were extracted.</p>}</div>
      <div className="mom-meta"><span>Generated with {minutes.provider ?? "configured provider"} · {minutes.model ?? "selected model"}</span>{minutes.status !== "sent" ? <button className="text-button" disabled={!canGenerate || busy !== null} onClick={() => void generate()}>Regenerate draft</button> : null}</div>

      {minutes.status !== "sent" ? <div className="mom-review-actions">
        <button className="button secondary" disabled={busy !== null} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save draft"}</button>
        <button className="button primary" disabled={busy !== null} onClick={() => void approve()}>{busy === "approve" ? "Approving…" : minutes.status === "approved" ? "Reapprove changes" : "Save & approve"}</button>
      </div> : null}

      {minutes.status === "approved" ? <div className="delivery-box">
        <h3>Send approved recap</h3><p>The application sends only this approved version. Participant sharing is off unless you explicitly enable it.</p>
        {!resendStatus?.can_attempt_send ? <p className="form-error" role="status">{resendStatusError ? "Could not check email delivery configuration. Refresh and try again." : !resendStatus ? "Checking email delivery configuration…" : !resendStatus.api_key_configured ? "Resend API key is missing. Set RESEND_API_KEY on the API service." : "Sender address is missing. Set RESEND_FROM_EMAIL on the API service."}</p> : <p role="status">Sender: {resendStatus.sender}. Domain verification is confirmed only when Resend accepts a send.</p>}
        <label>Internal team recipients<textarea rows={2} placeholder="team@company.com" value={recipients} onChange={(event) => setRecipients(event.target.value)} /></label>
        <label>Participant recipients<textarea rows={2} placeholder="optional, exact email addresses" value={participantRecipients} onChange={(event) => setParticipantRecipients(event.target.value)} /></label>
        <label className="include-transcript"><input type="checkbox" checked={shareParticipants} onChange={(event) => setShareParticipants(event.target.checked)} /> Also send to listed participants</label>
        <label className="include-transcript"><input type="checkbox" checked={includeTranscript} onChange={(event) => setIncludeTranscript(event.target.checked)} /> Include the full transcript</label>
        <div className="dialog-actions"><button className="button secondary" disabled={busy !== null} onClick={() => void saveDeliverySettings()}>Save recipients</button><button className="button primary" disabled={busy !== null || !recipientList.length || (shareParticipants && !participantList.length) || !resendStatus?.can_attempt_send} onClick={() => void send()}>{busy === "send" ? "Sending…" : "Send recap"}</button></div>
      </div> : null}
      {minutes.status === "sent" ? <div className="sent-banner"><b>Recap sent</b><p>This delivered MOM is locked. Corrections require a future versioned workflow.</p></div> : null}
    </div>}
  </section>;
}

function toEditable(minutes: MeetingMinutes): EditableDraft {
  return {
    title: minutes.title,
    summary: minutes.executive_summary,
    discussion: minutes.discussion_points.join("\n"),
    decisions: minutes.decisions.join("\n"),
    actions: minutes.action_items.map((item) => [item.description, item.owner ?? "", item.due_date ?? "", (item.evidence_segment_ids ?? []).join(", ")].join(" | ")).join("\n"),
    questions: minutes.open_questions.join("\n"),
    contributions: minutes.speaker_contributions ?? [],
    questionsAsked: minutes.questions_asked ?? [],
  };
}

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function toPayload(draft: EditableDraft, previous: MeetingMinutes | null): MinutesDraft {
  return {
    title: draft.title.trim(),
    executive_summary: draft.summary.trim(),
    discussion_points: lines(draft.discussion),
    decisions: lines(draft.decisions),
    action_items: lines(draft.actions).map((line) => {
      const [description = "", owner = "", dueDate = "", evidence = ""] = line.split("|").map((part) => part.trim());
      const prior = previous?.action_items.find((item) => item.description === description);
      return { description, owner: owner || null, due_date: dueDate || null, evidence_segment_ids: evidence ? evidence.split(",").map((id) => id.trim()).filter(Boolean) : prior?.evidence_segment_ids ?? [] };
    }),
    open_questions: lines(draft.questions),
    speaker_contributions: draft.contributions,
    questions_asked: draft.questionsAsked,
  };
}

function EvidenceLinks({ ids, segments }: { ids: string[]; segments: TranscriptSegment[] }) {
  return <div className="evidence-links">Evidence: {ids.map((id) => {
    const segment = segments.find((item) => item.segmentId === id);
    const label = typeof segment?.startedAt === "number" ? `${Math.floor(segment.startedAt / 60)}:${Math.floor(segment.startedAt % 60).toString().padStart(2, "0")}` : id.slice(0, 10);
    return <a key={id} href={`#transcript-${encodeURIComponent(id)}`} title={id}>{label}</a>;
  })}</div>;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The MOM workflow could not be completed.";
}
