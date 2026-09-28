"use client";

import { Select } from "@base-ui/react/select";
import type { ReactNode } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

/** `icon` is a decorative mark (e.g. a provider logo) shown before the label in the list and the trigger. */
export type UiSelectOption = { value: string; label: string; icon?: ReactNode };

/** The only select in the product; native select elements are not used. */
export function UiSelect({ id, label, value, options, onChange, disabled = false, hideLabel = false, size = "md", className = "", placeholder }: {
  id: string;
  label: string;
  value: string;
  options: UiSelectOption[];
  onChange(value: string): void;
  disabled?: boolean;
  hideLabel?: boolean;
  size?: "sm" | "md";
  className?: string;
  placeholder?: string;
}) {
  const items: UiSelectOption[] = placeholder && !options.some((option) => option.value === value) ? [{ value, label: placeholder }, ...options] : options;
  const withIcons = items.some((option) => option.icon);
  const renderValue = withIcons ? (selected: unknown) => {
    const option = items.find((candidate) => candidate.value === selected);
    return option ? <span className="ui-select-value">{option.icon}<span>{option.label}</span></span> : null;
  } : undefined;
  return <div className={`ui-select-field ${className}`.trim()}>
    <label id={`${id}-label`} htmlFor={id} className={hideLabel ? "sr-only" : undefined}>{label}</label>
    <Select.Root value={value} onValueChange={(next) => { if (next !== null) onChange(String(next)); }} disabled={disabled} items={items.map(({ value: itemValue, label: itemLabel }) => ({ value: itemValue, label: itemLabel }))}>
      <Select.Trigger id={id} className={size === "sm" ? "ui-select-trigger sm" : "ui-select-trigger"} aria-labelledby={`${id}-label`}>
        <Select.Value>{renderValue}</Select.Value><Select.Icon><ChevronsUpDown aria-hidden="true" /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={4} alignItemWithTrigger={false} className="ui-select-positioner">
          <Select.Popup className="ui-select-popup">
            <Select.List>{options.map((option) => <Select.Item key={option.value} value={option.value} className="ui-select-item">{option.icon ? <span className="ui-select-item-label">{option.icon}<Select.ItemText>{option.label}</Select.ItemText></span> : <Select.ItemText>{option.label}</Select.ItemText>}<Select.ItemIndicator><Check aria-hidden="true" /></Select.ItemIndicator></Select.Item>)}</Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  </div>;
}
