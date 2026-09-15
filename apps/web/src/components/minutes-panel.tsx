"use client";

import { useEffect, useMemo, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { MeetingDetail, MeetingMinutes, MinutesDraft } from "@/lib/types";

type EditableDraft = {
  title: string;
  summary: string;
  discussion: string;
  decisions: string;
  actions: string;
  questions: string;
};

const captureInProgress = new Set<MeetingDetail["status"]>([
  "created", "joining", "waiting_room", "live", "needs_attention", "stopping", "processing",
]);

export function MinutesPanel({ meeting, transcriptCount }: { meeting: MeetingDetail; transcriptCount: number }) {
  const [minutes, setMinutes] = useState<MeetingMinutes | null>(null);
  const [draft, setDraft] = useState<EditableDraft | null>(null);
  const [busy, setBusy] = useState<"generate" | "save" | "approve" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recipients, setRecipients] = useState("");
  const [includeTranscript, setIncludeTranscript] = useState(false);

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

  const canGenerate = !captureInProgress.has(meeting.status) && transcriptCount > 0;
  const recipientList = useMemo(
    () => [...new Set(recipients.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean))],
    [recipients],
  );

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
    if (!recipientList.length) { setError("Enter at least one recipient email address."); return; }
    setBusy("send"); setError(null); setNotice(null);
    try {
      const delivery = await meetingsService.sendMinutes(meeting.id, recipientList, includeTranscript);
      const refreshed = await meetingsService.getMinutes(meeting.id);
      if (refreshed) accept(refreshed);
      setNotice(`Recap sent to ${delivery.recipients.length} recipient${delivery.recipients.length === 1 ? "" : "s"}.`);
    } catch (requestError) { setError(messageFor(requestError)); }
    finally { setBusy(null); }
  }

  return <section className="minutes-panel" aria-labelledby="minutes-title">
    <div className="minutes-heading">
      <div><p className="eyebrow">POST-MEETING WORKFLOW</p><h2 id="minutes-title">MOM & follow-up</h2><p>Generate from the finalized transcript, review the draft, then approve it before sending.</p></div>
      {minutes ? <span className={`minutes-status ${minutes.status}`}>{minutes.status}</span> : null}
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="mom-notice" role="status">{notice}</p> : null}

    {!minutes || !draft ? <div className="mom-empty">
      <div><b>No MOM draft yet.</b><p>{canGenerate ? `${transcriptCount} transcript segment${transcriptCount === 1 ? " is" : "s are"} ready for summarization.` : captureInProgress.has(meeting.status) ? "Stop the assistant before generating the MOM." : "A finalized transcript is required."}</p></div>
      <button className="button primary" disabled={!canGenerate || busy !== null} onClick={() => void generate()}>{busy === "generate" ? "Generating…" : "Generate MOM"}</button>
    </div> : <div className="mom-editor">
      <label>Title<input value={draft.title} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>Executive summary<textarea rows={5} value={draft.summary} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label>
      <div className="mom-columns">
        <label>Discussion points <span>one per line</span><textarea rows={6} value={draft.discussion} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, discussion: event.target.value })} /></label>
        <label>Decisions <span>one per line</span><textarea rows={6} value={draft.decisions} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, decisions: event.target.value })} /></label>
      </div>
      <label>Action items <span>description | owner | due date — one per line</span><textarea rows={6} value={draft.actions} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, actions: event.target.value })} /></label>
      <label>Open questions <span>one per line</span><textarea rows={5} value={draft.questions} disabled={minutes.status === "sent"} onChange={(event) => setDraft({ ...draft, questions: event.target.value })} /></label>
      <div className="mom-meta"><span>Generated with {minutes.provider ?? "configured provider"} · {minutes.model ?? "selected model"}</span><button className="text-button" disabled={!canGenerate || busy !== null} onClick={() => void generate()}>Regenerate draft</button></div>

      {minutes.status !== "sent" ? <div className="mom-review-actions">
        <button className="button secondary" disabled={busy !== null} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save draft"}</button>
        <button className="button primary" disabled={busy !== null} onClick={() => void approve()}>{busy === "approve" ? "Approving…" : minutes.status === "approved" ? "Reapprove changes" : "Save & approve"}</button>
      </div> : null}

      {minutes.status === "approved" ? <div className="delivery-box">
        <h3>Send approved recap</h3><p>The application sends only this approved version. Separate addresses with commas or new lines.</p>
        <label>Recipients<textarea rows={3} placeholder="name@company.com" value={recipients} onChange={(event) => setRecipients(event.target.value)} /></label>
        <label className="include-transcript"><input type="checkbox" checked={includeTranscript} onChange={(event) => setIncludeTranscript(event.target.checked)} /> Include the full transcript</label>
        <button className="button primary" disabled={busy !== null || !recipientList.length} onClick={() => void send()}>{busy === "send" ? "Sending…" : "Send recap"}</button>
      </div> : null}
      {minutes.status === "sent" ? <div className="sent-banner"><b>Recap sent</b><p>This approved MOM is locked. Regenerate to begin a new draft.</p></div> : null}
    </div>}
  </section>;
}

function toEditable(minutes: MeetingMinutes): EditableDraft {
  return {
    title: minutes.title,
    summary: minutes.executive_summary,
    discussion: minutes.discussion_points.join("\n"),
    decisions: minutes.decisions.join("\n"),
    actions: minutes.action_items.map((item) => [item.description, item.owner ?? "", item.due_date ?? ""].join(" | ")).join("\n"),
    questions: minutes.open_questions.join("\n"),
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
    action_items: lines(draft.actions).map((line) => {
      const [description = "", owner = "", dueDate = ""] = line.split("|").map((part) => part.trim());
      return { description, owner: owner || null, due_date: dueDate || null };
    }),
    open_questions: lines(draft.questions),
  };
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The MOM workflow could not be completed.";
}
