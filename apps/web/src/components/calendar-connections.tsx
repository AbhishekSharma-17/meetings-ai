"use client";

import { useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Plus, X } from "lucide-react";
import type { CalendarConnection } from "@/lib/types";
import { CalendarBrandIcon } from "./brand-icons";
import { calendarProviderHints, calendarProviderNames, calendarProviders, type CalendarProvider } from "./calendar-providers";
import { Badge } from "./ui/feedback";

/** Connection status as a sentence-case word: ACTIVE → Connected, EXPIRED → Expired. */
export function connectionStatusLabel(status: string): string {
  if (status === "ACTIVE") return "Connected";
  const lower = status.replaceAll("_", " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** The four meeting sources as cards: connect, or add another account of the same kind. */
export function ProviderGrid({ activeConnections, disabled, onConnect }: {
  activeConnections: CalendarConnection[];
  disabled: boolean;
  onConnect(provider: CalendarProvider): void;
}) {
  return <div className="calendar-provider-grid">
    {calendarProviders.map((provider) => {
      const count = activeConnections.filter((item) => item.provider === provider).length;
      const name = calendarProviderNames[provider];
      return <article key={provider} className={count ? "card calendar-provider-card connected" : "card calendar-provider-card"}>
        <CalendarBrandIcon provider={provider} size="lg" />
        <div className="calendar-provider-copy">
          <b>{name}</b>
          <small>{count ? `${count} account${count === 1 ? "" : "s"} connected` : calendarProviderHints[provider]}</small>
        </div>
        <div className="calendar-provider-action">
          {count
            ? <><Badge tone="success" dot>Connected</Badge><button type="button" className="button secondary icon sm" aria-label={`Add another ${name} account`} title={`Add another ${name} account`} disabled={disabled} onClick={() => onConnect(provider)}><Plus aria-hidden="true" /></button></>
            : <button type="button" className="button secondary sm" disabled={disabled} onClick={() => onConnect(provider)}>Connect account</button>}
        </div>
      </article>;
    })}
  </div>;
}

/** Optional alias step before the provider's consent screen. */
export function CalendarAliasDialog({ provider, busy, onCancel, onSubmit }: {
  provider: CalendarProvider | null;
  busy: boolean;
  onCancel(): void;
  onSubmit(alias: string): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [alias, setAlias] = useState("");
  const [shownFor, setShownFor] = useState(provider);
  if (shownFor !== provider) { setShownFor(provider); setAlias(""); }
  const providerName = provider ? calendarProviderNames[provider] : "";
  return <Dialog.Root open={provider !== null} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="dialog calendar-alias-dialog" initialFocus={inputRef}>
        <Dialog.Close className="close-button" aria-label="Close" disabled={busy}><X aria-hidden="true" /></Dialog.Close>
        <div className="calendar-alias-title">
          {provider ? <CalendarBrandIcon provider={provider} size="lg" /> : null}
          <div>
            <Dialog.Title className="dialog-title">Name this {providerName} connection</Dialog.Title>
            <Dialog.Description className="dialog-intro">Optional. A name like “Work” or “Client A” helps tell accounts apart. You can change it later.</Dialog.Description>
          </div>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); onSubmit(alias.trim()); }}>
          <div className="dialog-body">
            <div className="field">
              <label htmlFor="new-calendar-alias">Connection name</label>
              <input ref={inputRef} id="new-calendar-alias" value={alias} maxLength={80} placeholder="e.g. Work calendar" onChange={(event) => setAlias(event.target.value)} />
              <p className="field-hint">The account’s email stays visible next to this name.</p>
            </div>
          </div>
          <div className="dialog-footer">
            <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>Cancel</button>
            <button type="submit" className="button primary" disabled={busy}>{busy ? "Connecting…" : "Continue to provider"}</button>
          </div>
        </form>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** One connected account: icon, name, identity, and optional trailing content or actions. */
export function AccountRow({ connection, meta, actions, children }: {
  connection: CalendarConnection;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const providerName = calendarProviderNames[connection.provider];
  const identity = connection.identity && connection.identity !== connection.label ? connection.identity : null;
  return <li className="calendar-account-row">
    <div className="calendar-account-main">
      <CalendarBrandIcon provider={connection.provider} size="sm" />
      <div className="calendar-account-copy">
        <b>{connection.label}</b>
        <small>{identity ? `${providerName} · ${identity}` : providerName}</small>
      </div>
      {meta ? <div className="calendar-account-meta">{meta}</div> : null}
      {actions ? <div className="calendar-account-actions">{actions}</div> : null}
    </div>
    {children}
  </li>;
}
