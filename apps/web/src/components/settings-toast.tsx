"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Alert, type Tone } from "./ui/feedback";

export type SettingsNotice = { text: string; tone: Tone };

const AUTO_DISMISS_MS = 6000;

/** Floating confirmation for settings screens, so feedback stays visible wherever the action was taken.
 *  Successes and info fade after a few seconds; warnings and errors stay until dismissed. */
export function SettingsToast({ notice, onDismiss }: { notice: SettingsNotice | null; onDismiss(): void }) {
  const dismissRef = useRef(onDismiss);
  useEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);
  useEffect(() => {
    if (!notice || notice.tone === "danger" || notice.tone === "warning") return;
    const timer = window.setTimeout(() => dismissRef.current(), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  if (!notice) return null;
  return <div className="settings-toast-region">
    <Alert tone={notice.tone} className="settings-toast" actions={<button type="button" className="icon-button sm" aria-label="Dismiss notice" onClick={onDismiss}><X aria-hidden="true" /></button>}>
      {notice.text}
    </Alert>
  </div>;
}
