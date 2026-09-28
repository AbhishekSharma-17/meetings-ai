"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isDemoActive } from "@/lib/demo-mode";
import { meetingsService } from "@/lib/meetings-service";
import { CALENDAR_OAUTH_CHANNEL, CALENDAR_OAUTH_FEATURES, CALENDAR_OAUTH_WINDOW, isCalendarOAuthResult, readCalendarOAuthResult, type CalendarOAuthResult } from "@/lib/calendar-oauth";
import type { CalendarConnection } from "@/lib/types";
import { calendarProviderNames, type CalendarProvider } from "./calendar-providers";

const POLL_INTERVAL_MS = 3_000;
const POLL_WINDOW_MS = 2 * 60_000;
const DEMO_CONSENT_MS = 1_400;

export type CalendarConnectWait = { provider: CalendarProvider; url: string | null; timedOut: boolean; demo: boolean };

type Attempt = {
  id: number;
  provider: CalendarProvider;
  known: Set<string>;
  popup: Window | null;
  cleanup: Array<() => void>;
};

/**
 * Connects a calendar in a new tab. The consent tab reports back via postMessage
 * (or a same-origin BroadcastChannel); the account list is also polled, so the
 * flow finishes even when neither message arrives. When the browser blocks the
 * new tab, the classic same-tab redirect is used instead.
 *
 * `start` must be called synchronously from the click/submit handler so the
 * browser treats the new tab as user-initiated.
 */
export function useCalendarConnect({ onConnected, onError, onRedirect }: {
  /** The refreshed account list and the new account, when it can be identified. */
  onConnected(connections: CalendarConnection[], connectionId: string | null, provider: CalendarProvider): void;
  onError(message: string): void;
  /** Popup blocked: the page is about to navigate to the provider (same-tab flow). */
  onRedirect?(): void;
}) {
  const [wait, setWait] = useState<CalendarConnectWait | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const nextId = useRef(0);
  const callbacks = useRef({ onConnected, onError, onRedirect });
  useEffect(() => { callbacks.current = { onConnected, onError, onRedirect }; }, [onConnected, onError, onRedirect]);

  const stop = useCallback((closePopup: boolean) => {
    const current = attempt.current;
    if (!current) return;
    attempt.current = null;
    for (const release of current.cleanup) release();
    if (closePopup && current.popup && !current.popup.closed) {
      try { current.popup.close(); } catch { /* Browser policy may keep it open. */ }
    }
    setWait(null);
  }, []);

  useEffect(() => () => stop(false), [stop]);

  const finish = useCallback(async (id: number, result: CalendarOAuthResult, listed?: CalendarConnection[]) => {
    const current = attempt.current;
    if (!current || current.id !== id) return;
    const { provider, known } = current;
    stop(false);
    const name = calendarProviderNames[provider];
    if (result.status !== "success") {
      callbacks.current.onError(`${name} didn't finish connecting${result.detail ? ` (${result.detail})` : ""}. Nothing was changed; try again when you're ready.`);
      return;
    }
    try {
      const connections = listed ?? await meetingsService.listCalendarConnections();
      const active = connections.filter((item) => item.status === "ACTIVE");
      const connectionId = active.find((item) => item.id === result.connectedAccountId)?.id
        ?? active.find((item) => !known.has(item.id) && item.provider === provider)?.id
        ?? active.find((item) => !known.has(item.id))?.id ?? null;
      callbacks.current.onConnected(connections, connectionId, provider);
    } catch (cause) {
      callbacks.current.onError(cause instanceof Error ? cause.message : `${name} connected, but the account list could not be refreshed.`);
    }
  }, [stop]);

  const check = useCallback(async (id: number) => {
    const current = attempt.current;
    if (!current || current.id !== id) return;
    try {
      const connections = await meetingsService.listCalendarConnections();
      const added = connections.find((item) => item.status === "ACTIVE" && !current.known.has(item.id));
      if (added) void finish(id, { type: "meetings-ai:calendar-connect", status: "success", connectedAccountId: added.id, detail: null }, connections);
    } catch { /* The next poll or the tab's message will try again. */ }
  }, [finish]);

  const listen = useCallback((current: Attempt) => {
    const receive = (data: unknown) => { if (isCalendarOAuthResult(data)) void finish(current.id, data); };
    const onMessage = (event: MessageEvent) => { if (event.origin === window.location.origin) receive(event.data); };
    window.addEventListener("message", onMessage);
    current.cleanup.push(() => window.removeEventListener("message", onMessage));
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(CALENDAR_OAUTH_CHANNEL);
      channel.onmessage = (event) => receive(event.data);
      current.cleanup.push(() => channel.close());
    }
    const onFocus = () => void check(current.id);
    window.addEventListener("focus", onFocus);
    current.cleanup.push(() => window.removeEventListener("focus", onFocus));
  }, [check, finish]);

  /** Fallback for a lost message: poll the account list for a while. */
  const poll = useCallback((current: Attempt) => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt >= POLL_WINDOW_MS) {
        window.clearInterval(timer);
        setWait((state) => state ? { ...state, timedOut: true } : state);
        return;
      }
      void check(current.id);
    }, POLL_INTERVAL_MS);
    current.cleanup.push(() => window.clearInterval(timer));
  }, [check]);

  const start = useCallback((provider: CalendarProvider, alias: string, knownIds: string[]) => {
    stop(true);
    const id = ++nextId.current;
    const demo = isDemoActive();
    const popup = demo ? null : window.open("about:blank", CALENDAR_OAUTH_WINDOW, CALENDAR_OAUTH_FEATURES);
    if (!demo && !popup) {
      callbacks.current.onRedirect?.();
      void meetingsService.connectCalendar(provider, alias)
        .then((url) => window.location.assign(url))
        .catch((cause) => callbacks.current.onError(cause instanceof Error ? cause.message : "Could not connect this account."));
      return;
    }
    if (popup) showOpening(popup, calendarProviderNames[provider]);
    const current: Attempt = { id, provider, known: new Set(knownIds), popup, cleanup: [] };
    attempt.current = current;
    setWait({ provider, url: null, timedOut: false, demo });
    if (!demo) { listen(current); poll(current); }
    void meetingsService.connectCalendar(provider, alias, { popup: true }).then((url) => {
      if (attempt.current?.id !== id) return;
      if (demo) {
        // The sample workspace simulates consent, then takes the same success path.
        const timer = window.setTimeout(() => void finish(id, readCalendarOAuthResult(new URL(url, window.location.href).search)), DEMO_CONSENT_MS);
        current.cleanup.push(() => window.clearTimeout(timer));
        return;
      }
      if (popup && !popup.closed) popup.location.href = url;
      setWait((state) => state ? { ...state, url } : state);
    }).catch((cause) => {
      if (attempt.current?.id !== id) return;
      stop(true);
      callbacks.current.onError(cause instanceof Error ? cause.message : "Could not connect this account.");
    });
  }, [finish, listen, poll, stop]);

  /** Re-opens the consent tab; must run inside a click handler. */
  const reopen = useCallback(() => {
    const current = attempt.current;
    if (!current || !wait?.url) return;
    const popup = window.open(wait.url, CALENDAR_OAUTH_WINDOW, CALENDAR_OAUTH_FEATURES);
    if (!popup) { window.location.assign(wait.url); return; }
    current.popup = popup;
    if (wait.timedOut) poll(current);
    setWait((state) => state ? { ...state, timedOut: false } : state);
  }, [poll, wait]);

  const recheck = useCallback(() => { if (attempt.current) void check(attempt.current.id); }, [check]);
  const cancel = useCallback(() => stop(true), [stop]);

  return { wait, start, reopen, recheck, cancel };
}

/** A same-origin blank tab can show a short note while the consent link is prepared. */
function showOpening(popup: Window, providerName: string) {
  try {
    const doc = popup.document;
    doc.title = `Connecting ${providerName}…`;
    const note = doc.createElement("p");
    note.textContent = `Opening ${providerName} sign-in…`;
    note.style.font = "14px system-ui, sans-serif";
    note.style.margin = "40px auto";
    note.style.textAlign = "center";
    doc.body.replaceChildren(note);
  } catch { /* Purely cosmetic. */ }
}
