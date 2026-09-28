/**
 * Which AI vendor a provider record belongs to, for showing its logo next to the name.
 * Records name providers in several ways (vault types, profile labels, usage rows, route views),
 * and OpenAI-compatible routes are identified by their endpoint host (openrouter.ai is OpenRouter).
 */

export type ProviderBrand = "openai" | "openrouter" | "exa";

export const providerBrandNames: Record<ProviderBrand, string> = { openai: "OpenAI", openrouter: "OpenRouter", exa: "Exa" };

const BRAND_HOSTS: ReadonlyArray<readonly [string, ProviderBrand]> = [
  ["openrouter.ai", "openrouter"],
  ["openai.com", "openai"],
  ["exa.ai", "exa"],
];

/** Host of a URL or a bare host name ("openrouter.ai", "https://openrouter.ai/api/v1"); null when unparseable. */
export function hostOf(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase() || null; }
  catch { return null; }
}

export function brandFromHost(host: string | null | undefined): ProviderBrand | null {
  if (!host) return null;
  const name = host.toLowerCase();
  return BRAND_HOSTS.find(([domain]) => name === domain || name.endsWith(`.${domain}`))?.[1] ?? null;
}

/**
 * The vendor for a provider name ("openai", "OpenRouter", "openai_compatible", "Exa web research"…)
 * plus an optional endpoint (URL or host). A known endpoint host wins; an OpenAI-type route on some
 * other server is not OpenAI, so it gets no vendor mark.
 */
export function providerBrand(provider: string | null | undefined, endpoint?: string | null): ProviderBrand | null {
  const host = hostOf(endpoint);
  const byHost = brandFromHost(host);
  if (byHost) return byHost;
  const key = (provider ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (key === "exa" || key === "exawebresearch") return "exa";
  if (key === "openrouter") return "openrouter";
  if (key === "openai") return host ? null : "openai";
  return null;
}

/** Endpoint host recorded on a usage event (`details.endpoint_host`), when present. */
export function usageEndpointHost(details: Record<string, unknown> | null | undefined): string | null {
  const host = details?.endpoint_host;
  return typeof host === "string" && host ? host : null;
}

/** A saved vault key's vendor (OpenAI-compatible keys saved for openrouter.ai count as OpenRouter). */
export const credentialBrand = (credential: { provider_type: string; base_url: string | null }): ProviderBrand | null =>
  providerBrand(credential.provider_type, credential.base_url);

/** A provider profile's vendor, from its provider label and endpoint. */
export const profileBrand = (profile: { provider: string; endpoint: string }): ProviderBrand | null =>
  providerBrand(profile.provider, profile.endpoint);
