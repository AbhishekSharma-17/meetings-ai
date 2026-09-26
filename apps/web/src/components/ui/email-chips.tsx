"use client";

import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";

const SEPARATOR = /[\s,;]+/;
const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/;
/** Keys that turn the typed text into a chip. Tab commits but still moves focus. */
const COMMIT_KEYS = new Set(["Enter", ",", ";", " "]);

export const isValidEmail = (value: string) => EMAIL.test(value);

/** Splits pasted or typed text into addresses. "Name <a@b.com>" entries keep only the address. */
export function parseEmailList(text: string): string[] {
  return text.replace(/[^,;\n<>]*<([^<>]+)>/g, " $1 ").split(SEPARATOR).map((item) => item.trim()).filter(Boolean);
}

/** Case-insensitive union that keeps the first spelling of each address. */
export function mergeEmails(current: string[], additions: string[]): string[] {
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

const initialOf = (value: string) => value.trim().charAt(0).toUpperCase() || "?";

/**
 * Multi-address input: every address is a removable chip. Typing then Enter, comma, space, Tab or
 * leaving the field commits it; pasted lists are split; duplicates are ignored; invalid entries are
 * kept as danger chips so nothing the user typed silently disappears.
 * When `name` is set, a hidden input submits the comma-joined list (including uncommitted text).
 */
export function EmailChips({ id, label, value, onChange, name, placeholder = "name@company.com", disabled = false, hint, labelSuffix }: {
  id: string;
  label: string;
  value: string[];
  onChange(next: string[]): void;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  hint?: ReactNode;
  labelSuffix?: ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;
  const invalid = value.filter((item) => !isValidEmail(item));

  function commit(text: string): boolean {
    const additions = parseEmailList(text);
    if (!additions.length) return false;
    const next = mergeEmails(value, additions);
    const added = next.length - value.length;
    if (added) onChange(next);
    setAnnouncement(added ? `Added ${next.slice(value.length).join(", ")}` : "Already added");
    return true;
  }

  function remove(email: string) {
    onChange(value.filter((item) => item !== email));
    setAnnouncement(`Removed ${email}`);
    inputRef.current?.focus();
  }

  function edit(email: string) {
    onChange(value.filter((item) => item !== email));
    setDraft(email);
    inputRef.current?.focus();
  }

  function handleChange(text: string) {
    // Typed or filled text that already contains separators commits every finished address.
    const parts = text.split(SEPARATOR);
    if (parts.length === 1) { setDraft(text); return; }
    const rest = parts.pop() ?? "";
    commit(parts.join(","));
    setDraft(rest);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (COMMIT_KEYS.has(event.key)) {
      event.preventDefault();
      if (commit(draft)) setDraft("");
      return;
    }
    if (event.key === "Tab" && draft.trim()) {
      if (commit(draft)) setDraft("");
      return;
    }
    if (event.key === "Backspace" && !draft && value.length) {
      event.preventDefault();
      remove(value[value.length - 1]);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    if (!SEPARATOR.test(text.trim())) return;
    event.preventDefault();
    commit(`${draft} ${text}`);
    setDraft("");
  }

  const pending = parseEmailList(draft);
  const describedBy = [hint ? hintId : null, invalid.length ? errorId : null].filter(Boolean).join(" ") || undefined;

  return <div className="field email-chips-field">
    <label htmlFor={id}>{label}{labelSuffix ? <> {labelSuffix}</> : null}</label>
    <div className="email-chips" data-disabled={disabled || undefined} data-invalid={invalid.length ? true : undefined}
      onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); inputRef.current?.focus(); } }}>
      {value.length ? <ul className="email-chip-list" role="list">
        {value.map((email) => {
          const valid = isValidEmail(email);
          return <li key={email} className="email-chip" data-invalid={valid ? undefined : true} title={valid ? email : `${email} is not a valid email address`}>
            <span className="email-chip-avatar" aria-hidden="true">{initialOf(email)}</span>
            {valid
              ? <span className="email-chip-text">{email}</span>
              : <button type="button" className="email-chip-text" disabled={disabled} onClick={() => edit(email)} aria-label={`Edit ${email}`}>{email}</button>}
            <button type="button" className="email-chip-remove" disabled={disabled} onClick={() => remove(email)} aria-label={`Remove ${email}`}><X aria-hidden="true" /></button>
          </li>;
        })}
      </ul> : null}
      <input ref={inputRef} id={id} className="email-chips-input" type="text" inputMode="email" autoComplete="off" spellCheck={false}
        value={draft} disabled={disabled} placeholder={value.length ? "Add another" : placeholder}
        aria-describedby={describedBy} aria-invalid={invalid.length ? true : undefined}
        onChange={(event) => handleChange(event.target.value)} onKeyDown={handleKeyDown} onPaste={handlePaste}
        onBlur={() => { if (commit(draft)) setDraft(""); }} />
    </div>
    {name ? <input type="hidden" name={name} value={mergeEmails(value, pending).join(", ")} /> : null}
    {invalid.length ? <p id={errorId} className="inline-error email-chips-error">
      {invalid.length === 1 ? `“${invalid[0]}” isn’t a valid email address.` : `${invalid.length} entries aren’t valid email addresses.`} Select it to edit, or remove it.
    </p> : null}
    {hint ? <p id={hintId} className="field-hint">{hint}</p> : null}
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
  </div>;
}

/** Read-only people chips, e.g. calendar invitees. Shows the name when known and the address beside it. */
export function PersonChips({ people, className = "", label }: { people: Array<{ name?: string | null; email?: string | null }>; className?: string; label?: string }) {
  if (!people.length) return null;
  return <ul className={`email-chip-list readonly ${className}`.trim()} aria-label={label}>
    {people.map((person, index) => {
      const primary = person.name?.trim() || person.email?.trim() || "Unknown";
      const secondary = person.name?.trim() && person.email ? person.email : null;
      return <li key={`${person.email ?? primary}-${index}`} className="email-chip readonly" title={secondary ? `${primary} · ${secondary}` : primary}>
        <span className="email-chip-avatar" aria-hidden="true">{initialOf(primary)}</span>
        <span className="email-chip-text">{primary}{secondary ? <small>{secondary}</small> : null}</span>
      </li>;
    })}
  </ul>;
}
