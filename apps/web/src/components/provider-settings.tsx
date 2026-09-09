"use client";

import { FormEvent, useMemo, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { Capability, ConnectionState, ProfileKind, ProviderProfile } from "@/lib/types";

const profileInfo: Record<ProfileKind, { title: string; description: string; capabilities: Capability[] }> = {
  transcription: { title: "Transcription", description: "Turns meeting audio into a searchable, attributed transcript.", capabilities: ["transcription"] },
  mom: { title: "MOM & actions", description: "Creates minutes, decisions, action items and email-ready follow-ups.", capabilities: ["text_generation"] },
  embedding: { title: "Knowledge embeddings", description: "Indexes approved meeting knowledge for retrieval and future briefs.", capabilities: ["embeddings"] },
};

const providerOptions = ["OpenAI", "Vexa native / self-hosted", "OpenAI-compatible"];
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

  function addProfile(kind: ProfileKind) {
    const number = profiles.filter((profile) => profile.kind === kind).length + 1;
    const created: ProviderProfile = { id: `new-${kind}-${number}`, kind, label: `New ${profileInfo[kind].title} profile ${number}`, provider: "OpenAI-compatible", executionLocation: "local", endpoint: "", model: "", capabilities: profileInfo[kind].capabilities.slice(0, 1), connectionState: "not_configured", isDefault: false, apiKeyConfigured: false };
    onProfilesChange([...profiles, created]); setSelectedId(created.id); setNotice("New profile created. Add connection details and save it.");
  }

  return <section className="page provider-page">
    <div className="provider-heading"><div><p className="eyebrow">SETTINGS</p><h1>AI providers</h1><p className="intro">Configure each stage independently. Your credentials remain write-only and are never displayed here.</p></div><div className="privacy-note"><span aria-hidden="true">⌁</span><span>Provider-agnostic by design</span></div></div>
    {notice ? <div className="toast" role="status"><span>✓</span>{notice}<button aria-label="Dismiss notice" onClick={() => setNotice(null)}>×</button></div> : null}
    <div className="provider-layout">
      <div className="profile-groups">
        {(Object.keys(profileInfo) as ProfileKind[]).map((kind) => <ProfileGroup key={kind} kind={kind} profiles={profiles.filter((profile) => profile.kind === kind)} selectedId={activeId} onSelect={setSelectedId} onAdd={() => addProfile(kind)} />)}
      </div>
      {selected ? <ProfileEditor key={selected.id} profile={selected} onSave={save} onChange={(profile) => onProfilesChange(profiles.map((candidate) => candidate.id === selected.id ? profile : candidate))} onNotice={setNotice} /> : null}
    </div>
  </section>;
}

function ProfileGroup({ kind, profiles, selectedId, onSelect, onAdd }: { kind: ProfileKind; profiles: ProviderProfile[]; selectedId: string; onSelect(id: string): void; onAdd(): void }) {
  const info = profileInfo[kind];
  return <section className="profile-group" aria-labelledby={`${kind}-title`}>
    <div className="group-heading"><div><h2 id={`${kind}-title`}>{info.title}</h2><p>{info.description}</p></div><button className="icon-add" onClick={onAdd} aria-label={`Add ${info.title} profile`}>+</button></div>
    <div className="profile-stack">{profiles.map((profile) => <button key={profile.id} className={selectedId === profile.id ? "profile-card selected" : "profile-card"} onClick={() => onSelect(profile.id)}>
      <span className={`connection-dot ${profile.connectionState}`} aria-hidden="true" />
      <span className="profile-card-copy"><b>{profile.label}</b><small>{profile.provider} · {profile.model || "No model set"}</small></span>
      {profile.isDefault ? <span className="default-pill">Default</span> : null}
    </button>)}</div>
  </section>;
}

function ProfileEditor({ profile, onSave, onChange, onNotice }: { profile: ProviderProfile; onSave(profile: ProviderProfile, apiKey?: string): Promise<void>; onChange(profile: ProviderProfile): void; onNotice(message: string): void }) {
  const [draft, setDraft] = useState(profile);
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const capabilities = useMemo(() => profileInfo[draft.kind].capabilities, [draft.kind]);
  const update = <K extends keyof ProviderProfile>(key: K, value: ProviderProfile[K]) => setDraft((current) => ({ ...current, [key]: value }));

  async function testConnection() {
    setTesting(true); update("connectionState", "checking");
    const tested = await meetingsService.testProviderConnection(draft, apiKey || undefined);
    setDraft(tested); onChange(tested); setApiKey(""); setTesting(false);
    onNotice(tested.connectionState === "configured" ? "Configuration is valid. The live network probe lands with the provider adapter." : "Add the required endpoint or credential and try again.");
  }
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await onSave(draft, apiKey || undefined); setApiKey(""); }
  function toggleCapability(capability: Capability) {
    const hasCapability = draft.capabilities.includes(capability);
    update("capabilities", hasCapability ? draft.capabilities.filter((item) => item !== capability) : [...draft.capabilities, capability]);
  }

  return <aside className="provider-editor" aria-label={`Edit ${profile.label}`}>
    <div className="editor-title"><div><p className="eyebrow">PROFILE</p><h2>{profileInfo[draft.kind].title}</h2></div><span className={`connection-state ${draft.connectionState}`}><i />{connectionText[draft.connectionState]}</span></div>
    <form onSubmit={submit}>
      <label htmlFor="profile-label">Profile name</label><input id="profile-label" value={draft.label} onChange={(event) => update("label", event.target.value)} required />
      <div className="field-grid"><div><label htmlFor="provider">Provider type</label><select id="provider" value={draft.provider} onChange={(event) => update("provider", event.target.value)}>{providerOptions.map((option) => <option key={option}>{option}</option>)}</select></div><div><label htmlFor="location">Execution location</label><select id="location" value={draft.executionLocation} onChange={(event) => update("executionLocation", event.target.value as ProviderProfile["executionLocation"])} disabled={draft.provider === "OpenAI"}><option value="local">Local / self-hosted</option><option value="cloud">Cloud</option></select></div></div>
      <label htmlFor="model">Model</label><input id="model" value={draft.model} onChange={(event) => update("model", event.target.value)} placeholder="Model ID" required />
      <label htmlFor="endpoint">Base endpoint</label><input id="endpoint" type="url" value={draft.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder="https://api.example.com/v1" />
      <label htmlFor="api-key">API key <span className="optional">write-only</span></label><div className="key-input"><input id="api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={draft.apiKeyConfigured ? "A key is already configured" : "Paste a new API key"} autoComplete="new-password" /><span aria-hidden="true">•••</span></div><p className="field-hint">Keys are sent only when you save or test. This UI never reads them back.</p>
      <fieldset><legend>Capabilities</legend><div className="capabilities">{capabilities.map((capability) => <label className="capability" key={capability}><input type="checkbox" checked={draft.capabilities.includes(capability)} onChange={() => toggleCapability(capability)} /><span>{capability.replace("_", " ")}</span></label>)}</div></fieldset>
      <label className="default-selector"><input type="checkbox" checked={draft.isDefault} onChange={(event) => update("isDefault", event.target.checked)} /><span><b>Use as the default {profileInfo[draft.kind].title.toLowerCase()} profile</b><small>New meetings will use this profile unless changed.</small></span></label>
      <div className="editor-actions"><button className="button secondary" type="button" disabled={testing} onClick={() => void testConnection()}>{testing ? "Testing…" : "Test connection"}</button><button className="button primary" type="submit">Save profile</button></div>
    </form>
  </aside>;
}
