"use client";

/**
 * Demo mode switch. This file is part of the normal bundle and stays tiny: the
 * demo API layer itself (fixtures, router, fetch patch) lives in ./demo and is
 * loaded with a dynamic import only when a visitor starts the demo.
 */
export const DEMO_FLAG_KEY = "meetings-ai:demo";
/** Which sample workspace is open, so a workspace switch (a page reload) lands in the right one. */
export const DEMO_WORKSPACE_KEY = "meetings-ai:demo:workspace";
/** Calendar accounts "connected" during the demo, so the simulated OAuth return (a reload) keeps them. */
export const DEMO_CALENDARS_KEY = "meetings-ai:demo:calendars";
/** A "Demo: …" note to show after a simulated redirect reloads the page. */
export const DEMO_PENDING_NOTICE_KEY = "meetings-ai:demo:notice";
/** Window event carrying a short "Demo: …" message for simulated outside-world actions. */
export const DEMO_NOTICE_EVENT = "meetings-ai:demo-notice";
/** Every sample organization and user id starts with this, so demo-only UI preferences can be removed on exit. */
export const DEMO_ID_PREFIX = "de300000-";

function sessionStore(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

function localStore(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function isDemoActive(): boolean {
  if (typeof window === "undefined") return false;
  try { return sessionStore()?.getItem(DEMO_FLAG_KEY) === "1"; } catch { return false; }
}

let installing: Promise<void> | null = null;

function installDemoLayer(): Promise<void> {
  installing ??= import("./demo").then((module) => module.installDemo()).catch((cause: unknown) => {
    installing = null;
    throw cause;
  });
  return installing;
}

/** Turns demo mode on and installs the in-browser sample API. */
export async function startDemo(): Promise<void> {
  try { sessionStore()?.setItem(DEMO_FLAG_KEY, "1"); } catch { /* The demo still runs for this page view. */ }
  try {
    await installDemoLayer();
  } catch (cause) {
    clearDemoStorage();
    throw cause;
  }
}

/**
 * Runs once when the app loads, before the first API call. Honours `/?demo=1`
 * and an active demo flag; returns true when the sample workspace should be used.
 */
export async function bootDemoMode(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get("demo") === "1") {
    params.delete("demo");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    await startDemo();
    return true;
  }
  if (!isDemoActive()) return false;
  await startDemo();
  return true;
}

function removeDemoKeys(storage: Storage | null) {
  if (!storage) return;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key));
    for (const key of keys) {
      if (key === DEMO_FLAG_KEY || key.startsWith(`${DEMO_FLAG_KEY}:`) || key.includes(DEMO_ID_PREFIX)) storage.removeItem(key);
    }
  } catch { /* Nothing to clean up without storage access. */ }
}

/** Removes the flag and every UI preference written for the sample organization. */
export function clearDemoStorage(): void {
  removeDemoKeys(sessionStore());
  removeDemoKeys(localStore());
}

/** Leaves the demo: clears its traces and reloads to the sign-in page. */
export function exitDemo(): void {
  clearDemoStorage();
  window.location.assign(window.location.pathname);
}
