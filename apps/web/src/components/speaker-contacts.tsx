"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { CalendarEvent, SpeakerIdentity, SpeakerSuggestion } from "@/lib/types";
import { Avatar, isAssistantName } from "./ui/avatar";
import { Badge, type Tone } from "./ui/feedback";
import { FilterInput, NoMatches } from "./scroll-panel";
import { useListSearch } from "./use-list-search";

const confidenceLabel: Record<NonNullable<SpeakerSuggestion["confidence"]>, { text: string; tone: Tone }> = {
  high: { text: "High match", tone: "success" },
  medium: { text: "Likely match", tone: "info" },
  low: { text: "Possible match", tone: "neutral" },
};
const sourceLabel: Record<NonNullable<SpeakerSuggestion["source"]>, string> = {
  invite: "Invitee", organizer: "Organizer", workspace_member: "Workspace member",
};

type Approval = { speaker: string; email: string };

/**
 * Named speakers and their confirmed contact emails. The API proposes matches
 * from invitees, the organizer and the workspace directory; nothing is linked
 * until a person approves it here.
 */
export function SpeakerContacts({ meetingId, assistantName, namedSpeakers: heardSpeakers, speakerIdentities, source, onSaveIdentity, onIdentitiesSaved }: {
  meetingId: string;
  /** The meeting's own assistant never gets a contact email. */
  assistantName?: string;
  namedSpeakers: string[];
  speakerIdentities: SpeakerIdentity[];
  source: CalendarEvent | null;
  onSaveIdentity(speaker: string, email: string): Promise<boolean>;
  onIdentitiesSaved(identities: SpeakerIdentity[]): void;
}) {
  const [suggestions, setSuggestions] = useState<SpeakerSuggestion[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [identityEmail, setIdentityEmail] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const namedSpeakers = useMemo(() => heardSpeakers.filter((speaker) => !isAssistantName(speaker, assistantName)), [heardSpeakers, assistantName]);
  const speakersKey = namedSpeakers.join("\u0000");
  const identitiesKey = speakerIdentities.map((item) => `${item.speaker}:${item.email}`).join("\u0000");

  useEffect(() => {
    let current = true;
    void meetingsService.getSpeakerSuggestions(meetingId)
      .then((items) => { if (current) setSuggestions(items); })
      // Suggestions are optional help; manual confirmation keeps working without them.
      .catch(() => { if (current) setSuggestions([]); });
    return () => { current = false; };
  }, [meetingId, speakersKey, identitiesKey]);

  const confirmed = useMemo(() => new Map(speakerIdentities.map((item) => [item.speaker, item.email])), [speakerIdentities]);
  const visible = useMemo(() => suggestions.filter((item) => namedSpeakers.includes(item.speaker) && !confirmed.has(item.speaker)
    && !dismissed.includes(dismissKey(item))), [suggestions, namedSpeakers, confirmed, dismissed]);
  const approvable = visible.filter((item): item is SpeakerSuggestion & { email: string } => item.status === "suggested" && Boolean(item.email));
  const highConfidence = approvable.filter((item) => item.confidence === "high");
  const inviteeOptions = source?.invitees?.filter((person) => person.email) ?? [];
  const busy = pending.length > 0;

  function openEditor(speaker: string, email: string) {
    setEditing(speaker); setIdentityEmail(email); setNotice(null);
  }

  async function save(speaker: string, email: string) {
    setPending([speaker]); setError(null); setNotice(null);
    try {
      if (await onSaveIdentity(speaker, email)) {
        setEditing(null);
        if (email) setNotice(`Linked ${email} to ${speaker}.`);
      }
    } finally { setPending([]); }
  }

  async function approveMany(items: Approval[]) {
    if (!items.length) return;
    setPending(items.map((item) => item.speaker)); setError(null); setNotice(null);
    try {
      onIdentitiesSaved(await meetingsService.saveSpeakerIdentities(meetingId, items));
      setNotice(`Linked ${items.length} speaker${items.length === 1 ? "" : "s"} to their email.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not approve these suggestions.");
    } finally { setPending([]); }
  }

  const speakerSearch = useListSearch(namedSpeakers, (speaker) => [speaker, confirmed.get(speaker), visible.find((item) => item.speaker === speaker)?.email]);
  const toApprovals = (items: typeof approvable): Approval[] => items.map((item) => ({ speaker: item.speaker, email: item.email }));

  return <div className="record-identities speaker-contacts">
    <div className="speaker-contacts-head">
      <div>
        <h3>Confirm speaker contact</h3>
        <p className="field-hint">{approvable.length ? "Suggestions come from invitees and your workspace. Nothing is linked until you approve it." : "Link an email only after you verify who spoke. It does not add recap recipients."}</p>
      </div>
      {approvable.length ? <div className="speaker-contacts-bulk">
        {highConfidence.length ? <button type="button" className="button secondary sm" disabled={busy} onClick={() => void approveMany(toApprovals(highConfidence))}>
          <Check aria-hidden="true" />Approve all high-confidence ({highConfidence.length})
        </button> : null}
        {approvable.length > highConfidence.length ? <button type="button" className="text-button neutral" disabled={busy} onClick={() => void approveMany(toApprovals(approvable))}>
          Approve all suggestions ({approvable.length})
        </button> : null}
      </div> : null}
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="form-success speaker-contacts-notice" role="status">{notice}</p> : null}
    {speakerSearch.offered ? <div className="list-search-inline"><FilterInput id="speaker-contact-search" label="Search speakers" value={speakerSearch.query} onChange={speakerSearch.setQuery} placeholder="Search speaker or email" /></div> : null}
    {speakerSearch.noMatches ? <NoMatches query={speakerSearch.query} noun="speakers" onClear={speakerSearch.clear} /> : null}
    <ul className="record-identity-list">
      {speakerSearch.visible.map((speaker) => {
        const email = confirmed.get(speaker);
        const suggestion = email ? undefined : visible.find((item) => item.speaker === speaker);
        const saving = pending.includes(speaker);
        return <li key={speaker} className="speaker-contact" data-state={email ? "confirmed" : suggestion?.status ?? "open"}>
          <div className="record-identity-row">
            <Avatar name={speaker} size="sm" />
            <span className="record-person-copy">
              <b>{speaker}</b>
              {email ? <small className="record-confirmed">{email} (confirmed)</small>
                : saving ? <small role="status">Linking…</small>
                  : <small>{suggestion ? "Not linked yet" : "Email not linked"}</small>}
            </span>
            {email ? <button className="text-button" type="button" disabled={busy} onClick={() => openEditor(speaker, email)}>Change</button>
              : suggestion ? null
                : <button className="text-button" type="button" disabled={busy} onClick={() => openEditor(speaker, "")}>Confirm email</button>}
          </div>
          {suggestion && editing !== speaker ? <SuggestionPanel suggestion={suggestion} busy={busy}
            onApprove={(value) => void save(speaker, value)}
            onChoose={(value) => openEditor(speaker, value)}
            onDismiss={() => setDismissed((current) => [...current, dismissKey(suggestion)])} /> : null}
          {editing === speaker ? <form className="record-identity-form" onSubmit={(event) => { event.preventDefault(); void save(speaker, identityEmail); }}>
            <label className="field">Email for {speaker}<input type="email" list={`speaker-emails-${encodeKey(speaker)}`} value={identityEmail} onChange={(event) => setIdentityEmail(event.target.value)} placeholder="person@company.com" autoFocus /></label>
            <datalist id={`speaker-emails-${encodeKey(speaker)}`}>
              {emailOptions(inviteeOptions, suggestion).map((option) => <option key={option.email} value={option.email}>{option.name}</option>)}
            </datalist>
            <div className="button-group end">
              <button type="button" className="button ghost sm" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="button primary sm" disabled={busy}>Save mapping</button>
            </div>
          </form> : null}
        </li>;
      })}
    </ul>
  </div>;
}

function SuggestionPanel({ suggestion, busy, onApprove, onChoose, onDismiss }: {
  suggestion: SpeakerSuggestion;
  busy: boolean;
  onApprove(email: string): void;
  onChoose(email: string): void;
  onDismiss(): void;
}) {
  if (suggestion.status === "ambiguous" || !suggestion.email) {
    return <div className="speaker-suggestion ambiguous" role="group" aria-label={`Possible matches for ${suggestion.speaker}`}>
      <div className="speaker-suggestion-match">
        <p className="speaker-suggestion-reason">{suggestion.reason}.</p>
        <DismissButton speaker={suggestion.speaker} busy={busy} onDismiss={onDismiss} />
      </div>
      {suggestion.alternatives.length ? <div className="speaker-suggestion-options">
        {suggestion.alternatives.map((option) => <button key={option.email} type="button" className="button ghost sm" disabled={busy}
          aria-label={`Review ${option.email} for ${suggestion.speaker}`} onClick={() => onChoose(option.email)}>
          <Avatar name={option.display_name} size="sm" />{option.display_name}
        </button>)}
      </div> : null}
      <div className="speaker-suggestion-actions">
        <button type="button" className="text-button" disabled={busy} onClick={() => onChoose("")}>Enter another email</button>
      </div>
    </div>;
  }
  const confidence = confidenceLabel[suggestion.confidence ?? "low"];
  const email = suggestion.email;
  return <div className="speaker-suggestion" role="group" aria-label={`Suggested email for ${suggestion.speaker}`}>
    <div className="speaker-suggestion-match">
      <Avatar name={suggestion.display_name ?? email} size="sm" />
      <div className="speaker-suggestion-copy">
        <span className="speaker-suggestion-title"><b>{suggestion.display_name ?? email}</b><Badge tone={confidence.tone}>{confidence.text}</Badge></span>
        <small className="speaker-suggestion-email">{email}</small>
        <small className="speaker-suggestion-reason">{suggestion.reason}{suggestion.source ? ` · ${sourceLabel[suggestion.source]}` : ""}</small>
      </div>
      <DismissButton speaker={suggestion.speaker} busy={busy} onDismiss={onDismiss} />
    </div>
    <div className="speaker-suggestion-actions">
      <button type="button" className="button secondary sm" disabled={busy} aria-label={`Approve ${email} for ${suggestion.speaker}`} onClick={() => onApprove(email)}><Check aria-hidden="true" />Approve</button>
      <button type="button" className="text-button" disabled={busy} onClick={() => onChoose("")}>Choose another</button>
    </div>
  </div>;
}

function DismissButton({ speaker, busy, onDismiss }: { speaker: string; busy: boolean; onDismiss(): void }) {
  return <button type="button" className="icon-button sm speaker-suggestion-dismiss" disabled={busy} aria-label={`Dismiss suggestion for ${speaker}`} title="Dismiss suggestion" onClick={onDismiss}>
    <X aria-hidden="true" />
  </button>;
}

function dismissKey(item: SpeakerSuggestion): string {
  return `${item.speaker}\u0000${item.email ?? item.status}`;
}

function encodeKey(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "");
}

function emailOptions(invitees: { name: string; email?: string | null }[], suggestion?: SpeakerSuggestion): { email: string; name: string }[] {
  const options = new Map<string, string>();
  for (const option of suggestion?.alternatives ?? []) options.set(option.email, option.display_name);
  for (const person of invitees) if (person.email && !options.has(person.email)) options.set(person.email, person.name);
  return [...options].map(([email, name]) => ({ email, name }));
}
