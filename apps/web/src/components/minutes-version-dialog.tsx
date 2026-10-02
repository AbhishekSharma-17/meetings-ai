"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Download, X } from "lucide-react";
import { minutesVersions, type MinutesVersion } from "@/lib/minutes-versions";
import { meetingsService } from "@/lib/meetings-service";
import type { MinutesDraft, MomGuidance, TranscriptSegment, WorkspaceMember } from "@/lib/types";
import { UiSelect } from "./ui-select";
import { Alert, Badge, LoadingRow } from "./ui/feedback";
import { EvidenceChips } from "./minutes-support";
import { useBackgroundJob } from "./use-background-job";
import { BackgroundJobHint } from "./background-job-hint";

const balanced: MomGuidance = { template: "standard", instructions: "", focus_fields: [] };
const presets = [
  { value: "standard", label: "Balanced minutes" }, { value: "technical", label: "Technical deep dive" },
  { value: "commercial", label: "Commercial recap" }, { value: "detailed", label: "Detailed discussion notes" },
  { value: "actions", label: "Decisions & actions" }, { value: "custom", label: "Custom focus" },
];
const guidanceFor = (value: string): MomGuidance => {
  if (value === "technical") return { template: "custom", instructions: "Explain technical discussions in depth, including design rationale, architecture, dependencies and technical risks. Distinguish proposals from decisions. Only include details actually discussed.", focus_fields: ["Architecture", "Dependencies", "Technical risks"] };
  if (value === "commercial") return { template: "client", instructions: "Focus on commercial context, requirements, scope, pricing discussions, stakeholders and next steps. Do not invent budgets or commitments.", focus_fields: ["Commercial context", "Scope", "Next steps"] };
  if (value === "detailed") return { template: "custom", instructions: "Give an elaborative account of each substantive discussion, rationale, alternatives, concerns and outcomes, while keeping the executive summary clear and grounded in the transcript.", focus_fields: [] };
  return { ...balanced, template: value === "actions" ? "actions" : value === "custom" ? "custom" : "standard" };
};
const message = (cause: unknown) => cause instanceof Error ? cause.message : "Could not update this MOM. Please try again.";
const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

/** One version per dialog. Saved content stays on the server; no private notes in browser storage. */
export function MinutesVersionDialog({ meetingId, versionId, segments, onClose, onChanged }: {
  meetingId?: string; versionId: string | null; segments: TranscriptSegment[]; onClose(): void; onChanged(): void;
}) {
  const [version, setVersion] = useState<MinutesVersion | null>(null);
  const versionRef = useRef<MinutesVersion | null>(null);
  const [label, setLabel] = useState("My meeting notes");
  const [guidance, setGuidance] = useState<MomGuidance>(balanced);
  const [preset, setPreset] = useState("standard");
  const [focus, setFocus] = useState("");
  const [content, setContent] = useState<MinutesDraft | null>(null);
  const [visibility, setVisibility] = useState<MinutesVersion["visibility"]>("private");
  const [userIds, setUserIds] = useState<string[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [busy, setBusy] = useState<string | null>(versionId ? "load" : null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const generation = useBackgroundJob("personal_mom", version?.id ?? versionId ?? "", {
    onFinish: (job) => {
      if (versionRef.current) void minutesVersions.get(versionRef.current.id).then(accept).catch((cause) => setError(message(cause)));
      if (job.status === "failed") setError(job.error ?? "Generation failed. You can retry it.");
      onChanged();
    },
  });
  const working = !!busy || generation.running;

  function accept(next: MinutesVersion) {
    versionRef.current = next;
    setVersion(next); setLabel(next.label); setGuidance(next.guidance ?? balanced);
    setPreset(next.template);
    setFocus(next.guidance?.focus_fields.join(", ") ?? ""); setContent(next.content);
    setVisibility(next.visibility); setUserIds(next.user_ids); setDirty(false);
  }
  useEffect(() => {
    let active = true;
    if (versionId) void minutesVersions.get(versionId).then((next) => { if (active) accept(next); })
      .catch((cause) => { if (active) setError(message(cause)); }).finally(() => { if (active) setBusy(null); });
    void meetingsService.listWorkspaceMembers().then((next) => { if (active) setMembers(next.filter((member) => member.status === "active")); }).catch(() => undefined);
    return () => { active = false; };
  }, [versionId]);
  const editable = !versionId || version?.is_mine;
  const configured = { ...guidance, focus_fields: [...new Set(focus.split(/[,;\n]+/).map((value) => value.trim()).filter(Boolean))] };
  async function save() {
    const next = version ? await minutesVersions.save(version, label, configured, content, preset)
      : await minutesVersions.create(meetingId!, label, configured, preset);
    accept(next); onChanged(); return next;
  }
  async function run(action: string, operation: () => Promise<void>) {
    setBusy(action); setError(null); setNotice(null);
    try { await operation(); }
    catch (cause) {
      setError(message(cause));
      // A failed provider call may have claimed a revision; refresh it for a safe retry.
      if (action === "generate" && versionRef.current) {
        try { accept(await minutesVersions.get(versionRef.current.id)); } catch { /* Retain the original error. */ }
      }
    }
    finally { setBusy(null); }
  }
  function close() { if (busy) return; if (dirty) setDiscard(true); else onClose(); }
  function edit(next: MinutesDraft) { setContent(next); setDirty(true); }
  function download() {
    if (!content) return;
    const markdown = [`# ${content.title}`, `Version: ${version?.label ?? label}`, `Prepared by: ${version?.creator_name ?? "You"}`,
      `Status: ${version?.status ?? "draft"}`, `Updated: ${version?.updated_at ?? ""}`, "", "## Executive summary", content.executive_summary,
      "", "## Discussion", ...content.discussion_points.map((item) => `- ${item}`), "", "## Decisions", ...content.decisions.map((item) => `- ${item}`),
      "", "## Action items", ...content.action_items.map((item) => `- ${item.description}${item.owner ? ` — ${item.owner}` : ""}${item.due_date ? ` (due ${item.due_date})` : ""}`),
      "", "## Open questions", ...content.open_questions.map((item) => `- ${item}`)].join("\n");
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const anchor = window.document.createElement("a"); anchor.href = url;
    anchor.download = `${label.replace(/[^a-zA-Z0-9_-]/g, "-") || "meeting-notes"}.md`; anchor.click();
    URL.revokeObjectURL(url);
  }
  return <Dialog.Root open onOpenChange={(open) => { if (!open) close(); }}>
    <Dialog.Portal><Dialog.Backdrop className="dialog-backdrop" /><Dialog.Popup className="dialog minutes-version-dialog">
      <button className="close-button" type="button" aria-label="Close MOM version" disabled={!!busy} onClick={close}><X /></button>
      <Dialog.Title>{version ? version.label : "Create your MOM"}</Dialog.Title>
      <Dialog.Description className="dialog-intro">The same transcript, interpreted for your needs. Your notes do not change anyone else&apos;s MOM.</Dialog.Description>
      <div className="minutes-version-dialog-body">
        {busy === "load" ? <LoadingRow>Opening MOM…</LoadingRow> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {notice ? <p className="field-hint" role="status">{notice}</p> : null}
        {generation.running ? <BackgroundJobHint>Your MOM is generating in the background. You can close this window and return later.</BackgroundJobHint> : null}
        {discard ? <Alert tone="warning" title="Discard unsaved changes?" actions={<><button className="button secondary sm" onClick={() => setDiscard(false)}>Keep editing</button><button className="button secondary sm" onClick={onClose}>Discard changes</button></>}>Your last saved version stays on the server.</Alert> : null}
        {version ? <p className="minutes-version-badges"><Badge tone={version.status === "approved" ? "success" : "neutral"}>{version.status}</Badge><span className="field-hint">By {version.creator_name} · {version.visibility === "private" ? "Private" : "Sharing configured"}</span></p> : null}
        {version?.content && !version.source_is_current ? <Alert tone="warning" title="Transcript changed">Generate this version again before approving or sharing its updated content.</Alert> : null}
        {editable && busy !== "load" ? <fieldset className="minutes-version-form" disabled={working}>
          <legend className="sr-only">Personal MOM format</legend>
          <div className="field-row"><div className="field"><label htmlFor="version-label">Version name</label><input id="version-label" maxLength={100} value={label} onChange={(event) => { setLabel(event.target.value); setDirty(true); }} /></div>
            <UiSelect id="version-perspective" label="Perspective" value={preset} options={presets} onChange={(value) => { setPreset(value); const next = guidanceFor(value); setGuidance(next); setFocus(next.focus_fields.join(", ")); setDirty(true); }} /></div>
          <div className="field"><label htmlFor="version-guidance">Instructions for your MOM</label><textarea id="version-guidance" rows={3} maxLength={2000} value={guidance.instructions} onChange={(event) => { setGuidance({ ...guidance, instructions: event.target.value }); setDirty(true); }} placeholder="Explain architecture in depth, or focus on commercial outcomes…" /></div>
          <div className="field"><label htmlFor="version-focus">Focus fields <span className="optional">optional, separated by commas</span></label><input id="version-focus" value={focus} onChange={(event) => { setFocus(event.target.value); setDirty(true); }} /></div>
          <p className="field-hint">The AI uses the workspace&apos;s configured MOM model. Only evidenced facts are included. Another version costs a text-generation call, not a second transcription.</p>
          <div className="minutes-version-actions"><button className="button secondary sm" onClick={() => void run("save", async () => { await save(); setNotice("Version saved privately. Generate a draft when capture is complete."); })} disabled={!label.trim()}>Save version</button>
            <button className="button primary sm" onClick={() => void run("generate", async () => { const saved = dirty || !version ? await save() : version; generation.track(await minutesVersions.startJob(saved)); })} disabled={!label.trim()}>{working ? "Generating…" : content ? "Regenerate my MOM" : "Generate my MOM"}</button></div>
        </fieldset> : null}
        {content ? <VersionContent content={content} segments={segments} editable={!!editable && !working} onChange={edit} /> : null}
        {content ? <div className="minutes-version-actions">
          <button className="button secondary sm" onClick={download} disabled={dirty}><Download />Download Markdown</button>
          {editable ? <button className="button secondary sm" disabled={working || (!dirty && version?.status === "approved") || !version?.source_is_current} onClick={() => void run("approve", async () => { const saved = dirty ? await save() : version!; accept(await minutesVersions.approve(saved)); onChanged(); setNotice("Reviewed and approved. Your sharing settings now apply to this version."); })}>Approve my MOM</button> : null}
        </div> : null}
        {version?.is_mine ? <section className="minutes-version-sharing" aria-label="Share this MOM">
          <h3>Share this version</h3><p className="field-hint">Private means only you—not even admins. Recipients can read approved content, but gain no transcript access. Editing or regenerating hides it until you approve again.</p>
          <UiSelect id="version-visibility" label="Who can read" value={visibility} options={[{ value: "private", label: "Only me" }, { value: "workspace", label: "Everyone in this workspace" }, { value: "specific", label: "Specific people" }]} onChange={(value) => setVisibility(value as MinutesVersion["visibility"])} disabled={working || dirty} />
          {visibility === "specific" ? <div className="minutes-version-members" role="group" aria-label="Choose MOM recipients">{members.filter((member) => member.user_id !== version.creator_id).map((member) => <label className="check-label" key={member.user_id}><input type="checkbox" checked={userIds.includes(member.user_id)} disabled={!!busy || dirty} onChange={(event) => setUserIds((ids) => event.target.checked ? [...ids, member.user_id] : ids.filter((id) => id !== member.user_id))} />{member.display_name}<small>{member.email}</small></label>)}</div> : null}
          <button className="button secondary sm" disabled={working || dirty} onClick={() => void run("sharing", async () => { accept(await minutesVersions.share(version, visibility, userIds)); onChanged(); setNotice("Sharing saved. Only approved, current notes are visible to recipients."); })}>Save sharing</button>
          {dirty ? <p className="field-hint">Save your draft before changing sharing.</p> : null}
        </section> : null}
        {version?.is_mine ? <div className="minutes-version-danger">{confirmDelete ? <Alert tone="warning" title="Delete only this MOM version?" actions={<><button className="button secondary sm" onClick={() => setConfirmDelete(false)}>Cancel</button><button className="button secondary sm" disabled={!!busy} onClick={() => void run("delete", async () => { await minutesVersions.remove(version); onChanged(); onClose(); })}>Delete version</button></>}>The shared transcript and everyone else&apos;s MOMs stay unchanged.</Alert> : <button className="text-button" disabled={!!busy} onClick={() => setConfirmDelete(true)}>Delete my version</button>}</div> : null}
      </div>
      <div className="dialog-footer"><button className="button secondary" disabled={!!busy} onClick={close}>Close</button></div>
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>;
}

function VersionContent({ content, segments, editable, onChange }: { content: MinutesDraft; segments: TranscriptSegment[]; editable: boolean; onChange(next: MinutesDraft): void }) {
  return <section className="minutes-version-content" aria-label="MOM content">
    <h3>{editable ? "Review your draft" : content.title}</h3>
    {editable ? <><div className="field"><label htmlFor="version-title">Document title</label><input id="version-title" value={content.title} onChange={(event) => onChange({ ...content, title: event.target.value })} /></div>
      <div className="field"><label htmlFor="version-summary">Executive summary</label><textarea id="version-summary" rows={4} value={content.executive_summary} onChange={(event) => onChange({ ...content, executive_summary: event.target.value })} /></div></>
      : <div><h4>Executive summary</h4><p>{content.executive_summary}</p></div>}
    {(["discussion_points", "decisions", "open_questions"] as const).map((field) => {
      const label = { discussion_points: "Discussion points", decisions: "Decisions", open_questions: "Open questions" }[field];
      return editable ? <div className="field" key={field}><label htmlFor={`version-${field}`}>{label} <span className="optional">one per line</span></label><textarea id={`version-${field}`} rows={3} value={content[field].join("\n")} onChange={(event) => onChange({ ...content, [field]: lines(event.target.value) })} /></div>
        : <div key={field}><h4>{label}</h4><ul>{content[field].map((item, index) => <li key={index}>{item}</li>)}</ul></div>;
    })}
    {content.action_items.length ? <div><h4>Action items</h4><ol>{content.action_items.map((item, index) => <li key={index}><b>{item.description}</b>{item.owner ? ` — ${item.owner}` : ""}{item.due_date ? ` · Due ${item.due_date}` : ""}{segments.length ? <EvidenceChips ids={item.evidence_segment_ids ?? []} segments={segments} /> : null}</li>)}</ol></div> : null}
    {content.speaker_contributions?.length ? <div><h4>Who said what</h4><ul>{content.speaker_contributions.map((item, index) => <li key={index}><b>{item.speaker}</b> · {item.summary}{segments.length ? <EvidenceChips ids={item.evidence_segment_ids} segments={segments} /> : null}</li>)}</ul></div> : null}
  </section>;
}
