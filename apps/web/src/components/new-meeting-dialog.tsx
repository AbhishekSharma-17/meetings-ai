"use client";

import { FormEvent, useId, useState } from "react";

export function NewMeetingDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const titleId = useId();
  const [submitted, setSubmitted] = useState(false);
  if (!open) return null;

  function close() { setSubmitted(false); onClose(); }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
  }
  return <div className="dialog-backdrop" role="presentation" onMouseDown={close}>
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
      <button className="close-button" onClick={close} aria-label="Close">×</button>
      <p className="eyebrow">SEND YOUR ASSISTANT</p><h2 id={titleId}>Join a meeting</h2>
      {submitted ? <div className="success-state" role="status"><span>✓</span><div><b>Ready to join</b><p>The assistant will appear in the meeting lobby and announce its recording disclosure before it starts.</p></div></div> : <form onSubmit={submit}>
        <label htmlFor="meeting-link">Meeting link</label>
        <input id="meeting-link" type="url" required placeholder="https://meet.google.com/..." autoFocus />
        <label htmlFor="meeting-title">Meeting name <span className="optional">optional</span></label>
        <input id="meeting-title" placeholder="e.g. Product discovery" />
        <div className="disclosure"><span aria-hidden="true">ⓘ</span><p><b>Disclosure is on.</b> “Meetings AI has joined and will record and transcribe this conversation.”</p></div>
        <div className="dialog-actions"><button className="button secondary" type="button" onClick={close}>Cancel</button><button className="button primary" type="submit">Send assistant</button></div>
      </form>}
    </section>
  </div>;
}
