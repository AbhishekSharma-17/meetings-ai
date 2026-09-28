"use client";

import { useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Avatar, DEFAULT_ASSISTANT_NAME, isAssistantName } from "./ui/avatar";
import type { ActionItem, TranscriptSegment } from "@/lib/types";
import { EvidenceChips, lines, type EditableDraft } from "./minutes-support";
import { FilterInput, NoMatches } from "./scroll-panel";
import { useListSearch } from "./use-list-search";
import { matchesQuery, shouldOfferSearch } from "@/lib/search";

const actionFields = (item: ActionItem) => [item.description, item.owner, item.due_date];

function ActionSearch({ id, query, onChange }: { id: string; query: string; onChange(value: string): void }) {
  return <div className="list-search-inline"><FilterInput id={id} label="Search action items" value={query} onChange={onChange} placeholder="Search action, owner or due date" /></div>;
}

function Section({ id, title, hint, count, actions, children }: { id: string; title: ReactNode; hint?: ReactNode; count?: number; actions?: ReactNode; children: ReactNode }) {
  return <div className="mom-section">
    <div className="mom-section-head">
      <div><h3 id={`${id}-heading`}>{title}{count !== undefined ? <span className="section-count">{count}</span> : null}</h3>{hint ? <p className="field-hint">{hint}</p> : null}</div>
      {actions}
    </div>
    {children}
  </div>;
}

function ListField({ id, label, value, onChange, rows }: { id: string; label: string; value: string; onChange(value: string): void; rows: number }) {
  return <div className="mom-section">
    <div className="mom-section-head"><div><h3 id={`${id}-heading`}><label htmlFor={id}>{label}</label></h3><p className="field-hint">One per line</p></div></div>
    <textarea id={id} rows={rows} value={value} onChange={(event) => onChange(event.target.value)} />
  </div>;
}

/** The editable MOM document: every field a reviewer can change before approval. */
export function MinutesEditor({ draft, segments, onChange }: { draft: EditableDraft; segments: TranscriptSegment[]; onChange(draft: EditableDraft): void }) {
  const updateAction = (index: number, patch: Partial<ActionItem>) => onChange({ ...draft, actions: draft.actions.map((entry, position) => position === index ? { ...entry, ...patch } : entry) });
  const [query, setQuery] = useState("");
  // The action being edited stays visible even if an edit stops it matching the search.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const addAction = () => { setQuery(""); onChange({ ...draft, actions: [...draft.actions, { description: "", owner: null, due_date: null, evidence_segment_ids: [] }] }); };
  const shownActions = draft.actions.map((item, index) => ({ item, index })).filter(({ item, index }) => index === activeIndex || matchesQuery(query, actionFields(item)));
  return <div className="mom-document">
    <div className="field mom-title-field">
      <label htmlFor="mom-title">Title</label>
      <input id="mom-title" value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} />
    </div>
    <div className="mom-section">
      <div className="mom-section-head"><div><h3 id="mom-summary-heading"><label htmlFor="mom-summary">Executive summary</label></h3></div></div>
      <textarea id="mom-summary" rows={4} value={draft.summary} onChange={(event) => onChange({ ...draft, summary: event.target.value })} />
    </div>
    <div className="grid-2 mom-pair">
      <ListField id="mom-discussion" label="Discussion points" rows={5} value={draft.discussion} onChange={(discussion) => onChange({ ...draft, discussion })} />
      <ListField id="mom-decisions" label="Decisions" rows={5} value={draft.decisions} onChange={(decisions) => onChange({ ...draft, decisions })} />
    </div>
    <Section id="mom-actions" title="Action items" count={draft.actions.length} hint="Only what was explicitly agreed. Every action needs transcript evidence."
      actions={<button type="button" className="button secondary sm" onClick={addAction}><Plus aria-hidden="true" /> Add action</button>}>
      {shouldOfferSearch(draft.actions.length, query) ? <ActionSearch id="mom-action-search" query={query} onChange={(value) => { setActiveIndex(null); setQuery(value); }} /> : null}
      {draft.actions.length && !shownActions.length ? <NoMatches query={query} noun="action items" onClear={() => setQuery("")} />
        : draft.actions.length ? <ol className="mom-action-list">
        {shownActions.map(({ item, index }) => <li className="mom-action" key={index} onFocus={() => setActiveIndex(index)}>
          <div className="field">
            <label htmlFor={`mom-action-${index}`}>Action</label>
            <input id={`mom-action-${index}`} value={item.description} onChange={(event) => updateAction(index, { description: event.target.value })} />
          </div>
          <div className="field-row">
            <div className="field"><label htmlFor={`mom-owner-${index}`}>Owner</label><input id={`mom-owner-${index}`} value={item.owner ?? ""} onChange={(event) => updateAction(index, { owner: event.target.value || null })} /></div>
            <div className="field"><label htmlFor={`mom-due-${index}`}>Due date</label><input id={`mom-due-${index}`} value={item.due_date ?? ""} onChange={(event) => updateAction(index, { due_date: event.target.value || null })} /></div>
          </div>
          <div className="mom-action-foot">
            <EvidenceChips ids={item.evidence_segment_ids ?? []} segments={segments} emptyLabel="No evidence linked"
              onRemove={(id) => updateAction(index, { evidence_segment_ids: (item.evidence_segment_ids ?? []).filter((evidenceId) => evidenceId !== id) })}
              onAdd={(id) => updateAction(index, { evidence_segment_ids: [...new Set([...(item.evidence_segment_ids ?? []), id])] })} addId={`mom-evidence-${index}`} />
            <button type="button" className="text-button destructive" onClick={() => { setActiveIndex(null); onChange({ ...draft, actions: draft.actions.filter((_, position) => position !== index) }); }}><Trash2 aria-hidden="true" /> Remove action</button>
          </div>
        </li>)}
      </ol> : <p className="mom-empty-line">No action items. Add one only if it was agreed in the meeting.</p>}
    </Section>
    <ListField id="mom-questions" label="Open questions" rows={3} value={draft.questions} onChange={(questions) => onChange({ ...draft, questions })} />
    <Section id="mom-attribution" title="Who said what" hint="Each claim links to evidence. If a speaker is wrong, correct the transcript and regenerate.">
      {draft.contributions.length ? <ul className="mom-claims">
        {draft.contributions.map((item, index) => <li className="mom-claim" key={`${item.speaker}-${index}`}>
          <div className="mom-claim-head"><Avatar name={item.speaker} size="sm" kind={isAssistantName(item.speaker, DEFAULT_ASSISTANT_NAME) ? "assistant" : "person"} /><b>{item.speaker}</b>
            <button type="button" className="text-button neutral" onClick={() => onChange({ ...draft, contributions: draft.contributions.filter((_, position) => position !== index) })}>Remove claim</button></div>
          <textarea aria-label={`Contribution by ${item.speaker}`} rows={2} value={item.summary} onChange={(event) => onChange({ ...draft, contributions: draft.contributions.map((entry, position) => position === index ? { ...entry, summary: event.target.value } : entry) })} />
          <EvidenceChips ids={item.evidence_segment_ids} segments={segments} />
        </li>)}
      </ul> : <p className="mom-empty-line">No named-speaker contributions were extracted.</p>}
    </Section>
    <Section id="mom-asked" title="Questions asked">
      {draft.questionsAsked.length ? <ul className="mom-claims">
        {draft.questionsAsked.map((item, index) => <li className="mom-claim" key={`${item.speaker ?? "unknown"}-${index}`}>
          <div className="mom-claim-head"><Avatar name={item.speaker} size="sm" fallback={item.speaker ? undefined : "?"} /><b>{item.speaker ?? "Unidentified speaker"}</b>
            <button type="button" className="text-button neutral" onClick={() => onChange({ ...draft, questionsAsked: draft.questionsAsked.filter((_, position) => position !== index) })}>Remove question</button></div>
          <textarea aria-label={`Question asked by ${item.speaker ?? "unidentified speaker"}`} rows={2} value={item.question} onChange={(event) => onChange({ ...draft, questionsAsked: draft.questionsAsked.map((entry, position) => position === index ? { ...entry, question: event.target.value } : entry) })} />
          <EvidenceChips ids={item.evidence_segment_ids} segments={segments} />
        </li>)}
      </ul> : <p className="mom-empty-line">No direct questions were extracted.</p>}
    </Section>
  </div>;
}

function ReadList({ items, empty }: { items: string[]; empty: string }) {
  return items.length ? <ul className="mom-read-list">{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="mom-empty-line">{empty}</p>;
}

/** Locked, read-only rendering of a delivered MOM. */
export function MinutesDocument({ draft, segments }: { draft: EditableDraft; segments: TranscriptSegment[] }) {
  const search = useListSearch(draft.actions, actionFields);
  return <div className="mom-document read-only">
    <p className="mom-read-title">{draft.title}</p>
    <Section id="mom-summary-read" title="Executive summary"><p className="mom-read-text">{draft.summary}</p></Section>
    <div className="grid-2 mom-pair">
      <Section id="mom-discussion-read" title="Discussion points"><ReadList items={lines(draft.discussion)} empty="None recorded." /></Section>
      <Section id="mom-decisions-read" title="Decisions"><ReadList items={lines(draft.decisions)} empty="None recorded." /></Section>
    </div>
    <Section id="mom-actions-read" title="Action items" count={draft.actions.length}>
      {search.offered ? <ActionSearch id="mom-action-search-read" query={search.query} onChange={search.setQuery} /> : null}
      {search.noMatches ? <NoMatches query={search.query} noun="action items" onClear={search.clear} />
        : draft.actions.length ? <ol className="mom-action-list">{search.visible.map((item) => <li className="mom-action" key={draft.actions.indexOf(item)}>
        <b>{item.description}</b>
        <div className="tag-list">{item.owner ? <span className="tag">Owner · {item.owner}</span> : null}{item.due_date ? <span className="tag">Due · {item.due_date}</span> : null}</div>
        <EvidenceChips ids={item.evidence_segment_ids ?? []} segments={segments} />
      </li>)}</ol> : <p className="mom-empty-line">No action items.</p>}
    </Section>
    <Section id="mom-questions-read" title="Open questions"><ReadList items={lines(draft.questions)} empty="None recorded." /></Section>
    {draft.contributions.length ? <Section id="mom-attribution-read" title="Who said what"><ul className="mom-claims">{draft.contributions.map((item, index) => <li className="mom-claim" key={index}>
      <div className="mom-claim-head"><Avatar name={item.speaker} size="sm" kind={isAssistantName(item.speaker, DEFAULT_ASSISTANT_NAME) ? "assistant" : "person"} /><b>{item.speaker}</b></div><p className="mom-read-text">{item.summary}</p><EvidenceChips ids={item.evidence_segment_ids} segments={segments} />
    </li>)}</ul></Section> : null}
    {draft.questionsAsked.length ? <Section id="mom-asked-read" title="Questions asked"><ul className="mom-claims">{draft.questionsAsked.map((item, index) => <li className="mom-claim" key={index}>
      <div className="mom-claim-head"><Avatar name={item.speaker} size="sm" fallback={item.speaker ? undefined : "?"} /><b>{item.speaker ?? "Unidentified speaker"}</b></div><p className="mom-read-text">{item.question}</p><EvidenceChips ids={item.evidence_segment_ids} segments={segments} />
    </li>)}</ul></Section> : null}
  </div>;
}
