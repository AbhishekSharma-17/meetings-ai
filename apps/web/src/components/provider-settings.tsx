"use client";

import { useState } from "react";
import { KeyRound, Plus, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import { useUiPreference } from "@/lib/ui-preferences";
import type { ProfileKind, ProviderProfile } from "@/lib/types";
import { PageHeader } from "./ui/page-header";
import { Badge, EmptyState } from "./ui/feedback";
import { SettingsToast, type SettingsNotice } from "./settings-toast";
import { ProviderEditor } from "./provider-editor";
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

  async function save(profile: ProviderProfile, apiKey?: string) {
    const saved = await meetingsService.saveProviderProfile(profile, apiKey);
    onProfilesChange(profiles.map((candidate) => candidate.id === profile.id ? saved : candidate.kind === saved.kind && saved.isDefault ? { ...candidate, isDefault: false } : candidate));
    setSelectedId(saved.id);
    setNotice({ tone: "success", text: `${saved.label} saved. API keys are write-only.` });
    return saved;
  }

  async function remove(profile: ProviderProfile) {
    await meetingsService.deleteProviderProfile(profile.id);
    const next = profiles.filter((candidate) => candidate.id !== profile.id).map((candidate) => candidate.kind === profile.kind && profile.isDefault ? { ...candidate, isDefault: false } : candidate);
    onProfilesChange(next);
    setSelectedId(next[0]?.id ?? "");
    setNotice({ tone: "success", text: `${profile.label} deleted. Its default selection and knowledge-base model reference were cleared; meeting history remains.` });
  }

  function addProfile(kind: ProfileKind) {
    const number = profiles.filter((profile) => profile.kind === kind).length + 1;
    const created: ProviderProfile = { id: `new-${kind}-${crypto.randomUUID()}`, kind, label: `New ${profileInfo[kind].title} profile ${number}`, provider: "OpenAI-compatible", executionLocation: "local", endpoint: "", model: "", capabilities: profileInfo[kind].capabilities.slice(0, 1), connectionState: "not_configured", isDefault: false, apiKeyConfigured: false, credentialHint: null };
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
    <div className="provider-layout">
      <div className="provider-groups">
        {profileKinds.map((kind) => <ProfileGroup key={kind} kind={kind} profiles={profiles.filter((profile) => profile.kind === kind)} selectedId={activeId} onSelect={select} onAdd={() => addProfile(kind)} />)}
      </div>
      {selected
        ? <ProviderEditor key={selected.id} identity={identity} profile={selected} onSave={save} onDelete={remove} onChange={(profile) => onProfilesChange(profiles.map((candidate) => candidate.id === selected.id ? profile : candidate))} onNotice={setNotice} />
        : <div className="provider-editor-empty"><EmptyState icon={<SlidersHorizontal />} title="Add your first configuration">Use an Add button to set up transcription, minutes or embeddings.</EmptyState></div>}
    </div>
    <SettingsToast notice={notice} onDismiss={() => setNotice(null)} />
  </section>;
}

function credentialText(profile: ProviderProfile): string {
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
      <button type="button" className="button secondary sm" onClick={onAdd} aria-label={`Add ${info.title} profile`}><Plus aria-hidden="true" /> Add</button>
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
              <span className="provider-row-key"><KeyRound aria-hidden="true" />{credentialText(profile)}</span>
              {unsaved ? <Badge tone="warning" dot>Not saved</Badge> : <Badge tone={connectionTone[profile.connectionState]} dot>{connectionText[profile.connectionState]}</Badge>}
            </span>
          </button>
        </li>;
      })}
    </ul>}
  </section>;
}
