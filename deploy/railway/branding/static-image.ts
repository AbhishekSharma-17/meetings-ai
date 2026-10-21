/** Meetings AI deployment overlay. Still-image camera only; never handles audio. */
import { existsSync } from "node:fs";
import type { ElementHandle, Page } from "playwright";

export const STATIC_LOGO_PATH = "/app/branding/meetings-ai.y4m";
export const SILENT_INPUT_PATH = "/app/branding/silence.wav";

export function isStaticLogoEnabled(): boolean {
  return process.env.MEETINGS_AI_STATIC_LOGO_ENABLED === "true" && existsSync(STATIC_LOGO_PATH) && existsSync(SILENT_INPUT_PATH);
}

export function staticLogoBrowserArgs(args: readonly string[]): string[] {
  if (!isStaticLogoEnabled()) return [...args];
  return [
    ...args.filter(arg => !arg.startsWith("--use-file-for-fake-video-capture=")),
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${STATIC_LOGO_PATH}`,
    // Chromium otherwise supplies a synthetic test tone as its fake microphone.
    // Preserve the platform's existing mute controls; never introduce that tone.
    `--use-file-for-fake-audio-capture=${SILENT_INPUT_PATH}`,
  ];
}

type CameraAttributes = {
  label: string | null;
  checked: string | null;
  muted: string | null;
  inputChecked?: boolean;
};

/** Known state only: an unknown control is never blindly toggled. */
export function cameraIsOn(attrs: CameraAttributes): boolean | undefined {
  if (typeof attrs.inputChecked === "boolean") return attrs.inputChecked;
  if (attrs.checked === "true" || attrs.checked === "false") return attrs.checked === "true";
  if (attrs.muted === "true" || attrs.muted === "false") return attrs.muted === "false";
  const label = (attrs.label || "").toLowerCase();
  if (/\b(stop video|turn (off (your )?(camera|video)|(your )?(camera|video) off))\b/.test(label)) return true;
  if (/\b(start video|turn (on (your )?(camera|video)|(your )?(camera|video) on))\b/.test(label)) return false;
  return undefined;
}

async function state(handle: ElementHandle<Element>): Promise<boolean | undefined> {
  return cameraIsOn(await handle.evaluate(el => ({
    label: el.getAttribute("aria-label"),
    checked: el.getAttribute("aria-checked"),
    muted: el.getAttribute("data-is-muted"),
    inputChecked: el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : undefined,
  })));
}

export type StaticImageResult = "already-on" | "enabled" | "blocked" | "unknown" | "unavailable";

/** Configure the lobby once. Never override a later host camera restriction. */
export async function enableStaticImage(
  page: Page,
  selectors: readonly string[],
  log: (message: string) => void,
  click?: (handle: ElementHandle<Element>) => Promise<void>,
  timeoutMs = 5000,
): Promise<StaticImageResult> {
  let handle: ElementHandle<Element> | null = null;
  try {
    handle = await page.waitForSelector(selectors.join(", "), { state: "visible", timeout: timeoutMs });
    if (!handle) return "unavailable";
    const disabled = await handle.evaluate(el => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true");
    if (disabled) {
      log("[Meetings AI image] Camera unavailable or disabled by meeting policy; continuing capture without the image.");
      return "blocked";
    }
    const before = await state(handle);
    if (before === true) {
      log("[Meetings AI image] Still-image camera is already enabled in the lobby.");
      return "already-on";
    }
    if (before === undefined) {
      log("[Meetings AI image] Unrecognized camera control; leaving it unchanged.");
      return "unknown";
    }
    if (click) await click(handle);
    else await handle.click({ timeout: timeoutMs });
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      if (await state(handle) === true) {
        log("[Meetings AI image] Still-image camera enabled in the lobby; remote visibility depends on the meeting host.");
        return "enabled";
      }
      await page.waitForTimeout(100);
    }
    log("[Meetings AI image] Camera did not turn on; continuing without retrying or changing audio.");
    return "blocked";
  } catch {
    log("[Meetings AI image] Camera control not available; continuing capture without the image.");
    return "unavailable";
  } finally {
    await handle?.dispose().catch(() => {});
  }
}
