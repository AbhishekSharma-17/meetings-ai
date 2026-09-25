"use client";

import { Select } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";

export function UiSelect({ id, label, value, options, onChange, disabled = false }: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
  disabled?: boolean;
}) {
  return <div className="ui-select-field">
    <label id={`${id}-label`} htmlFor={id}>{label}</label>
    <Select.Root value={value} onValueChange={(next) => { if (next !== null) onChange(String(next)); }} disabled={disabled} items={options}>
      <Select.Trigger id={id} className="ui-select-trigger" aria-labelledby={`${id}-label`}>
        <Select.Value /><Select.Icon><ChevronDown aria-hidden="true" /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={4} alignItemWithTrigger={false} className="ui-select-positioner">
          <Select.Popup className="ui-select-popup">
            <Select.List>{options.map((option) => <Select.Item key={option.value} value={option.value} className="ui-select-item"><Select.ItemText>{option.label}</Select.ItemText><Select.ItemIndicator><Check aria-hidden="true" /></Select.ItemIndicator></Select.Item>)}</Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  </div>;
}
