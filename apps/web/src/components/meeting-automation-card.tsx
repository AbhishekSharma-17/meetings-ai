"use client";

import { useEffect, useRef, useState } from "react";
import { calendarAutomationService as service, automationError, type MeetingAutomation } from "@/lib/calendar-automation-service";
import { Card } from "./ui/card";
import { Alert, Badge } from "./ui/feedback";

/** Per-occurrence exceptions never change a person's default calendar rule. */
export function MeetingAutomationCard({ meetingId, onChanged }: { meetingId: string; onChanged?(): void }) {
  const [view, setView] = useState<MeetingAutomation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    async function refresh() {
      if (document.hidden) { timer = window.setTimeout(() => void refresh(), 15_000); return; }
      const version = requestVersion.current;
      try {
        const next = await service.meeting(meetingId);
        if (!active) return;
        if (version === requestVersion.current) setView(next);
        if (next.automated) timer = window.setTimeout(() => void refresh(), 15_000);
      } catch { /* Older APIs and manual meetings have no automation record. */ }
    }
    void refresh();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [meetingId]);
  async function change(values: Partial<Pick<MeetingAutomation, "skip" | "hold_delivery">>) {
    requestVersion.current++;
    setBusy(true); setError(null);
    try { setView(await service.override(meetingId, values)); onChanged?.(); }
    catch (cause) { setError(automationError(cause, "The meeting override could not be saved. Try again; the previous setting still applies.")); }
    finally { setBusy(false); }
  }
  if (!view?.automated) return null;
  const needsReview = view.hold_delivery || view.delivery_status === "held" || !!view.last_error && /manual|review/.test(view.last_error);
  const stoppedManually = !!view.last_error && /stopped manually/i.test(view.last_error);
  const deletedManually = !!view.last_error && /MOM deleted manually/i.test(view.last_error);
  const changedManually = !!view.last_error && /manually|manual changes/i.test(view.last_error);
  return <Card title="Calendar automation" description="This assistant was enrolled by your saved calendar rule." actions={<Badge tone={view.skip || needsReview || view.last_error ? "warning" : "info"} dot>{view.skip ? "Skipped" : needsReview ? "Manual review" : view.last_error ? "Needs attention" : "Automatic"}</Badge>}>
    <div className="form-stack">
      <p className="field-hint">Delivery: {view.delivery_status?.replaceAll("_", " ") ?? "Waiting for meeting completion"}. {view.mom_mode === "draft" ? "Draft only." : view.mom_mode === "send_automatically" ? "Automatic email configured." : "Uses your saved MOM delivery default."}</p>
      <label className="choice-card"><input type="checkbox" disabled={!view.can_edit || busy || view.skip} checked={view.skip} onChange={(event) => void change({ skip: event.target.checked })} /><span><b>Skip this occurrence</b><small>{view.skip ? "This occurrence was skipped. Schedule a new assistant manually if you want it to join." : "Cancels this pending automatic join. A recording already in progress is not stopped."}</small></span></label>
      <label className="choice-card"><input type="checkbox" disabled={!view.can_edit || busy} checked={view.hold_delivery} onChange={(event) => void change({ hold_delivery: event.target.checked })} /><span><b>Require manual review</b><small>Hold automatic email for this meeting so you can review and send it yourself.</small></span></label>
      {!view.can_edit ? <p className="field-hint">Only the meeting owner or an admin can change these settings.</p> : null}
      {busy ? <p className="field-hint" role="status">Saving meeting override…</p> : null}
      {view.last_error ? <Alert tone="warning">{stoppedManually ? "Automatic email is suspended because the assistant was stopped manually. Review the MOM and recipients below, then send the recap manually." : deletedManually ? "Automatic email is suspended because the MOM was deleted manually. Generate a new draft below and review it before sending manually." : changedManually ? "Automatic email is suspended after manual changes to this meeting. Use the MOM and delivery controls below to review or send it manually." : "Automatic processing needs attention. Review this meeting’s minutes and delivery before sending manually."}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  </Card>;
}
