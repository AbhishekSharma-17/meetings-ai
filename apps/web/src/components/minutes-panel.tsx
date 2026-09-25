"use client";

import { useEffect, useMemo, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { ActionItem, AttributedQuestion, MeetingDeliverySettings, MeetingDetail, MeetingMinutes, MinutesDraft, MomGuidance, PostMeetingJob, ResendStatus, SpeakerContribution, TranscriptSegment } from "@/lib/types";

type EditableDraft = {
  title: string;
  summary: string;
  discussion: string;
  decisions: string;
  actions: ActionItem[];
  questions: string;
  contributions: SpeakerContribution[];
  questionsAsked: AttributedQuestion[];
};

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
  const [resendStatus, setResendStatus] = useState<ResendStatus | null>(null);
  const [resendStatusError, setResendStatusError] = useState(false);
  const [postMeetingJob, setPostMeetingJob] = useState<PostMeetingJob | null>(null);
  const [momGuidance, setMomGuidance] = useState<MomGuidance>(defaultMomGuidance);
  const [momFocusInput, setMomFocusInput] = useState("");
  const [savingGuidance, setSavingGuidance] = useState(false);

  useEffect(() => {
    let current = true;
    void meetingsService.getMomGuidance(meeting.id).then((value) => {
      if (current) { setMomGuidance(value); setMomFocusInput(value.focus_fields.join(", ")); }
    }).catch(() => { if (current) setError("Could not load MOM format settings."); });
    return () => { current = false; };
  }, [meeting.id]);

  async function saveGuidance() {
    setSavingGuidance(true); setError(null);
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
    setMomDeleted(false);
  }

  async function deleteDraft() {
    setBusy("delete"); setError(null); setNotice(null);
    try {
      await meetingsService.deleteMinutes(meeting.id);
      setMinutes(null); setDraft(null); setMomDeleted(true); setConfirmDelete(false);
      setPostMeetingJob(await meetingsService.getPostMeetingJob(meeting.id));
      setNotice("MOM deleted. Its indexed facts and saved AI answers citing this meeting were cleared; the transcript remains.");
    } catch (cause) { setError(messageFor(cause)); }
    finally { setBusy(null); }
  }

  async function generate() {
    setBusy("generate"); setError(null); setNotice(null);
    try {
      await meetingsService.saveMomGuidance(meeting.id, { ...momGuidance, focus_fields: momFocusInput.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean) });
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
      const saved = await meetingsService.saveMinutes(meeting.id, toPayload(draft));
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
      await meetingsService.saveMinutes(meeting.id, toPayload(draft));
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
    <details className="mom-guidance-panel"><summary>MOM template & custom focus</summary><p>Guides the next AI draft. The transcript and its evidence remain authoritative.</p><div className="mom-guidance-grid"><label>Template<select value={momGuidance.template} disabled={minutes?.status === "sent"} onChange={(event) => setMomGuidance({ ...momGuidance, template: event.target.value as MomGuidance["template"] })}><option value="standard">Balanced meeting minutes</option><option value="actions">Decisions & action tracker</option><option value="client">Client recap</option><option value="discovery">Discovery notes</option><option value="custom">Custom focus</option></select></label><label>Focus fields <small>comma-separated</small><input value={momFocusInput} disabled={minutes?.status === "sent"} onChange={(event) => setMomFocusInput(event.target.value)} placeholder="Risks, Budget, Dependencies" /></label></div><label>Organizer guidance<textarea rows={3} maxLength={2000} value={momGuidance.instructions} disabled={minutes?.status === "sent"} onChange={(event) => setMomGuidance({ ...momGuidance, instructions: event.target.value })} placeholder="What should the draft emphasize?" /></label><p>Supported focus fields become labelled discussion points. Unsaid details are omitted.</p>{minutes?.status !== "sent" ? <button className="button secondary" type="button" disabled={savingGuidance} onClick={() => void saveGuidance()}>{savingGuidance ? "Saving…" : "Save MOM format"}</button> : null}</details>

    {!minutes || !draft ? <div className="mom-empty">
      <div><b>No MOM draft yet.</b><p>{momDeleted ? "The MOM was deleted. Generate a new draft manually if needed." : postMeetingJob?.last_error ? `Automatic drafting ${postMeetingJob.exhausted ? "stopped after repeated failures" : "will retry"}: ${postMeetingJob.last_error}. You can try Generate MOM manually.` : postMeetingJob?.enabled === false ? "This meeting predates automatic drafting. Generate its MOM manually." : canGenerate ? `Automatic drafting is in progress. ${transcriptCount} transcript segment${transcriptCount === 1 ? " is" : "s are"} available; you can also generate manually.` : captureInProgress.has(meeting.status) ? "The MOM will be drafted after capture completes." : "A finalized transcript is required."}</p></div>
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
      <div className="mom-action-list"><div className="section-heading"><div><h3>Action items</h3><p>Owners and dates should reflect what was explicitly agreed. Every action needs transcript evidence.</p></div>{minutes.status !== "sent" ? <button type="button" className="button secondary" onClick={() => setDraft({ ...draft, actions: [...draft.actions, { description: "", owner: null, due_date: null, evidence_segment_ids: [] }] })}>Add action</button> : null}</div>{draft.actions.map((item, index) => <div className="mom-action-card" key={index}><label>Action<input value={item.description} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, actions: draft.actions.map((entry, position) => position === index ? { ...entry, description: event.target.value } : entry) })} /></label><div className="mom-columns"><label>Owner<input value={item.owner ?? ""} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, actions: draft.actions.map((entry, position) => position === index ? { ...entry, owner: event.target.value || null } : entry) })} /></label><label>Due date<input value={item.due_date ?? ""} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, actions: draft.actions.map((entry, position) => position === index ? { ...entry, due_date: event.target.value || null } : entry) })} /></label></div><EvidenceLinks ids={item.evidence_segment_ids ?? []} segments={segments} />{minutes.status !== "sent" ? <><div className="mom-evidence-remove">{(item.evidence_segment_ids ?? []).map((id) => <button type="button" className="text-button" key={id} onClick={() => setDraft({ ...draft, actions: draft.actions.map((entry, position) => position === index ? { ...entry, evidence_segment_ids: (entry.evidence_segment_ids ?? []).filter((evidenceId) => evidenceId !== id) } : entry) })}>Remove {evidenceTime(id, segments)} evidence</button>)}</div><label className="mom-evidence-add">Add transcript evidence<select value="" onChange={(event) => { const value = event.target.value; if (value) setDraft({ ...draft, actions: draft.actions.map((entry, position) => position === index ? { ...entry, evidence_segment_ids: [...new Set([...(entry.evidence_segment_ids ?? []), value])] } : entry) }); }}><option value="">Choose a transcript turn</option>{segments.filter((segment) => segment.isFinal).map((segment) => <option key={segment.segmentId} value={segment.segmentId}>{evidenceTime(segment.segmentId, segments)} · {segment.speaker} · {segment.text.slice(0, 80)}</option>)}</select></label><button type="button" className="text-button destructive" onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, position) => position !== index) })}>Remove action</button></> : null}</div>)}</div>
      <label>Open questions <span>one per line</span><textarea rows={5} value={draft.questions} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, questions: event.target.value })} /></label>
      <div className="attribution-review"><h3>Who said what</h3><p>Each claim links to transcript evidence. Correct a speaker in the transcript and regenerate if attribution is wrong.</p>{draft.contributions.length ? draft.contributions.map((item, index) => <div className="attribution-item" key={`${item.speaker}-${index}`}><b>{item.speaker}</b><textarea aria-label={`Contribution by ${item.speaker}`} rows={2} value={item.summary} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, contributions: draft.contributions.map((entry, position) => position === index ? { ...entry, summary: event.target.value } : entry) })} /><EvidenceLinks ids={item.evidence_segment_ids} segments={segments} />{minutes.status !== "sent" ? <button className="text-button" onClick={() => setDraft({ ...draft, contributions: draft.contributions.filter((_, position) => position !== index) })}>Remove claim</button> : null}</div>) : <p>No named-speaker contributions were extracted.</p>}</div>
      <div className="attribution-review"><h3>Questions asked</h3>{draft.questionsAsked.length ? draft.questionsAsked.map((item, index) => <div className="attribution-item" key={`${item.speaker ?? "unknown"}-${index}`}><b>{item.speaker ?? "Unidentified speaker"}</b><textarea aria-label={`Question asked by ${item.speaker ?? "unidentified speaker"}`} rows={2} value={item.question} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, questionsAsked: draft.questionsAsked.map((entry, position) => position === index ? { ...entry, question: event.target.value } : entry) })} /><EvidenceLinks ids={item.evidence_segment_ids} segments={segments} />{minutes.status !== "sent" ? <button className="text-button" onClick={() => setDraft({ ...draft, questionsAsked: draft.questionsAsked.filter((_, position) => position !== index) })}>Remove question</button> : null}</div>) : <p>No direct questions were extracted.</p>}</div>
      <div className="mom-meta"><span>Generated with {minutes.provider ?? "configured provider"} · {minutes.model ?? "selected model"}</span>{minutes.status !== "sent" ? <button className="text-button" disabled={!canGenerate || busy !== null} onClick={() => void generate()}>Regenerate draft</button> : null}</div>
      {minutes.status !== "sent" ? <div className="mom-delete-control">{confirmDelete ? <div className="mom-delete-confirm"><b>Delete this MOM?</b><p>The transcript stays, but the draft, approval, indexed facts, and saved AI answers citing this meeting will be removed.</p><button className="button secondary" disabled={busy !== null} onClick={() => setConfirmDelete(false)}>Cancel</button><button className="button danger" disabled={busy !== null} onClick={() => void deleteDraft()}>{busy === "delete" ? "Deleting…" : "Confirm delete MOM"}</button></div> : <button className="text-button destructive" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>Delete MOM draft</button>}</div> : null}

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
        <label className="include-transcript"><input type="checkbox" checked={includeTranscript} onChange={(event) => setIncludeTranscript(event.target.checked)} /> Attach the full timestamped transcript (.md)</label>
        <div className="dialog-actions"><button className="button secondary" disabled={busy !== null} onClick={() => void saveDeliverySettings()}>Save recipients</button><button className="button primary" disabled={busy !== null || !recipientList.length || (shareParticipants && !participantList.length) || !resendStatus?.can_attempt_send} onClick={() => void send()}>{busy === "send" ? "Sending…" : "Send recap"}</button></div>
      </div> : null}
      {minutes.status === "sent" ? <div className="sent-banner"><b>Recap sent</b><p>This delivered MOM is locked. Corrections require a future versioned workflow.</p></div> : null}
    </div>}
  </section>;
}

function toEditable(minutes: MeetingMinutes): EditableDraft {
  return {
    title: readableText(minutes.title),
    summary: readableText(minutes.executive_summary),
    discussion: minutes.discussion_points.map(readableText).join("\n"),
    decisions: minutes.decisions.map(readableText).join("\n"),
    actions: minutes.action_items.map((item) => ({ ...item, description: readableText(item.description) })),
    questions: minutes.open_questions.map(readableText).join("\n"),
    contributions: (minutes.speaker_contributions ?? []).map((item) => ({ ...item, summary: readableText(item.summary) })),
    questionsAsked: (minutes.questions_asked ?? []).map((item) => ({ ...item, question: readableText(item.question) })),
  };
}

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function toPayload(draft: EditableDraft): MinutesDraft {
  return {
    title: draft.title.trim(),
    executive_summary: draft.summary.trim(),
    discussion_points: lines(draft.discussion),
    decisions: lines(draft.decisions),
    action_items: draft.actions.filter((item) => item.description.trim()).map((item) => ({ ...item, description: item.description.trim(), owner: item.owner?.trim() || null, due_date: item.due_date?.trim() || null })),
    open_questions: lines(draft.questions),
    speaker_contributions: draft.contributions,
    questions_asked: draft.questionsAsked,
  };
}

function EvidenceLinks({ ids, segments }: { ids: string[]; segments: TranscriptSegment[] }) {
  return <div className="evidence-links">Transcript proof <small>(elapsed from first captured turn)</small>: {ids.map((id) => {
    const segment = segments.find((item) => item.segmentId === id);
    return <a key={id} href={`#transcript-${encodeURIComponent(id)}`} title={segment ? `Open ${segment.speaker}'s transcript turn: ${segment.text.slice(0, 100)}` : "Open transcript evidence"}>At {evidenceTime(id, segments)}</a>;
  })}</div>;
}

function readableText(value: string): string {
  return value.replace(/\[[^\]]*csrc-[^\]]+\]/g, "").replace(/csrc-[A-Za-z0-9:._-]+/g, "transcript source").replace(/\s{2,}/g, " ").trim();
}

function evidenceTime(id: string, segments: TranscriptSegment[]): string {
  const segment = segments.find((item) => item.segmentId === id);
  const first = segments.find((item) => item.startedAt !== null);
  if (!segment || !first) return "View transcript";
  const numeric = (value: string | number | null): number | null => typeof value === "number" ? value : value ? Date.parse(value) / 1000 : null;
  const at = numeric(segment.startedAt);
  const start = numeric(first.startedAt);
  if (at === null || start === null || !Number.isFinite(at - start)) return "View transcript";
  const seconds = Math.max(0, Math.floor(at - start));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The MOM workflow could not be completed.";
}
