"use client";

import { useState, type ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronDown } from "lucide-react";
import type { CalendarEvent, KnowledgeBase } from "@/lib/types";
import { EmailChips, mergeEmails, PersonChips } from "./ui/email-chips";
import { SwitchField } from "./ui/switch";
import { UiSelect } from "./ui-select";

export type MomTemplate = "standard" | "actions" | "client" | "discovery" | "custom";

const momTemplates: { value: MomTemplate; label: string }[] = [
  { value: "standard", label: "Balanced meeting minutes" },
  { value: "actions", label: "Decisions and action tracker" },
  { value: "client", label: "Client recap" },
  { value: "discovery", label: "Discovery notes" },
  { value: "custom", label: "Custom focus" },
];

function splitList(value: string): string[] {
  return value.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean);
}

/** Calendar details carried into the dialog. Invitees are listed, never treated as verified. */
export function SourcePreview({ event }: { event: CalendarEvent }) {
  const invitees = event.invitees ?? [];
  return <div className="inset-panel nm-source">
    {event.organizer || event.agenda ? <dl className="nm-source-meta">
      {event.organizer ? <div><dt>Organizer</dt><dd>{event.organizer}</dd></div> : null}
      {event.agenda ? <div><dt>Agenda</dt><dd>{event.agenda}</dd></div> : null}
    </dl> : null}
    <p className="field-hint">{invitees.length} listed invitee{invitees.length === 1 ? "" : "s"}. These are not verified attendees or speakers.</p>
    <PersonChips people={invitees} className="nm-invitees" label="Listed invitees" />
  </div>;
}

export function KnowledgeOptions({ disabled, bases, basesError, enabled, onEnabledChange, selectedBaseId, onSelectBase, newBaseName, onNewBaseNameChange, tagInput, onTagInputChange }: {
  disabled: boolean;
  bases: KnowledgeBase[];
  basesError: string | null;
  enabled: boolean;
  onEnabledChange(value: boolean): void;
  selectedBaseId: string;
  onSelectBase(value: string): void;
  newBaseName: string;
  onNewBaseNameChange(value: string): void;
  tagInput: string;
  onTagInputChange(value: string): void;
}) {
  const trimmedName = newBaseName.trim().toLocaleLowerCase();
  const reusesBase = Boolean(trimmedName) && bases.some((base) => base.name.trim().toLocaleLowerCase() === trimmedName);
  const tags = splitList(tagInput);
  return <section className={enabled ? "nm-section nm-knowledge enabled" : "nm-section nm-knowledge"} aria-label="AI knowledge">
    <SwitchField id="knowledge-enabled" label="Add this meeting to AI knowledge" description="Index its transcript and approved minutes for AI search after the meeting." checked={enabled} onChange={onEnabledChange} disabled={disabled} />
    <div className="nm-knowledge-fields">
      <div className="field-row">
        <UiSelect id="knowledge-base" label="Knowledge base" value={selectedBaseId} onChange={onSelectBase} disabled={disabled}
          options={[{ value: "", label: "No named knowledge base" }, ...bases.map((base) => ({ value: base.id, label: base.name }))]} />
        <div className="field">
          <label htmlFor="new-knowledge-base">Or create a knowledge base <span className="optional">optional</span></label>
          <input id="new-knowledge-base" name="new-knowledge-base" maxLength={120} placeholder="e.g. Acme client" value={newBaseName} disabled={disabled} onChange={(event) => onNewBaseNameChange(event.target.value)} />
        </div>
      </div>
      {reusesBase ? <p className="field-hint" role="status">This knowledge base already exists. The meeting will be added to it.</p> : null}
      {basesError ? <p className="form-error" role="alert">{basesError}</p> : null}
      <div className="field">
        <label htmlFor="meeting-tags">Knowledge tags <span className="optional">comma-separated</span></label>
        <input id="meeting-tags" name="meeting-tags" value={tagInput} onChange={(event) => onTagInputChange(event.target.value)} placeholder="e.g. discovery, roadmap, Acme" disabled={disabled} />
        {tags.length ? <ul className="tag-list" aria-label="Tags to add">{tags.map((item, index) => <li className="tag" key={`${item}:${index}`}>#{item}</li>)}</ul> : null}
      </div>
      <p className="field-hint">One knowledge base per meeting. A new name creates a base; an existing name reuses it.</p>
    </div>
  </section>;
}

function CollapsibleSection({ title, summary, children }: { title: string; summary: string; children: ReactNode }) {
  return <Collapsible.Root className="nm-collapsible">
    <Collapsible.Trigger type="button" className="nm-collapsible-trigger">
      <span className="nm-collapsible-title">{title}</span>
      <small className="nm-collapsible-summary">{summary}</small>
      <ChevronDown className="nm-chevron" aria-hidden="true" />
    </Collapsible.Trigger>
    {/* Kept mounted so the form still submits these fields while collapsed. */}
    <Collapsible.Panel keepMounted className="nm-collapsible-panel">{children}</Collapsible.Panel>
  </Collapsible.Root>;
}

export function MinutesOptions({ disabled, template, onTemplateChange, focus, onFocusChange, instructions, onInstructionsChange }: {
  disabled: boolean;
  template: MomTemplate;
  onTemplateChange(value: MomTemplate): void;
  focus: string;
  onFocusChange(value: string): void;
  instructions: string;
  onInstructionsChange(value: string): void;
}) {
  const summary = momTemplates.find((item) => item.value === template)?.label ?? "Balanced meeting minutes";
  return <CollapsibleSection title="Minutes format" summary={summary}>
    <div className="form-stack">
      <div className="field-row">
        <UiSelect id="mom-template" label="Template" value={template} onChange={(value) => onTemplateChange(value as MomTemplate)} options={momTemplates} disabled={disabled} />
        <div className="field">
          <label htmlFor="mom-focus">Additional fields to cover <span className="optional">comma-separated</span></label>
          <input id="mom-focus" value={focus} onChange={(event) => onFocusChange(event.target.value)} placeholder="e.g. Risks, Budget, Dependencies" disabled={disabled} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="mom-instructions">Organizer guidance <span className="optional">optional</span></label>
        <textarea id="mom-instructions" value={instructions} onChange={(event) => onInstructionsChange(event.target.value)} maxLength={2000} rows={3} placeholder="What should the draft emphasize?" disabled={disabled} />
        <p className="field-hint">The transcript stays the source of truth; unsupported claims are left out.</p>
      </div>
    </div>
  </CollapsibleSection>;
}

export function DeliveryOptions({ disabled, defaultParticipants }: { disabled: boolean; defaultParticipants: string[] }) {
  const [internal, setInternal] = useState<string[]>([]);
  const [participants, setParticipants] = useState<string[]>(() => mergeEmails([], defaultParticipants));
  const summary = internal.length + participants.length
    ? `${internal.length + participants.length} recipient${internal.length + participants.length === 1 ? "" : "s"} · sent after approval`
    : "Sent only after you approve the minutes";
  return <CollapsibleSection title="Recap delivery options" summary={summary}>
    <div className="form-stack">
      <div className="field-row">
        <EmailChips id="internal-recipients" name="internal-recipients" label="Internal team email addresses" value={internal} onChange={setInternal} placeholder="team@company.com" disabled={disabled} />
        <EmailChips id="participant-recipients" name="participant-recipients" label="Participant email addresses" value={participants} onChange={setParticipants} placeholder="Exact addresses only" disabled={disabled} />
      </div>
      <div className="stack nm-delivery-checks">
        <label className="check-label"><input type="checkbox" name="share-participants" disabled={disabled} /> Also send to listed participants after approval</label>
        <label className="check-label"><input type="checkbox" name="include-transcript" disabled={disabled} /> Include full transcript in the email</label>
      </div>
      <p className="field-hint">Press Enter after each address or paste a list. Recipients are saved with the meeting; nothing is emailed until you approve its minutes.</p>
    </div>
  </CollapsibleSection>;
}
