import type { InPersonDevice } from "./in-person-types";

/** Formats in order of preference: Opus in WebM, then MP4 (iOS Safari), then whatever else records. */
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  if (typeof MediaRecorder.isTypeSupported !== "function") return "";
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

/** "audio/webm;codecs=opus" → "audio/webm". */
export const baseMime = (type: string) => type.split(";")[0].trim().toLowerCase() || "audio/webm";

type NavigatorWithHints = Navigator & { userAgentData?: { mobile?: boolean }; standalone?: boolean };

function agent(): string {
  return typeof navigator === "undefined" ? "" : navigator.userAgent;
}

/** iPhone, iPad and iPod, including iPads that report a desktop Safari user agent. */
export function isAppleMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/i.test(agent()) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isAndroid(): boolean {
  return /Android/i.test(agent());
}

/** Phones and tablets: touch devices where locking the screen or switching apps can stop a recording. */
export function isHandheld(): boolean {
  if (typeof navigator === "undefined") return false;
  const hints = (navigator as NavigatorWithHints).userAgentData;
  return Boolean(hints?.mobile) || isAppleMobile() || isAndroid() || /Mobile/i.test(agent());
}

export function deviceKind(): InPersonDevice {
  if (typeof navigator === "undefined") return "unknown";
  if (/iPhone|iPod/i.test(agent()) || (isAndroid() && /Mobile/i.test(agent())) || (navigator as NavigatorWithHints).userAgentData?.mobile) return "phone";
  if (isHandheld()) return "unknown";
  return "laptop";
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as NavigatorWithHints).standalone); }
  catch { return false; }
}

/** Why this browser cannot record at all, or null when it can. */
export function recordingUnsupported(): string | null {
  if (typeof window === "undefined") return null;
  if (!window.isSecureContext) return "Recording needs a secure connection. Open Meetings AI from its https:// address and try again.";
  if (!navigator.mediaDevices?.getUserMedia) return "This browser cannot use a microphone. Use a recent version of Chrome, Safari, Edge or Firefox.";
  if (typeof MediaRecorder === "undefined") return "This browser cannot record audio. Use a recent version of Chrome, Safari, Edge or Firefox.";
  return null;
}

function allowMicHint(): string {
  if (isAppleMobile()) return "On iPhone or iPad, open Settings → Safari → Microphone and choose Allow (or Ask), then reload this page.";
  if (isAndroid()) return "Tap the icon next to the address bar, open Permissions and allow the microphone. Also check Settings → Apps → your browser → Permissions.";
  if (/Mac OS X/i.test(agent())) return "Click the icon at the left of the address bar and allow the microphone. If it is still blocked, open System Settings → Privacy & Security → Microphone and turn it on for your browser.";
  return "Click the icon at the left of the address bar and allow the microphone. If it is still blocked, check your system's privacy settings for the microphone.";
}

/** Plain-language explanation of a getUserMedia failure. */
export function microphoneError(error: unknown): { title: string; detail: string } {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return { title: "Microphone access is blocked", detail: allowMicHint() };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return { title: "No microphone found", detail: "Connect a microphone, or choose another one, and try again." };
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return { title: "The microphone is busy", detail: "Another app may be using it, such as a video call. Close that app and try again." };
  }
  const unsupported = recordingUnsupported();
  if (unsupported) return { title: "Recording is not available here", detail: unsupported };
  return { title: "The microphone could not start", detail: "Try again. If it keeps failing, reload the page or restart the browser." };
}

export async function openMicrophone(deviceId?: string | null): Promise<MediaStream> {
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio });
}

export type Microphone = { deviceId: string; label: string };

/** Audio inputs; labels are only available after the microphone permission is granted. */
export async function listMicrophones(): Promise<Microphone[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
  return devices.filter((device) => device.kind === "audioinput" && device.deviceId)
    .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` }));
}

export function stopStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

/** Reads the input level (0–1) from a stream through an AnalyserNode. */
export class LevelMeter {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;

  constructor(stream: MediaStream) {
    try {
      const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;
      this.context = new Context();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.buffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
      this.context.createMediaStreamSource(stream).connect(this.analyser);
      void this.context.resume?.().catch(() => undefined);
    } catch { this.close(); }
  }

  read(): number {
    if (!this.analyser || !this.buffer) return 0;
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (const sample of this.buffer) sum += sample * sample;
    const rms = Math.sqrt(sum / this.buffer.length);
    // Speech sits around 0.02–0.2 RMS; a square-root curve makes quiet voices visible.
    return Math.min(1, Math.sqrt(rms * 4));
  }

  close(): void {
    void this.context?.close().catch(() => undefined);
    this.context = null; this.analyser = null; this.buffer = null;
  }
}

type WakeLockSentinelLike = { release(): Promise<void>; addEventListener?(type: "release", listener: () => void): void };
type WakeLockNavigator = Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } };

/** Keeps the screen on while recording; re-acquired when the page becomes visible again. */
export class ScreenWakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;

  get supported(): boolean { return typeof navigator !== "undefined" && Boolean((navigator as WakeLockNavigator).wakeLock); }

  async acquire(): Promise<void> {
    this.wanted = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    await this.request();
  }

  async release(): Promise<void> {
    this.wanted = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    const sentinel = this.sentinel; this.sentinel = null;
    await sentinel?.release().catch(() => undefined);
  }

  private async request() {
    const lock = (navigator as WakeLockNavigator).wakeLock;
    if (!lock || !this.wanted || this.sentinel || document.visibilityState !== "visible") return;
    try {
      this.sentinel = await lock.request("screen");
      this.sentinel.addEventListener?.("release", () => { this.sentinel = null; });
    } catch { this.sentinel = null; }
  }

  private readonly onVisibility = () => { if (document.visibilityState === "visible") void this.request(); };
}

type BatteryLike = EventTarget & { level: number; charging: boolean };

/** Calls back with true while the battery is below 15% and not charging (where the browser tells us). */
export function watchLowBattery(callback: (low: boolean) => void): () => void {
  const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> }).getBattery;
  if (typeof getBattery !== "function") return () => undefined;
  let battery: BatteryLike | null = null;
  let active = true;
  const update = () => { if (active && battery) callback(battery.level < 0.15 && !battery.charging); };
  void getBattery.call(navigator).then((value) => {
    if (!active) return;
    battery = value; update();
    battery.addEventListener("levelchange", update);
    battery.addEventListener("chargingchange", update);
  }).catch(() => undefined);
  return () => {
    active = false;
    battery?.removeEventListener("levelchange", update);
    battery?.removeEventListener("chargingchange", update);
  };
}
