"use client";

import { FormEvent, useId, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { MeetingDetail } from "@/lib/types";

export function NewMeetingDialog({ open, onClose, onMeetingJoined }: { open: boolean; onClose(): void; onMeetingJoined(meeting: MeetingDetail): void }) {
  const titleId = useId();
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  if (!open) return null;

  function close() { setError(null); setJoining(false); onClose(); }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setJoining(true);
    try {
      const meeting = await meetingsService.createMeeting({
        meetingUrl: String(form.get("meeting-link") ?? ""),
        title: String(form.get("meeting-title") ?? "") || undefined,
        botName: String(form.get("bot-name") ?? "") || undefined,
      });
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
  return <div className="dialog-backdrop" role="presentation" onMouseDown={close}>
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
      <button className="close-button" onClick={close} aria-label="Close">×</button>
      <p className="eyebrow">SEND YOUR ASSISTANT</p><h2 id={titleId}>Join a meeting</h2>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="meeting-link">Meeting link</label>
        <input id="meeting-link" name="meeting-link" type="url" required placeholder="https://meet.google.com/..." autoFocus disabled={joining} />
        <label htmlFor="meeting-title">Meeting name <span className="optional">optional</span></label>
        <input id="meeting-title" name="meeting-title" placeholder="e.g. Product discovery" disabled={joining} />
        <label htmlFor="bot-name">Assistant name</label>
        <input id="bot-name" name="bot-name" defaultValue="Meetings AI" disabled={joining} />
        <div className="disclosure"><span aria-hidden="true">ⓘ</span><p><b>Disclosure is required.</b> Before sending, confirm the host will announce: “Meetings AI has joined and will record and transcribe this conversation.”</p></div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button className="button secondary" type="button" onClick={close} disabled={joining}>Cancel</button><button className="button primary" type="submit" disabled={joining}>{joining ? "Creating and joining…" : "Send assistant"}</button></div>
      </form>
    </section>
  </div>;
}
