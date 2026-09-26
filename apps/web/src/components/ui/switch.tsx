"use client";

import type { ReactNode } from "react";
import { Switch as BaseSwitch } from "@base-ui/react/switch";

/** Labelled on/off setting. The label text is the switch's accessible name. */
export function SwitchField({ id, label, description, checked, onChange, disabled = false }: {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
}) {
  return <div className="switch-row">
    <span><b id={`${id}-label`}>{label}</b>{description ? <small id={`${id}-description`}>{description}</small> : null}</span>
    <BaseSwitch.Root id={id} className="switch" checked={checked} onCheckedChange={(next) => onChange(next)} disabled={disabled} aria-labelledby={`${id}-label`} aria-describedby={description ? `${id}-description` : undefined}>
      <BaseSwitch.Thumb className="switch-thumb" />
    </BaseSwitch.Root>
  </div>;
}
