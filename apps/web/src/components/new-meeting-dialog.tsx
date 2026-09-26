"use client";

import { FormEvent, useEffect, useId, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CircleCheck, Link2, X } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { KnowledgeBase, MeetingDetail } from "@/lib/types";
import type { CalendarSelection } from "./calendar-import-dialog";
import { calendarProviderNames } from "./calendar-providers";
import { DeliveryOptions, KnowledgeOptions, MinutesOptions, SourcePreview, type MomTemplate } from "./new-meeting-sections";
import { Alert } from "./ui/feedback";

const SUPPORTED_PLATFORMS = "Google Meet, Zoom, Microsoft Teams or Jitsi";

function detectPlatform(value: string): string | null {
  try {
    const host = new URL(value.trim()).hostname.toLowerCase();
    if (host === "meet.google.com") return "Google Meet";
    if (host === "zoom.us" || host.endsWith(".zoom.us")) return "Zoom";
    if (host.endsWith("teams.microsoft.com") || host.endsWith("teams.live.com")) return "Microsoft Teams";
    if (host === "meet.jit.si" || host.includes("jitsi")) return "Jitsi";
    return null;
  } catch { return null; }
}

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
  const [momTemplate, setMomTemplate] = useState<MomTemplate>("standard");
  const [momInstructions, setMomInstructions] = useState("");
  const [momFocusInput, setMomFocusInput] = useState("");
  const [joinTiming, setJoinTiming] = useState<"now" | "scheduled">("now");
  const [scheduledStart, setScheduledStart] = useState("");
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
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

  function close() { setError(null); setJoining(false); setSelectedBaseId(""); setNewBaseName(""); setTagInput(""); setKnowledgeEnabled(false); setMomTemplate("standard"); setMomInstructions(""); setMomFocusInput(""); setJoinTiming("now"); setScheduledStart(""); setLinkValue(""); setLinkError(null); onClose(); }

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
      let scheduledStartIso: string | null = null;
      if (!calendarSelection && joinTiming === "scheduled") {
        const scheduledTime = new Date(scheduledStart).getTime();
        if (!scheduledStart || !Number.isFinite(scheduledTime) || scheduledTime <= Date.now() + 60_000) {
          throw new Error("Choose a start time at least one minute from now, or select Join now.");
        }
        scheduledStartIso = new Date(scheduledTime).toISOString();
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
        momGuidance: { template: momTemplate, instructions: momInstructions.trim(), focus_fields: momFocusInput.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean) },
      };
      const shouldSchedule = calendarSelection && new Date(calendarSelection.event.starts_at).getTime() > Date.now() + 60_000;
      if (shouldSchedule) {
        const scheduled = await meetingsService.scheduleCalendarEvent(calendarSelection.event, calendarSelection.period, calendarSelection.timezone, input, calendarSelection.eventDate);
        onMeetingJoined(scheduled);
        return;
      }
      if (calendarSelection) {
        const joined = await meetingsService.joinCalendarEvent(calendarSelection.event, calendarSelection.period, calendarSelection.timezone, input, calendarSelection.eventDate);
        onMeetingJoined(joined);
        return;
      }
      if (scheduledStartIso) {
        const scheduled = await meetingsService.scheduleMeeting(input, scheduledStartIso);
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

  const source = calendarSelection?.event;
  const link = source ? source.meeting_url : linkValue;
  const platform = detectPlatform(link);
  const willSchedule = calendarSelection?.willSchedule || joinTiming === "scheduled";
  const description = source
    ? `From ${calendarProviderNames[source.provider]} · ${new Date(source.starts_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. Future meetings are scheduled; meetings starting now join right away.`
    : "Paste a meeting link. You review the transcript and minutes before anything is emailed.";
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !joining) close(); }}>
    <Dialog.Portal>
    <Dialog.Backdrop className="dialog-backdrop" />
    <Dialog.Popup className="dialog lg new-meeting-dialog" aria-labelledby={titleId}>
      <Dialog.Close className="close-button" aria-label="Close" disabled={joining}><X aria-hidden="true" /></Dialog.Close>
      <Dialog.Title id={titleId}>{source ? "Review sourced meeting" : "Send your assistant"}</Dialog.Title>
      <Dialog.Description className="dialog-intro">{description}</Dialog.Description>
      <form className="new-meeting-form" onSubmit={(event) => void submit(event)}>
        <section className="nm-section" aria-labelledby={`${titleId}-meeting`}>
          <h3 id={`${titleId}-meeting`} className="sr-only">Meeting</h3>
          <div className="field">
            <label htmlFor="meeting-link">Meeting link</label>
            <div className="input-with-icon">
              <Link2 aria-hidden="true" />
              <input id="meeting-link" name="meeting-link" type="url" required placeholder="https://meet.google.com/..." autoFocus defaultValue={source?.meeting_url ?? ""} readOnly={Boolean(source)} disabled={joining}
                aria-invalid={linkError ? true : undefined} aria-describedby="meeting-link-hint"
                onChange={(event) => { setLinkValue(event.target.value); setLinkError(null); }}
                onInvalid={(event) => { event.preventDefault(); event.currentTarget.focus(); setLinkError(event.currentTarget.value ? "Enter a full meeting link that starts with https://." : "Paste the meeting link to continue."); }} />
            </div>
            {linkError
              ? <p id="meeting-link-hint" className="inline-error nm-link-hint">{linkError}</p>
              : <p id="meeting-link-hint" className={platform ? "field-hint nm-link-hint detected" : "field-hint nm-link-hint"}>{platform ? <><CircleCheck aria-hidden="true" />{platform} link</> : `Works with ${SUPPORTED_PLATFORMS}.`}</p>}
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="meeting-title">Meeting name <span className="optional">optional</span></label>
              <input id="meeting-title" name="meeting-title" placeholder="e.g. Product discovery" defaultValue={source?.title ?? ""} disabled={joining} />
            </div>
            <div className="field">
              <label htmlFor="bot-name">Assistant name</label>
              <input id="bot-name" name="bot-name" defaultValue="Meetings AI" disabled={joining} />
            </div>
          </div>
          {source ? <SourcePreview event={source} /> : null}
        </section>

        {!source ? <fieldset className="nm-section">
          <legend className="nm-section-title">When should the assistant join?</legend>
          <div className="field-row">
            <label className="choice-card"><input type="radio" name="join-timing" value="now" checked={joinTiming === "now"} onChange={() => setJoinTiming("now")} disabled={joining} /><span><b>Join now</b><small>It joins as soon as you send it.</small></span></label>
            <label className="choice-card"><input type="radio" name="join-timing" value="scheduled" checked={joinTiming === "scheduled"} onChange={() => setJoinTiming("scheduled")} disabled={joining} /><span><b>At the meeting start time</b><small>Queue it now; it joins on time.</small></span></label>
          </div>
          {joinTiming === "scheduled" ? <div className="field nm-schedule-field">
            <label htmlFor="scheduled-start">Meeting start</label>
            <input id="scheduled-start" type="datetime-local" value={scheduledStart} onChange={(event) => setScheduledStart(event.target.value)} required disabled={joining} />
            <p className="field-hint">Your time zone: {timeZone}. The assistant leaves once the meeting goes quiet.</p>
          </div> : null}
        </fieldset> : null}

        <KnowledgeOptions
          disabled={joining} bases={bases} basesError={basesError}
          enabled={knowledgeEnabled} onEnabledChange={setKnowledgeEnabled}
          selectedBaseId={selectedBaseId} onSelectBase={(value) => { setSelectedBaseId(value); if (value) setKnowledgeEnabled(true); }}
          newBaseName={newBaseName} onNewBaseNameChange={(value) => { setNewBaseName(value); if (value.trim()) setKnowledgeEnabled(true); }}
          tagInput={tagInput} onTagInputChange={setTagInput}
        />

        <div className="nm-section nm-disclosures">
          <MinutesOptions disabled={joining} template={momTemplate} onTemplateChange={setMomTemplate} focus={momFocusInput} onFocusChange={setMomFocusInput} instructions={momInstructions} onInstructionsChange={setMomInstructions} />
          <DeliveryOptions disabled={joining} defaultParticipants={(source?.invitees ?? []).flatMap((person) => person.email ? [person.email] : [])} />
        </div>

        <Alert tone="info" role="note" title="Disclosure is required." className="nm-disclosure">Before sending, confirm the host will announce: “Meetings AI has joined and will record and transcribe this conversation.”</Alert>

        <div className="dialog-footer nm-footer">
          {error ? <p className="form-error nm-footer-error" role="alert">{error}</p> : null}
          <button className="button secondary" type="button" onClick={close} disabled={joining}>Cancel</button>
          <button className="button primary" type="submit" disabled={joining}>{joining ? "Saving…" : willSchedule ? "Schedule assistant" : "Send assistant"}</button>
        </div>
      </form>
    </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function addresses(value: string): string[] {
  return [...new Set(value.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean))];
}
