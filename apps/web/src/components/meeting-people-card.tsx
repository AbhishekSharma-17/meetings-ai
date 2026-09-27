"use client";

import { useState } from "react";
import { Avatar, isAssistantName } from "./ui/avatar";
import type { CalendarEvent, MeetingParticipants, SpeakerIdentity } from "@/lib/types";

/** Participant evidence plus human-confirmed speaker contacts. Never auto-matches emails to voices. */
export function MeetingPeopleCard({ participants, assistantName, namedSpeakers, speakerIdentities, source, onSaveIdentity }: {
  participants: MeetingParticipants | null;
  /** The meeting's bot name; the assistant is shown with the Meetings AI logo. */
  assistantName?: string;
  namedSpeakers: string[];
  speakerIdentities: SpeakerIdentity[];
  source: CalendarEvent | null;
  onSaveIdentity(speaker: string, email: string): Promise<boolean>;
}) {
  const [editingIdentity, setEditingIdentity] = useState<string | null>(null);
  const [identityEmail, setIdentityEmail] = useState("");
  const people = participants?.participants ?? [];
  const inviteeEmails = source?.invitees?.filter((person) => person.email) ?? [];

  async function save(speaker: string) {
    if (await onSaveIdentity(speaker, identityEmail)) setEditingIdentity(null);
  }

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
      <p className="field-hint">Invitees may not have joined and silent attendees may be missing. Speaker names are never matched to emails automatically.</p>
    </div>
    {namedSpeakers.length ? <div className="record-identities">
      <h3>Confirm speaker contact</h3>
      <p className="field-hint">Link an email only after you verify who spoke. It does not add recap recipients.</p>
      <ul className="record-identity-list">
        {namedSpeakers.map((speaker) => {
          const identity = speakerIdentities.find((item) => item.speaker === speaker);
          const suggestion = source?.invitees?.find((person) => person.email && person.name.toLocaleLowerCase() === speaker.toLocaleLowerCase());
          return <li key={speaker}>
            <div className="record-identity-row">
              <span className="record-person-copy">
                <b>{speaker}</b>
                {identity ? <small className="record-confirmed">{identity.email} (confirmed)</small> : <small>Email not linked</small>}
                {!identity && suggestion ? <small>Possible invitee: {suggestion.email} · confirm before linking</small> : null}
              </span>
              <button className="text-button" type="button" onClick={() => { setEditingIdentity(speaker); setIdentityEmail(identity?.email ?? suggestion?.email ?? ""); }}>Confirm email</button>
            </div>
            {editingIdentity === speaker ? <div className="record-identity-form">
              <label className="field">Email for {speaker}<input type="email" list="source-invitee-emails" value={identityEmail} onChange={(event) => setIdentityEmail(event.target.value)} placeholder="person@company.com" /></label>
              <datalist id="source-invitee-emails">{inviteeEmails.map((person) => <option key={person.email} value={person.email ?? ""}>{person.name}</option>)}</datalist>
              <div className="button-group end">
                <button type="button" className="button ghost sm" onClick={() => setEditingIdentity(null)}>Cancel</button>
                <button type="button" className="button primary sm" onClick={() => void save(speaker)}>Save mapping</button>
              </div>
            </div> : null}
          </li>;
        })}
      </ul>
    </div> : null}
  </section>;
}
