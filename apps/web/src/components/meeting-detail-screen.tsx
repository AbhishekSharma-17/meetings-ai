"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { meetingsService } from "@/lib/meetings-service";
import type { KnowledgeBase, MeetingDetail, MeetingParticipants, SpeakerIdentity, TranscriptSegment, TranscriptionRoute } from "@/lib/types";
import { MinutesPanel } from "./minutes-panel";

const pollableStatuses = new Set<MeetingDetail["status"]>(["created", "joining", "waiting_room", "live", "stopping", "processing"]);
const lifecycleCopy: Record<MeetingDetail["status"], { label: string; detail: string }> = {
  created: { label: "Created", detail: "The meeting record exists and is ready to dispatch." },
  joining: { label: "Joining", detail: "The assistant is being sent to the meeting." },
  waiting_room: { label: "Waiting in lobby", detail: "The assistant is waiting for a host to admit it." },
  live: { label: "Capturing live", detail: "The assistant is in the meeting and transcript updates will appear below." },
  needs_attention: { label: "Needs attention", detail: "The meeting platform needs a person to help the assistant continue." },
  stopping: { label: "Stopping", detail: "A stop request is in progress. This action is safe to repeat." },
  processing: { label: "Processing", detail: "Capture has ended; transcript and MOM processing are underway." },
  ready: { label: "Ready", detail: "The capture workflow has completed." },
  stopped: { label: "Stopped", detail: "The assistant has been stopped." },
  failed: { label: "Needs attention", detail: "The assistant could not complete the requested action." },
};

export function MeetingDetailScreen({ meetingId, focusSegmentId, onBack, onMeetingChange }: { meetingId: string; focusSegmentId?: string | null; onBack(): void; onMeetingChange(meeting: MeetingDetail): void }) {
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [participants, setParticipants] = useState<MeetingParticipants | null>(null);
  const [transcriptionRoute, setTranscriptionRoute] = useState<TranscriptionRoute | null>(null);
  const [speakerIdentities, setSpeakerIdentities] = useState<SpeakerIdentity[]>([]);
  const [editingIdentity, setEditingIdentity] = useState<string | null>(null);
  const [identityEmail, setIdentityEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<"join" | "stop" | "refresh" | null>(null);
  const [editingSpeakerId, setEditingSpeakerId] = useState<string | null>(null);
  const [speakerName, setSpeakerName] = useState("");
  const [applyToSameLabel, setApplyToSameLabel] = useState(false);
  const [savingSpeaker, setSavingSpeaker] = useState(false);
  const [speakerRevision, setSpeakerRevision] = useState(0);
  const lastFocused = useRef<string | null>(null);

  const acceptMeeting = useCallback((next: MeetingDetail) => {
    setMeeting(next);
    onMeetingChange(next);
  }, [onMeetingChange]);

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const nextMeeting = await meetingsService.getMeeting(meetingId);
        const nextSegments = await meetingsService.getTranscript(meetingId).catch(() => []);
        const nextRoute = await meetingsService.getTranscriptionRoute(meetingId).catch(() => null);
        if (!current) return;
        acceptMeeting(nextMeeting);
        setSegments(nextSegments);
        setTranscriptionRoute(nextRoute);
        setError(null);
      } catch (requestError) {
        if (current) setError(requestError instanceof Error ? requestError.message : "Unable to load this meeting.");
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5_000);
    return () => { current = false; window.clearInterval(interval); };
  }, [acceptMeeting, meetingId]);

  useEffect(() => {
    let current = true;
    const load = () => void meetingsService.getParticipants(meetingId).then((value) => {
      if (current) setParticipants(value);
    }).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 20_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [meetingId, speakerRevision]);

  useEffect(() => {
    if (!focusSegmentId || !segments.some((segment) => segment.segmentId === focusSegmentId)) return;
    const key = `${meetingId}:${focusSegmentId}`;
    if (lastFocused.current === key) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`transcript-${encodeURIComponent(focusSegmentId)}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      lastFocused.current = key;
    });
    return () => cancelAnimationFrame(frame);
  }, [focusSegmentId, meetingId, segments]);

  useEffect(() => {
    let current = true;
    void meetingsService.getSpeakerIdentities(meetingId).then((items) => {
      if (current) setSpeakerIdentities(items);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [meetingId, speakerRevision]);

  async function runAction(nextAction: "join" | "stop" | "refresh") {
    setAction(nextAction);
    setError(null);
    if (nextAction === "stop" && meeting) acceptMeeting({ ...meeting, status: "stopping" });
    try {
      const updated = nextAction === "join" ? await meetingsService.joinMeeting(meetingId)
        : nextAction === "stop" ? await meetingsService.stopMeeting(meetingId)
          : await meetingsService.refreshMeeting(meetingId);
      acceptMeeting(updated);
      const transcript = await meetingsService.getTranscript(meetingId).catch(() => []);
      setSegments(transcript);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The meeting action could not be completed.");
      const reloaded = await meetingsService.getMeeting(meetingId).catch(() => null);
      if (reloaded) acceptMeeting(reloaded);
    } finally {
      setAction(null);
    }
  }

  async function saveSpeaker(segment: TranscriptSegment) {
    setSavingSpeaker(true); setError(null);
    try {
      const corrected = await meetingsService.correctSpeaker(
        meetingId, segment.segmentId, speakerName.trim() || null, applyToSameLabel,
      );
      setSegments(corrected);
      setEditingSpeakerId(null);
      setSpeakerRevision((current) => current + 1);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not save speaker correction.");
    } finally { setSavingSpeaker(false); }
  }

  async function saveIdentity(speaker: string) {
    setError(null);
    try {
      const next = await meetingsService.saveSpeakerIdentity(meetingId, speaker, identityEmail.trim() || null);
      setSpeakerIdentities(next);
      setEditingIdentity(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not confirm speaker email.");
    }
  }

  async function downloadTranscript() {
    setError(null);
    try {
      const json = await meetingsService.exportTranscript(meetingId);
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `meetings-ai-transcript-${meetingId}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not export transcript.");
    }
  }

  if (!meeting) return <section className="page detail-page"><button className="back-button" onClick={onBack}>← All meetings</button><div className="detail-loading" role="status">Loading meeting lifecycle…</div>{error ? <p className="form-error" role="alert">{error}</p> : null}</section>;

  const lifecycle = lifecycleCopy[meeting.status];
  const canJoin = meeting.status === "created" || meeting.status === "failed";
  const canStop = ["joining", "waiting_room", "live", "needs_attention", "processing", "stopping"].includes(meeting.status);
  const namedSpeakers = [...new Set(segments.filter((segment) => segment.isFinal && segment.speaker !== "Unidentified speaker").map((segment) => segment.speaker))];
  const unattributedCount = segments.filter((segment) => segment.isFinal && segment.speaker === "Unidentified speaker").length;
  const finalizedCount = segments.filter((segment) => segment.isFinal).length;
  const reviewedCount = segments.filter((segment) => segment.isFinal && segment.speakerReviewed).length;
  const namedCoverage = finalizedCount ? Math.round((finalizedCount - unattributedCount) * 100 / finalizedCount) : 0;
  return <section className="page detail-page">
    <button className="back-button" onClick={onBack}>← All meetings</button>
    <div className="detail-hero">
      <div><p className="eyebrow">MEETING LIFECYCLE</p><h1>{meeting.title}</h1><a className="meeting-url" href={meeting.meetingUrl} target="_blank" rel="noreferrer">{meeting.meetingUrl || "No meeting link recorded"}<span aria-hidden="true">↗</span></a></div>
      <div className="detail-actions"><button className="button secondary" onClick={() => void runAction("refresh")} disabled={action !== null}>{action === "refresh" ? "Refreshing…" : "Refresh"}</button>{canJoin ? <button className="button primary" onClick={() => void runAction("join")} disabled={action !== null}>{action === "join" ? "Joining…" : meeting.status === "failed" ? "Retry join" : "Join meeting"}</button> : null}{canStop ? <button className="button danger" onClick={() => void runAction("stop")} disabled={action !== null}>{action === "stop" ? "Stopping…" : "Stop assistant"}</button> : null}</div>
    </div>
    <div className="meeting-knowledge-summary"><b>AI knowledge</b><span>{meeting.knowledgeEnabled ? "Included after completion" : "Not included"}</span>{meeting.tags.length ? <span>{meeting.tags.map((tag) => `#${tag}`).join(" · ")}</span> : null}</div>
    <MeetingKnowledgeControls key={meeting.id} meeting={meeting} onSaved={acceptMeeting} />
    {error ? <p className="form-error detail-error" role="alert">{error}</p> : null}

    <div className="lifecycle-banner" role="status"><span className={`status ${meeting.status}`}>{lifecycle.label}</span><div><b>{lifecycle.detail}</b><p>Controls operate on this product meeting record; the persisted capture identifier is resolved by the API.</p></div></div>

    <div className="detail-grid">
      <section className="detail-card" aria-labelledby="meeting-details-title"><h2 id="meeting-details-title">Meeting details</h2><dl className="metadata-list"><Metadata label="Platform" value={meeting.platform} /><Metadata label="Assistant" value={meeting.botName} /><Metadata label="Created" value={formatTimestamp(meeting.createdAt)} /><Metadata label="Last update" value={formatTimestamp(meeting.updatedAt)} /><Metadata label="Joined" value={formatTimestamp(meeting.joinedAt)} /><Metadata label="Stopped" value={formatTimestamp(meeting.stoppedAt)} /></dl></section>
      <section className="detail-card" aria-labelledby="capture-title"><h2 id="capture-title">People & capture</h2><p className="muted-copy">Duration: {meeting.duration}</p>{participants?.participants.length ? <ul className="participant-list">{participants.participants.map((person, index) => <li key={`${person.source}-${person.name}-${index}`}><b>{person.name}</b> <span>{person.source === "invite" ? "Invited" : "Heard speaking"}</span>{person.email ? <small>{person.email}</small> : null}</li>)}</ul> : <p className="muted-copy">No participant evidence is available yet.</p>}<p className="muted-copy">This is not a verified attendance roster. Invitees may not have joined; silent attendees may be absent. Speaker names are not automatically matched to invitee emails.</p>{namedSpeakers.length ? <div className="speaker-identities"><h3>Confirm speaker contact</h3><p>Only link an email after you verify who spoke. This does not add them to recap recipients.</p>{namedSpeakers.map((speaker) => { const identity = speakerIdentities.find((item) => item.speaker === speaker); return <div key={speaker} className="speaker-identity-row"><span><b>{speaker}</b>{identity ? ` · ${identity.email} (confirmed)` : " · email not linked"}</span><button className="text-button" onClick={() => { setEditingIdentity(speaker); setIdentityEmail(identity?.email ?? ""); }}>Confirm email</button>{editingIdentity === speaker ? <div className="speaker-identity-form"><label>Email for {speaker}<input type="email" value={identityEmail} onChange={(event) => setIdentityEmail(event.target.value)} placeholder="person@company.com" /></label><div className="dialog-actions"><button className="button secondary" onClick={() => setEditingIdentity(null)}>Cancel</button><button className="button primary" onClick={() => void saveIdentity(speaker)}>Save mapping</button></div></div> : null}</div>; })}</div> : null}{meeting.errorMessage ? <p className="inline-error"><b>Adapter message:</b> {meeting.errorMessage}</p> : null}</section>
    </div>

    <section className="transcript-panel" aria-labelledby="transcript-title"><div className="section-heading"><div><h2 id="transcript-title">Speaker-attributed transcript</h2><p>Names come from the capture pipeline or your explicit corrections. Unresolved turns stay unidentified.</p></div><div className="transcript-tools"><span className="polling-indicator">{pollableStatuses.has(meeting.status) ? "Updates every 5 seconds" : "Capture complete"}</span>{segments.length ? <button className="text-button" type="button" onClick={() => void downloadTranscript()}>Download transcript JSON</button> : null}</div></div>
      {segments.length ? <><p className="speaker-summary"><b>Speakers heard:</b> {namedSpeakers.length ? namedSpeakers.join(", ") : "none identified"}{unattributedCount ? ` · ${unattributedCount} unidentified turn${unattributedCount === 1 ? "" : "s"}` : ""} · {namedCoverage}% of finalized turns named · {reviewedCount} reviewed. Coverage is not a measure of identity accuracy, and this is not a complete attendance roster.</p><ol className="transcript-list">{segments.map((segment) => <li key={segment.id} id={`transcript-${encodeURIComponent(segment.segmentId)}`} className={focusSegmentId === segment.segmentId ? "focused-source" : undefined}><div className="segment-meta"><b>{segment.speaker}</b><span>{formatTimestamp(segment.startedAt)}{segment.isFinal ? "" : " · provisional"}{segment.speakerReviewed ? " · reviewed" : segment.attributionSource ? ` · ${segment.attributionSource}` : ""}</span></div><p>{segment.text}</p><div className="speaker-review-row">{segment.rawSpeaker && segment.rawSpeaker !== segment.speaker ? <small>Capture label: {segment.rawSpeaker}</small> : null}<button className="text-button" type="button" onClick={() => { setEditingSpeakerId(segment.segmentId); setSpeakerName(segment.speaker === "Unidentified speaker" ? "" : segment.speaker); setApplyToSameLabel(false); }}>Review speaker</button></div>{editingSpeakerId === segment.segmentId ? <div className="speaker-review-form"><label>Correct speaker name<input value={speakerName} onChange={(event) => setSpeakerName(event.target.value)} placeholder="Leave blank to mark unidentified" /></label><label className="speaker-bulk-choice"><input type="checkbox" checked={applyToSameLabel} onChange={(event) => setApplyToSameLabel(event.target.checked)} disabled={!segment.rawSpeaker} /> Apply to all turns with capture label “{segment.rawSpeaker || "none"}”</label><div className="dialog-actions"><button className="button secondary" onClick={() => setEditingSpeakerId(null)} disabled={savingSpeaker}>Cancel</button><button className="button primary" onClick={() => void saveSpeaker(segment)} disabled={savingSpeaker}>{savingSpeaker ? "Saving…" : "Save speaker"}</button></div></div> : null}</li>)}</ol></> : <div className="empty-state"><b>No transcript segments yet.</b><p>{meeting.status === "live" ? "The assistant is live; the first finalized segment will appear here when the API returns it." : "Transcript segments will appear after the capture adapter produces them."}</p></div>}</section>
    {transcriptionRoute ? <section className="route-audit" aria-label="Transcription runtime route"><b>Transcription runtime</b><span>{transcriptionRoute.mode === "profile" ? `${transcriptionRoute.profile_name} · ${transcriptionRoute.model} · ${transcriptionRoute.endpoint_host}` : transcriptionRoute.mode === "vexa_deployment" ? "Vexa deployment default" : "Chosen when the assistant joins"}</span><small>Stored for this bot run. Changing provider defaults does not switch an active bot.</small></section> : null}
    <MinutesPanel key={`${meeting.id}:${speakerRevision}`} meeting={meeting} transcriptCount={segments.filter((segment) => segment.isFinal).length} segments={segments} />
  </section>;
}

function Metadata({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }

function MeetingKnowledgeControls({ meeting, onSaved }: {
  meeting: MeetingDetail; onSaved(meeting: MeetingDetail): void;
}) {
  const [tags, setTags] = useState(meeting.tags.join(", "));
  const [included, setIncluded] = useState(meeting.knowledgeEnabled);
  const [baseId, setBaseId] = useState(meeting.knowledgeBaseId ?? "");
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void meetingsService.listKnowledgeBases().then(setBases).catch(() => setBases([]));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(null); setMessage(null);
    try {
      const updated = await meetingsService.updateMeetingKnowledge(
        meeting.id, tags.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean), included, baseId || null,
      );
      setTags(updated.tags.join(", "));
      onSaved(updated);
      setMessage("Knowledge settings saved. Opt-out takes effect on the next search.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update knowledge settings.");
    } finally { setSaving(false); }
  }

  return <details className="meeting-knowledge-edit"><summary>Edit tags and AI knowledge inclusion</summary><form onSubmit={(event) => void submit(event)}><label htmlFor="meeting-detail-tags">Tags, comma-separated</label><input id="meeting-detail-tags" value={tags} onChange={(event) => setTags(event.target.value)} maxLength={650} disabled={saving} /><label htmlFor="meeting-detail-base">Knowledge base</label><select id="meeting-detail-base" value={baseId} onChange={(event) => setBaseId(event.target.value)} disabled={saving}><option value="">No named knowledge base</option>{bases.map((base) => <option value={base.id} key={base.id}>{base.name}</option>)}</select><label className="check-label"><input type="checkbox" checked={included} onChange={(event) => setIncluded(event.target.checked)} disabled={saving} /> Include finalized transcript and approved facts in AI knowledge</label><p>Removing a meeting immediately excludes it from search and new AI answers. Existing answers are not a revocable copy.</p>{error ? <p className="form-error" role="alert">{error}</p> : null}{message ? <p className="workspace-success" role="status">{message}</p> : null}<button className="button secondary" disabled={saving}>{saving ? "Saving…" : "Save knowledge settings"}</button></form></details>;
}

function formatTimestamp(value: string | number | null): string {
  if (value === null || value === "") return "—";
  if (typeof value === "number") {
    const minutes = Math.floor(value / 60);
    return `${minutes}:${Math.floor(value % 60).toString().padStart(2, "0")}`;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
