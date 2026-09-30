"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AudioLines, Check, CheckCheck, Pencil, Quote, RefreshCw, UserRoundSearch, X } from "lucide-react";
import { inPersonService } from "@/lib/in-person-service";
import type { SpeakerNameEvidence, SpeakerNameRow, SpeakerNamesView } from "@/lib/in-person-types";
import { Alert, Badge, LoadingRow, type Tone } from "./ui/feedback";
import { formatClock } from "./use-in-person";

const PENDING_POLL_MS = 5_000;
const MAX_APPROVALS = 20;
const MAX_NAME = 120;
const confidence: Record<"high" | "medium" | "low", { label: string; tone: Tone }> = {
  high: { label: "High confidence", tone: "success" }, medium: { label: "Medium confidence", tone: "info" }, low: { label: "Low confidence", tone: "warning" },
};
const evidenceKind: Record<SpeakerNameEvidence["kind"], string> = {
  addressed: "Called by name", self_introduction: "Introduced themselves", expected_person: "On the expected list", invitee: "Calendar invitee",
  voice_sample: "Matched their saved voice sample",
};
export const SINGLE_SPEAKER_COPY = "The speech-to-text model didn't separate speakers, so everything is under one Speaker. You can rename or reassign individual lines in the transcript.";

/** Suggested names for "Speaker A/B/…" in an in-person recording. Nothing is applied until approved. */
export function InPersonSpeakerNames({ meetingId, onApplied, onFocusAt }: {
  meetingId: string;
  /** Names were written to the transcript: reload it. */
  onApplied(): void;
  /** Jump to the transcript turn nearest this many seconds into the recording. */
  onFocusAt?(seconds: number): void;
}) {
  const [view, setView] = useState<SpeakerNamesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setView(await inPersonService.speakerNames(meetingId)); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load speaker suggestions."); }
  }, [meetingId]);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(first);
  }, [load]);

  useEffect(() => {
    if (view?.status !== "pending") return;
    const timer = window.setTimeout(() => void load(), PENDING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [load, view]);

  async function act(key: string, work: () => Promise<SpeakerNamesView>, applied: boolean) {
    setBusy(key); setError(null);
    try {
      setView(await work());
      setEditing(null);
      if (applied) onApplied();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save. Try again."); }
    finally { setBusy(null); }
  }

  const approve = (approvals: Array<{ speaker: string; name: string }>) => act(approvals.length > 1 ? "all" : approvals[0].speaker, () => inPersonService.approveNames(meetingId, approvals.slice(0, MAX_APPROVALS)), true);
  const dismiss = (speaker: string) => act(speaker, () => inPersonService.dismissName(meetingId, speaker), false);
  const refresh = () => act("refresh", () => inPersonService.refreshNames(meetingId), false);

  if (view?.status === "not_applicable") return null;
  const suggested = (view?.speakers ?? []).filter((row) => row.state === "suggested" && row.suggestion);
  const messages = error || !view || view.status === "pending" || view.status === "unavailable" || view.single_speaker || (view.status === "ready" && !view.speakers.length);
  return <section className="card ip-names" aria-labelledby="ip-names-title">
    <div className="card-header">
      <div><h2 id="ip-names-title">Name the speakers</h2><p>Suggestions come from what was said in the room. Nothing changes until you approve a name.</p></div>
      <div className="button-group">
        {view?.status === "ready" ? <button type="button" className="button ghost sm" disabled={busy !== null} onClick={() => void refresh()}><RefreshCw aria-hidden="true" />{busy === "refresh" ? "Checking…" : "Suggest again"}</button> : null}
        {suggested.length > 1 ? <button type="button" className="button primary sm" disabled={busy !== null} onClick={() => void approve(suggested.map((row) => ({ speaker: row.speaker, name: row.suggestion?.name ?? "" })))}>
          <CheckCheck aria-hidden="true" />{busy === "all" ? "Approving…" : `Approve all suggestions (${suggested.length})`}
        </button> : null}
      </div>
    </div>
    {messages ? <div className="card-body stack">
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!view && !error ? <LoadingRow>Loading speaker suggestions…</LoadingRow> : null}
      {view?.status === "pending" ? <LoadingRow>Suggesting names from the transcript…</LoadingRow> : null}
      {view?.status === "unavailable" ? <Alert tone="neutral" role="note">{view.message ?? "Name suggestions are not available for this meeting. You can still rename speakers below."}</Alert> : null}
      {view?.single_speaker ? <Alert tone="info" title="One speaker label">{SINGLE_SPEAKER_COPY}</Alert> : null}
      {view?.status === "ready" && !view.speakers.length ? <p className="muted-copy">No speaker labels in this transcript yet.</p> : null}
    </div> : null}
    {view && view.speakers.length ? <ul className="ip-name-list">
      {view.speakers.map((row) => <SpeakerRow key={row.speaker} row={row} busy={busy === row.speaker} disabled={busy !== null} editing={editing === row.speaker}
        onEdit={() => setEditing(row.speaker)} onCancel={() => setEditing(null)} onApprove={(name) => void approve([{ speaker: row.speaker, name }])}
        onDismiss={() => void dismiss(row.speaker)} onFocusAt={onFocusAt} />)}
    </ul> : null}
  </section>;
}

function SpeakerRow({ row, busy, disabled, editing, onEdit, onCancel, onApprove, onDismiss, onFocusAt }: {
  row: SpeakerNameRow; busy: boolean; disabled: boolean; editing: boolean;
  onEdit(): void; onCancel(): void; onApprove(name: string): void; onDismiss(): void; onFocusAt?(seconds: number): void;
}) {
  const suggestion = row.state === "suggested" ? row.suggestion : null;
  const letter = row.speaker.replace(/^speaker\s+/i, "").slice(0, 2).toUpperCase() || "?";
  return <li className="ip-name-row" role="group" aria-label={row.speaker} data-state={row.state}>
    <div className="ip-name-head">
      <span className="avatar" aria-hidden="true">{letter}</span>
      <div className="ip-name-copy">
        <b>{row.speaker}</b>
        <small>{row.segments} turn{row.segments === 1 ? "" : "s"} · first at <button type="button" className="text-button neutral tabular" onClick={() => onFocusAt?.(row.first_at_seconds)}>{formatClock(row.first_at_seconds * 1000)}</button></small>
        {row.sample ? <q className="ip-name-sample">{row.sample}</q> : null}
      </div>
      {row.state === "approved" && row.current_name ? <Badge tone="success" dot>Named {row.current_name}</Badge> : null}
      {row.state === "dismissed" ? <Badge>Suggestion dismissed</Badge> : null}
    </div>

    {suggestion && !editing ? <div className="inset-panel ip-suggestion">
      <p className="ip-suggestion-name"><UserRoundSearch aria-hidden="true" /><b>{suggestion.name}</b><Badge tone={confidence[suggestion.confidence].tone}>{confidence[suggestion.confidence].label}</Badge></p>
      <p className="ip-suggestion-reason">{suggestion.reason}</p>
      {suggestion.evidence.length ? <ul className="ip-evidence" aria-label={`Evidence for ${suggestion.name}`}>
        {suggestion.evidence.map((item, index) => <li key={`${item.at_seconds}-${index}`}>
          {item.kind === "voice_sample" ? <AudioLines aria-hidden="true" /> : <Quote aria-hidden="true" />}
          <span><q>{item.quote}</q><small>{evidenceKind[item.kind]} · <button type="button" className="text-button neutral tabular" onClick={() => onFocusAt?.(item.at_seconds)} aria-label={`Show the line at ${formatClock(item.at_seconds * 1000)} in the transcript`}>{formatClock(item.at_seconds * 1000)}</button></small></span>
        </li>)}
      </ul> : null}
    </div> : null}

    {editing ? <NameForm speaker={row.speaker} initial={row.current_name ?? suggestion?.name ?? row.suggestion?.name ?? ""} busy={busy} onCancel={onCancel} onSave={onApprove} />
      : <div className="button-group ip-name-actions">
        {suggestion ? <button type="button" className="button primary sm" disabled={disabled} aria-label={`Approve ${suggestion.name} for ${row.speaker}`} onClick={() => onApprove(suggestion.name)}><Check aria-hidden="true" />{busy ? "Saving…" : "Approve"}</button> : null}
        <button type="button" className="button secondary sm" disabled={disabled} aria-label={`Edit name for ${row.speaker}`} onClick={onEdit}><Pencil aria-hidden="true" />{row.state === "approved" ? "Rename" : suggestion ? "Edit name" : "Name this speaker"}</button>
        {suggestion ? <button type="button" className="button ghost sm" disabled={disabled} aria-label={`Dismiss suggestion for ${row.speaker}`} onClick={onDismiss}><X aria-hidden="true" />Dismiss</button> : null}
      </div>}
  </li>;
}

function NameForm({ speaker, initial, busy, onCancel, onSave }: { speaker: string; initial: string; busy: boolean; onCancel(): void; onSave(name: string): void }) {
  const [name, setName] = useState(initial);
  const id = `ip-name-${speaker.replace(/\W+/g, "-").toLowerCase()}`;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim()) onSave(name.trim());
  }
  return <form className="ip-name-form" onSubmit={submit}>
    <div className="field"><label htmlFor={id}>Name for {speaker}</label><input id={id} value={name} maxLength={MAX_NAME} autoFocus autoComplete="off" onChange={(event) => setName(event.target.value)} /></div>
    <p className="field-hint">Every line labelled {speaker} gets this name. You can still change single lines in the transcript.</p>
    <div className="button-group end">
      <button type="button" className="button ghost sm" onClick={onCancel}>Cancel</button>
      <button type="submit" className="button primary sm" disabled={busy || !name.trim()}>{busy ? "Saving…" : "Save name"}</button>
    </div>
  </form>;
}
