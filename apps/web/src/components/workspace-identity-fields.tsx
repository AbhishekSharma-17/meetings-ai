import type { OrganizationIdentity, OrganizationIdentityInput } from "@/lib/types";
import { ChipInput } from "./ui/chip-input";

const DOMAIN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PERSONAL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "zoho.com", "yandex.com", "mail.com"]);
export const MAX_IDENTITY_ALIASES = 20;
export const MAX_IDENTITY_DOMAINS = 30;

/** "https://www.Acme.io/about", "@acme.io" and "ACME.IO" all become "acme.io"; anything else is kept for editing. */
export function normalizeDomain(value: string): string {
  const text = value.trim().toLowerCase().replace(/^@/, "").replace(/^[a-z]+:\/\//, "").replace(/^[^@/]*@/, "");
  return text.split(/[/?#:]/)[0].replace(/^www\./, "").replace(/\.$/, "");
}

export function domainProblem(value: string): string | null {
  if (!DOMAIN.test(value)) return "isn’t a domain like yourcompany.com";
  if (PERSONAL.has(value)) return "is a personal email provider, not your company’s domain";
  return null;
}

export function identityInput(identity: OrganizationIdentity): OrganizationIdentityInput {
  return { company_name: identity.company_name?.trim() || null, aliases: identity.aliases, domains: identity.domains };
}

/**
 * "Our company" in the Organization brief: the name, aliases and email domains meeting prep uses to
 * tell our side from the client's. Owners and admins edit; everyone else sees it read-only.
 */
export function WorkspaceIdentityFields({ value, onChange, disabled }: {
  value: OrganizationIdentity;
  onChange(next: OrganizationIdentity): void;
  disabled: boolean;
}) {
  return <fieldset className="brief-identity" disabled={disabled}>
    <legend>Our company</legend>
    <p className="field-hint">Meeting prep uses this to tell your side from the client’s, so it never researches you or pitches to your colleagues.{value.configured ? "" : " Suggested from your workspace name and member emails. Save to confirm."}</p>
    <div className="field">
      <label htmlFor="brief-company-name">Company name</label>
      <input id="brief-company-name" value={value.company_name ?? ""} maxLength={200} autoComplete="organization" placeholder="e.g. GenAI Protos"
        onChange={(event) => onChange({ ...value, company_name: event.target.value })} />
    </div>
    <div className="field-row">
      <ChipInput id="brief-company-aliases" label="Other names" labelSuffix={<small>abbreviations, brands</small>} kind="text"
        value={value.aliases} onChange={(aliases) => onChange({ ...value, aliases })} disabled={disabled}
        maxItems={MAX_IDENTITY_ALIASES} maxItemLength={120} placeholder="e.g. GAP, GenAI Protos Labs"
        hint="Names in meeting titles like “GAP <> Acme” are recognised as you." />
      <ChipInput id="brief-company-domains" label="Our email domains" kind="text"
        value={value.domains} onChange={(domains) => onChange({ ...value, domains: [...new Set(domains.flatMap((item) => item.split(/\s+/)).map(normalizeDomain).filter(Boolean))] })}
        disabled={disabled} maxItems={MAX_IDENTITY_DOMAINS} validate={domainProblem} placeholder="yourcompany.com"
        hint="Attendees with these domains are on your side. Member email domains are always included." />
    </div>
  </fieldset>;
}
