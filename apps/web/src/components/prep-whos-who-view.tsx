"use client";

import { useState, type ReactNode } from "react";
import { Building2, Handshake, UsersRound } from "lucide-react";
import type { PartyCompany, PartyPerson, PartySide, PartyWarning, WhosWho } from "@/lib/types";
import { Alert, Badge } from "./ui/feedback";
import { FilterInput } from "./scroll-panel";
import { matchesQuery, shouldOfferSearch } from "@/lib/search";

/** Correction callback: a side to pin, or null to go back to the automatic classification. */
export type SideChange = (key: string, side: "ours" | "theirs" | null) => void;

const otherLabels: Record<Exclude<PartySide, "ours" | "theirs">, string> = {
  other_external: "Third party",
  unknown: "Unclassified",
};

/** Our company and our attendees vs. the client and theirs, each with where we learned it. */
export function WhosWhoView({ value, onSide, disabled = false, onOpenOrganization }: {
  value: WhosWho;
  /** Omit for a read-only summary (saved briefing). */
  onSide?: SideChange;
  disabled?: boolean;
  onOpenOrganization?(): void;
}) {
  const [query, setQuery] = useState("");
  const searching = Boolean(query.trim());
  const shown = value.attendees.filter((person) => matchesQuery(query, person.name, person.email, person.email?.split("@")[1], person.reason));
  const ours = shown.filter((person) => person.side === "ours");
  const theirs = shown.filter((person) => person.side === "theirs");
  const others = shown.filter((person) => person.side === "other_external" || person.side === "unknown");
  const noMatch = "No one on this side matches the search.";
  return <div className="prep-whos-who-body">
    <WhosWhoWarnings warnings={value.warnings} onOpenOrganization={onOpenOrganization} />
    {shouldOfferSearch(value.attendees.length, query) ? <div className="list-search-inline"><FilterInput id="whos-who-search" label="Search attendees" value={query} onChange={setQuery} placeholder="Search name, email or company" />
      {searching ? <span className="list-search-count" role="status">{shown.length} of {value.attendees.length}</span> : null}</div> : null}
    <div className="prep-sides">
      <SideColumn tone="ours" icon={<Building2 />} heading="Your side" company={value.our_company}
        fallbackName="Your company" people={ours} onSide={onSide} disabled={disabled} empty={searching ? noMatch : "None of your colleagues are on this invite."} />
      <SideColumn tone="theirs" icon={<Handshake />} heading="Client" company={value.target}
        fallbackName="Not identified yet" people={theirs} onSide={onSide} disabled={disabled} empty={searching ? noMatch : "No one from the client is identified yet."} />
    </div>
    {others.length ? <section className="prep-side-others" aria-label="Others in the invite">
      <h4 className="prep-side-subhead"><UsersRound aria-hidden="true" />Others in the invite <span className="section-count">{others.length}</span></h4>
      <ul className="prep-side-people">{others.map((person) => <PersonRow key={person.key} person={person} onSide={onSide} disabled={disabled} />)}</ul>
    </section> : null}
    {value.ignored.length ? <p className="field-hint prep-side-ignored">{value.ignored.length === 1 ? "1 calendar or system address" : `${value.ignored.length} calendar or system addresses`} ignored (rooms, groups, no-reply).</p> : null}
  </div>;
}

export function WhosWhoWarnings({ warnings, onOpenOrganization }: { warnings: PartyWarning[]; onOpenOrganization?(): void }) {
  if (!warnings.length) return null;
  return <div className="prep-side-warnings">
    {warnings.map((warning) => warning.code === "target_is_us"
      ? <Alert key={warning.code} tone="warning" title="That looks like your own company">{warning.message}</Alert>
      : warning.code === "identity_missing"
        ? <Alert key={warning.code} tone="neutral" actions={onOpenOrganization ? <button type="button" className="button secondary sm" onClick={onOpenOrganization}>Open company profile</button> : null}>{warning.message}</Alert>
        : <Alert key={warning.code} tone="info">{warning.message}</Alert>)}
  </div>;
}

function SideColumn({ tone, icon, heading, company, fallbackName, people, onSide, disabled, empty }: {
  tone: "ours" | "theirs"; icon: ReactNode; heading: string; company: PartyCompany; fallbackName: string;
  people: PartyPerson[]; onSide?: SideChange; disabled: boolean; empty: string;
}) {
  const name = company.name || (tone === "theirs" ? company.domains[0] : null) || fallbackName;
  const known = Boolean(company.name || company.domains.length);
  return <section className="prep-side" data-side={tone} aria-label={heading}>
    <header className="prep-side-head">
      <span className="prep-side-icon" aria-hidden="true">{icon}</span>
      <div className="prep-side-id">
        <h4 className="prep-side-label">{heading}</h4>
        <p className="prep-side-company" data-unknown={known ? undefined : true}>{name}</p>
        {company.reason ? <p className="prep-side-source">{company.reason}</p> : null}
      </div>
    </header>
    {company.domains.length && (tone === "ours" || company.name) ? <ul className="prep-side-domains" aria-label={`${heading} email domains`}>
      {company.domains.slice(0, 6).map((domain) => <li key={domain} className="tag">{domain}</li>)}
      {company.domains.length > 6 ? <li className="tag">+{company.domains.length - 6}</li> : null}
    </ul> : null}
    {people.length ? <ul className="prep-side-people">{people.map((person) => <PersonRow key={person.key} person={person} onSide={onSide} disabled={disabled} />)}</ul>
      : <p className="prep-side-empty">{empty}</p>}
  </section>;
}

function PersonRow({ person, onSide, disabled }: { person: PartyPerson; onSide?: SideChange; disabled: boolean }) {
  const label = person.side === "other_external" || person.side === "unknown" ? otherLabels[person.side] : null;
  return <li className="prep-side-person">
    <div className="prep-side-person-copy">
      <p className="prep-side-person-name">{person.name}{label ? <Badge tone="neutral">{label}</Badge> : null}{person.overridden ? <Badge tone="brand">Corrected</Badge> : null}</p>
      {person.email ? <p className="prep-side-person-email" title={person.email}>{person.email}</p> : null}
      <p className="prep-side-person-reason">{person.reason}</p>
    </div>
    {onSide ? <div className="prep-side-actions">
      <div className="segmented prep-side-toggle" role="group" aria-label={`Which side is ${person.name} on?`}>
        <button type="button" aria-pressed={person.side === "ours"} disabled={disabled} onClick={() => { if (person.side !== "ours") onSide(person.key, "ours"); }}>Ours</button>
        <button type="button" aria-pressed={person.side === "theirs"} disabled={disabled} onClick={() => { if (person.side !== "theirs") onSide(person.key, "theirs"); }}>Client</button>
      </div>
      {person.overridden ? <button type="button" className="text-button neutral" disabled={disabled} onClick={() => onSide(person.key, null)} aria-label={`Undo the correction for ${person.name}`}>Undo</button> : null}
    </div> : null}
  </li>;
}
