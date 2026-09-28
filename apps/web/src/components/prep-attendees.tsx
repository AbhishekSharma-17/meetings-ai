"use client";

import { ExternalLink, Target } from "lucide-react";
import type { PrepAttendee, PrepMatchConfidence, PrepPersona, PrepSourceV2 } from "@/lib/types";
import { Badge } from "./ui/feedback";
import { Citations, safeHref } from "./prep-shared";
import { Avatar } from "./ui/avatar";
import { FilterInput, NoMatches } from "./scroll-panel";
import { useListSearch } from "./use-list-search";

export const personaLabels: Record<PrepPersona, string> = {
  technical: "Technical", business: "Business", sales: "Sales", executive: "Executive", unknown: "Role unknown",
};
const sideLabels: Record<string, string> = { other_external: "Third party", unknown: "Unclassified" };
const matchCopy: Record<PrepMatchConfidence, { label: string; tone: "success" | "info" | "neutral" }> = {
  confirmed: { label: "Profile confirmed", tone: "success" },
  likely: { label: "Likely profile", tone: "info" },
  unconfirmed: { label: "Profile unconfirmed", tone: "neutral" },
};

/** Invitees from the calendar with public-profile context. Only name-and-company matches carry a profile link. */
export function PrepAttendees({ attendees, sources }: { attendees: PrepAttendee[]; sources: Map<string, PrepSourceV2> }) {
  const search = useListSearch(attendees, (person) => [person.name, person.email, person.title, personaLabels[person.persona], person.side ? sideLabels[person.side] : null,
    (matchCopy[person.match_confidence] ?? matchCopy.unconfirmed).label, person.likely_interests]);
  return <>
    {search.offered ? <div className="list-search-inline"><FilterInput id="prep-attendee-search" label="Search attendees" value={search.query} onChange={search.setQuery} placeholder="Search name, title, email or role" /></div> : null}
    {search.noMatches ? <NoMatches query={search.query} noun="attendees" onClear={search.clear} /> : <ul className="prep-people">
    {search.visible.map((person) => <li key={`${person.name}-${person.email ?? ""}`}><PersonCard person={person} sources={sources} /></li>)}
  </ul>}
  </>;
}

function PersonCard({ person, sources }: { person: PrepAttendee; sources: Map<string, PrepSourceV2> }) {
  const match = matchCopy[person.match_confidence] ?? matchCopy.unconfirmed;
  const profile = safeHref(person.linkedin_url);
  return <article className="prep-person" aria-label={person.name}>
    <header className="prep-person-head">
      <Avatar name={person.name} fallback={person.name.trim() ? undefined : "?"} />
      <div className="prep-person-id">
        <p className="prep-person-name">{person.name}</p>
        <p className="prep-person-title" title={person.title || person.email || undefined}>{person.title || person.email || "Title not confirmed"}</p>
      </div>
    </header>
    <div className="prep-person-badges">
      {person.side && sideLabels[person.side] ? <Badge tone="neutral">{sideLabels[person.side]}</Badge> : null}
      <Badge tone="brand">{personaLabels[person.persona] ?? person.persona}</Badge>
      <Badge tone={match.tone} dot>{match.label}</Badge>
      {profile ? <a className="prep-person-link" href={profile} target="_blank" rel="noreferrer noopener" aria-label={`Public profile for ${person.name}`}>Profile <ExternalLink aria-hidden="true" /></a> : null}
    </div>
    {person.background ? <p className="prep-person-text">{person.background} <Citations ids={person.source_ids} sources={sources} /></p> : null}
    {person.likely_interests.length ? <ul className="tag-list prep-person-interests" aria-label={`Likely interests of ${person.name}`}>
      {person.likely_interests.map((item) => <li key={item} className="tag">{item}</li>)}
    </ul> : null}
    {person.angle ? <p className="prep-person-angle"><Target aria-hidden="true" /><span>{person.angle}</span></p> : null}
  </article>;
}
