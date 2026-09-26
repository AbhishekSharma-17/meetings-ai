"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Check, Search, Trash2 } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import { readUiPreference } from "@/lib/ui-preferences";
import type { Capability, ProfileKeyChoice, ProviderProfile, TextModelCatalog, VaultCredential } from "@/lib/types";
import { UiSelect } from "./ui-select";
import { Alert, Badge } from "./ui/feedback";
import type { SettingsNotice } from "./settings-toast";
import { capabilityLabel, compatibleCredentials, isUnsavedProfile, profileInfo, providerOptions } from "./provider-profile-info";
import { initialKeyChoice, keyChoiceChanged, keyChoicePayload, ProviderKeyField, type KeyChoiceState } from "./provider-key-field";

type DraftFields = Pick<ProviderProfile, "label" | "provider" | "executionLocation" | "endpoint" | "model" | "capabilities" | "isDefault">;
type DraftEnvelope = { baseline: string; fields: DraftFields };
const CATALOG_RESULT_LIMIT = 35;

function draftFields(profile: ProviderProfile): DraftFields {
  return { label: profile.label, provider: profile.provider, executionLocation: profile.executionLocation,
    endpoint: profile.endpoint, model: profile.model, capabilities: profile.capabilities, isDefault: profile.isDefault };
}
function storableDraftFields(draft: ProviderProfile, baseline: ProviderProfile): DraftFields {
  const fields = draftFields(draft);
  if (fields.endpoint && fields.endpoint !== baseline.endpoint) {
    try {
      const endpoint = new URL(fields.endpoint);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fields.endpoint = baseline.endpoint;
    } catch { fields.endpoint = baseline.endpoint; }
  }
  return fields;
}
function isDraftEnvelope(value: unknown): value is DraftEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<DraftEnvelope>;
  const fields = envelope.fields;
  return typeof envelope.baseline === "string" && Boolean(fields)
    && typeof fields?.label === "string" && typeof fields.provider === "string"
    && (fields.executionLocation === "local" || fields.executionLocation === "cloud")
    && typeof fields.endpoint === "string" && typeof fields.model === "string"
    && Array.isArray(fields.capabilities) && fields.capabilities.every((item) => typeof item === "string")
    && typeof fields.isDefault === "boolean";
}

const defaultLabel: Record<ProviderProfile["kind"], string> = { transcription: "transcription", mom: "MOM & actions", embedding: "knowledge embeddings" };

const defaultHint: Record<ProviderProfile["kind"], string> = {
  mom: "Used for new MOM drafts.",
  transcription: "Used for the next bot join; active bots keep their route.",
  embedding: "Saved for the knowledge-base workflow.",
};

export function ProviderEditor({ identity, profile, credentials, canSaveKeys, onSave, onDelete, onChange, onNotice }: {
  identity: string;
  profile: ProviderProfile;
  credentials: VaultCredential[];
  canSaveKeys: boolean;
  onSave(profile: ProviderProfile, apiKey?: string, keyChoice?: ProfileKeyChoice): Promise<ProviderProfile>;
  onDelete(profile: ProviderProfile): Promise<void>;
  onChange(profile: ProviderProfile): void;
  onNotice(notice: SettingsNotice): void;
}) {
  const draftKey = `meetings-ai:provider-draft:${identity}:${profile.id}`;
  const [draft, setDraft] = useState<ProviderProfile>(() => {
    const saved = readUiPreference<DraftEnvelope | null>(draftKey, null, (value): value is DraftEnvelope | null => value === null || isDraftEnvelope(value), "session");
    return saved?.baseline === JSON.stringify(draftFields(profile)) ? { ...profile, ...draftFields({ ...profile, ...saved.fields }) } : profile;
  });
  const [keyChoice, setKeyChoice] = useState<KeyChoiceState>(() => initialKeyChoice(profile));
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [catalog, setCatalog] = useState<TextModelCatalog | null>(null);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const capabilities = useMemo(() => profileInfo[draft.kind].capabilities, [draft.kind]);
  const isNew = isUnsavedProfile(profile.id);
  const hasUnsavedChanges = keyChoiceChanged(keyChoice, profile) || draft.label !== profile.label || draft.provider !== profile.provider
    || draft.executionLocation !== profile.executionLocation || draft.endpoint !== profile.endpoint
    || draft.model !== profile.model || draft.isDefault !== profile.isDefault
    || draft.capabilities.join(",") !== profile.capabilities.join(",");
  const canBrowseModels = draft.kind === "mom" && !isNew && (draft.provider === "OpenAI" || draft.provider === "OpenRouter");
  const Icon = profileInfo[draft.kind].icon;

  useEffect(() => {
    try {
      if (JSON.stringify(draftFields(draft)) === JSON.stringify(draftFields(profile))) sessionStorage.removeItem(draftKey);
      else sessionStorage.setItem(draftKey, JSON.stringify({ baseline: JSON.stringify(draftFields(profile)), fields: storableDraftFields(draft, profile) }));
    } catch { /* Unsaved non-secret fields remain in memory even if storage is unavailable. */ }
  }, [draft, draftKey, profile]);
  useEffect(() => {
    if (confirmDelete) document.getElementById("provider-delete-confirm")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [confirmDelete]);
  const update = <K extends keyof ProviderProfile>(key: K, value: ProviderProfile[K]) => setDraft((current) => ({ ...current, [key]: value }));

  async function testConnection() {
    setTesting(true); update("connectionState", "checking");
    try {
      const tested = await meetingsService.testProviderConnection(profile);
      setDraft((current) => ({ ...current, connectionState: tested.connectionState }));
      onChange(tested);
      onNotice(tested.connectionState === "configured"
        ? { tone: "success", text: "Configuration fields are valid. Runtime connectivity is checked when that provider workflow is enabled." }
        : { tone: "warning", text: "Add the required endpoint or credential and try again." });
    } catch (error) {
      const failed = { ...draft, connectionState: "failed" as const };
      setDraft(failed); onChange(failed);
      onNotice({ tone: "danger", text: error instanceof Error ? error.message : "Configuration validation failed." });
    } finally {
      setTesting(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (keyChoice.mode === "saved" && !compatibleCredentials(draft, credentials).some((item) => item.id === keyChoice.credentialId)) { onNotice({ tone: "warning", text: "Choose a saved key, or switch to pasting a new one." }); return; }
    setSaving(true);
    try {
      const apiKey = keyChoice.mode === "paste" ? keyChoice.apiKey || undefined : undefined;
      const saved = await onSave(draft, apiKey, keyChoicePayload(keyChoice, profile, draft.label));
      setDraft(saved); setKeyChoice(initialKeyChoice(saved));
      try { sessionStorage.removeItem(draftKey); } catch { /* Optional browser storage. */ }
    }
    catch (error) { onNotice({ tone: "danger", text: error instanceof Error ? error.message : "Could not save profile." }); }
    finally { setSaving(false); }
  }
  async function remove() {
    setDeleting(true);
    try { await onDelete(profile); try { sessionStorage.removeItem(draftKey); } catch { /* Optional browser storage. */ } }
    catch (error) { onNotice({ tone: "danger", text: error instanceof Error ? error.message : "Could not delete profile." }); setDeleting(false); }
  }
  function setProvider(value: string) {
    setDraft((current) => ({ ...current, provider: value,
      executionLocation: value === "OpenAI" || value === "OpenRouter" ? "cloud" : current.executionLocation,
      endpoint: value === "OpenRouter" ? "https://openrouter.ai/api/v1" : value === "OpenAI" ? "https://api.openai.com/v1" : current.endpoint,
      model: value === "OpenAI" && current.kind === "mom" && !current.model ? "gpt-6-luna" : current.model,
    }));
  }
  async function discoverModels() {
    setCatalogBusy(true); setCatalogError(null);
    try { setCatalog(await meetingsService.listKnowledgeModels(profile.id)); }
    catch (cause) { setCatalogError(cause instanceof Error ? cause.message : "Could not load models."); }
    finally { setCatalogBusy(false); }
  }
  function toggleCapability(capability: Capability) {
    const hasCapability = draft.capabilities.includes(capability);
    update("capabilities", hasCapability ? draft.capabilities.filter((item) => item !== capability) : [...draft.capabilities, capability]);
  }
  const validateBlocked = isNew || hasUnsavedChanges;
  const catalogMatches = catalog?.models.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(catalogSearch.toLowerCase())).slice(0, CATALOG_RESULT_LIMIT) ?? [];

  return <aside id="provider-editor" className="card provider-editor" aria-label={`Edit ${profile.label}`}>
    <div className="card-header provider-editor-header">
      <span className="settings-icon" aria-hidden="true"><Icon /></span>
      <div>
        <p className="provider-editor-kind">{profileInfo[draft.kind].title}{isNew ? " · not saved yet" : ""}</p>
        <h2>{draft.label || "Untitled profile"}</h2>
      </div>
      {profile.isDefault ? <Badge tone="brand">Default</Badge> : null}
    </div>
    <form onSubmit={submit}>
      <div className="card-body form-stack">
        <div className="field">
          <label htmlFor="profile-label">Profile name</label>
          <input id="profile-label" value={draft.label} onChange={(event) => update("label", event.target.value)} required />
        </div>
        <div className="field-row">
          <UiSelect id="provider" label="Provider type" value={draft.provider} onChange={setProvider} options={providerOptions.map((option) => ({ value: option, label: option }))} />
          <UiSelect id="location" label="Execution location" value={draft.executionLocation} onChange={(value) => update("executionLocation", value as ProviderProfile["executionLocation"])} disabled={draft.provider === "OpenAI" || draft.provider === "OpenRouter"} options={[{ value: "local", label: "Local / self-hosted" }, { value: "cloud", label: "Cloud" }]} />
        </div>
        <div className="field">
          <div className="provider-field-label">
            <label htmlFor="model">Model</label>
            {canBrowseModels ? <button type="button" className="text-button" disabled={catalogBusy} onClick={() => void discoverModels()}>{catalogBusy ? "Loading models…" : catalog ? "Refresh live models" : "Browse live models"}</button> : null}
          </div>
          <input id="model" value={draft.model} onChange={(event) => update("model", event.target.value)} placeholder="Model ID" required />
          {catalogError ? <p className="form-error" role="alert">{catalogError}</p> : null}
        </div>
        {canBrowseModels && catalog ? <div className="inset-panel provider-catalog">
          <p className="field-hint">{catalog.models.length} models from {catalog.provider}. Pick one, then save. Availability and prices can change.</p>
          <div className="input-with-icon"><Search aria-hidden="true" /><input aria-label="Search provider models" value={catalogSearch} onChange={(event) => setCatalogSearch(event.target.value)} placeholder="Search by name or ID" /></div>
          <ul className="provider-catalog-results">
            {catalogMatches.map((item) => <li key={item.id}><button type="button" className="provider-catalog-item" aria-pressed={draft.model === item.id} onClick={() => update("model", item.id)}>
              <span><b>{item.name}</b><small>{item.id}</small></span>
              {item.input_per_million_usd !== null ? <small className="provider-catalog-price">${item.input_per_million_usd}/M in · ${item.output_per_million_usd}/M out</small> : null}
              {draft.model === item.id ? <Check aria-hidden="true" /> : null}
            </button></li>)}
            {catalogMatches.length ? null : <li className="provider-catalog-empty">No models match this search.</li>}
          </ul>
        </div> : null}
        <div className="field">
          <label htmlFor="endpoint">Base endpoint</label>
          <input id="endpoint" type="url" value={draft.endpoint} onChange={(event) => update("endpoint", event.target.value)} disabled={draft.provider === "OpenAI"} placeholder="https://api.example.com/v1" aria-describedby={draft.provider === "OpenRouter" || draft.provider === "OpenAI-compatible" ? "endpoint-hint" : undefined} />
          {draft.provider === "OpenRouter" || draft.provider === "OpenAI-compatible" ? <p id="endpoint-hint" className="field-hint">For a private server, choose OpenAI-compatible and enter its URL.</p> : null}
        </div>
        <ProviderKeyField draft={draft} credentials={credentials} canSaveKeys={canSaveKeys} value={keyChoice} onChange={setKeyChoice} />
        <fieldset className="provider-capabilities">
          <legend>Capabilities</legend>
          <div className="cluster">{capabilities.map((capability) => <label className="check-label" key={capability}><input type="checkbox" checked={draft.capabilities.includes(capability)} onChange={() => toggleCapability(capability)} />{capabilityLabel[capability]}</label>)}</div>
        </fieldset>
        <label className="choice-card">
          <input type="checkbox" checked={draft.isDefault} onChange={(event) => update("isDefault", event.target.checked)} />
          <span><b>Use as the default {defaultLabel[draft.kind]} profile</b><small>{defaultHint[draft.kind]}</small></span>
        </label>
        {confirmDelete ? <div id="provider-delete-confirm"><Alert tone="danger" className="provider-delete-confirm" title={`Delete ${profile.label}?`}>
          <p>Its stored key is removed and defaults are cleared. Meeting history stays.</p>
          <div className="button-group">
            <button className="button danger sm" type="button" disabled={deleting} onClick={() => void remove()}>{deleting ? "Deleting…" : "Delete profile"}</button>
            <button className="button secondary sm" type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        </Alert></div> : null}
      </div>
      <div className="card-footer split provider-editor-footer">
        {confirmDelete ? <span /> : <button className="button danger-outline icon" type="button" disabled={deleting} onClick={() => setConfirmDelete(true)} aria-label="Delete configuration" title="Delete configuration"><Trash2 aria-hidden="true" /></button>}
        <div className="button-group">
          <button className="button secondary" type="button" disabled={testing || saving || deleting || validateBlocked} onClick={() => void testConnection()} title={validateBlocked ? "Save changes first, then validate the stored configuration" : "Check the stored configuration without making a provider API call"}>{testing ? "Validating…" : "Validate saved configuration"}</button>
          <button className="button primary" type="submit" disabled={saving || deleting}>{saving ? "Saving…" : "Save profile"}</button>
        </div>
      </div>
    </form>
  </aside>;
}
