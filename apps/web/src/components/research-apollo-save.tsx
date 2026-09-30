"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CircleCheck, CloudUpload, ExternalLink, Link2, X } from "lucide-react";
import { formatDate } from "@/lib/time-preferences";
import { researchService } from "@/lib/research-service";
import type { ApolloCrmLink, ApolloSavePreview, ApolloUsage, ResearchProfile } from "@/lib/research-types";
import { Alert, LoadingRow } from "./ui/feedback";
import { UiSelect } from "./ui-select";
import { safeLink } from "./research-shared";

const NONE = "";
const CREATE = "create";
const noun = (profile: ResearchProfile) => profile.kind === "person" ? "contact" : "account";

/** Header action: "In Apollo" once saved; "Save to Apollo" for owners and admins; disabled with "Ask an admin" for members. */
export function ApolloSaveAction({ profile, isAdmin, onOpen }: { profile: ResearchProfile; isAdmin: boolean; onOpen(): void }) {
  const link = profile.apollo_crm;
  const href = link ? safeLink(link.url) : undefined;
  if (link && href) return <a className="button secondary" href={href} target="_blank" rel="noopener noreferrer"><CircleCheck aria-hidden="true" />In Apollo<ExternalLink aria-hidden="true" /></a>;
  if (link) return null;
  if (isAdmin) return <button type="button" className="button secondary" onClick={onOpen}><CloudUpload aria-hidden="true" />Save to Apollo</button>;
  return <span className="rx-apollo-locked">
    <button type="button" className="button secondary" disabled aria-describedby="rx-apollo-locked-hint"><CloudUpload aria-hidden="true" />Save to Apollo</button>
    <small id="rx-apollo-locked-hint">Ask an admin</small>
  </span>;
}

/** "Created in Apollo by Ada on 30 Sep" beside the data age. */
export function ApolloSavedNote({ link }: { link: ApolloCrmLink }) {
  const verb = link.action === "linked" ? "Linked to an existing Apollo" : "Created as an Apollo";
  return <span className="field-hint rx-apollo-note">{verb} {link.record_type} by {link.by?.name ?? "a teammate"} on {formatDate(link.at)}</span>;
}

/** Shows exactly what will be written, checks Apollo for likely duplicates first, then links or creates. */
export function SaveToApolloDialog({ open, profile, onClose, onSaved, onUsage }: {
  open: boolean; profile: ResearchProfile; onClose(): void; onSaved(profile: ResearchProfile, usage: ApolloUsage, message: string): void;
  /** The duplicate check and pick-lists spend Apollo calls too. */
  onUsage(usage: ApolloUsage): void;
}) {
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog rx-dialog rx-apollo-dialog">
        <Dialog.Close className="close-button" aria-label="Close"><X /></Dialog.Close>
        <Dialog.Title>Save to Apollo</Dialog.Title>
        <Dialog.Description className="dialog-intro">Adds {profile.name} to your team&apos;s Apollo as {noun(profile) === "contact" ? "a contact" : "an account"}. Nothing is written until you confirm.</Dialog.Description>
        {open ? <SaveForm profile={profile} onClose={onClose} onSaved={onSaved} onUsage={onUsage} /> : null}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function SaveForm({ profile, onClose, onSaved, onUsage }: { profile: ResearchProfile; onClose(): void; onSaved(profile: ResearchProfile, usage: ApolloUsage, message: string): void; onUsage(usage: ApolloUsage): void }) {
  const [preview, setPreview] = useState<ApolloSavePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [choice, setChoice] = useState(CREATE);
  const [stageId, setStageId] = useState(NONE);
  const [ownerId, setOwnerId] = useState(NONE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void researchService.apolloPreview(profile.id).then((next) => {
      if (!live) return;
      setPreview(next); setChoice(next.matches[0]?.id ?? CREATE); setLoadError(null); onUsage(next.usage);
    }).catch((cause) => { if (live) setLoadError(cause instanceof Error ? cause.message : "Apollo couldn't be checked. Try again."); });
    return () => { live = false; };
    // onUsage is a parent callback; re-checking Apollo whenever it changes identity would spend calls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, attempt]);

  async function submit() {
    if (!preview) return;
    setBusy(true); setError(null);
    const linking = choice !== CREATE;
    try {
      const saved = await researchService.saveToApollo(profile.id, linking
        ? { action: "link", record_id: choice }
        : { action: "create", create_anyway: preview.matches.length > 0, stage_id: stageId || null, owner_id: ownerId || null });
      onSaved(saved.profile, saved.usage, linking ? `Linked to the existing Apollo ${preview.record_type}.` : `Created in Apollo as a new ${preview.record_type}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "It couldn't be saved to Apollo. Try again."); setBusy(false); }
  }

  if (loadError) return <>
    <div className="dialog-body"><Alert tone="danger">{loadError}</Alert></div>
    <div className="dialog-footer"><button type="button" className="button secondary" onClick={onClose}>Close</button><button type="button" className="button primary" onClick={() => { setLoadError(null); setAttempt((value) => value + 1); }}>Check again</button></div>
  </>;
  if (!preview) return <div className="dialog-body"><LoadingRow>Checking Apollo for an existing {noun(profile)}…</LoadingRow></div>;

  const creating = choice === CREATE;
  return <>
    <div className="dialog-body form-stack">
      {preview.matches.length ? <MatchChoices preview={preview} choice={choice} onChoice={setChoice} />
        : <Alert tone="success">No existing {preview.record_type} for {profile.name} found in Apollo.</Alert>}
      {creating ? <CreateDetails preview={preview} stageId={stageId} ownerId={ownerId} onStage={setStageId} onOwner={setOwnerId} /> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
    <div className="dialog-footer">
      <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
      <button type="button" className="button primary" disabled={busy} onClick={() => void submit()}>
        {busy ? "Saving…" : creating ? (preview.matches.length ? "Create anyway" : `Create ${preview.record_type}`) : "Link to existing"}
      </button>
    </div>
  </>;
}

function MatchChoices({ preview, choice, onChoice }: { preview: ApolloSavePreview; choice: string; onChoice(value: string): void }) {
  const plural = preview.matches.length === 1 ? `a likely match` : `${preview.matches.length} likely matches`;
  return <fieldset className="rx-apollo-choices">
    <legend className="field-label">Apollo already has {plural}</legend>
    {preview.matches.map((match) => {
      const href = safeLink(match.url);
      return <label key={match.id} className="choice-card">
        <input type="radio" name="rx-apollo-choice" value={match.id} checked={choice === match.id} onChange={() => onChoice(match.id)} />
        <Link2 className="choice-icon" aria-hidden="true" />
        <span><b>Link to {match.name}</b><small>{match.detail ?? `Existing ${preview.record_type}`}{href ? <> · <a href={href} target="_blank" rel="noopener noreferrer">Open in Apollo</a></> : null}</small></span>
      </label>;
    })}
    <label className="choice-card">
      <input type="radio" name="rx-apollo-choice" value={CREATE} checked={choice === CREATE} onChange={() => onChoice(CREATE)} />
      <CloudUpload className="choice-icon" aria-hidden="true" />
      <span><b>Create a new {preview.record_type} anyway</b><small>Apollo doesn&apos;t merge duplicates, so only do this if it&apos;s a different {preview.record_type === "contact" ? "person" : "company"}.</small></span>
    </label>
  </fieldset>;
}

function CreateDetails({ preview, stageId, ownerId, onStage, onOwner }: {
  preview: ApolloSavePreview; stageId: string; ownerId: string; onStage(value: string): void; onOwner(value: string): void;
}) {
  const kind = preview.record_type === "contact" ? "Contact" : "Account";
  return <section className="rx-apollo-write" aria-labelledby="rx-apollo-write-title">
    <h3 id="rx-apollo-write-title" className="field-label">What will be written</h3>
    <dl className="rx-facts rx-apollo-fields">{preview.fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
    <div className="rx-apollo-picks">
      {preview.stages.length ? <UiSelect id="rx-apollo-stage" label={`${kind} stage`} value={stageId} onChange={onStage}
        options={[{ value: NONE, label: "No stage" }, ...preview.stages.map((stage) => ({ value: stage.id, label: stage.name }))]} /> : null}
      {preview.owners.length ? <UiSelect id="rx-apollo-owner" label="Owner in Apollo" value={ownerId} onChange={onOwner}
        options={[{ value: NONE, label: "Apollo's default" }, ...preview.owners.map((owner) => ({ value: owner.id, label: owner.name }))]} /> : null}
    </div>
    {[preview.stages_note, preview.owners_note].filter(Boolean).map((note) => <p key={note} className="field-hint">{note}</p>)}
    <ul className="rx-apollo-left-out">{preview.not_sent.map((note) => <li key={note}>{note}</li>)}</ul>
  </section>;
}
