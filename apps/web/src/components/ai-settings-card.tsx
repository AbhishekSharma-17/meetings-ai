"use client";

import { useState } from "react";
import { BrainCircuit, Globe, Lock, MessageSquareText, ScanText } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { AiSettingsInput, AiSettingsView, ProviderProfile, VaultCredential } from "@/lib/types";
import { UiSelect } from "./ui-select";
import { Alert, Badge } from "./ui/feedback";
import type { SettingsNotice } from "./settings-toast";
import { ModelRoutePicker, NONE, type ModelRoute } from "./ai-settings-model-picker";

type Draft = { chat: ModelRoute; vision: ModelRoute; researchKey: string; research: ModelRoute };

function draftFrom(view: AiSettingsView): Draft {
  return {
    chat: { profileId: view.chat_profile_id ?? "", model: view.chat_model ?? "" },
    vision: { profileId: view.vision_profile_id ?? "", model: view.vision_model ?? "" },
    researchKey: view.research_credential_id ?? "",
    research: { profileId: view.research_profile_id ?? "", model: view.research_model ?? "" },
  };
}

function toInput(draft: Draft): AiSettingsInput {
  const route = (value: ModelRoute) => ({ id: value.profileId || null, model: value.profileId && value.model ? value.model : null });
  const chat = route(draft.chat), vision = route(draft.vision), research = route(draft.research);
  return {
    chat_profile_id: chat.id, chat_model: chat.model,
    vision_profile_id: vision.id, vision_model: vision.model,
    research_credential_id: draft.researchKey || null,
    research_profile_id: research.id, research_model: research.model,
  };
}

// Recommended GPT-6 routing, checked 2026-09-27 in OpenAI's model docs/pricing and
// OpenRouter's live catalog: gpt-6-luna reads text and images at $0.10 / $0.50 per 1M
// tokens; gpt-6-sol ($2 / $10) drafts minutes and writes research briefs.
const RECOMMENDED = { chat: "gpt-6-luna", vision: "gpt-6-luna", research: "gpt-6-sol", minutes: "gpt-6-sol" } as const;
const OPENROUTER_URL = "https://openrouter.ai/api/v1";

function isOpenAiDirect(profile: ProviderProfile): boolean {
  return profile.provider === "OpenAI" && (!profile.endpoint || profile.endpoint.startsWith("https://api.openai.com"));
}

function isOpenRouter(profile: ProviderProfile): boolean {
  return profile.endpoint.replace(/\/$/, "") === OPENROUTER_URL;
}

/** Model id for a GPT-6 variant on this profile's route (OpenRouter prefixes the vendor). */
function routedModel(profile: ProviderProfile, model: string): string {
  return isOpenRouter(profile) ? `openai/${model}` : model;
}

function recommendedDraft(draft: Draft, profiles: ProviderProfile[]): Draft | null {
  const usable = profiles.filter((profile) => profile.capabilities.includes("text_generation") && !profile.id.startsWith("new-"));
  const route = usable.find(isOpenAiDirect) ?? usable.find(isOpenRouter);
  if (!route) return null;
  return {
    ...draft,
    chat: { profileId: route.id, model: routedModel(route, RECOMMENDED.chat) },
    vision: { profileId: route.id, model: routedModel(route, RECOMMENDED.vision) },
    research: { profileId: route.id, model: routedModel(route, RECOMMENDED.research) },
  };
}

/** A minutes/text profile on a saved OpenAI or OpenRouter key, for workspaces with none yet. */
function starterProfile(key: VaultCredential, makeDefault: boolean): ProviderProfile {
  const openai = key.provider_type === "openai";
  return {
    id: "new-recommended", kind: "mom", label: openai ? "GPT-6 (OpenAI)" : "GPT-6 via OpenRouter",
    provider: openai ? "OpenAI" : "OpenRouter", executionLocation: "cloud",
    endpoint: openai ? "" : OPENROUTER_URL, model: openai ? RECOMMENDED.minutes : `openai/${RECOMMENDED.minutes}`,
    capabilities: ["text_generation"], connectionState: "not_configured", isDefault: makeDefault,
    apiKeyConfigured: false, credentialHint: null, credentialId: key.id, credentialLabel: key.label,
  };
}

/** One-line description of the model that answers Ask AI, for everyone. */
export function effectiveChatText(view: AiSettingsView): string {
  const route = view.effective_chat;
  if (route.source === "not_configured" || !route.model) return "Ask AI has no model yet";
  const name = route.profile_name ? ` via ${route.profile_name}` : "";
  return route.source === "workspace_settings" ? `Ask AI uses ${route.model}${name}` : `Ask AI uses the workspace default, ${route.model}${name}`;
}

export function WorkspaceAiCard({ view, error, profiles, exaKeys, keys = [], onProfileCreated, onSaved, onNotice }: {
  view: AiSettingsView | null;
  error: string | null;
  profiles: ProviderProfile[];
  exaKeys: VaultCredential[];
  keys?: VaultCredential[];
  onProfileCreated?(profile: ProviderProfile): void;
  onSaved(view: AiSettingsView): void;
  onNotice(notice: SettingsNotice): void;
}) {
  if (!view) return error ? <section className="card workspace-ai" aria-labelledby="workspace-ai-title">
    <CardHead />
    <div className="card-body"><Alert tone="warning" title="Workspace AI settings are unavailable">{error}</Alert></div>
  </section> : null;
  if (!view.can_edit) return <section className="card workspace-ai" aria-labelledby="workspace-ai-title">
    <CardHead readOnly />
    <div className="card-body workspace-ai-readonly">
      <MessageSquareText aria-hidden="true" />
      <p><b>{effectiveChatText(view)}</b><small>Set by the workspace owner.{view.research_configured ? " Web research is on." : ""}</small></p>
    </div>
  </section>;
  return <OwnerForm key={JSON.stringify(toInput(draftFrom(view)))} view={view} profiles={profiles} exaKeys={exaKeys} keys={keys} onProfileCreated={onProfileCreated} onSaved={onSaved} onNotice={onNotice} />;
}

function CardHead({ readOnly = false }: { readOnly?: boolean }) {
  return <div className="card-header provider-group-header">
    <span className="settings-icon" aria-hidden="true"><BrainCircuit /></span>
    <div><h2 id="workspace-ai-title">Workspace AI</h2><p>{readOnly ? "Models used by everyone in this workspace." : "Models used by everyone. Only you, the owner, can change them."}</p></div>
    {readOnly ? <Badge tone="neutral"><Lock aria-hidden="true" /> Owner only</Badge> : null}
  </div>;
}

function OwnerForm({ view, profiles, exaKeys, keys, onProfileCreated, onSaved, onNotice }: {
  view: AiSettingsView;
  profiles: ProviderProfile[];
  exaKeys: VaultCredential[];
  keys: VaultCredential[];
  onProfileCreated?(profile: ProviderProfile): void;
  onSaved(view: AiSettingsView): void;
  onNotice(notice: SettingsNotice): void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(view));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(toInput(draft)) !== JSON.stringify(toInput(draftFrom(view)));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const recommended = recommendedDraft(draft, profiles);
  const starterKey = recommended ? undefined : keys.find((key) => key.provider_type === "openai") ?? keys.find((key) => key.provider_type === "openrouter");
  const [settingUp, setSettingUp] = useState(false);

  async function setUpRecommended() {
    if (!starterKey) return;
    setSettingUp(true); setError(null);
    try {
      const hasTextDefault = profiles.some((profile) => profile.isDefault && profile.capabilities.includes("text_generation"));
      const created = await meetingsService.saveProviderProfile(starterProfile(starterKey, !hasTextDefault), undefined, { credentialId: starterKey.id });
      onProfileCreated?.(created);
      const next = recommendedDraft(draft, [created]);
      if (next) setDraft(next);
      onNotice({ tone: "success", text: `Created “${created.label}” on ${starterKey.label}. Review the models below, then save.` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the recommended profile.");
    } finally { setSettingUp(false); }
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      const saved = await meetingsService.updateAiSettings(toInput(draft));
      onSaved(saved);
      onNotice({ tone: "success", text: `Workspace AI saved. ${effectiveChatText(saved)}.` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Workspace AI settings could not be saved.");
    } finally { setSaving(false); }
  }

  return <section className="card workspace-ai" aria-labelledby="workspace-ai-title">
    <CardHead />
    <div className="card-body workspace-ai-grid">
      <fieldset className="workspace-ai-section">
        <legend><MessageSquareText aria-hidden="true" /> Ask AI chat</legend>
        <p className="field-hint">Answers every knowledge question. {effectiveChatText(view)}.</p>
        <ModelRoutePicker id="ai-chat" name="Ask AI" profiles={profiles} value={draft.chat} onChange={(value) => set("chat", value)} noneLabel="Workspace default (MOM & actions)" />
      </fieldset>
      <fieldset className="workspace-ai-section">
        <legend><ScanText aria-hidden="true" /> Vision & OCR</legend>
        <p className="field-hint">Reads scanned pages and images. Automatic uses gpt-6-luna on your OpenAI or OpenRouter default.</p>
        <ModelRoutePicker id="ai-vision" name="Vision" profiles={profiles} value={draft.vision} onChange={(value) => set("vision", value)} noneLabel="Automatic" />
      </fieldset>
      <fieldset className="workspace-ai-section">
        <legend><Globe aria-hidden="true" /> Web research</legend>
        <p className="field-hint">Meeting prep: Exa searches the web and a text model writes the brief.</p>
        <UiSelect id="ai-research-key" label="Exa key" value={draft.researchKey || NONE} onChange={(value) => set("researchKey", value === NONE ? "" : value)}
          options={[{ value: NONE, label: exaKeys.length ? "Off" : "Off · add an Exa key first" }, ...exaKeys.map((key) => ({ value: key.id, label: `${key.label} · ${key.hint}` }))]} />
        <ModelRoutePicker id="ai-research" name="Research writing" profiles={profiles} value={draft.research} onChange={(value) => set("research", value)} noneLabel="Workspace default (MOM & actions)" />
      </fieldset>
    </div>
    {error ? <div className="workspace-ai-error"><Alert tone="danger">{error}</Alert></div> : null}
    <div className="card-footer split">
      <span className="cluster">
        {recommended ? <button type="button" className="button secondary sm" onClick={() => setDraft(recommended)} title="Ask AI and vision: gpt-6-luna · research writing: gpt-6-sol">Apply recommended models</button>
          : starterKey ? <button type="button" className="button secondary sm" disabled={settingUp} onClick={() => void setUpRecommended()} title={`Creates a GPT-6 minutes profile on ${starterKey.label}`}>{settingUp ? "Setting up…" : "Set up recommended models"}</button> : null}
        <span className="field-hint">{profiles.length ? "Leave a model blank to use the profile's own model." : starterKey ? `No model profile yet. Set up uses your saved key “${starterKey.label}”.` : "Add an OpenAI or OpenRouter key above, or a MOM & actions profile below."}</span>
      </span>
      <button type="button" className={dirty ? "button primary" : "button secondary"} disabled={saving || !dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save workspace AI"}</button>
    </div>
  </section>;
}
