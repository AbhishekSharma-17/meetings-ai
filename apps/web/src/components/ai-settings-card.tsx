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

// Recommended GPT-6 routing (checked 2026-09-27 in OpenAI's model docs and pricing):
// gpt-6-luna reads text and images at $0.10 / $0.50 per 1M tokens; gpt-6-sol ($2 / $10)
// writes the longer research briefs. Only offered when an OpenAI profile exists.
const RECOMMENDED = { chat: "gpt-6-luna", vision: "gpt-6-luna", research: "gpt-6-sol" } as const;

function recommendedDraft(draft: Draft, profiles: ProviderProfile[]): Draft | null {
  const openai = profiles.find((profile) => profile.provider === "OpenAI" && profile.capabilities.includes("text_generation")
    && !profile.id.startsWith("new-") && (!profile.endpoint || profile.endpoint.startsWith("https://api.openai.com")));
  if (!openai) return null;
  return {
    ...draft,
    chat: { profileId: openai.id, model: RECOMMENDED.chat },
    vision: { profileId: openai.id, model: RECOMMENDED.vision },
    research: { profileId: openai.id, model: RECOMMENDED.research },
  };
}

/** One-line description of the model that answers Ask AI, for everyone. */
export function effectiveChatText(view: AiSettingsView): string {
  const route = view.effective_chat;
  if (route.source === "not_configured" || !route.model) return "Ask AI has no model yet";
  const name = route.profile_name ? ` via ${route.profile_name}` : "";
  return route.source === "workspace_settings" ? `Ask AI uses ${route.model}${name}` : `Ask AI uses the workspace default, ${route.model}${name}`;
}

export function WorkspaceAiCard({ view, error, profiles, exaKeys, onSaved, onNotice }: {
  view: AiSettingsView | null;
  error: string | null;
  profiles: ProviderProfile[];
  exaKeys: VaultCredential[];
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
  return <OwnerForm key={JSON.stringify(toInput(draftFrom(view)))} view={view} profiles={profiles} exaKeys={exaKeys} onSaved={onSaved} onNotice={onNotice} />;
}

function CardHead({ readOnly = false }: { readOnly?: boolean }) {
  return <div className="card-header provider-group-header">
    <span className="settings-icon" aria-hidden="true"><BrainCircuit /></span>
    <div><h2 id="workspace-ai-title">Workspace AI</h2><p>{readOnly ? "Models used by everyone in this workspace." : "Models used by everyone. Only you, the owner, can change them."}</p></div>
    {readOnly ? <Badge tone="neutral"><Lock aria-hidden="true" /> Owner only</Badge> : null}
  </div>;
}

function OwnerForm({ view, profiles, exaKeys, onSaved, onNotice }: {
  view: AiSettingsView;
  profiles: ProviderProfile[];
  exaKeys: VaultCredential[];
  onSaved(view: AiSettingsView): void;
  onNotice(notice: SettingsNotice): void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(view));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(toInput(draft)) !== JSON.stringify(toInput(draftFrom(view)));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const recommended = recommendedDraft(draft, profiles);

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
        <p className="field-hint">Reads scanned pages and images in documents. gpt-6-luna accepts images and is economical; with an OpenAI default and no choice here, it is used automatically.</p>
        <ModelRoutePicker id="ai-vision" name="Vision" profiles={profiles} value={draft.vision} onChange={(value) => set("vision", value)} noneLabel="Automatic (gpt-6-luna with an OpenAI default)" />
      </fieldset>
      <fieldset className="workspace-ai-section">
        <legend><Globe aria-hidden="true" /> Web research</legend>
        <p className="field-hint">Public research for meeting prep uses an Exa key; a text model writes the brief.</p>
        <UiSelect id="ai-research-key" label="Exa key" value={draft.researchKey || NONE} onChange={(value) => set("researchKey", value === NONE ? "" : value)}
          options={[{ value: NONE, label: exaKeys.length ? "Off" : "Off · add an Exa key first" }, ...exaKeys.map((key) => ({ value: key.id, label: `${key.label} · ${key.hint}` }))]} />
        <ModelRoutePicker id="ai-research" name="Research writing" profiles={profiles} value={draft.research} onChange={(value) => set("research", value)} noneLabel="Workspace default (MOM & actions)" />
      </fieldset>
    </div>
    {error ? <div className="workspace-ai-error"><Alert tone="danger">{error}</Alert></div> : null}
    <div className="card-footer split">
      <span className="cluster">
        {recommended ? <button type="button" className="button secondary sm" onClick={() => setDraft(recommended)} title="Ask AI and vision: gpt-6-luna · research writing: gpt-6-sol">Apply recommended models</button> : null}
        <span className="field-hint">{profiles.length ? "Leave a model blank to use the profile's own model." : "Add a MOM & actions profile first; its models are offered here."}</span>
      </span>
      <button type="button" className={dirty ? "button primary" : "button secondary"} disabled={saving || !dirty} onClick={() => void save()}>{saving ? "Saving…" : "Save workspace AI"}</button>
    </div>
  </section>;
}
