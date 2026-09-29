import type { AiRouteView, AiSettingsView, CatalogCapability, CatalogProviderType, VaultCredential, VaultProviderType } from "../../types";
import { newId, ORG_MAIN } from "../fixtures/ids";
import { type BackendProfile, catalogModels, OPENROUTER_URL } from "../fixtures/providers";
import { json, noContent, notify, problem, str, wait } from "../http";
import type { DemoRouter } from "../router";
import type { DemoStore } from "../store";

const hintFor = (secret: string) => `…${secret.trim().slice(-4)}`;
const BILLING_TYPES = new Set<string>(["openrouter_management", "openai_admin", "exa_service"]);

function credentialsView(store: DemoStore): VaultCredential[] {
  return store.credentials.map((item) => ({
    ...item, billing_only: BILLING_TYPES.has(item.provider_type), used_by_profiles: store.profiles.filter((profile) => profile.credential_id === item.id).length,
    used_by_settings: store.ai.research_credential_id === item.id || store.profiles.some((profile) => profile.credential_id === item.id && [store.ai.chat_profile_id, store.ai.vision_profile_id, store.ai.research_profile_id].includes(profile.id)),
  }));
}

function route(store: DemoStore, profileId: string | null, model: string | null, source: AiRouteView["source"]): AiRouteView {
  const profile = store.profiles.find((item) => item.id === profileId) ?? store.profiles.find((item) => item.id === store.defaults.find((entry) => entry.capability === "text_generation")?.ordered_profile_ids[0]);
  if (!profile) return { profile_id: null, profile_name: null, provider: null, model: null, source: "not_configured" };
  return { profile_id: profile.id, profile_name: profile.name, provider: profile.base_url === OPENROUTER_URL ? "openrouter" : profile.provider_type, model: model || profile.capabilities[0]?.model || null, source };
}

function aiView(store: DemoStore): AiSettingsView {
  const canEdit = store.orgId === ORG_MAIN;
  const ai = store.ai;
  const key = store.credentials.find((item) => item.id === ai.research_credential_id);
  return {
    can_edit: canEdit, ...(canEdit ? ai : { chat_profile_id: null, chat_model: null, vision_profile_id: null, vision_model: null, research_credential_id: null, research_profile_id: null, research_model: null, updated_at: ai.updated_at, updated_by: ai.updated_by }),
    research_credential_label: canEdit ? key?.label ?? null : null, vision_configured: true, research_configured: Boolean(key),
    effective_chat: route(store, ai.chat_profile_id, ai.chat_model, ai.chat_profile_id ? "workspace_settings" : "workspace_default"),
    automatic_vision: canEdit ? route(store, null, "openai/gpt-6-luna", "workspace_default") : null,
  };
}

function profileFrom(store: DemoStore, body: Record<string, unknown>, current?: BackendProfile): BackendProfile | Response {
  const name = str(body.name)?.trim();
  const capabilities = Array.isArray(body.capabilities) ? body.capabilities as BackendProfile["capabilities"] : current?.capabilities ?? [];
  if (!name || !capabilities.length) return problem(422, "Enter a name and choose what this profile is for.");
  const apiKey = str(body.api_key);
  let credential = current ? { id: current.credential_id, label: current.credential_label, hint: current.credential_hint, configured: current.credential_configured } : { id: null as string | null, label: null as string | null, hint: null as string | null, configured: false };
  if (apiKey) {
    credential = { id: null, label: null, hint: hintFor(apiKey), configured: true };
    if (body.save_to_vault) {
      const saved = addCredential(store, { label: str(body.credential_label) ?? name, provider_type: str(body.base_url) === OPENROUTER_URL ? "openrouter" : str(body.provider_type) === "openai" ? "openai" : "openai_compatible", base_url: str(body.base_url), secret: apiKey });
      credential = { id: saved.id, label: saved.label, hint: saved.hint, configured: true };
    }
  } else if ("credential_id" in body) {
    const key = store.credentials.find((item) => item.id === str(body.credential_id));
    credential = key ? { id: key.id, label: key.label, hint: key.hint, configured: true } : { id: null, label: null, hint: null, configured: false };
  }
  return {
    id: current?.id ?? newId(12), name, provider_type: (str(body.provider_type) as BackendProfile["provider_type"]) ?? "openai_compatible",
    execution_location: str(body.execution_location) === "local" ? "local" : "cloud", base_url: str(body.base_url), capabilities,
    credential_configured: credential.configured, credential_hint: credential.hint, credential_id: credential.id, credential_label: credential.label,
  };
}

function addCredential(store: DemoStore, input: { label: string; provider_type: VaultProviderType; base_url: string | null; secret: string }): VaultCredential {
  const now = new Date().toISOString();
  const record: VaultCredential = { id: newId(11), label: input.label, provider_type: input.provider_type, base_url: input.base_url, hint: hintFor(input.secret), created_at: now, updated_at: now, last_used_at: null, used_by_profiles: 0, used_by_settings: false };
  store.credentials = [...store.credentials, record];
  notify("Demo: keys are never sent anywhere or stored in the sample — only the last four characters are kept in this tab.");
  return record;
}

export function registerProviders(router: DemoRouter): void {
  router
    .on("GET", "/v1/provider-profiles", ({ store }) => json(store.profiles))
    .on("GET", "/v1/provider-defaults", ({ store }) => json(store.defaults))
    .on("POST", "/v1/provider-profiles", ({ store, body }) => {
      const profile = profileFrom(store, body);
      if (profile instanceof Response) return profile;
      store.profiles = [...store.profiles, profile];
      return json(profile, 201);
    })
    .on("PATCH", "/v1/provider-profiles/:id", ({ store, params, body }) => {
      const current = store.profiles.find((item) => item.id === params.id);
      if (!current) return problem(404, "provider profile not found");
      const profile = profileFrom(store, body, current);
      if (profile instanceof Response) return profile;
      store.profiles = store.profiles.map((item) => item.id === params.id ? profile : item);
      return json(profile);
    })
    .on("DELETE", "/v1/provider-profiles/:id", ({ store, params }) => {
      store.profiles = store.profiles.filter((item) => item.id !== params.id);
      store.defaults = store.defaults.map((entry) => ({ ...entry, ordered_profile_ids: entry.ordered_profile_ids.filter((id) => id !== params.id) }));
      return noContent();
    })
    .on("POST", "/v1/provider-profiles/:id/test", async () => {
      await wait(700);
      notify("Demo: the configuration was checked for completeness only; no provider was contacted.");
      return json({ status: "configuration_valid" });
    })
    .on("PUT", "/v1/provider-defaults/:capability", ({ store, params, body }) => {
      const id = str(body.cloud_profile_id) ?? str(body.local_profile_id);
      if (!id) return problem(422, "Choose a profile.");
      const entry = { capability: params.capability, ordered_profile_ids: [id] };
      store.defaults = [...store.defaults.filter((item) => item.capability !== params.capability), entry];
      return json(entry);
    })
    .on("GET", "/v1/credentials", ({ store, query }) => json(credentialsView(store).filter((item) => !query.get("provider_type") || item.provider_type === query.get("provider_type"))))
    .on("POST", "/v1/credentials", ({ store, body }) => {
      const label = str(body.label)?.trim();
      const secret = str(body.secret);
      const type = str(body.provider_type) as VaultProviderType | null;
      if (!label || !secret || secret.trim().length < 8 || !type) return problem(422, "Enter a label and a key of at least 8 characters.");
      const saved = addCredential(store, { label, provider_type: type, base_url: type === "openrouter" ? OPENROUTER_URL : BILLING_TYPES.has(type) ? null : str(body.base_url), secret });
      return json({ ...saved, billing_only: BILLING_TYPES.has(type) }, 201);
    })
    .on("PATCH", "/v1/credentials/:id", ({ store, params, body }) => {
      const current = store.credentials.find((item) => item.id === params.id);
      if (!current) return problem(404, "key not found");
      const secret = str(body.secret);
      const next = { ...current, label: str(body.label)?.trim() || current.label, hint: secret ? hintFor(secret) : current.hint, updated_at: new Date().toISOString() };
      store.credentials = store.credentials.map((item) => item.id === params.id ? next : item);
      return json(credentialsView(store).find((item) => item.id === params.id));
    })
    .on("DELETE", "/v1/credentials/:id", ({ store, params }) => {
      const view = credentialsView(store).find((item) => item.id === params.id);
      if (!view) return problem(404, "key not found");
      const usedBy = [...store.profiles.filter((profile) => profile.credential_id === params.id).map((profile) => `provider profile '${profile.name}'`), ...(store.ai.research_credential_id === params.id ? ["workspace AI research"] : [])];
      if (usedBy.length) return json({ detail: { message: "remove this key from the listed uses before deleting it", used_by: usedBy } }, 409);
      store.credentials = store.credentials.filter((item) => item.id !== params.id);
      return noContent();
    })
    .on("POST", "/v1/credentials/:id/test", async ({ store, params }) => {
      await wait(600);
      if (!store.credentials.some((item) => item.id === params.id)) return problem(404, "key not found");
      return json({ credential_id: params.id, status: "unverified", network_call_performed: false, message: "Demo: sample keys are not checked with the provider. In a real workspace this makes one small request." });
    })
    .on("GET", "/v1/ai/settings", ({ store }) => json(aiView(store)))
    .on("PUT", "/v1/ai/settings", ({ store, body }) => {
      if (store.orgId !== ORG_MAIN) return problem(403, "Only the workspace owner can change AI settings.");
      store.ai = {
        chat_profile_id: str(body.chat_profile_id), chat_model: str(body.chat_model), vision_profile_id: str(body.vision_profile_id), vision_model: str(body.vision_model),
        research_credential_id: str(body.research_credential_id), research_profile_id: str(body.research_profile_id), research_model: str(body.research_model),
        updated_at: new Date().toISOString(), updated_by: store.displayName,
      };
      return json(aiView(store));
    })
    .on("GET", "/v1/model-catalog", async ({ store, query }) => {
      await wait(250);
      const capability = (query.get("capability") ?? "text_generation") as CatalogCapability;
      const profile = store.profiles.find((item) => item.id === query.get("profile_id"));
      const key = store.credentials.find((item) => item.id === query.get("credential_id"));
      const explicit = query.get("provider") as CatalogProviderType | null;
      const provider: CatalogProviderType = explicit ?? (profile ? (profile.provider_type === "openai" ? "openai" : "openrouter") : key?.provider_type === "openai" ? "openai" : "openrouter");
      const note = capability === "vision" && provider === "openai" ? "OpenAI's model list doesn't say which models read images, so only models verified to accept images are listed." : "Demo: a trimmed sample of the live catalog with list prices.";
      return json({ provider, capability, live_catalog: true, fetched_at: new Date().toISOString(), note, models: catalogModels(provider === "openai_compatible" ? "openrouter" : provider, capability) });
    });
}
