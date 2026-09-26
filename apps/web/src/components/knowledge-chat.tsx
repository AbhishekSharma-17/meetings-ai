"use client";

import { Fragment, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import Image from "next/image";
import { Popover } from "@base-ui/react/popover";
import { ArrowUp, Check, ChevronDown, Copy, Cpu, Library, MessagesSquare, Quote, Tag, X } from "lucide-react";
import type { AiSettingsView, KnowledgeChatResponse, KnowledgeSource } from "@/lib/types";
import { SourceCard, type OpenSource } from "./knowledge-sources";

export type Exchange = { question: string; response: KnowledgeChatResponse };
export type PendingAnswer = { question: string; raw: string; answer: string };

const SUGGESTED_PROMPTS = [
  "What decisions were made most recently?",
  "List open action items and their owners",
  "Which questions are still unresolved?",
  "Summarise how this topic evolved across meetings",
];
const CITATION_PATTERN = /\[K(\d+)\]/g;

/** Renders an answer as paragraphs and bullets, turning [K1] markers into citation chips. */
function AnswerText({ text, citations, onCite }: { text: string; citations: KnowledgeSource[]; onCite?(index: number): void }) {
  const inline = (line: string, key: string): ReactNode[] => {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const match of line.matchAll(CITATION_PATTERN)) {
      const index = Number(match[1]);
      if (match.index > last) parts.push(line.slice(last, match.index));
      parts.push(citations[index - 1] && onCite
        ? <button key={`${key}-${match.index}`} type="button" className="citation-chip" aria-label={`Show source ${index}`} onClick={() => onCite(index)}>{index}</button>
        : <sup key={`${key}-${match.index}`} className="citation-chip static">{index}</sup>);
      last = match.index + match[0].length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return parts;
  };
  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return <div className="answer-text">{blocks.map((block, blockIndex) => {
    const lines = block.split("\n");
    if (lines.every((line) => /^\s*[-*•]\s+/.test(line))) {
      return <ul key={blockIndex}>{lines.map((line, lineIndex) => <li key={lineIndex}>{inline(line.replace(/^\s*[-*•]\s+/, ""), `${blockIndex}-${lineIndex}`)}</li>)}</ul>;
    }
    return <p key={blockIndex}>{lines.map((line, lineIndex) => <Fragment key={lineIndex}>{lineIndex ? <br /> : null}{inline(line, `${blockIndex}-${lineIndex}`)}</Fragment>)}</p>;
  })}</div>;
}

function AssistantMark() {
  return <span className="assistant-mark" aria-hidden="true"><Image src="/icon.svg" width={28} height={28} alt="" /></span>;
}

export function ChatTurn({ exchange, onOpenSource }: { exchange: Exchange; onOpenSource: OpenSource }) {
  const { response } = exchange;
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const count = response.citations.length;
  const cite = (index: number) => {
    setSourcesOpen(true); setHighlight(index);
    requestAnimationFrame(() => document.getElementById(`citation-${response.citations[index - 1]?.source_id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };
  const copy = () => {
    void navigator.clipboard?.writeText(response.answer).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }).catch(() => undefined);
  };
  return <div className="chat-turn">
    <div className="chat-user"><p>{exchange.question}</p></div>
    <article className="chat-assistant" aria-label="Meetings AI answer">
      <AssistantMark />
      <div className="chat-assistant-body">
        <AnswerText text={response.answer} citations={response.citations} onCite={cite} />
        <div className="chat-answer-meta">
          {count ? <button type="button" className={sourcesOpen ? "source-toggle open" : "source-toggle"} aria-expanded={sourcesOpen} onClick={() => setSourcesOpen((value) => !value)}><Quote aria-hidden="true" />{count} source{count === 1 ? "" : "s"}<ChevronDown aria-hidden="true" /></button> : <span className="field-hint">No matching sources</span>}
          <button type="button" className="icon-button sm" aria-label={copied ? "Copied" : "Copy answer"} onClick={copy}>{copied ? <Check /> : <Copy />}</button>
          {response.model ? <span className="chat-model-label">{response.provider} · {response.model}</span> : null}
        </div>
        {sourcesOpen && count ? <div className="chat-sources">{response.citations.map((source, index) => <SourceCard key={source.source_id} source={source} index={index + 1} highlighted={highlight === index + 1} onOpenSource={onOpenSource} />)}</div> : null}
      </div>
    </article>
  </div>;
}

export function PendingTurn({ pending }: { pending: PendingAnswer }) {
  return <div className="chat-turn" aria-live="polite" aria-busy="true">
    <div className="chat-user"><p>{pending.question}</p></div>
    <article className="chat-assistant streaming" aria-label="Meetings AI is answering">
      <AssistantMark />
      <div className="chat-assistant-body">
        {pending.answer ? <div className="answer-text"><p>{pending.answer.replace(CITATION_PATTERN, "")}<span className="stream-cursor" aria-hidden="true" /></p></div>
          : <p className="thinking"><span className="thinking-dots" aria-hidden="true"><i /><i /><i /></span>Searching meeting evidence…</p>}
        <p className="field-hint">Citations appear once the answer is verified against sources.</p>
      </div>
    </article>
  </div>;
}

export function ChatWelcome({ baseName, disabled, onPrompt }: { baseName: string | null; disabled: boolean; onPrompt(prompt: string): void }) {
  return <div className="chat-welcome">
    <span className="chat-welcome-mark" aria-hidden="true"><MessagesSquare /></span>
    <h2>{baseName ? `Ask ${baseName}` : "Choose a knowledge base"}</h2>
    <p>{baseName ? "Answers are grounded in opted-in meetings and cite the exact transcript turn." : "Select a named knowledge base to start a saved chat."}</p>
    {baseName ? <div className="prompt-grid">{SUGGESTED_PROMPTS.map((prompt) => <button key={prompt} type="button" className="prompt-card" disabled={disabled} onClick={() => onPrompt(prompt)}>{prompt}</button>)}</div> : null}
  </div>;
}

export type BaseDefaultControl = { baseName: string; value: string; options: { value: string; label: string }[]; onChange(value: string): void };

/** Read-only view of the owner-chosen Ask AI model; admins can still set a per-base fallback. */
export function ChatModelInfo({ settings, onOpenProviders, baseDefault }: {
  settings: AiSettingsView | null | undefined;
  onOpenProviders?(): void;
  baseDefault?: BaseDefaultControl | null;
}) {
  const [open, setOpen] = useState(false);
  const route = settings?.effective_chat;
  const label = route?.model ?? (settings ? "No model configured" : settings === null ? "Workspace model" : "Loading…");
  const summary = settings === null ? "Answers use the model chosen by the workspace owner." : !route || route.source === "not_configured" || !route.model ? "Ask AI has no model yet. The workspace owner chooses it in AI providers."
    : `${route.model}${route.profile_name ? ` via ${route.profile_name}` : ""}${route.source === "workspace_default" ? " (workspace default)" : ""}.`;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="composer-chip knowledge-model-trigger" aria-label={`Ask AI model: ${label}`}><Cpu aria-hidden="true" /><span>{label}</span><ChevronDown aria-hidden="true" /></Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="top" align="start" sideOffset={8} className="ui-select-positioner">
        <Popover.Popup className="popover model-popover">
          <p className="menu-label">Ask AI model</p>
          <p className="model-summary">{summary}</p>
          <p className="field-hint model-summary">Set by the workspace owner for everyone, so answers stay consistent and costs predictable.</p>
          {settings?.can_edit && onOpenProviders ? <div className="model-foot"><button type="button" className="text-button" onClick={() => { setOpen(false); onOpenProviders(); }}>Change in AI providers</button></div> : null}
          {baseDefault ? <>
            <div className="menu-separator" />
            <p className="menu-label">Fallback for {baseDefault.baseName}</p>
            <p className="field-hint model-summary">Used only when no workspace chat model is set.</p>
            <div role="radiogroup" aria-label={`Default provider for ${baseDefault.baseName}`}>{baseDefault.options.map((option) => <button key={option.value || "workspace"} type="button" role="radio" aria-checked={option.value === baseDefault.value} className="menu-item" onClick={() => baseDefault.onChange(option.value)}><span className="model-provider-name">{option.label}</span>{option.value === baseDefault.value ? <Check className="model-check" aria-hidden="true" /> : null}</button>)}</div>
          </> : null}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

/** Chooses which knowledge base the next message searches, from inside the composer. */
export function BasePicker({ bases, selectedId, onSelect }: { bases: { id: string; name: string; meetings: number }[]; selectedId: string; onSelect(id: string): void }) {
  const [open, setOpen] = useState(false);
  const selected = bases.find((base) => base.id === selectedId);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="composer-chip knowledge-base-trigger" aria-label="Switch knowledge base" title={selected ? `Chatting with ${selected.name}` : undefined} disabled={!bases.length}><Library aria-hidden="true" /><span>{selected?.name ?? "Choose a knowledge base"}</span><ChevronDown aria-hidden="true" /></Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="top" align="start" sideOffset={8} className="ui-select-positioner">
        <Popover.Popup className="popover model-popover">
          <p className="menu-label">Chat with</p>
          <div role="radiogroup" aria-label="Knowledge base for this chat">{bases.map((base) => <button key={base.id} type="button" role="radio" aria-checked={base.id === selectedId} className="menu-item" onClick={() => { onSelect(base.id); setOpen(false); }}><Library /><span className="model-provider-name">{base.name}</span><small>{base.meetings} meeting{base.meetings === 1 ? "" : "s"}</small>{base.id === selectedId ? <Check className="model-check" aria-hidden="true" /> : null}</button>)}</div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

export function Composer({ value, onChange, onSubmit, busy, disabled, tags, onTags, picker, hint, basePicker }: {
  value: string;
  onChange(value: string): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  busy: boolean;
  disabled: boolean;
  tags: string;
  onTags(value: string): void;
  picker: ReactNode;
  hint: string;
  basePicker?: ReactNode;
}) {
  const [tagsOpen, setTagsOpen] = useState(tags.length > 0);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };
  return <form className="composer" onSubmit={onSubmit}>
    <div className="composer-box">
      {tagsOpen ? <div className="composer-tags"><Tag aria-hidden="true" /><label className="sr-only" htmlFor="knowledge-tags">Filter by tags</label><input id="knowledge-tags" value={tags} onChange={(event) => onTags(event.target.value)} placeholder="Only use meetings tagged… e.g. roadmap, customer research" /><button type="button" className="icon-button sm" aria-label="Remove tag filter" onClick={() => { onTags(""); setTagsOpen(false); }}><X /></button></div> : null}
      <label className="sr-only" htmlFor="knowledge-question">Message your knowledge base</label>
      <textarea id="knowledge-question" rows={1} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} minLength={3} maxLength={500} required disabled={disabled} placeholder={disabled ? "Select a knowledge base to start chatting" : "Ask about a decision, person, date or follow-up…"} />
      <div className="composer-bar">
        {basePicker}
        {picker}
        {!tagsOpen ? <button type="button" className="composer-chip" onClick={() => setTagsOpen(true)}><Tag aria-hidden="true" /><span>Tags</span></button> : null}
        <span className="composer-hint">{hint}</span>
        <button className="button primary icon composer-send" aria-label="Send" disabled={busy || disabled || value.trim().length < 3}>{busy ? <span className="spinner on-brand" aria-hidden="true" /> : <ArrowUp />}</button>
      </div>
    </div>
    <p className="composer-note">Answers can be wrong. Check cited sources before relying on names, dates or commitments.</p>
  </form>;
}
