import { Server } from "lucide-react";
import type { VaultProviderType } from "@/lib/types";

/*
 * Simplified single-colour marks for AI providers. They draw in currentColor so they
 * follow the theme; full-colour logos would belong in brand-icons.tsx.
 */

function OpenAiMark() {
  return <svg className="provider-mark stroked" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {[0, 60, 120, 180, 240, 300].map((angle) => <rect key={angle} x="9" y="2.6" width="6" height="11" rx="3" transform={`rotate(${angle} 12 12)`} />)}
  </svg>;
}

function OpenRouterMark() {
  return <svg className="provider-mark stroked" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M2.5 12h5.5c3 0 4-5.5 7-5.5h5" />
    <path d="M8 12c3 0 4 5.5 7 5.5h5" />
    <path d="M17.5 3.8 20.5 6.5 17.5 9.2" />
    <path d="M17.5 14.8 20.5 17.5 17.5 20.2" />
  </svg>;
}

function ExaMark() {
  return <svg className="provider-mark filled" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M5 3h14v3.2H9.6l4.1 5.8-4.1 5.8H19V21H5v-2.6L10 12 5 5.6Z" />
  </svg>;
}

export function ProviderBrandIcon({ provider, className = "" }: { provider: VaultProviderType; className?: string }) {
  return <span className={`provider-brand ${provider} ${className}`.trim()} aria-hidden="true">
    {provider === "openai" ? <OpenAiMark /> : provider === "openrouter" ? <OpenRouterMark /> : provider === "exa" ? <ExaMark /> : <Server />}
  </span>;
}
