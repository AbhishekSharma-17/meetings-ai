import type { ReactNode } from "react";
import { Radar, Server } from "lucide-react";
import { providerBrand, providerBrandNames, type ProviderBrand } from "./provider-brand";
import { providerLabel } from "./usage-labels";

/*
 * Official marks for AI providers, from LobeHub's lobe-icons (@lobehub/icons-static-svg 1.95.1,
 * MIT licence, https://github.com/lobehub/lobe-icons). Path data is inlined: no runtime
 * dependency and no network request. The trademarks belong to their owners.
 *
 * All three draw in currentColor (the owners' monochrome variants) on a neutral tile, so they keep
 * full contrast in light and dark themes. OpenRouter's lime fails 3:1 on light surfaces and Exa's
 * blue fails it on dark ones, so brand colour is not used.
 * Providers without a mark (custom OpenAI-compatible servers, local, Vexa…) get a neutral server icon.
 * Apollo has no mark in lobe-icons 1.95.1, so it gets a neutral radar glyph rather than an imitation logo.
 */

export type ProviderIconSize = "xs" | "sm" | "md";

const MARKS: Record<Exclude<ProviderBrand, "apollo">, ReactNode> = {
  openai: <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />,
  openrouter: <path d="M18.654 3.87a5.087 5.087 0 110 10.174L23.7 19.09c.64.641.187 1.737-.72 1.737H8.48a8.479 8.479 0 010-16.958h10.175zM8.479 7.26a5.087 5.087 0 100 10.176 5.087 5.087 0 000-10.175z" />,
  exa: <path clipRule="evenodd" d="M3 0h19v1.791L13.892 12 22 22.209V24H3V0zm9.62 10.348l6.589-8.557H6.03l6.59 8.557zM5.138 3.935v7.17h5.52l-5.52-7.17zm5.52 8.96h-5.52v7.17l5.52-7.17zM6.03 22.21l6.59-8.557 6.589 8.557H6.03z" />,
};

/** Decorative provider logo: always pair it with the provider's name in visible text. */
export function ProviderBrandIcon({ brand, size = "md", className = "" }: { brand: ProviderBrand | null; size?: ProviderIconSize; className?: string }) {
  return <span className={`provider-brand ${size} ${className}`.trim()} data-provider-brand={brand ?? "generic"} aria-hidden="true">
    {brand === "apollo" ? <Radar className="provider-mark neutral" />
      : brand
        ? <svg className="provider-mark" viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" focusable="false">{MARKS[brand]}</svg>
        : <Server />}
  </span>;
}

/** Inline "[logo] Name" for tables, meta lines and pickers. Unknown providers show just the name. */
export function ProviderName({ brand, label, className = "" }: { brand: ProviderBrand | null; label?: string; className?: string }) {
  const text = label ?? (brand ? providerBrandNames[brand] : "");
  return <span className={`provider-name ${className}`.trim()}>
    {brand ? <ProviderBrandIcon brand={brand} size="xs" /> : null}
    <span>{text}</span>
  </span>;
}

/** Leading mark for a picker option (UiSelect `icon`). */
export function providerOptionIcon(brand: ProviderBrand | null): ReactNode {
  return <ProviderBrandIcon brand={brand} size="xs" />;
}

/** Name for a usage/cost record: OpenAI-compatible rows sent to openrouter.ai read as OpenRouter. */
export function usageProviderText(provider: string, endpointHost?: string | null): string {
  const brand = providerBrand(provider, endpointHost);
  return brand ? providerBrandNames[brand] : providerLabel(provider);
}

/** "[logo] Provider" for usage, cost and briefing records. */
export function UsageProviderName({ provider, endpointHost, className }: { provider: string; endpointHost?: string | null; className?: string }) {
  return <ProviderName brand={providerBrand(provider, endpointHost)} label={usageProviderText(provider, endpointHost)} className={className} />;
}
