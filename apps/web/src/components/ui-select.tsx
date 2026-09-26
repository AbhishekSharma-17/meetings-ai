"use client";

import { Select } from "@base-ui/react/select";
import { Check, ChevronsUpDown } from "lucide-react";

/** The only select in the product; native select elements are not used. */
export function UiSelect({ id, label, value, options, onChange, disabled = false, hideLabel = false, size = "md", className = "", placeholder }: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
  disabled?: boolean;
  hideLabel?: boolean;
  size?: "sm" | "md";
  className?: string;
  placeholder?: string;
}) {
  const items = placeholder && !options.some((option) => option.value === value) ? [{ value, label: placeholder }, ...options] : options;
  return <div className={`ui-select-field ${className}`.trim()}>
    <label id={`${id}-label`} htmlFor={id} className={hideLabel ? "sr-only" : undefined}>{label}</label>
    <Select.Root value={value} onValueChange={(next) => { if (next !== null) onChange(String(next)); }} disabled={disabled} items={items}>
      <Select.Trigger id={id} className={size === "sm" ? "ui-select-trigger sm" : "ui-select-trigger"} aria-labelledby={`${id}-label`}>
        <Select.Value /><Select.Icon><ChevronsUpDown aria-hidden="true" /></Select.Icon>
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
