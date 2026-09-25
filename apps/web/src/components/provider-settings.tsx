"use client";

import { FormEvent, useMemo, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { Capability, ConnectionState, ProfileKind, ProviderProfile } from "@/lib/types";
import { UiSelect } from "./ui-select";
import { AudioLines, BookOpenText, FileText, KeyRound, ShieldCheck, Trash2 } from "lucide-react";

const profileInfo: Record<ProfileKind, { title: string; description: string; capabilities: Capability[] }> = {
  transcription: { title: "Transcription", description: "Turns meeting audio into a searchable, attributed transcript.", capabilities: ["transcription"] },
  mom: { title: "MOM & actions", description: "Creates minutes, decisions, action items and email-ready follow-ups.", capabilities: ["text_generation"] },
  embedding: { title: "Knowledge embeddings", description: "Indexes approved meeting knowledge for retrieval and future briefs.", capabilities: ["embeddings"] },
};

const providerOptions = ["OpenAI", "OpenRouter", "Vexa native / self-hosted", "OpenAI-compatible"];
const connectionText: Record<ConnectionState, string> = { configured: "Configuration valid", not_configured: "Not configured", checking: "Checking…", failed: "Check failed" };

export function ProviderSettings({ profiles, onProfilesChange }: { profiles: ProviderProfile[]; onProfilesChange(profiles: ProviderProfile[]): void }) {
  const [selectedId, setSelectedId] = useState<string>(profiles[0]?.id ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const activeId = profiles.some((profile) => profile.id === selectedId) ? selectedId : (profiles[0]?.id ?? "");
  const selected = profiles.find((profile) => profile.id === activeId);

  async function save(profile: ProviderProfile, apiKey?: string) {
    const saved = await meetingsService.saveProviderProfile(profile, apiKey);
    onProfilesChange(profiles.map((candidate) => candidate.id === profile.id ? saved : candidate.kind === saved.kind && saved.isDefault ? { ...candidate, isDefault: false } : candidate));
    setSelectedId(saved.id);
    setNotice(`${saved.label} saved. API keys are write-only.`);
  }

  async function remove(profile: ProviderProfile) {
    await meetingsService.deleteProviderProfile(profile.id);
    const next = profiles.filter((candidate) => candidate.id !== profile.id).map((candidate) => candidate.kind === profile.kind && profile.isDefault ? { ...candidate, isDefault: false } : candidate);
    onProfilesChange(next);
    setSelectedId(next[0]?.id ?? "");
    setNotice(`${profile.label} deleted. Any default selection and knowledge-base model reference were cleared; prior meeting history remains.`);
  }

  function addProfile(kind: ProfileKind) {
    const number = profiles.filter((profile) => profile.kind === kind).length + 1;
    const created: ProviderProfile = { id: `new-${kind}-${crypto.randomUUID()}`, kind, label: `New ${profileInfo[kind].title} profile ${number}`, provider: "OpenAI-compatible", executionLocation: "local", endpoint: "", model: "", capabilities: profileInfo[kind].capabilities.slice(0, 1), connectionState: "not_configured", isDefault: false, apiKeyConfigured: false, credentialHint: null };
    onProfilesChange([...profiles, created]); setSelectedId(created.id); setNotice("New profile created. Add connection details and save it.");
  }

  const savedCount = profiles.filter((profile) => !profile.id.startsWith("new-")).length;
  return <section className="page provider-page">
    <div className="provider-heading"><div><p className="eyebrow">AI WORKSPACE</p><h1>AI providers</h1><p className="intro">Build your model pipeline from named configurations. Choose a different provider for capture, meeting intelligence, and knowledge.</p></div><div className="privacy-note"><ShieldCheck aria-hidden="true" /><span>Credentials encrypted at rest</span></div></div>
    <div className="provider-overview"><div className="provider-overview-intro"><span className="provider-overview-icon"><KeyRound /></span><span><b>{savedCount} saved configuration{savedCount === 1 ? "" : "s"}</b><small>Keys stay write-only; only their last four characters are shown here.</small></span></div><div className="provider-flow" aria-label="AI pipeline">{(Object.keys(profileInfo) as ProfileKind[]).map((kind) => { const items = profiles.filter((profile) => profile.kind === kind && !profile.id.startsWith("new-")); const active = items.find((profile) => profile.isDefault); const Icon = kind === "transcription" ? AudioLines : kind === "mom" ? FileText : BookOpenText; return <div className="provider-flow-stage" key={kind}><span className="provider-flow-icon"><Icon /></span><span><small>{profileInfo[kind].title}</small><b>{active ? active.label : items.length ? `${items.length} saved · no default` : "Not configured"}</b></span><i className={active ? "ready" : ""} aria-hidden="true" /></div>; })}</div></div>
    <div className="provider-runtime-note" role="note"><b>Routing</b><span>Transcription defaults apply to the next bot join. MOM defaults generate meeting drafts. Each knowledge base can select its own Ask AI model. Changing a default never switches a bot already in a call. “Validate” checks saved fields; it does not make a live model request.</span></div>
    {notice ? <div className="toast" role="status"><span>✓</span>{notice}<button aria-label="Dismiss notice" onClick={() => setNotice(null)}>×</button></div> : null}
    <div className="provider-layout">
      <div className="profile-groups">
        {(Object.keys(profileInfo) as ProfileKind[]).map((kind) => <ProfileGroup key={kind} kind={kind} profiles={profiles.filter((profile) => profile.kind === kind)} selectedId={activeId} onSelect={setSelectedId} onAdd={() => addProfile(kind)} />)}
      </div>
      {selected ? <ProfileEditor key={selected.id} profile={selected} onSave={save} onDelete={remove} onChange={(profile) => onProfilesChange(profiles.map((candidate) => candidate.id === selected.id ? profile : candidate))} onNotice={setNotice} /> : <div className="provider-editor provider-empty"><h2>Add your first configuration</h2><p>Choose a + button to configure transcription, MOM generation, or embeddings. Profiles only appear here after you create them.</p></div>}
    </div>
  </section>;
}

function ProfileGroup({ kind, profiles, selectedId, onSelect, onAdd }: { kind: ProfileKind; profiles: ProviderProfile[]; selectedId: string; onSelect(id: string): void; onAdd(): void }) {
  const info = profileInfo[kind];
  return <section className="profile-group" aria-labelledby={`${kind}-title`}>
    <div className="group-heading"><div><h2 id={`${kind}-title`}>{info.title}</h2><p>{info.description}</p></div><button className="icon-add" onClick={onAdd} aria-label={`Add ${info.title} profile`}>+</button></div>
    <div className="profile-stack">{profiles.length === 0 ? <p className="profile-empty">No configurations yet</p> : null}{profiles.map((profile) => <button key={profile.id} className={selectedId === profile.id ? "profile-card selected" : "profile-card"} onClick={() => onSelect(profile.id)}>
      <span className={`connection-dot ${profile.connectionState}`} aria-hidden="true" />
      <span className="profile-card-copy"><b>{profile.label}</b><small>{profile.provider} · {profile.model || "No model set"}</small><small>{profile.apiKeyConfigured ? `Key ${profile.credentialHint ?? "saved"}` : profile.executionLocation === "local" ? "Local endpoint" : "Key needed"}</small></span>
      {profile.isDefault ? <span className="default-pill">Default</span> : null}
    </button>)}</div>
  </section>;
}

function ProfileEditor({ profile, onSave, onDelete, onChange, onNotice }: { profile: ProviderProfile; onSave(profile: ProviderProfile, apiKey?: string): Promise<void>; onDelete(profile: ProviderProfile): Promise<void>; onChange(profile: ProviderProfile): void; onNotice(message: string): void }) {
  const [draft, setDraft] = useState(profile);
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const capabilities = useMemo(() => profileInfo[draft.kind].capabilities, [draft.kind]);
  const hasUnsavedChanges = Boolean(apiKey) || draft.label !== profile.label || draft.provider !== profile.provider
    || draft.executionLocation !== profile.executionLocation || draft.endpoint !== profile.endpoint
    || draft.model !== profile.model || draft.isDefault !== profile.isDefault
    || draft.capabilities.join(",") !== profile.capabilities.join(",");
  const update = <K extends keyof ProviderProfile>(key: K, value: ProviderProfile[K]) => setDraft((current) => ({ ...current, [key]: value }));

  async function testConnection() {
    setTesting(true); update("connectionState", "checking");
    try {
      const tested = await meetingsService.testProviderConnection(profile);
      setDraft((current) => ({ ...current, connectionState: tested.connectionState }));
      onChange(tested);
      onNotice(tested.connectionState === "configured" ? "Configuration fields are valid. Runtime connectivity is checked when that provider workflow is enabled." : "Add the required endpoint or credential and try again.");
    } catch (error) {
      const failed = { ...draft, connectionState: "failed" as const };
      setDraft(failed); onChange(failed);
      onNotice(error instanceof Error ? error.message : "Configuration validation failed.");
    } finally {
      setTesting(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true);
    try { await onSave(draft, apiKey || undefined); setApiKey(""); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Could not save profile."); }
    finally { setSaving(false); }
  }
  async function remove() {
    setDeleting(true);
    try { await onDelete(profile); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Could not delete profile."); setDeleting(false); }
  }
  function setProvider(value: string) {
    setDraft((current) => ({ ...current, provider: value,
      executionLocation: value === "OpenAI" || value === "OpenRouter" ? "cloud" : current.executionLocation,
      endpoint: value === "OpenRouter" ? "https://openrouter.ai/api/v1" : value === "OpenAI" ? "https://api.openai.com/v1" : current.endpoint,
    }));
  }
  function toggleCapability(capability: Capability) {
    const hasCapability = draft.capabilities.includes(capability);
    update("capabilities", hasCapability ? draft.capabilities.filter((item) => item !== capability) : [...draft.capabilities, capability]);
  }

  return <aside className="provider-editor" aria-label={`Edit ${profile.label}`}>
    <div className="editor-title"><div><p className="eyebrow">CONFIGURATION</p><h2>{draft.label}</h2><p className="provider-editor-subtitle">{profileInfo[draft.kind].title} · {draft.provider}</p></div><span className={`connection-state ${draft.connectionState}`}><i />{connectionText[draft.connectionState]}</span></div>
    <form onSubmit={submit}>
      <label htmlFor="profile-label">Profile name</label><input id="profile-label" value={draft.label} onChange={(event) => update("label", event.target.value)} required />
      <div className="field-grid"><UiSelect id="provider" label="Provider type" value={draft.provider} onChange={setProvider} options={providerOptions.map((option) => ({ value: option, label: option }))} /><UiSelect id="location" label="Execution location" value={draft.executionLocation} onChange={(value) => update("executionLocation", value as ProviderProfile["executionLocation"])} disabled={draft.provider === "OpenAI" || draft.provider === "OpenRouter"} options={[{ value: "local", label: "Local / self-hosted" }, { value: "cloud", label: "Cloud" }]} /></div>
      <label htmlFor="model">Model</label><input id="model" value={draft.model} onChange={(event) => update("model", event.target.value)} placeholder="Model ID" required />
      <label htmlFor="endpoint">Base endpoint</label><input id="endpoint" type="url" value={draft.endpoint} onChange={(event) => update("endpoint", event.target.value)} disabled={draft.provider === "OpenAI"} placeholder="https://api.example.com/v1" />{draft.provider === "OpenRouter" || draft.provider === "OpenAI-compatible" ? <p className="field-hint">OpenRouter uses its OpenAI-compatible endpoint. For a private server, choose OpenAI-compatible and enter your URL.</p> : null}
      <div className={draft.apiKeyConfigured ? "provider-key-status saved" : "provider-key-status"}><KeyRound /><span><b>{draft.apiKeyConfigured ? "API key saved" : draft.executionLocation === "local" ? "Local connection" : "API key not configured"}</b><small>{draft.apiKeyConfigured ? `Ending in ${draft.credentialHint ?? "••••"} · encrypted at rest` : draft.executionLocation === "local" ? "A key is optional if your endpoint does not require one." : "Add a key to use this cloud provider."}</small></span></div>
      <label htmlFor="api-key">API key <span className="optional">write-only</span></label><div className="key-input"><input id="api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={draft.apiKeyConfigured ? "A key is already configured" : "Paste a new API key"} autoComplete="new-password" /><span aria-hidden="true">•••</span></div><p className="field-hint">Leave blank to keep the saved key, or enter a replacement. The existing key is never returned to the browser.</p>
      <fieldset><legend>Capabilities</legend><div className="capabilities">{capabilities.map((capability) => <label className="capability" key={capability}><input type="checkbox" checked={draft.capabilities.includes(capability)} onChange={() => toggleCapability(capability)} /><span>{capability.replace("_", " ")}</span></label>)}</div></fieldset>
      <label className="default-selector"><input type="checkbox" checked={draft.isDefault} onChange={(event) => update("isDefault", event.target.checked)} /><span><b>Use as the default {profileInfo[draft.kind].title.toLowerCase()} profile</b><small>{draft.kind === "mom" ? "Used for new MOM drafts." : draft.kind === "transcription" ? "Used for the next bot join; active bots keep their route." : "Saved for the future knowledge-base workflow."}</small></span></label>
      {confirmDelete ? <div className="provider-delete-confirm" role="alert"><span>Delete <b>{profile.label}</b>? This removes its stored key and clears defaults. Meeting history stays.</span><button className="button secondary" type="button" onClick={() => setConfirmDelete(false)}>Cancel</button><button className="button danger" type="button" disabled={deleting} onClick={() => void remove()}>{deleting ? "Deleting…" : "Delete profile"}</button></div> : null}
      <div className="editor-actions"><button className="button secondary" type="button" disabled={testing || saving || deleting || profile.id.startsWith("new-") || hasUnsavedChanges} onClick={() => void testConnection()} title={profile.id.startsWith("new-") || hasUnsavedChanges ? "Save changes first, then validate the stored configuration" : "Check the stored configuration without making a provider API call"}>{testing ? "Validating…" : "Validate saved configuration"}</button><button className="button primary" type="submit" disabled={saving || deleting}>{saving ? "Saving…" : "Save profile"}</button></div>
      <button className="provider-delete-trigger" type="button" disabled={deleting} onClick={() => setConfirmDelete(true)}><Trash2 size={15} /> Delete configuration</button>
    </form>
  </aside>;
}
