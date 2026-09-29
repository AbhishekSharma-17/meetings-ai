/**
 * "Add to home screen": Chrome on Android fires beforeinstallprompt once, early. It is captured
 * here (this module loads with the app) so the recorder's setup screen can offer Install app.
 */
type InstallPromptEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const DISMISSED_KEY = "meetings-ai:install-hint-dismissed";
let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    for (const listener of listeners) listener();
  });
  window.addEventListener("appinstalled", () => { deferred = null; for (const listener of listeners) listener(); });
}

export function canPromptInstall(): boolean { return deferred !== null; }

export function onInstallAvailabilityChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Shows the browser's install dialog; true when the person installed the app. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null;
  await event.prompt();
  const choice = await event.userChoice.catch(() => ({ outcome: "dismissed" as const }));
  for (const listener of listeners) listener();
  return choice.outcome === "accepted";
}

export function installHintDismissed(): boolean {
  try { return window.localStorage.getItem(DISMISSED_KEY) === "1"; } catch { return false; }
}

export function dismissInstallHint(): void {
  try { window.localStorage.setItem(DISMISSED_KEY, "1"); } catch { /* The hint simply shows again next time. */ }
}
