"use client";

import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";

type ClearScope = "read" | "all";

const confirmCopy: Record<ClearScope, { question: string; action: string; busy: string }> = {
  read: { question: "Clear read notifications? Unread ones stay.", action: "Clear read", busy: "Clearing…" },
  all: { question: "Clear all notifications? This can’t be undone.", action: "Clear all", busy: "Clearing…" },
};

/** Footer of the notification panel: clear read or all notifications, each behind an inline confirmation. */
export function NotificationClearBar({ hasRead, onClear, audience = "all" }: { hasRead: boolean; onClear(readOnly: boolean): Promise<boolean>; audience?: "all" | "personal" | "workspace" }) {
  const [confirming, setConfirming] = useState<ClearScope | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => { if (confirming) cancelRef.current?.focus(); }, [confirming]);

  function ask(scope: ClearScope, opener: HTMLButtonElement) {
    openerRef.current = opener;
    setConfirming(scope);
  }
  function cancel() {
    setConfirming(null);
    window.requestAnimationFrame(() => openerRef.current?.focus());
  }
  async function confirm(scope: ClearScope) {
    setBusy(true);
    const cleared = await onClear(scope === "read");
    setBusy(false);
    if (cleared) setConfirming(null);
  }

  if (confirming) {
    const copy = confirmCopy[confirming];
    return <footer className="notification-panel-foot confirming" role="group" aria-label="Confirm clearing notifications">
      <p className="notification-clear-question">{copy.question}{audience !== "all" ? ` Only your ${audience} updates in this workspace will be cleared.` : ""}</p>
      <div className="button-group">
        <button ref={cancelRef} type="button" className="button secondary sm" disabled={busy} onClick={cancel}>Cancel</button>
        <button type="button" className="button danger sm" disabled={busy} onClick={() => void confirm(confirming)}>{busy ? copy.busy : copy.action}</button>
      </div>
    </footer>;
  }
  return <footer className="notification-panel-foot">
    <button type="button" className="text-button neutral" disabled={!hasRead} title={hasRead ? undefined : "No read notifications to clear"} onClick={(event) => ask("read", event.currentTarget)}>Clear read</button>
    <button type="button" className="text-button destructive" onClick={(event) => ask("all", event.currentTarget)}><Trash2 aria-hidden="true" />Clear all</button>
  </footer>;
}
