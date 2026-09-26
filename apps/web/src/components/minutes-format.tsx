"use client";

import { useState } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import type { MomGuidance } from "@/lib/types";
import { UiSelect } from "./ui-select";

const templateOptions: { value: MomGuidance["template"]; label: string }[] = [
  { value: "standard", label: "Balanced meeting minutes" },
  { value: "actions", label: "Decisions & action tracker" },
  { value: "client", label: "Client recap" },
  { value: "discovery", label: "Discovery notes" },
  { value: "custom", label: "Custom focus" },
];

/** Compact "MOM template & focus" row that expands into the guidance form. */
export function MinutesFormat({ guidance, focusInput, locked, saving, onGuidanceChange, onFocusInputChange, onSave }: {
  guidance: MomGuidance;
  focusInput: string;
  locked: boolean;
  saving: boolean;
  onGuidanceChange(guidance: MomGuidance): void;
  onFocusInputChange(value: string): void;
  onSave(): void;
}) {
  const [open, setOpen] = useState(false);
  const templateLabel = templateOptions.find((option) => option.value === guidance.template)?.label ?? "Balanced meeting minutes";
  const focusSummary = focusInput.trim() ? ` · Focus: ${focusInput.trim()}` : "";
  return <Collapsible.Root className="mom-format" open={open && !locked} onOpenChange={setOpen}>
    <div className="mom-format-bar">
      <SlidersHorizontal aria-hidden="true" />
      <span className="mom-format-summary"><b>MOM template & focus</b><small>{templateLabel}{focusSummary}</small></span>
      {!locked ? <Collapsible.Trigger className="button ghost sm mom-format-trigger">{open ? "Done" : "Customize"}<ChevronDown aria-hidden="true" /></Collapsible.Trigger> : null}
    </div>
    <Collapsible.Panel className="mom-format-panel">
      <div className="field-row">
        <UiSelect id="mom-template" label="Template" value={guidance.template} options={templateOptions} onChange={(value) => onGuidanceChange({ ...guidance, template: value as MomGuidance["template"] })} disabled={locked} />
        <div className="field"><label htmlFor="mom-focus">Focus fields <small>comma-separated</small></label><input id="mom-focus" value={focusInput} disabled={locked} onChange={(event) => onFocusInputChange(event.target.value)} placeholder="Risks, Budget, Dependencies" /></div>
      </div>
      <div className="field"><label htmlFor="mom-guidance">Organizer guidance</label><textarea id="mom-guidance" rows={3} maxLength={2000} value={guidance.instructions} disabled={locked} onChange={(event) => onGuidanceChange({ ...guidance, instructions: event.target.value })} placeholder="What should the draft emphasize?" /></div>
      <div className="mom-format-foot">
        <p className="field-hint">Guides the next draft. Supported focus fields become labelled discussion points; unsaid details are omitted.</p>
        <button className="button secondary sm" type="button" disabled={saving || locked} onClick={onSave}>{saving ? "Saving…" : "Save MOM format"}</button>
      </div>
    </Collapsible.Panel>
  </Collapsible.Root>;
}
