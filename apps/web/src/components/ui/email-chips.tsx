"use client";

import type { ReactNode } from "react";
import { ChipInput, isValidEmail, mergeChips, parseChipList, type ChipSuggestion } from "./chip-input";

export { isValidEmail };

/** Splits pasted or typed text into addresses. "Name <a@b.com>" entries keep only the address. */
export function parseEmailList(text: string): string[] {
  return parseChipList(text, "email");
}

/** Case-insensitive union that keeps the first spelling of each address. */
export const mergeEmails = mergeChips;

const initialOf = (value: string) => value.trim().charAt(0).toUpperCase() || "?";

/**
 * Multi-address input: every address is a removable chip. Typing then Enter, comma, space, Tab or
 * leaving the field commits it; pasted lists are split; duplicates are ignored; invalid entries are
 * kept as danger chips so nothing the user typed silently disappears.
 * When `name` is set, a hidden input submits the comma-joined list (including uncommitted text).
 * A thin email-kind wrapper over ChipInput; `leading`/`suggestions` add team chips and a picker.
 */
export function EmailChips({ id, label, value, onChange, name, placeholder = "name@company.com", disabled = false, hint, labelSuffix, leading, onRemoveLeading, suggestions, onPick, suggestionsLabel }: {
  id: string;
  label: string;
  value: string[];
  onChange(next: string[]): void;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  hint?: ReactNode;
  labelSuffix?: ReactNode;
  leading?: ReactNode;
  onRemoveLeading?(): void;
  suggestions?: ChipSuggestion[];
  onPick?(suggestion: ChipSuggestion): void;
  suggestionsLabel?: string;
}) {
  return <ChipInput kind="email" id={id} label={label} value={value} onChange={onChange} name={name} placeholder={placeholder}
    disabled={disabled} hint={hint} labelSuffix={labelSuffix} leading={leading} onRemoveLeading={onRemoveLeading}
    suggestions={suggestions} onPick={onPick} suggestionsLabel={suggestionsLabel} />;
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
