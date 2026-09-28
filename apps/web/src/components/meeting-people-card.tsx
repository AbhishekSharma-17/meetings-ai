"use client";

import { Avatar, isAssistantName } from "./ui/avatar";
import { SpeakerContacts } from "./speaker-contacts";
import type { CalendarEvent, MeetingParticipants, SpeakerIdentity } from "@/lib/types";

/** Participant evidence plus human-confirmed speaker contacts. Never auto-matches emails to voices. */
export function MeetingPeopleCard({ meetingId, participants, assistantName, namedSpeakers, speakerIdentities, source, onSaveIdentity, onIdentitiesSaved }: {
  meetingId: string;
  participants: MeetingParticipants | null;
  /** The meeting's bot name; the assistant is shown with the Meetings AI logo. */
  assistantName?: string;
  namedSpeakers: string[];
  speakerIdentities: SpeakerIdentity[];
  source: CalendarEvent | null;
  onSaveIdentity(speaker: string, email: string): Promise<boolean>;
  /** Called with the full identity list after several suggestions are approved at once. */
  onIdentitiesSaved(identities: SpeakerIdentity[]): void;
}) {
  const people = participants?.participants ?? [];

  return <section className="card" aria-labelledby="capture-title">
    <div className="card-header">
      <div><h2 id="capture-title">People & capture</h2><p>Invitees and voices heard. Not a verified attendance roster.</p></div>
    </div>
    <div className="card-body stack">
      {people.length ? <ul className="record-people">
        {people.map((person, index) => <li key={`${person.source}-${person.name}-${index}`}>
          <Avatar name={person.name} size="sm" kind={isAssistantName(person.name, assistantName) ? "assistant" : "person"} />
          <span className="record-person-copy"><b>{person.name}</b>{person.email ? <small>{person.email}</small> : null}</span>
          <span className="record-person-source">{person.source === "invite" ? "Invited" : "Heard speaking"}</span>
        </li>)}
      </ul> : <p className="muted-copy record-quiet">No participant evidence yet.</p>}
      <p className="field-hint">Invitees may not have joined and silent attendees may be missing. Speaker emails are only suggested; you approve each link.</p>
    </div>
    {namedSpeakers.length ? <SpeakerContacts meetingId={meetingId} assistantName={assistantName} namedSpeakers={namedSpeakers} speakerIdentities={speakerIdentities} source={source} onSaveIdentity={onSaveIdentity} onIdentitiesSaved={onIdentitiesSaved} /> : null}
  </section>;
}
