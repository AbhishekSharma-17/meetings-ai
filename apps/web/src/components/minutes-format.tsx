"use client";

import { useState } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import type { MomGuidance } from "@/lib/types";
import { UiSelect } from "./ui-select";
import { ChipInput } from "./ui/chip-input";

/** The panel keeps focus fields as one comma-separated string; the chips edit it as a list. */
const toList = (value: string) => [...new Set(value.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean))];
const toText = (list: string[]) => list.join(", ");

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
  const focusList = toList(focusInput);
  const focusSummary = focusList.length ? ` · Focus: ${focusList.join(", ")}` : "";
  return <Collapsible.Root className="mom-format" open={open && !locked} onOpenChange={setOpen}>
    <div className="mom-format-bar">
      <SlidersHorizontal aria-hidden="true" />
      <span className="mom-format-summary"><b>MOM template & focus</b><small>{templateLabel}{focusSummary}</small></span>
      {!locked ? <Collapsible.Trigger className="button ghost sm mom-format-trigger">{open ? "Done" : "Customize"}<ChevronDown aria-hidden="true" /></Collapsible.Trigger> : null}
    </div>
    <Collapsible.Panel className="mom-format-panel">
      <div className="field-row">
        <UiSelect id="mom-template" label="Template" value={guidance.template} options={templateOptions} onChange={(value) => onGuidanceChange({ ...guidance, template: value as MomGuidance["template"] })} disabled={locked} />
        <ChipInput id="mom-focus" kind="text" label="Focus fields" labelSuffix={<span className="optional">optional</span>} value={focusList}
          onChange={(list) => onFocusInputChange(toText(list))} disabled={locked} placeholder="Risks, Budget, Dependencies" maxItems={8} maxItemLength={80} />
      </div>
      <div className="field"><label htmlFor="mom-guidance">Organizer guidance</label><textarea id="mom-guidance" rows={3} maxLength={2000} value={guidance.instructions} disabled={locked} onChange={(event) => onGuidanceChange({ ...guidance, instructions: event.target.value })} placeholder="What should the draft emphasize?" /></div>
      <div className="mom-format-foot">
        <p className="field-hint">Guides the next draft. Supported focus fields become labelled discussion points; unsaid details are omitted.</p>
        <button className="button secondary sm" type="button" disabled={saving || locked} onClick={onSave}>{saving ? "Saving…" : "Save MOM format"}</button>
      </div>
    </Collapsible.Panel>
  </Collapsible.Root>;
}
