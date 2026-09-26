"use client";

import { FormEvent, KeyboardEvent, useEffect, useState } from "react";
import { X } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { KnowledgeBase, MeetingDetail } from "@/lib/types";
import { Badge } from "./ui/feedback";
import { SwitchField } from "./ui/switch";
import { UiSelect } from "./ui-select";

const NO_BASE = "__none__";
const TAGS_MAX_LENGTH = 650;

function splitTags(value: string): string[] {
  return value.split(/[,;\n]+/).map((item) => item.trim()).filter(Boolean);
}

/** Per-meeting AI knowledge inclusion, named base and tags. */
export function MeetingKnowledgeSettings({ meeting, onSaved }: {
  meeting: MeetingDetail; onSaved(meeting: MeetingDetail): void;
}) {
  const [tags, setTags] = useState<string[]>(meeting.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [included, setIncluded] = useState(meeting.knowledgeEnabled);
  const [baseId, setBaseId] = useState(meeting.knowledgeBaseId ?? "");
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void meetingsService.listKnowledgeBases().then(setBases).catch(() => setBases([]));
  }, []);

  function commitDraft(): string[] {
    const additions = splitTags(tagDraft);
    if (!additions.length) return tags;
    const next = [...new Set([...tags, ...additions])];
    if (next.join(", ").length > TAGS_MAX_LENGTH) { setError("Tags are limited to 650 characters in total."); return tags; }
    setTags(next); setTagDraft("");
    return next;
  }

  function onTagKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") { event.preventDefault(); commitDraft(); }
    else if (event.key === "Backspace" && !tagDraft && tags.length) setTags(tags.slice(0, -1));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(null); setMessage(null);
    try {
      const updated = await meetingsService.updateMeetingKnowledge(meeting.id, commitDraft(), included, baseId || null);
      setTags(updated.tags);
      onSaved(updated);
      setMessage("Knowledge settings saved. Opt-out takes effect on the next search.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update knowledge settings.");
    } finally { setSaving(false); }
  }

  const baseOptions = [{ value: NO_BASE, label: "No named knowledge base" }, ...bases.map((base) => ({ value: base.id, label: base.name }))];
  return <section className="card" aria-labelledby="meeting-knowledge-title">
    <div className="card-header">
      <div><h2 id="meeting-knowledge-title">AI knowledge</h2></div>
      <Badge className="record-card-badge" tone={meeting.knowledgeEnabled ? "brand" : "neutral"} dot>{meeting.knowledgeEnabled ? "Included after completion" : "Not included"}</Badge>
    </div>
    <form className="card-body form-stack" onSubmit={(event) => void submit(event)}>
      <SwitchField id="meeting-knowledge-included" label="Include in AI knowledge" description="Finalized transcript and approved facts become searchable." checked={included} onChange={setIncluded} disabled={saving} />
      <UiSelect id="meeting-detail-base" label="Knowledge base" value={baseId || NO_BASE} options={baseOptions} onChange={(value) => setBaseId(value === NO_BASE ? "" : value)} disabled={saving} />
      <div className="field">
        <label htmlFor="meeting-detail-tags">Tags</label>
        <div className="record-tag-input">
          {tags.map((tag) => <span className="tag" key={tag}>#{tag}<button type="button" className="record-tag-remove" aria-label={`Remove tag ${tag}`} onClick={() => setTags(tags.filter((item) => item !== tag))} disabled={saving}><X aria-hidden="true" /></button></span>)}
          <input id="meeting-detail-tags" value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} onKeyDown={onTagKey} onBlur={() => void commitDraft()} placeholder={tags.length ? "Add tag" : "Add tags, press Enter"} maxLength={TAGS_MAX_LENGTH} disabled={saving} />
        </div>
      </div>
      <p className="field-hint">Opting out removes the meeting from new searches and answers at once. Earlier answers are not recalled.</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {message ? <p className="form-success" role="status">{message}</p> : null}
      <div><button className="button secondary sm" disabled={saving}>{saving ? "Saving…" : "Save knowledge settings"}</button></div>
    </form>
  </section>;
}
