"use client";

import { useMemo } from "react";
import type { ProviderProfile } from "@/lib/types";
import { UiSelect } from "./ui-select";
import { ModelCombobox } from "./model-combobox";
import { recommendedModelIds } from "./provider-profile-info";
import { useModelCatalog } from "./use-model-catalog";

export type ModelRoute = { profileId: string; model: string };
export const NONE = "none";

/** LLM profile plus an optional model override, picked from that profile's live catalog or typed. */
export function ModelRoutePicker({ id, name, profiles, value, onChange, noneLabel, capability = "text_generation", disabled = false }: {
  id: string;
  name: string;
  profiles: ProviderProfile[];
  value: ModelRoute;
  onChange(next: ModelRoute): void;
  noneLabel: string;
  /** "vision" lists only models that accept images. */
  capability?: "text_generation" | "vision";
  disabled?: boolean;
}) {
  const profile = profiles.find((item) => item.id === value.profileId);
  const request = useMemo(() => profile ? { key: `${profile.id}:${capability}`, query: { capability, profileId: profile.id } } : null, [profile, capability]);
  const catalog = useModelCatalog(request);

  return <div className="ai-route">
    <UiSelect id={`${id}-profile`} label={`${name} provider`} value={value.profileId || NONE} onChange={(next) => onChange({ profileId: next === NONE ? "" : next, model: "" })} disabled={disabled}
      options={[{ value: NONE, label: noneLabel }, ...profiles.map((item) => ({ value: item.id, label: item.label }))]} />
    {profile ? <ModelCombobox id={`${id}-model`} label={`${name} model`} value={value.model} catalog={catalog} disabled={disabled}
      onChange={(model) => onChange({ ...value, model })}
      placeholder={`Provider default · ${profile.model || "not set"}`} recommendedIds={recommendedModelIds[capability]}
      hint={capability === "vision" ? "Only models that read images are listed." : undefined} /> : null}
  </div>;
}
