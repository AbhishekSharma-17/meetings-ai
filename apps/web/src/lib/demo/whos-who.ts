/* Demo-side who's who: a compact port of the API's resolver (services/api/app/prep_parties.py) so the
   sample workspace shows the same our-side / client-side split without a server. */
import type { AttendeeSides, CachedCalendarEvent, OrganizationIdentity, PartyCompany, PartyPerson, PartyWarning, WhosWho } from "../types";
import type { DemoStore } from "./store";

const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);
const SYSTEM_DOMAINS = ["calendar.google.com", "calendar-notification.google.com", "calendar.zoom.us", "reply.calendly.com", "teams.microsoft.com"];
const SYSTEM_LOCAL = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|calendar|calendly|scheduler|invites?|meetings?|resource|rooms?)$/;
const LEGAL = new Set(["inc", "llc", "ltd", "limited", "gmbh", "plc", "corp", "co", "company", "pvt", "private", "group"]);
const NOISE = new Set("weekly daily monthly quarterly sync call meeting intro kickoff catch up demo review discussion follow followup check in standup qbr discovery partnership proposal workshop session chat planning plan update status pitch roadmap strategy prep readout pilot renewal signature business onboarding all hands leadership delivery walkthrough month end the a an for of with and".split(" "));
const TARGET_IS_US = "The target looked like your own company; add the client's name or website.";

type Identity = { name: string | null; aliases: string[]; domains: string[]; configured: boolean };

const words = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
function keys(value: string | null | undefined): Set<string> {
  let parts = words(value ?? "");
  const found = new Set([parts.join("")]);
  while (parts.length > 1 && LEGAL.has(parts[parts.length - 1])) { parts = parts.slice(0, -1); found.add(parts.join("")); }
  return new Set([...found].filter((key) => key.length >= 2));
}
const root = (domain: string) => { const labels = domain.split("."); return labels.length >= 2 ? labels[labels.length - 2] : labels[0]; };
const hostOf = (value: string | null | undefined) => { try { return value ? new URL(value.includes("://") ? value : `https://${value}`).hostname.replace(/^www\./, "") : null; } catch { return null; } };
const domainOf = (email: string | null | undefined) => email?.includes("@") ? email.split("@")[1].toLowerCase() : null;
const owns = (identity: Identity, domain: string | null) => Boolean(domain) && identity.domains.some((ours) => domain === ours || domain!.endsWith(`.${ours}`));

function isUs(identity: Identity, text: string | null | undefined): boolean {
  if (!text?.trim()) return false;
  if (/\./.test(text) && !/\s/.test(text.trim()) && owns(identity, hostOf(text))) return true;
  const ours = new Set([...[identity.name, ...identity.aliases].flatMap((name) => [...keys(name)]), ...identity.domains.map(root)]);
  return [...keys(text)].some((key) => ours.has(key));
}

/** Suggestions the demo offers before the visitor saves an identity (mirrors the API). */
export function demoIdentity(store: DemoStore): OrganizationIdentity {
  const memberDomains = store.members.map((member) => domainOf(member.email)).filter((domain): domain is string => Boolean(domain) && !FREE_MAIL.has(domain!));
  const suggested = { company_name: store.workspace.display_name, domains: [...new Set([hostOf(store.brief.website), ...memberDomains].filter((item): item is string => Boolean(item)))] };
  return store.companyIdentity ?? { company_name: suggested.company_name, aliases: [], domains: suggested.domains, configured: false, can_edit: true, updated_at: null, suggestions: suggested };
}

function ourSide(store: DemoStore): Identity {
  const saved = demoIdentity(store);
  const domains = new Set([...saved.domains, ...saved.suggestions.domains]);
  return { name: saved.company_name || store.workspace.display_name, aliases: saved.aliases, domains: [...domains], configured: saved.configured };
}

function fromTitle(title: string, identity: Identity): string | null {
  const parts = title.split(/\s*(?:<>|\||—|–)\s*|\s+(?:x|vs\.?|with)\s+|:\s+/i).map((part) => part.split(/\s+/).filter((word) => !NOISE.has(word.toLowerCase())).join(" ").trim());
  if (parts.length < 2) return null;
  return parts.find((part) => part && /^[A-Z0-9]/.test(part) && !isUs(identity, part) && part.split(" ").length <= 5) ?? null;
}

type Person = { key: string; name: string; email: string | null; domain: string | null };

function people(event: CachedCalendarEvent): { list: Person[]; ignored: string[] } {
  const list = new Map<string, Person>();
  const ignored: string[] = [];
  for (const invitee of event.invitees ?? []) {
    const email = invitee.email?.trim() || null;
    const domain = domainOf(email);
    if ((domain && SYSTEM_DOMAINS.some((item) => domain === item || domain.endsWith(`.${item}`))) || (email && SYSTEM_LOCAL.test(email.split("@")[0].toLowerCase()))) { ignored.push(email ?? invitee.name); continue; }
    const key = email ? email.toLowerCase() : `name:${words(invitee.name).join(" ") || "guest"}`;
    if (!list.has(key)) list.set(key, { key, name: invitee.name || email?.split("@")[0] || "Guest", email, domain });
  }
  return { list: [...list.values()], ignored };
}

function target(identity: Identity, list: Person[], input: { target_company: string | null; company_website: string | null; attendee_sides: AttendeeSides }, title: string, warnings: PartyWarning[]): PartyCompany {
  const warn = () => { if (!warnings.length) warnings.push({ code: "target_is_us", message: TARGET_IS_US }); };
  let name = input.target_company?.trim() || null;
  let website = input.company_website?.trim() || null;
  if (name && isUs(identity, name)) { name = null; warn(); }
  if (website && isUs(identity, website)) { website = null; warn(); }
  const counts = new Map<string, number>();
  for (const person of list) {
    const side = input.attendee_sides[person.key];
    if (side === "ours" || !person.domain || FREE_MAIL.has(person.domain) || owns(identity, person.domain)) continue;
    counts.set(person.domain, (counts.get(person.domain) ?? 0) + (side === "theirs" ? 10 : 1));
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([domain]) => domain);
  if (name || website) {
    const domain = hostOf(website) ?? ranked.find((item) => [...keys(name)].some((key) => key.includes(root(item)) || root(item).includes(key))) ?? (ranked.length === 1 ? ranked[0] : null);
    const titled = !name && domain ? fromTitle(title, identity) : null;
    if (titled && [...keys(titled)].some((key) => key.includes(root(domain!)) || root(domain!).includes(key))) name = titled;
    return { name, aliases: [], domains: domain ? [domain] : [], website, source: "inputs", reason: "Set in the prep inputs" };
  }
  if (ranked.length) {
    const titled = fromTitle(title, identity);
    const matches = titled && [...keys(titled)].some((key) => key.includes(root(ranked[0])) || root(ranked[0]).includes(key));
    return { name: matches ? titled : null, aliases: [], domains: [ranked[0]], website: `https://${ranked[0]}`, source: "email_domain", reason: `From email domain ${ranked[0]}` };
  }
  const titled = fromTitle(title, identity);
  if (titled) return { name: titled, aliases: [], domains: [], website: null, source: "event_title", reason: "From the event title" };
  warnings.push({ code: "no_target", message: "We couldn't tell which company you're meeting. Add the client's name or website." });
  return { name: null, aliases: [], domains: [], website: null, source: "none", reason: "Not found in the inputs, attendee emails or title" };
}

function classify(person: Person, identity: Identity, company: PartyCompany, sides: AttendeeSides): PartyPerson {
  const base = { key: person.key, name: person.name, email: person.email, overridden: false };
  const override = sides[person.key];
  if (override) return { ...base, side: override, overridden: true, reason: `You marked them as ${override === "ours" ? "your team" : "the client"}` };
  if (owns(identity, person.domain)) return { ...base, side: "ours", reason: `Email domain ${person.domain} is yours` };
  if (!person.domain) return { ...base, side: "unknown", reason: "No email address in the invite" };
  if (FREE_MAIL.has(person.domain)) return { ...base, side: "unknown", reason: `Personal email (${person.domain}); company unknown` };
  if (company.domains[0] && (person.domain === company.domains[0] || person.domain.endsWith(`.${company.domains[0]}`))) return { ...base, side: "theirs", reason: `From email domain ${person.domain}` };
  return { ...base, side: "other_external", reason: `Another company (${person.domain})` };
}

export function demoWhosWho(store: DemoStore, event: CachedCalendarEvent, input: { target_company: string | null; company_website: string | null; attendee_sides: AttendeeSides }): WhosWho {
  const identity = ourSide(store);
  const { list, ignored } = people(event);
  const warnings: PartyWarning[] = [];
  const company = target(identity, list, input, event.title, warnings);
  return {
    our_company: { name: identity.name, aliases: identity.aliases, domains: identity.domains, website: null, source: identity.configured ? "identity" : "workspace", reason: identity.configured ? "From your Organization brief" : "From your workspace name and member emails" },
    target: company, attendees: list.map((person) => classify(person, identity, company, input.attendee_sides)), ignored, warnings,
  };
}
