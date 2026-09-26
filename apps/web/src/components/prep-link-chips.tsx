"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Link2, X } from "lucide-react";

export const MAX_PREP_LINKS = 12;

export function isHttpsLink(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.includes(".") && !parsed.username && !parsed.password && value.length <= 500;
  } catch { return false; }
}

/** Reference links as removable chips (HTTPS only, up to 12). Reuses the shared chip primitives. */
export function PrepLinkChips({ id, value, onChange, disabled = false }: {
  id: string; value: string[]; onChange(next: string[]): void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const full = value.length >= MAX_PREP_LINKS;

  function commit(text: string): void {
    const candidates = text.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
    if (!candidates.length) return;
    const invalid = candidates.filter((item) => !isHttpsLink(item));
    const next = [...value];
    for (const item of candidates) if (isHttpsLink(item) && !next.includes(item) && next.length < MAX_PREP_LINKS) next.push(item);
    if (next.length !== value.length) onChange(next);
    setProblem(invalid.length ? `“${invalid[0]}” isn’t a valid https:// link.` : candidates.length + value.length > MAX_PREP_LINKS && next.length === MAX_PREP_LINKS ? `Up to ${MAX_PREP_LINKS} links.` : null);
    setDraft(invalid.join(" "));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === "," || event.key === " ") { event.preventDefault(); commit(draft); }
    if (event.key === "Backspace" && !draft && value.length) { event.preventDefault(); onChange(value.slice(0, -1)); }
  }

  return <div className="field">
    <label htmlFor={id}>Reference links <span className="optional">{value.length}/{MAX_PREP_LINKS}</span></label>
    <div className="email-chips prep-link-chips" data-disabled={disabled || undefined} data-invalid={problem ? true : undefined}
      onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); inputRef.current?.focus(); } }}>
      {value.length ? <ul className="email-chip-list" role="list">
        {value.map((link) => <li key={link} className="email-chip" title={link}>
          <span className="email-chip-avatar" aria-hidden="true"><Link2 /></span>
          <span className="email-chip-text">{link.replace(/^https:\/\/(www\.)?/, "")}</span>
          <button type="button" className="email-chip-remove" disabled={disabled} onClick={() => { onChange(value.filter((item) => item !== link)); inputRef.current?.focus(); }} aria-label={`Remove ${link}`}><X aria-hidden="true" /></button>
        </li>)}
      </ul> : null}
      <input ref={inputRef} id={id} className="email-chips-input" type="url" inputMode="url" autoComplete="off" spellCheck={false}
        value={draft} disabled={disabled || full} placeholder={full ? "Link limit reached" : value.length ? "Add another link" : "https://company.com/press, https://…"}
        aria-invalid={problem ? true : undefined} aria-describedby={`${id}-hint`}
        onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown}
        onPaste={(event) => { event.preventDefault(); commit(`${draft} ${event.clipboardData.getData("text")}`); }}
        onBlur={() => commit(draft)} />
    </div>
    {problem ? <p className="inline-error" role="alert">{problem}</p> : null}
    <p id={`${id}-hint`} className="field-hint">Press, product or partner pages worth reading. Public https links only.</p>
  </div>;
}
