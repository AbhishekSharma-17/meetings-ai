"use client";

import { KeyRound } from "lucide-react";
import type { ProfileKeyChoice, ProviderProfile, VaultCredential } from "@/lib/types";
import { UiSelect } from "./ui-select";
import { providerOptionIcon } from "./provider-brand-icons";
import { credentialBrand } from "./provider-brand";
import { canSaveToVault, compatibleCredentials } from "./provider-profile-info";

export type KeyChoiceState = { mode: "saved" | "paste"; credentialId: string; apiKey: string; saveToVault: boolean; vaultLabel: string };

export function initialKeyChoice(profile: ProviderProfile): KeyChoiceState {
  return { mode: profile.credentialId ? "saved" : "paste", credentialId: profile.credentialId ?? "", apiKey: "", saveToVault: false, vaultLabel: "" };
}

export function keyChoiceChanged(state: KeyChoiceState, profile: ProviderProfile): boolean {
  if (state.apiKey) return true;
  return state.mode === "saved" ? state.credentialId !== (profile.credentialId ?? "") : Boolean(profile.credentialId);
}

/** Translate the editor state into the save request; the secret itself travels separately. */
export function keyChoicePayload(state: KeyChoiceState, profile: ProviderProfile, defaultLabel: string): ProfileKeyChoice | undefined {
  if (state.mode === "saved") return state.credentialId ? { credentialId: state.credentialId } : undefined;
  if (state.apiKey && state.saveToVault) return { saveToVaultLabel: (state.vaultLabel.trim() || defaultLabel).slice(0, 100) };
  return profile.credentialId ? { credentialId: null } : undefined;
}

function pasteHint(draft: ProviderProfile, typed: boolean): string {
  const saved = draft.credentialLabel ?? "the saved key";
  if (draft.credentialId) return typed ? `Replaces ${saved} for this profile only.` : `Leave blank to stop using ${saved}.`;
  if (draft.apiKeyConfigured) return `Saved key ${draft.credentialHint ?? "••••"} is encrypted and never shown again. Leave blank to keep it.`;
  if (draft.executionLocation === "local") return "Optional if your endpoint does not require a key.";
  return "Required for this cloud provider.";
}

/** "Use a saved key" or "Paste a new key" for one provider profile. */
export function ProviderKeyField({ draft, credentials, canSaveKeys, value, onChange }: {
  draft: ProviderProfile;
  credentials: VaultCredential[];
  canSaveKeys: boolean;
  value: KeyChoiceState;
  onChange(next: KeyChoiceState): void;
}) {
  const compatible = compatibleCredentials(draft, credentials);
  // Attaching a saved key is owner-only (saved keys are the owner's spend); admins paste their own.
  const showChoice = canSaveKeys && (compatible.length > 0 || value.mode === "saved");
  const set = (patch: Partial<KeyChoiceState>) => onChange({ ...value, ...patch });
  const linked = compatible.find((item) => item.id === value.credentialId);

  if (!canSaveKeys && value.mode === "saved") return <div className="provider-key-field">
    <p className="field-hint" role="status">Uses the owner’s saved key {linked ? `“${linked.label}”` : ""}. Only the workspace owner can change which saved key a profile uses.</p>
    <button type="button" className="text-button" onClick={() => set({ mode: "paste", credentialId: "", apiKey: "" })}>Paste a different key instead</button>
  </div>;

  return <div className="provider-key-field">
    {showChoice ? <div className="provider-key-choice">
      <span id="api-key-source-label" className="field-label">API key source</span>
      <div className="segmented" role="group" aria-labelledby="api-key-source-label">
        <button type="button" aria-pressed={value.mode === "saved"} onClick={() => set({ mode: "saved", credentialId: value.credentialId || compatible[0]?.id || "", apiKey: "", saveToVault: false })}>Use a saved key</button>
        <button type="button" aria-pressed={value.mode === "paste"} onClick={() => set({ mode: "paste" })}>Paste a new key</button>
      </div>
    </div> : null}
    {value.mode === "saved" ? compatible.length ? <div className="field">
      <UiSelect id="profile-credential" label="Saved API key" value={value.credentialId} placeholder="Choose a saved key" onChange={(id) => set({ credentialId: id })}
        options={compatible.map((item) => ({ value: item.id, label: `${item.label} · ${item.hint}`, icon: providerOptionIcon(credentialBrand(item)) }))} />
      <p className="field-hint">{linked ? `Uses ${linked.label}. Replacing that key updates this profile too.` : "Choose which saved key this profile uses."}</p>
    </div> : <p className="field-hint provider-key-none" role="status">No saved key matches this provider{draft.provider === "OpenAI-compatible" ? " and endpoint" : ""}. Paste a key instead, or add one under API keys.</p>
      : <>
        <div className="field">
          <label htmlFor="api-key">API key <span className="optional">write-only</span></label>
          <div className="input-with-icon"><KeyRound aria-hidden="true" /><input id="api-key" type="password" value={value.apiKey} onChange={(event) => set({ apiKey: event.target.value })} placeholder={draft.apiKeyConfigured && !draft.credentialId ? "A key is already configured" : "Paste a new API key"} autoComplete="new-password" aria-describedby="api-key-hint" /></div>
          <p id="api-key-hint" className="field-hint">{pasteHint(draft, Boolean(value.apiKey))}</p>
        </div>
        {canSaveKeys && canSaveToVault(draft.provider) && value.apiKey ? <div className="provider-key-vault">
          <label className="check-label"><input type="checkbox" checked={value.saveToVault} onChange={(event) => set({ saveToVault: event.target.checked })} />Also save to API keys for reuse</label>
          {value.saveToVault ? <div className="field">
            <label htmlFor="vault-label">Saved key name</label>
            <input id="vault-label" value={value.vaultLabel} onChange={(event) => set({ vaultLabel: event.target.value })} placeholder={draft.label} maxLength={100} autoComplete="off" />
          </div> : null}
        </div> : null}
      </>}
  </div>;
}
