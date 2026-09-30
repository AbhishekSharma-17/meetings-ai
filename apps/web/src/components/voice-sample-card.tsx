"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Mic, Pause, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import { voiceSampleService, type VoiceSampleStatus } from "@/lib/voice-sample-service";
import { formatDateTime } from "@/lib/time-store";
import { Alert, Badge, LoadingRow } from "./ui/feedback";
import { InPersonLevel } from "./in-person-level";
import { formatClock } from "./use-in-person";
import { SAMPLE_MAX_MS, SAMPLE_MIN_MS, useVoiceRecorder, type RecordedSample } from "./use-voice-recorder";

const CONSENT = "Used only to suggest your name when you're recorded in person in this workspace. Delete any time.";
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/** Plays one audio URL with a single toggle button; stops when the URL changes or the card unmounts. */
function usePlayback() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const stop = useCallback(() => { audio.current?.pause(); audio.current = null; setPlaying(false); }, []);
  const play = useCallback(async (url: string) => {
    stop();
    const element = new Audio(url);
    element.addEventListener("ended", () => setPlaying(false));
    audio.current = element;
    setPlaying(true);
    try { await element.play(); } catch { setPlaying(false); throw new Error("This browser could not play the sample."); }
  }, [stop]);
  useEffect(() => stop, [stop]);
  return { playing, play, stop };
}

/** My profile: an opt-in 5–10 second voice sample used to suggest the person's name in in-person recordings. */
export function VoiceSampleCard({ displayName }: { displayName: string }) {
  const [status, setStatus] = useState<VoiceSampleStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | "play" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const savedUrl = useRef<string | null>(null);
  const recorder = useVoiceRecorder();
  const playback = usePlayback();

  const load = useCallback(async () => {
    setLoadError(null);
    try { setStatus(await voiceSampleService.status()); }
    catch { setLoadError("Your voice sample settings could not be loaded."); }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);
  useEffect(() => () => { if (savedUrl.current) URL.revokeObjectURL(savedUrl.current); }, []);

  const forgetSavedAudio = () => { if (savedUrl.current) URL.revokeObjectURL(savedUrl.current); savedUrl.current = null; };

  async function playSaved() {
    if (playback.playing) { playback.stop(); return; }
    setError(null); setBusy("play");
    try {
      savedUrl.current ??= URL.createObjectURL(await voiceSampleService.audio());
      await playback.play(savedUrl.current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The sample could not be played."); }
    finally { setBusy(null); }
  }

  async function playRecorded(sample: RecordedSample) {
    if (playback.playing) { playback.stop(); return; }
    setError(null);
    try { await playback.play(sample.url); } catch (cause) { setError(cause instanceof Error ? cause.message : "The sample could not be played."); }
  }

  async function save(sample: RecordedSample) {
    setError(null); setNotice(null); setBusy("save"); playback.stop();
    try {
      setStatus(await voiceSampleService.save(sample.blob, sample.durationMs));
      forgetSavedAudio(); recorder.reset(); setAgreed(false);
      setNotice("Voice sample saved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Your voice sample could not be saved. Try again."); }
    finally { setBusy(null); }
  }

  async function remove() {
    setError(null); setNotice(null); setBusy("delete"); playback.stop();
    try {
      await voiceSampleService.remove();
      forgetSavedAudio(); setConfirmDelete(false);
      setStatus((current) => current ? { ...current, sample: null } : current);
      setNotice("Voice sample deleted.");
    } catch { setError("The sample could not be deleted. Try again."); }
    finally { setBusy(null); }
  }

  function record() { setError(null); setNotice(null); setConfirmDelete(false); playback.stop(); void recorder.start(); }

  return <section className="card voice-card" aria-labelledby="voice-sample-title">
    <div className="card-header">
      <div><h2 id="voice-sample-title">Voice sample</h2><p>Optional. Record 5–10 seconds of yourself talking so Meetings AI can suggest your name in in-person recordings.</p></div>
      {status?.sample ? <Badge tone="success" dot>Saved</Badge> : null}
    </div>
    <div className="card-body voice-body">
      {loadError ? <Alert tone="danger" title={loadError} actions={<button type="button" className="button secondary sm" onClick={() => void load()}><RefreshCw aria-hidden="true" />Retry</button>} />
        : !status ? <LoadingRow>Loading your voice sample…</LoadingRow>
          : <>
            <Matching status={status} />
            {recorder.phase === "recording" || recorder.phase === "requesting"
              ? <Recording phase={recorder.phase} elapsedMs={recorder.elapsedMs} level={recorder.level} displayName={displayName} onStop={recorder.stop} onCancel={recorder.reset} />
              : recorder.phase === "recorded" && recorder.sample
                ? <Preview sample={recorder.sample} playing={playback.playing} busy={busy === "save"} needsConsent={!status.sample} agreed={agreed} onAgree={setAgreed}
                  onPlay={() => void playRecorded(recorder.sample as RecordedSample)} onSave={() => void save(recorder.sample as RecordedSample)} onAgain={record} onDiscard={() => { playback.stop(); recorder.reset(); }} />
                : status.sample
                  ? <Saved status={status} playing={playback.playing} busy={busy} confirmDelete={confirmDelete} onPlay={() => void playSaved()} onAgain={record}
                    onDelete={() => setConfirmDelete(true)} onConfirmDelete={() => void remove()} onCancelDelete={() => setConfirmDelete(false)} />
                  : <Empty onRecord={record} />}
            {recorder.phase === "error" && recorder.problem ? <Alert tone="danger" title={recorder.problem.title}
              actions={<button type="button" className="button secondary sm" onClick={record}><RefreshCw aria-hidden="true" />Try again</button>}>{recorder.problem.detail}</Alert> : null}
            {error ? <p className="form-error" role="alert">{error}</p> : null}
            {notice ? <p className="form-success" role="status">{notice}</p> : null}
          </>}
    </div>
  </section>;
}

function Matching({ status }: { status: VoiceSampleStatus }) {
  const available = status.matching.status === "available";
  return <div className="voice-matching">
    <Badge tone={available ? "brand" : "neutral"}>{available ? "Used for name suggestions" : "Not used for matching yet"}</Badge>
    <p className="field-hint">{status.matching.message}</p>
  </div>;
}

function Empty({ onRecord }: { onRecord(): void }) {
  return <div className="voice-row">
    <p className="voice-consent">{CONSENT}</p>
    <button type="button" className="button secondary" onClick={onRecord}><Mic aria-hidden="true" />Record a sample</button>
  </div>;
}

function Recording({ phase, elapsedMs, level, displayName, onStop, onCancel }: {
  phase: "recording" | "requesting"; elapsedMs: number; level: number; displayName: string; onStop(): void; onCancel(): void;
}) {
  const tooShort = elapsedMs < SAMPLE_MIN_MS;
  const first = displayName.split(" ")[0] || displayName;
  return <div className="voice-recording" role="group" aria-label="Recording your voice sample">
    <p className="voice-script">Read this aloud: “Hi, this is {first}. I’m recording a short sample so Meetings AI can recognise my voice in meetings.”</p>
    <div className="voice-clock">
      <span className="voice-timer tabular" aria-live="off">{formatClock(elapsedMs)} <small>/ {formatClock(SAMPLE_MAX_MS)}</small></span>
      <span className="field-hint" role="status">{phase === "requesting" ? "Waiting for microphone permission…" : tooShort ? `Keep going — at least ${seconds(SAMPLE_MIN_MS)}` : "Stop when you're done, or it stops at 10 s"}</span>
    </div>
    <InPersonLevel level={level} label="Microphone level" />
    <div className="button-group">
      <button type="button" className="button primary" disabled={phase !== "recording" || tooShort} onClick={onStop}><Square aria-hidden="true" />Stop</button>
      <button type="button" className="button ghost" onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}

function Preview({ sample, playing, busy, needsConsent, agreed, onAgree, onPlay, onSave, onAgain, onDiscard }: {
  sample: RecordedSample; playing: boolean; busy: boolean; needsConsent: boolean; agreed: boolean; onAgree(value: boolean): void;
  onPlay(): void; onSave(): void; onAgain(): void; onDiscard(): void;
}) {
  return <div className="voice-preview">
    <div className="voice-row">
      <PlayButton playing={playing} onClick={onPlay} label="Play what you recorded" />
      <span className="voice-meta"><AudioLines aria-hidden="true" />New recording · {seconds(sample.durationMs)}</span>
    </div>
    {needsConsent ? <label className="check-label voice-consent-check"><input type="checkbox" checked={agreed} onChange={(event) => onAgree(event.target.checked)} />{CONSENT}</label>
      : <p className="voice-consent">{CONSENT}</p>}
    <div className="button-group">
      <button type="button" className="button primary" disabled={busy || (needsConsent && !agreed)} onClick={onSave}>{busy ? "Saving…" : "Save sample"}</button>
      <button type="button" className="button secondary" disabled={busy} onClick={onAgain}><RefreshCw aria-hidden="true" />Record again</button>
      <button type="button" className="button ghost" disabled={busy} onClick={onDiscard}>Discard</button>
    </div>
  </div>;
}

function Saved({ status, playing, busy, confirmDelete, onPlay, onAgain, onDelete, onConfirmDelete, onCancelDelete }: {
  status: VoiceSampleStatus; playing: boolean; busy: "save" | "delete" | "play" | null; confirmDelete: boolean;
  onPlay(): void; onAgain(): void; onDelete(): void; onConfirmDelete(): void; onCancelDelete(): void;
}) {
  const sample = status.sample;
  if (!sample) return null;
  return <div className="voice-preview">
    <div className="voice-row">
      <PlayButton playing={playing} disabled={busy === "play"} onClick={onPlay} label="Play your voice sample" />
      <span className="voice-meta"><AudioLines aria-hidden="true" />{seconds(sample.duration_ms)} · saved {formatDateTime(sample.updated_at)}</span>
    </div>
    <p className="voice-consent">{CONSENT} Only you can listen to it; admins can see that you have one.</p>
    {confirmDelete ? <div className="voice-confirm" role="group" aria-label="Delete your voice sample?">
      <span>Delete your voice sample? New recordings won&apos;t suggest your name from it.</span>
      <div className="button-group">
        <button type="button" className="button danger sm" disabled={busy === "delete"} onClick={onConfirmDelete}>{busy === "delete" ? "Deleting…" : "Delete sample"}</button>
        <button type="button" className="button ghost sm" disabled={busy === "delete"} onClick={onCancelDelete}>Keep it</button>
      </div>
    </div> : <div className="button-group">
      <button type="button" className="button secondary" onClick={onAgain}><Mic aria-hidden="true" />Record again</button>
      <button type="button" className="button ghost" onClick={onDelete}><Trash2 aria-hidden="true" />Delete</button>
    </div>}
  </div>;
}

function PlayButton({ playing, disabled = false, onClick, label }: { playing: boolean; disabled?: boolean; onClick(): void; label: string }) {
  return <button type="button" className="button secondary icon voice-play" aria-label={playing ? "Stop playback" : label} aria-pressed={playing} disabled={disabled} onClick={onClick}>
    {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
  </button>;
}
