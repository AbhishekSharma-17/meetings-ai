"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CalendarDays, Library, X } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import { researchService } from "@/lib/research-service";
import { currentTimeSettings, formatDateTime, todayKey } from "@/lib/time-preferences";
import { addDaysToKey } from "@/lib/time-format";
import type { CachedCalendarEvent, KnowledgeBase } from "@/lib/types";
import type { PrepareResult, ResearchProfile } from "@/lib/research-types";
import { Alert, EmptyState, LoadingRow } from "./ui/feedback";
import { UiSelect } from "./ui-select";

function Shell({ open, title, intro, onClose, children }: { open: boolean; title: string; intro: string; onClose(): void; children: ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog rx-dialog">
        <Dialog.Close className="close-button" aria-label="Close"><X /></Dialog.Close>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description className="dialog-intro">{intro}</Dialog.Description>
        {open ? children : null}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** Choose one of my upcoming synced meetings; its prep inputs are pre-filled and the chosen people marked as theirs. */
export function PrepareDialog({ open, profile, people, onClose, onPrepared, onOpenCalendar }: {
  open: boolean; profile: ResearchProfile; people: ResearchProfile[]; onClose(): void;
  onPrepared(result: PrepareResult): void; onOpenCalendar(): void;
}) {
  return <Shell open={open} title="Prepare a meeting" intro={`Pre-fills meeting prep with ${profile.kind === "company" ? profile.name : `${profile.name}${profile.company ? ` at ${profile.company}` : ""}`}.`} onClose={onClose}>
    <PrepareForm profile={profile} people={people} onClose={onClose} onPrepared={onPrepared} onOpenCalendar={onOpenCalendar} />
  </Shell>;
}

function PrepareForm({ profile, people, onClose, onPrepared, onOpenCalendar }: { profile: ResearchProfile; people: ResearchProfile[]; onClose(): void; onPrepared(result: PrepareResult): void; onOpenCalendar(): void }) {
  const [events, setEvents] = useState<CachedCalendarEvent[] | null>(null);
  const [eventId, setEventId] = useState("");
  const [chosen, setChosen] = useState<string[]>(() => people.map((person) => person.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const first = todayKey();
    void meetingsService.getSyncedCalendar(first, addDaysToKey(first, 60), currentTimeSettings().timeZone)
      .then((snapshot) => {
        const upcoming = snapshot.events.filter((event) => new Date(event.ends_at).getTime() > Date.now());
        setEvents(upcoming); setEventId(upcoming[0]?.id ?? "");
      })
      .catch(() => { setEvents([]); setError("Your calendar couldn't be loaded. Try again."); });
  }, []);

  async function submit() {
    setBusy(true); setError(null);
    try { onPrepared(await researchService.prepare(profile.id, eventId, profile.kind === "company" ? chosen : [])); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Meeting prep couldn't be filled in. Try again."); setBusy(false); }
  }

  if (events === null) return <div className="dialog-body"><LoadingRow>Loading your upcoming meetings…</LoadingRow></div>;
  if (!events.length) return <>
    <div className="dialog-body"><EmptyState plain icon={<CalendarDays />} title="No upcoming meetings">Sync your calendar first, then prepare a meeting from here.</EmptyState>{error ? <Alert tone="danger">{error}</Alert> : null}</div>
    <div className="dialog-footer"><button type="button" className="button secondary" onClick={onClose}>Close</button><button type="button" className="button primary" onClick={onOpenCalendar}>Open calendar</button></div>
  </>;
  return <>
    <div className="dialog-body form-stack">
      <UiSelect id="rx-prepare-event" label="Meeting" value={eventId} onChange={setEventId}
        options={events.map((event) => ({ value: event.id, label: `${event.title} · ${formatDateTime(event.starts_at)}` }))} />
      {profile.kind === "company" && people.length ? <fieldset className="rx-people-pick">
        <legend className="field-label">Mark as their side</legend>
        {people.map((person) => <label key={person.id} className="check-label">
          <input type="checkbox" checked={chosen.includes(person.id)} onChange={() => setChosen((current) => current.includes(person.id) ? current.filter((item) => item !== person.id) : [...current, person.id])} />
          <span>{person.name}{person.title ? <small> · {person.title}</small> : null}</span>
        </label>)}
      </fieldset> : null}
      <p className="field-hint">The company and website are filled in and a note lists these people. You still choose when to generate the briefing.</p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
    <div className="dialog-footer"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button primary" disabled={busy || !eventId} onClick={() => void submit()}>{busy ? "Filling in…" : "Open meeting prep"}</button></div>
  </>;
}

/** Add the profile as a document to a knowledge base I can write to (creator or admin); it is indexed like any upload. */
export function KnowledgeDialog({ open, profile, userId, isAdmin, onClose, onSaved }: {
  open: boolean; profile: ResearchProfile; userId: string; isAdmin: boolean; onClose(): void; onSaved(baseId: string, baseName: string): void;
}) {
  return <Shell open={open} title="Save to knowledge" intro={`Adds ${profile.name} as a document with its Apollo facts and the date they were fetched.`} onClose={onClose}>
    <KnowledgeForm profile={profile} userId={userId} isAdmin={isAdmin} onClose={onClose} onSaved={onSaved} />
  </Shell>;
}

function KnowledgeForm({ profile, userId, isAdmin, onClose, onSaved }: { profile: ResearchProfile; userId: string; isAdmin: boolean; onClose(): void; onSaved(baseId: string, baseName: string): void }) {
  const [bases, setBases] = useState<KnowledgeBase[] | null>(null);
  const [baseId, setBaseId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void meetingsService.listKnowledgeBases().then((all) => {
      const writable = all.filter((base) => isAdmin || base.created_by === userId);
      setBases(writable); setBaseId(writable[0]?.id ?? "");
    }).catch(() => { setBases([]); setError("Knowledge bases couldn't be loaded. Try again."); });
  }, [isAdmin, userId]);

  async function submit() {
    setBusy(true); setError(null);
    try {
      await researchService.saveToKnowledge(profile.id, baseId);
      onSaved(baseId, bases?.find((base) => base.id === baseId)?.name ?? "the knowledge base");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "It couldn't be saved. Try again."); setBusy(false); }
  }

  if (bases === null) return <div className="dialog-body"><LoadingRow>Loading knowledge bases…</LoadingRow></div>;
  return <>
    <div className="dialog-body form-stack">
      {bases.length ? <UiSelect id="rx-knowledge-base" label="Knowledge base" value={baseId} onChange={setBaseId}
        options={bases.map((base) => ({ value: base.id, label: base.name, icon: <Library aria-hidden="true" /> }))} />
        : <EmptyState plain icon={<Library />} title="No knowledge base you can add to">Create one in AI knowledge first; you can add to bases you created.</EmptyState>}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
    <div className="dialog-footer"><button type="button" className="button secondary" onClick={onClose}>Cancel</button>{bases.length ? <button type="button" className="button primary" disabled={busy || !baseId} onClick={() => void submit()}>{busy ? "Saving…" : "Save"}</button> : null}</div>
  </>;
}
