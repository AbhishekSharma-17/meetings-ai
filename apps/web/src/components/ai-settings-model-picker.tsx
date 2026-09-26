"use client";

import { useState } from "react";
import { Check, Search } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { ProviderProfile, TextModelCatalog } from "@/lib/types";
import { UiSelect } from "./ui-select";

export type ModelRoute = { profileId: string; model: string };
export const NONE = "none";
const RESULT_LIMIT = 30;

/** Provider profile plus optional model override, with a searchable live catalog. */
export function ModelRoutePicker({ id, name, profiles, value, onChange, noneLabel, disabled = false }: {
  id: string;
  name: string;
  profiles: ProviderProfile[];
  value: ModelRoute;
  onChange(next: ModelRoute): void;
  noneLabel: string;
  disabled?: boolean;
}) {
  const [catalog, setCatalog] = useState<TextModelCatalog | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profile = profiles.find((item) => item.id === value.profileId);
  const matches = catalog?.models.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(search.toLowerCase())).slice(0, RESULT_LIMIT) ?? [];

  async function browse() {
    if (!profile) return;
    setBusy(true); setError(null);
    try { setCatalog(await meetingsService.listKnowledgeModels(profile.id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load models."); }
    finally { setBusy(false); }
  }

  function selectProfile(next: string) {
    setCatalog(null); setSearch(""); setError(null);
    onChange({ profileId: next, model: "" });
  }

  return <div className="ai-route">
    <UiSelect id={`${id}-profile`} label={`${name} provider`} value={value.profileId || NONE} onChange={(next) => selectProfile(next === NONE ? "" : next)} disabled={disabled}
      options={[{ value: NONE, label: noneLabel }, ...profiles.map((item) => ({ value: item.id, label: item.label }))]} />
    {profile ? <div className="field">
      <div className="provider-field-label">
        <label htmlFor={`${id}-model`}>{name} model</label>
        <button type="button" className="text-button" disabled={busy || disabled} onClick={() => void browse()}>{busy ? "Loading…" : catalog ? "Refresh" : "Browse models"}</button>
      </div>
      <input id={`${id}-model`} value={value.model} onChange={(event) => onChange({ ...value, model: event.target.value.trim() })} placeholder={`Profile default · ${profile.model || "not set"}`} disabled={disabled} spellCheck={false} autoComplete="off" />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div> : null}
    {profile && catalog ? <div className="inset-panel provider-catalog">
      <div className="input-with-icon"><Search aria-hidden="true" /><input aria-label={`Search ${name} models`} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${catalog.models.length} models`} /></div>
      <ul className="provider-catalog-results">
        {matches.map((item) => <li key={item.id}><button type="button" className="provider-catalog-item" aria-pressed={(value.model || profile.model) === item.id} onClick={() => onChange({ ...value, model: item.id === profile.model ? "" : item.id })}>
          <span><b>{item.name}</b><small>{item.id}</small></span>
          {item.input_per_million_usd !== null ? <small className="provider-catalog-price">${item.input_per_million_usd}/M in · ${item.output_per_million_usd}/M out</small> : null}
          {(value.model || profile.model) === item.id ? <Check aria-hidden="true" /> : null}
        </button></li>)}
        {matches.length ? null : <li className="provider-catalog-empty">No models match this search.</li>}
      </ul>
    </div> : null}
  </div>;
}
