"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import { useUiPreference } from "@/lib/ui-preferences";
import type { AiSettingsView, ProfileKeyChoice, ProfileKind, ProviderProfile, VaultCredential } from "@/lib/types";
import { PageHeader } from "./ui/page-header";
import { Badge, EmptyState } from "./ui/feedback";
import { SettingsToast, type SettingsNotice } from "./settings-toast";
import { ProviderEditor } from "./provider-editor";
import { ApiKeysCard } from "./provider-keys";
import { WorkspaceAiCard } from "./ai-settings-card";
import { connectionText, connectionTone, isUnsavedProfile, profileInfo, profileKinds } from "./provider-profile-info";

const STACKED_LAYOUT_QUERY = "(max-width: 1100px)";

/** On stacked layouts the editor sits below the lists, so bring it into view after a selection. */
function revealEditor() {
  if (typeof window === "undefined" || !window.matchMedia(STACKED_LAYOUT_QUERY).matches) return;
  window.requestAnimationFrame(() => document.getElementById("provider-editor")?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

export function ProviderSettings({ identity, profiles, onProfilesChange }: { identity: string; profiles: ProviderProfile[]; onProfilesChange(profiles: ProviderProfile[]): void }) {
  const [selectedId, setSelectedId] = useUiPreference(`meetings-ai:provider-selection:${identity}`, "", (value): value is string => typeof value === "string");
  const [notice, setNotice] = useState<SettingsNotice | null>(null);
  const activeId = profiles.some((profile) => profile.id === selectedId) ? selectedId : (profiles[0]?.id ?? "");
  const selected = profiles.find((profile) => profile.id === activeId);
  const [credentials, setCredentials] = useState<VaultCredential[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [aiSettings, setAiSettings] = useState<AiSettingsView | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const isOwner = aiSettings?.can_edit === true;
  const textProfiles = profiles.filter((profile) => !isUnsavedProfile(profile.id) && profile.capabilities.includes("text_generation"));

  const refreshCredentials = useCallback(async () => {
    try { setCredentials(await meetingsService.listCredentials()); setKeysError(null); }
    catch (cause) { setKeysError(cause instanceof Error ? cause.message : "Saved keys could not be loaded."); }
    finally { setKeysLoading(false); }
  }, []);
  const refreshAiSettings = useCallback(async () => {
    try { setAiSettings(await meetingsService.getAiSettings()); setAiError(null); }
    catch (cause) { setAiError(cause instanceof Error ? cause.message : "Workspace AI settings could not be loaded."); }
  }, []);
  useEffect(() => {
    let active = true;
    meetingsService.listCredentials()
      .then((items) => { if (active) { setCredentials(items); setKeysError(null); } })
      .catch((cause: unknown) => { if (active) setKeysError(cause instanceof Error ? cause.message : "Saved keys could not be loaded."); })
      .finally(() => { if (active) setKeysLoading(false); });
    meetingsService.getAiSettings()
      .then((view) => { if (active) setAiSettings(view); })
      .catch((cause: unknown) => { if (active) setAiError(cause instanceof Error ? cause.message : "Workspace AI settings could not be loaded."); });
    return () => { active = false; };
  }, []);

  async function save(profile: ProviderProfile, apiKey?: string, keyChoice?: ProfileKeyChoice) {
    const saved = await meetingsService.saveProviderProfile(profile, apiKey, keyChoice);
    if (keyChoice) void refreshCredentials();
    onProfilesChange(profiles.map((candidate) => candidate.id === profile.id ? saved : candidate.kind === saved.kind && saved.isDefault ? { ...candidate, isDefault: false } : candidate));
    if (saved.kind === "mom") void refreshAiSettings(); // the default LLM feeds "Same as default" and Automatic vision
    setSelectedId(saved.id);
    setNotice({ tone: "success", text: `${saved.label} saved. API keys are write-only.` });
    return saved;
  }

  async function remove(profile: ProviderProfile) {
    await meetingsService.deleteProviderProfile(profile.id);
    void refreshCredentials(); void refreshAiSettings();
    const next = profiles.filter((candidate) => candidate.id !== profile.id).map((candidate) => candidate.kind === profile.kind && profile.isDefault ? { ...candidate, isDefault: false } : candidate);
    onProfilesChange(next);
    setSelectedId(next[0]?.id ?? "");
    setNotice({ tone: "success", text: `${profile.label} deleted. Its default selection and knowledge-base model reference were cleared; meeting history remains.` });
  }

  function addProfile(kind: ProfileKind) {
    const number = profiles.filter((profile) => profile.kind === kind).length + 1;
    const created: ProviderProfile = { id: `new-${kind}-${crypto.randomUUID()}`, kind, label: `New ${profileInfo[kind].noun} profile ${number}`, provider: "OpenAI-compatible", executionLocation: "local", endpoint: "", model: "", capabilities: profileInfo[kind].capabilities.slice(0, 1), connectionState: "not_configured", isDefault: false, apiKeyConfigured: false, credentialHint: null };
    onProfilesChange([...profiles, created]); setSelectedId(created.id); setNotice({ tone: "info", text: "New profile created. Add connection details and save it." });
    revealEditor();
  }

  function select(id: string) {
    setSelectedId(id);
    revealEditor();
  }

  return <section className="page wide provider-page" aria-labelledby="providers-title">
    <PageHeader
      titleId="providers-title"
      title="AI providers"
      description="Each step of the meeting pipeline uses a named model configuration. Defaults apply to the next bot join or draft; work already running keeps its route."
      actions={<span className="provider-privacy"><ShieldCheck aria-hidden="true" /> Keys are write-only and encrypted at rest</span>}
    />
    <div className="provider-overview">
      <ApiKeysCard credentials={credentials} loading={keysLoading} error={keysError} canManage={isOwner} onRefresh={refreshCredentials} onNotice={setNotice} />
      <WorkspaceAiCard view={aiSettings} error={aiError} profiles={textProfiles} exaKeys={credentials.filter((item) => item.provider_type === "exa")} keys={credentials} onProfileCreated={(created) => { onProfilesChange([...profiles.map((candidate) => created.isDefault && candidate.kind === created.kind ? { ...candidate, isDefault: false } : candidate), created]); void refreshCredentials(); void refreshAiSettings(); }} onSaved={(view) => { setAiSettings(view); void refreshCredentials(); }} onNotice={setNotice} />
    </div>
    <div className="provider-layout">
      <div className="provider-groups">
        {profileKinds.map((kind) => <ProfileGroup key={kind} kind={kind} profiles={profiles.filter((profile) => profile.kind === kind)} selectedId={activeId} onSelect={select} onAdd={() => addProfile(kind)} />)}
      </div>
      {selected
        ? <ProviderEditor key={selected.id} identity={identity} profile={selected} credentials={credentials} canSaveKeys={isOwner} onSave={save} onDelete={remove} onChange={(profile) => onProfilesChange(profiles.map((candidate) => candidate.id === selected.id ? profile : candidate))} onNotice={setNotice} />
        : <div className="provider-editor-empty"><EmptyState icon={<SlidersHorizontal />} title="Add your first configuration">Use an Add button to set up speech to text, an LLM or embeddings.</EmptyState></div>}
    </div>
    <SettingsToast notice={notice} onDismiss={() => setNotice(null)} />
  </section>;
}

function credentialText(profile: ProviderProfile): string {
  if (profile.credentialId && profile.credentialLabel) return profile.credentialLabel;
  if (profile.apiKeyConfigured) return profile.credentialHint ?? "Key saved";
  return profile.executionLocation === "local" ? "Key optional" : "No key";
}

function ProfileGroup({ kind, profiles, selectedId, onSelect, onAdd }: { kind: ProfileKind; profiles: ProviderProfile[]; selectedId: string; onSelect(id: string): void; onAdd(): void }) {
  const info = profileInfo[kind];
  const Icon = info.icon;
  return <section className="card provider-group" aria-labelledby={`${kind}-title`}>
    <div className="card-header provider-group-header">
      <span className="settings-icon" aria-hidden="true"><Icon /></span>
      <div><h2 id={`${kind}-title`}>{info.title}</h2><p>{info.description}</p></div>
      <button type="button" className="button secondary sm" onClick={onAdd} aria-label={`Add ${info.noun} profile`}><Plus aria-hidden="true" /> Add</button>
    </div>
    {profiles.length === 0 ? <p className="provider-group-empty">No configurations yet.</p> : <ul className="provider-rows">
      {profiles.map((profile) => {
        const unsaved = isUnsavedProfile(profile.id);
        return <li key={profile.id}>
          <button type="button" className="provider-row" aria-current={selectedId === profile.id ? "true" : undefined} onClick={() => onSelect(profile.id)}>
            <span className="provider-row-main">
              <span className="provider-row-title"><b>{profile.label}</b>{profile.isDefault ? <Badge tone="brand">Default</Badge> : null}</span>
              <small>{profile.provider} · {profile.model || "No model set"}</small>
            </span>
            <span className="provider-row-meta">
              <span className="tag">{profile.executionLocation === "local" ? "Local" : "Cloud"}</span>
              <span className="provider-row-key" title={profile.credentialLabel ? `Saved key ${profile.credentialLabel} ${profile.credentialHint ?? ""}`.trim() : undefined}><KeyRound aria-hidden="true" /><span>{credentialText(profile)}</span></span>
              {unsaved ? <Badge tone="warning" dot>Not saved</Badge> : <Badge tone={connectionTone[profile.connectionState]} dot>{connectionText[profile.connectionState]}</Badge>}
            </span>
          </button>
        </li>;
      })}
    </ul>}
  </section>;
}
