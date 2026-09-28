"use client";

import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { Hash, Link2, X } from "lucide-react";

/** What a chip holds. Each kind has its own separators, validation and chip marker. */
export type ChipKind = "email" | "tag" | "url" | "text";

/** A dropdown option offered while typing (e.g. a team or a workspace member). */
export type ChipSuggestion = {
  id: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  /** Extra words the query matches besides the label, e.g. an email address. */
  keywords?: string[];
};

const LIST_SEPARATOR = /[\s,;]+/;
const PHRASE_SEPARATOR = /[,;\n]+/;
const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/;
const TAG = /^[\p{L}\p{N}_][\p{L}\p{N}_ -]*[\p{L}\p{N}_]$/u;
const MAX_SUGGESTIONS = 8;

export const isValidEmail = (value: string) => EMAIL.test(value);

export function isHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.includes(".") && !parsed.username && !parsed.password && value.length <= 500;
  } catch { return false; }
}

/** Default validation per kind. Returns a short reason, or null when the value is fine. */
export function chipProblem(kind: ChipKind, value: string, maxLength?: number): string | null {
  if (maxLength && value.length > maxLength) return `is longer than ${maxLength} characters`;
  if (kind === "email") return isValidEmail(value) ? null : "isn’t a valid email address";
  if (kind === "url") return isHttpsUrl(value) ? null : "isn’t a valid https:// link";
  if (kind === "tag") return value.length >= 2 && TAG.test(value) ? null : "needs 2+ letters or numbers (spaces, - and _ allowed)";
  return value.trim() ? null : "is empty";
}

/**
 * Splits typed or pasted text into items. Emails and links split on spaces too; tags and free
 * text keep spaces ("customer research") and split on commas, semicolons and new lines only.
 * "Name <a@b.com>" entries keep only the address.
 */
export function parseChipList(text: string, kind: ChipKind = "email"): string[] {
  if (kind === "email") text = text.replace(/[^,;\n<>]*<([^<>]+)>/g, " $1 ");
  const separator = kind === "email" || kind === "url" ? LIST_SEPARATOR : PHRASE_SEPARATOR;
  return text.split(separator).map((item) => item.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/** Case-insensitive union that keeps the first spelling of each item. */
export function mergeChips(current: string[], additions: string[]): string[] {
  const seen = new Set(current.map((item) => item.toLowerCase()));
  const next = [...current];
  for (const item of additions) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

const noun: Record<ChipKind, string> = { email: "address", tag: "tag", url: "link", text: "entry" };
const initialOf = (value: string) => value.trim().charAt(0).toUpperCase() || "?";

function ChipMarker({ kind, value }: { kind: ChipKind; value: string }) {
  if (kind === "email") return <span className="email-chip-avatar" aria-hidden="true">{initialOf(value)}</span>;
  if (kind === "url") return <span className="email-chip-avatar" aria-hidden="true"><Link2 /></span>;
  if (kind === "tag") return <span className="email-chip-avatar chip-marker-tag" aria-hidden="true"><Hash /></span>;
  return null;
}

function matches(suggestion: ChipSuggestion, query: string): boolean {
  if (!query) return true;
  const needle = query.toLocaleLowerCase();
  return [suggestion.label, ...(suggestion.keywords ?? [])].some((text) => text.toLocaleLowerCase().split(/[\s@._-]+/).concat(text.toLocaleLowerCase()).some((word) => word.startsWith(needle)));
}

export type ChipInputProps = {
  id: string;
  label: string;
  value: string[];
  onChange(next: string[]): void;
  kind?: ChipKind;
  /** When set, a hidden input submits the comma-joined list, including uncommitted text. */
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  hint?: ReactNode;
  labelSuffix?: ReactNode;
  maxItems?: number;
  maxItemLength?: number;
  /** Overrides the kind's validation. Return a short reason ("isn’t allowed") or null. */
  validate?(value: string): string | null;
  /** Chips rendered before the value chips (e.g. team chips); Backspace calls onRemoveLeading when the value is empty. */
  leading?: ReactNode;
  onRemoveLeading?(): void;
  /** Options offered while typing; picking one calls onPick instead of adding the typed text. */
  suggestions?: ChipSuggestion[];
  onPick?(suggestion: ChipSuggestion): void;
  suggestionsLabel?: string;
};

/**
 * Multi-value input where every value is a removable chip. Enter, comma or leaving the field
 * commits the text (emails and links also commit on space and Tab); pasted lists are split;
 * duplicates are ignored; invalid entries stay as danger chips so nothing typed silently disappears.
 * With `suggestions`, typing "@" or part of a name opens a listbox; ↑/↓ move, Enter picks.
 */
export function ChipInput({
  id, label, value, onChange, kind = "text", name, placeholder, disabled = false, hint, labelSuffix,
  maxItems, maxItemLength, validate, leading, onRemoveLeading, suggestions, onPick, suggestionsLabel = "Suggestions",
}: ChipInputProps) {
  const [draft, setDraft] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;
  const listId = `${baseId}-listbox`;
  const problemOf = (item: string) => validate ? validate(item) : chipProblem(kind, item, maxItemLength);
  const invalid = value.filter((item) => problemOf(item));
  const full = maxItems !== undefined && value.length >= maxItems;

  // A draft that looks like an address being typed ("pm@ex…") is not a name query.
  const typingAddress = kind === "email" && draft.indexOf("@") > 0;
  const query = draft.startsWith("@") ? draft.slice(1).trim() : draft.trim();
  const options = suggestions && !dismissed && !typingAddress && (draft.startsWith("@") || query)
    ? suggestions.filter((item) => matches(item, query)).slice(0, MAX_SUGGESTIONS) : [];
  const open = options.length > 0;
  // Enter picks the highlighted option unless the text is clearly an address.
  const activeIndex = open ? Math.min(active, options.length - 1) : -1;
  const querying = Boolean(suggestions) && (draft.startsWith("@") || (kind === "email" && !draft.includes("@")));

  // Inside a scrolling dialog the list could open under the sticky footer; bring it into view once.
  useEffect(() => {
    if (open) listRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  function exactMatch(text: string): ChipSuggestion | undefined {
    if (!suggestions || !onPick || (kind === "email" && isValidEmail(text.trim()))) return undefined;
    const wanted = text.replace(/^@/, "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
    return wanted ? suggestions.find((item) => item.label.toLocaleLowerCase() === wanted) : undefined;
  }

  function commit(text: string): boolean {
    const exact = exactMatch(text);
    if (exact) { pick(exact); return true; }
    const additions = parseChipList(text, kind);
    if (!additions.length) return false;
    const room = maxItems === undefined ? additions : additions.slice(0, Math.max(0, maxItems - value.length));
    const next = mergeChips(value, room);
    const added = next.length - value.length;
    if (added) onChange(next);
    setAnnouncement(added ? `Added ${next.slice(value.length).join(", ")}` : room.length < additions.length ? `Up to ${maxItems} ${noun[kind]}s` : "Already added");
    return true;
  }

  function pick(option: ChipSuggestion) {
    onPick?.(option);
    setDraft("");
    setActive(0);
    setAnnouncement(`Added ${option.label}`);
    inputRef.current?.focus();
  }

  function remove(item: string) {
    onChange(value.filter((entry) => entry !== item));
    setAnnouncement(`Removed ${item}`);
    inputRef.current?.focus();
  }

  function edit(item: string) {
    onChange(value.filter((entry) => entry !== item));
    setDraft(item);
    inputRef.current?.focus();
  }

  function handleChange(text: string) {
    setDismissed(false);
    setActive(0);
    // Typed or filled text that already contains separators commits every finished item.
    const separator = querying && (text.startsWith("@") || !text.includes("@")) ? PHRASE_SEPARATOR
      : kind === "email" || kind === "url" ? LIST_SEPARATOR : PHRASE_SEPARATOR;
    const parts = text.split(separator);
    if (parts.length === 1) { setDraft(text); return; }
    const rest = parts.pop() ?? "";
    commit(parts.join(","));
    setDraft(rest);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + options.length) % options.length);
      return;
    }
    if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissed(true); return; }
    if (event.key === "Enter" && open && activeIndex >= 0) { event.preventDefault(); pick(options[activeIndex]); return; }
    const spaceCommits = (kind === "email" || kind === "url") && !querying;
    if (event.key === "Enter" || event.key === "," || event.key === ";" || (event.key === " " && spaceCommits)) {
      event.preventDefault();
      if (commit(draft)) setDraft("");
      return;
    }
    // Tabbing away while a suggestion is highlighted picks it, like Enter, instead of
    // committing the half-typed search (e.g. "@Lead") as an invalid chip.
    if (event.key === "Tab" && open && activeIndex >= 0) { event.preventDefault(); pick(options[activeIndex]); return; }
    if (event.key === "Tab" && draft.trim() && (kind === "email" || kind === "url")) {
      if (commit(draft)) setDraft("");
      return;
    }
    if (event.key === "Backspace" && !draft) {
      if (value.length) { event.preventDefault(); remove(value[value.length - 1]); }
      else if (onRemoveLeading) { event.preventDefault(); onRemoveLeading(); }
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    const separator = kind === "email" || kind === "url" ? LIST_SEPARATOR : PHRASE_SEPARATOR;
    if (!separator.test(text.trim())) return;
    event.preventDefault();
    commit(`${draft}${kind === "email" || kind === "url" ? " " : ","}${text}`);
    setDraft("");
  }

  const pending = parseChipList(draft, kind).filter((item) => !(querying && item.startsWith("@")));
  const describedBy = [hint ? hintId : null, invalid.length ? errorId : null].filter(Boolean).join(" ") || undefined;
  const firstProblem = invalid.length ? problemOf(invalid[0]) : null;

  return <div className={`field email-chips-field chip-input-field${suggestions ? " has-suggestions" : ""}`}>
    <label htmlFor={id}>{label}{labelSuffix ? <> {labelSuffix}</> : null}</label>
    <div className="email-chips" data-disabled={disabled || undefined} data-invalid={invalid.length ? true : undefined} data-kind={kind}
      onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); inputRef.current?.focus(); } }}>
      {leading || value.length ? <ul className="email-chip-list" role="list">
        {leading}
        {value.map((item) => {
          const problem = problemOf(item);
          return <li key={item} className="email-chip" data-kind={kind} data-invalid={problem ? true : undefined} title={problem ? `${item} ${problem}` : item}>
            <ChipMarker kind={kind} value={item} />
            {problem
              ? <button type="button" className="email-chip-text" disabled={disabled} onClick={() => edit(item)} aria-label={`Edit ${item}`}>{item}</button>
              : <span className="email-chip-text">{kind === "url" ? item.replace(/^https:\/\/(www\.)?/, "") : item}</span>}
            <button type="button" className="email-chip-remove" disabled={disabled} onClick={() => remove(item)} aria-label={`Remove ${item}`}><X aria-hidden="true" /></button>
          </li>;
        })}
      </ul> : null}
      <input ref={inputRef} id={id} className="email-chips-input" type="text" inputMode={kind === "email" ? "email" : kind === "url" ? "url" : "text"} autoComplete="off" spellCheck={kind === "text"}
        value={draft} disabled={disabled || full} placeholder={full ? `Limit of ${maxItems} reached` : value.length ? "Add another" : placeholder}
        aria-describedby={describedBy} aria-invalid={invalid.length ? true : undefined}
        role={suggestions ? "combobox" : undefined} aria-expanded={suggestions ? open : undefined} aria-controls={suggestions ? listId : undefined}
        aria-autocomplete={suggestions ? "list" : undefined} aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        onChange={(event) => handleChange(event.target.value)} onKeyDown={handleKeyDown} onPaste={handlePaste}
        onBlur={() => {
          setDismissed(true);
          // An unfinished "@team" search stays in the field instead of becoming an invalid chip.
          if (suggestions && draft.startsWith("@") && !exactMatch(draft)) return;
          if (commit(draft)) setDraft("");
        }} onFocus={() => setDismissed(false)} />
      {suggestions ? <ul ref={listRef} id={listId} role="listbox" aria-label={suggestionsLabel} className="chip-suggestions" hidden={!open}>
        {options.map((option, index) => <li key={option.id} id={`${listId}-${index}`} role="option" aria-selected={index === activeIndex} className="chip-suggestion"
          onMouseDown={(event) => { event.preventDefault(); pick(option); }} onMouseEnter={() => setActive(index)}>
          {option.icon ? <span className="chip-suggestion-icon" aria-hidden="true">{option.icon}</span> : null}
          <span className="chip-suggestion-text"><b>{option.label}</b>{option.detail ? <small>{option.detail}</small> : null}</span>
        </li>)}
      </ul> : null}
    </div>
    {name ? <input type="hidden" name={name} value={mergeChips(value, pending).join(", ")} /> : null}
    {invalid.length ? <p id={errorId} className="inline-error email-chips-error">
      {invalid.length === 1 ? `“${invalid[0]}” ${firstProblem}.` : `${invalid.length} entries aren’t valid ${noun[kind]}s.`} Select it to edit, or remove it.
    </p> : null}
    {hint ? <p id={hintId} className="field-hint">{hint}</p> : null}
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </div>;
}
