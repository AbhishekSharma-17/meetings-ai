"use client";

import { FormEvent, useEffect, useId, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { KnowledgeBase, MeetingDetail } from "@/lib/types";
import type { CalendarSelection } from "./calendar-import-dialog";

export function NewMeetingDialog({ open, onClose, onMeetingJoined, calendarSelection }: { open: boolean; onClose(): void; onMeetingJoined(meeting: MeetingDetail): void; calendarSelection?: CalendarSelection | null }) {
  const titleId = useId();
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [basesError, setBasesError] = useState<string | null>(null);
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(false);
  const [selectedBaseId, setSelectedBaseId] = useState("");
  const [newBaseName, setNewBaseName] = useState("");
  const [tagInput, setTagInput] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    void meetingsService.listKnowledgeBases().then((items) => {
      if (active) { setBases(items); setBasesError(null); }
    }).catch(() => {
      if (active) { setBases([]); setBasesError("Knowledge bases could not be loaded. Please retry or choose a new name."); }
    });
    return () => { active = false; };
  }, [open]);
  if (!open) return null;

  function close() { setError(null); setJoining(false); setSelectedBaseId(""); setNewBaseName(""); setTagInput(""); setKnowledgeEnabled(false); onClose(); }

  async function resolveKnowledgeBaseId(): Promise<string | null> {
    if (!knowledgeEnabled) return null;
    const name = newBaseName.trim();
    if (!name) return selectedBaseId || null;
    const matches = (items: KnowledgeBase[]) => items.find((base) => base.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
    const existing = matches(bases);
    if (existing) return existing.id;
    try {
      const created = await meetingsService.createKnowledgeBase(name);
      setBases((items) => [...items, created]);
      return created.id;
    } catch (createError) {
      if ((createError as { status?: number }).status !== 409) throw createError;
      // A second tab or another teammate may have created this base since the dialog opened.
      const latest = await meetingsService.listKnowledgeBases().catch(() => {
        throw new Error(`A knowledge base named “${name}” already exists, but the available bases could not be loaded. Refresh the page and select it, or ask an administrator for access.`);
      });
      setBases(latest);
      setBasesError(null);
      const concurrent = matches(latest);
      if (concurrent) return concurrent.id;
      throw new Error(`A knowledge base named “${name}” already exists, but you cannot access it. Ask its owner to share it or choose another name.`);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setJoining(true);
    try {
      const deliverySettings = {
        internal_recipients: addresses(String(form.get("internal-recipients") ?? "")),
        participant_recipients: addresses(String(form.get("participant-recipients") ?? "")),
        send_to_participants: form.get("share-participants") === "on",
        include_transcript: form.get("include-transcript") === "on",
      };
      if (deliverySettings.send_to_participants && deliverySettings.participant_recipients.length === 0) {
        throw new Error("Add at least one participant email address, or turn off participant delivery.");
      }
      const knowledgeBaseId = await resolveKnowledgeBaseId();
      const input = {
        meetingUrl: String(form.get("meeting-link") ?? ""),
        title: String(form.get("meeting-title") ?? "") || undefined,
        botName: String(form.get("bot-name") ?? "") || undefined,
        tags: tagInput.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean),
        knowledgeEnabled,
        knowledgeBaseId,
        deliverySettings,
      };
      const shouldSchedule = calendarSelection && new Date(calendarSelection.event.starts_at).getTime() > Date.now() + 60_000;
      if (shouldSchedule) {
        const scheduled = await meetingsService.scheduleCalendarEvent(calendarSelection.event, calendarSelection.period, calendarSelection.timezone, input);
        onMeetingJoined(scheduled);
        return;
      }
      const meeting = await meetingsService.createMeeting(input);
      try {
        const joined = await meetingsService.joinMeeting(meeting.id);
        onMeetingJoined(joined);
      } catch (joinError) {
        // The API persists adapter failures on the meeting record. Open that
        // durable record so the user can see the reason and retry from there.
        const failed = await meetingsService.getMeeting(meeting.id).catch(() => null);
        if (failed) {
          onMeetingJoined(failed);
          return;
        }
        throw joinError;
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "We could not start the assistant. Please try again.");
    } finally {
      setJoining(false);
    }
  }
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !joining) close(); }}>
    <Dialog.Portal>
    <Dialog.Backdrop className="dialog-backdrop" />
    <Dialog.Popup className="dialog" aria-labelledby={titleId}>
      <Dialog.Close className="close-button" aria-label="Close" disabled={joining}><X /></Dialog.Close>
      <p className="eyebrow">NEW CAPTURE</p><Dialog.Title id={titleId}>{calendarSelection ? "Review calendar meeting" : "Send your assistant"}</Dialog.Title><Dialog.Description className="dialog-intro">{calendarSelection ? `From your ${calendarSelection.event.provider === "googlecalendar" ? "Google" : "Outlook"} calendar · ${new Date(calendarSelection.event.starts_at).toLocaleString()}. Future meetings are scheduled automatically; meetings starting now join immediately.` : "Paste a meeting link to start a capture. You’ll review the transcript and minutes here before anything is emailed."}</Dialog.Description>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="meeting-link">Meeting link</label>
        <input id="meeting-link" name="meeting-link" type="url" required placeholder="https://meet.google.com/..." autoFocus defaultValue={calendarSelection?.event.meeting_url ?? ""} readOnly={Boolean(calendarSelection)} disabled={joining} />
        <label htmlFor="meeting-title">Meeting name <span className="optional">optional</span></label>
        <input id="meeting-title" name="meeting-title" placeholder="e.g. Product discovery" defaultValue={calendarSelection?.event.title ?? ""} disabled={joining} />
        <label htmlFor="bot-name">Assistant name</label>
        <input id="bot-name" name="bot-name" defaultValue="Meetings AI" disabled={joining} />
        <div className={knowledgeEnabled ? "meeting-knowledge-options enabled" : "meeting-knowledge-options"}>
          <label className="meeting-knowledge-primary"><input type="checkbox" name="knowledge-enabled" checked={knowledgeEnabled} onChange={(event) => setKnowledgeEnabled(event.target.checked)} disabled={joining} /><span><b>Add this meeting to AI knowledge</b><small>Connect its transcript and approved MOM to a searchable knowledge base after completion.</small></span></label>
          <div className="meeting-knowledge-fields"><label htmlFor="knowledge-base">Knowledge base <span className="optional">one per meeting</span></label>
          <select id="knowledge-base" name="knowledge-base" value={selectedBaseId} disabled={joining} onChange={(event) => { setSelectedBaseId(event.target.value); if (event.target.value) setKnowledgeEnabled(true); }}><option value="">No named knowledge base</option>{bases.map((base) => <option value={base.id} key={base.id}>{base.name}</option>)}</select>
          {basesError ? <p className="form-error" role="alert">{basesError}</p> : null}
          <label htmlFor="new-knowledge-base">Or create a knowledge base <span className="optional">optional</span></label>
          <input id="new-knowledge-base" name="new-knowledge-base" maxLength={120} placeholder="e.g. Acme client" value={newBaseName} disabled={joining} onChange={(event) => { setNewBaseName(event.target.value); if (event.target.value.trim()) setKnowledgeEnabled(true); }} />
          {newBaseName.trim() && bases.some((base) => base.name.trim().toLocaleLowerCase() === newBaseName.trim().toLocaleLowerCase()) ? <p role="status">This knowledge base already exists. The meeting will be added to it.</p> : null}
          <label htmlFor="meeting-tags">Knowledge tags <span className="optional">add multiple, separated by commas</span></label>
          <input id="meeting-tags" name="meeting-tags" value={tagInput} onChange={(event) => setTagInput(event.target.value)} placeholder="e.g. discovery, roadmap, Acme" disabled={joining} />
          {tagInput.trim() ? <div className="meeting-tag-preview" aria-label="Tags to add">{tagInput.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean).map((item, index) => <span key={`${item}:${index}`}>#{item}</span>)}</div> : null}
          <p>One knowledge base can hold many meetings. Tags can be multiple. An existing name reuses that base; a new name creates one.</p></div>
        </div>
        <details className="meeting-delivery-options">
          <summary>Recap delivery options</summary>
          <p>Recipients are saved with this meeting. No email is sent until you review and approve its MOM.</p>
          <label htmlFor="internal-recipients">Internal team email addresses</label>
          <textarea id="internal-recipients" name="internal-recipients" rows={2} placeholder="team@company.com" disabled={joining} />
          <label htmlFor="participant-recipients">Participant email addresses</label>
          <textarea id="participant-recipients" name="participant-recipients" rows={2} placeholder="optional; enter exact addresses" disabled={joining} />
          <label className="check-label"><input type="checkbox" name="share-participants" disabled={joining} /> Also send to listed participants after approval</label>
          <p>To enable participant delivery, add their email addresses above. Nothing is sent until the MOM is approved.</p>
          <label className="check-label"><input type="checkbox" name="include-transcript" disabled={joining} /> Include full transcript in the email</label>
        </details>
        <div className="disclosure"><span aria-hidden="true">ⓘ</span><p><b>Disclosure is required.</b> Before sending, confirm the host will announce: “Meetings AI has joined and will record and transcribe this conversation.”</p></div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button className="button secondary" type="button" onClick={close} disabled={joining}>Cancel</button><button className="button primary" type="submit" disabled={joining}>{joining ? "Saving…" : calendarSelection?.willSchedule ? "Schedule assistant" : "Send assistant"}</button></div>
      </form>
    </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function addresses(value: string): string[] {
  return [...new Set(value.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean))];
}
