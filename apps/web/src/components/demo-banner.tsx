"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { FlaskConical, Info, LogOut, Minimize2, X } from "lucide-react";
import { DEMO_NOTICE_EVENT, DEMO_PENDING_NOTICE_KEY, exitDemo } from "@/lib/demo-mode";

const COMPACT_KEY = "meetings-ai:demo:banner";
const COMPACT_EVENT = "meetings-ai:demo-banner";
const NOTICE_MS = 6_500;

function readCompact(): boolean {
  try { return window.sessionStorage.getItem(COMPACT_KEY) === "compact"; } catch { return false; }
}

function subscribe(onChange: () => void) {
  window.addEventListener(COMPACT_EVENT, onChange);
  return () => window.removeEventListener(COMPACT_EVENT, onChange);
}

function setCompact(compact: boolean) {
  try { window.sessionStorage.setItem(COMPACT_KEY, compact ? "compact" : "full"); } catch { /* Still switches for this page view. */ }
  window.dispatchEvent(new Event(COMPACT_EVENT));
}

/** Whether the demo banner is minimised to the top-bar pill (per tab, cleared when the demo ends). */
function useCompact(): boolean {
  return useSyncExternalStore(subscribe, readCompact, () => false);
}

/** Full-width strip at the top of the main panel. Minimising moves it into the top bar; it never disappears. */
export function DemoBanner() {
  const compact = useCompact();
  return <>
    {compact ? null : <div className="demo-banner" role="region" aria-label="Demo mode">
      <span className="demo-banner-icon" aria-hidden="true"><FlaskConical /></span>
      <p className="demo-banner-copy"><b>Demo workspace</b><span className="demo-banner-detail"> — sample data, nothing is saved</span></p>
      <div className="demo-banner-actions">
        <button type="button" className="button secondary sm" onClick={exitDemo}><LogOut aria-hidden="true" />Exit demo</button>
        <button type="button" className="icon-button demo-banner-minimise" aria-label="Minimise demo banner" title="Minimise" onClick={() => setCompact(true)}><Minimize2 aria-hidden="true" /></button>
      </div>
    </div>}
    <DemoNotices />
  </>;
}

/** Compact form shown in the top bar once the banner is minimised. */
export function DemoPill() {
  const compact = useCompact();
  if (!compact) return null;
  return <span className="demo-pill" role="group" aria-label="Demo mode">
    <button type="button" className="demo-pill-label" onClick={() => setCompact(false)} title="Sample data, nothing is saved. Show details."><FlaskConical aria-hidden="true" />Demo</button>
    <button type="button" className="demo-pill-exit" onClick={exitDemo}>Exit demo</button>
  </span>;
}

function takePendingNotice(): string | null {
  try {
    const raw = window.sessionStorage.getItem(DEMO_PENDING_NOTICE_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(DEMO_PENDING_NOTICE_KEY);
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : null;
  } catch { return null; }
}

/** "Demo: …" notes for actions that would reach the outside world in a real workspace. */
function DemoNotices() {
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const show = useCallback((text: string) => setNotice({ id: Date.now(), text }), []);

  useEffect(() => {
    const pending = takePendingNotice();
    if (pending) queueMicrotask(() => show(pending));
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (typeof detail === "string" && detail) show(detail);
    };
    window.addEventListener(DEMO_NOTICE_EVENT, listener);
    return () => window.removeEventListener(DEMO_NOTICE_EVENT, listener);
  }, [show]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice((current) => current?.id === notice.id ? null : current), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return <div className="demo-notice-region" role="status" aria-live="polite">
    {notice ? <div key={notice.id} className="demo-notice">
      <Info aria-hidden="true" />
      <p>{notice.text}</p>
      <button type="button" className="icon-button" aria-label="Dismiss note" onClick={() => setNotice(null)}><X aria-hidden="true" /></button>
    </div> : null}
  </div>;
}
