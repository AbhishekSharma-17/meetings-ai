"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, RefreshCw } from "lucide-react";
import { LevelMeter, listMicrophones, microphoneError, openMicrophone, recordingUnsupported, stopStream, type Microphone } from "@/lib/in-person-media";
import { UiSelect } from "./ui-select";
import { Alert } from "./ui/feedback";
import { useLevel } from "./use-in-person";
import { InPersonLevel } from "./in-person-level";

type MicStatus = "idle" | "requesting" | "ready" | "error";
export type MicProblem = { title: string; detail: string };

/** Microphone permission, device choice and a live level preview for the setup screen. */
export function useMicrophoneCheck() {
  const [status, setStatus] = useState<MicStatus>("idle");
  const [problem, setProblem] = useState<MicProblem | null>(null);
  const [devices, setDevices] = useState<Microphone[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const stream = useRef<MediaStream | null>(null);
  const meter = useRef<LevelMeter | null>(null);
  // Bumped on every request and on unmount: a microphone that opens after that is closed, never adopted.
  const attempt = useRef(0);

  const release = useCallback(() => {
    meter.current?.close(); meter.current = null;
    stopStream(stream.current); stream.current = null;
  }, []);

  useEffect(() => () => { attempt.current += 1; release(); }, [release]);

  const request = useCallback(async (nextDeviceId?: string): Promise<MediaStream | null> => {
    const unsupported = recordingUnsupported();
    if (unsupported) { setProblem({ title: "Recording is not available here", detail: unsupported }); setStatus("error"); return null; }
    release();
    const mine = ++attempt.current;
    setStatus("requesting"); setProblem(null);
    try {
      const next = await openMicrophone(nextDeviceId || null);
      if (mine !== attempt.current) { stopStream(next); return null; }  // closed or superseded while the prompt was up
      stream.current = next;
      meter.current = new LevelMeter(next);
      const found = await listMicrophones();
      const active = next.getAudioTracks()[0]?.getSettings().deviceId;
      setDevices(found);
      setDeviceId(nextDeviceId || active || found[0]?.deviceId || "");
      setStatus("ready");
      return next;
    } catch (cause) {
      setProblem(microphoneError(cause));
      setStatus("error");
      return null;
    }
  }, [release]);

  /** Hands the open stream to the recorder; the check no longer owns (or stops) it. */
  const take = useCallback((): MediaStream | null => {
    const current = stream.current;
    meter.current?.close(); meter.current = null;
    stream.current = null;
    if (current) setStatus("idle");
    return current;
  }, []);

  const readLevel = useCallback(() => meter.current?.read() ?? 0, []);
  const level = useLevel(readLevel, status === "ready");
  const choose = useCallback((id: string) => { setDeviceId(id); void request(id); }, [request]);
  return { status, problem, devices, deviceId, level, request, take, choose, setProblem, setStatus };
}

export type MicrophoneCheck = ReturnType<typeof useMicrophoneCheck>;

/** Demo mode: a gentle simulated level so the preview looks like the real microphone check. */
function demoLevel(): number {
  const t = Date.now() / 1000;
  return Math.max(0.04, Math.min(0.95, 0.4 + 0.2 * Math.sin(t * 2.3) + 0.1 * Math.sin(t * 6.1 + 1.3)));
}

export function InPersonMicCheck({ check, showPicker, demo }: { check: MicrophoneCheck; showPicker: boolean; demo: boolean }) {
  return <section className="ip-section" aria-labelledby="ip-mic-title">
    <h3 id="ip-mic-title" className="ip-section-title">Microphone</h3>
    {demo ? <DemoMicrophone /> : <MicrophoneState check={check} showPicker={showPicker} />}
  </section>;
}

function DemoMicrophone() {
  const level = useLevel(demoLevel, true);
  return <>
    <InPersonLevel level={level} label="Microphone level" />
    <p className="field-hint">Demo: no microphone is used. Audio, captions and the transcript are simulated.</p>
  </>;
}

function MicrophoneState({ check, showPicker }: { check: MicrophoneCheck; showPicker: boolean }) {
  if (check.status === "ready") return <>
    {showPicker && check.devices.length > 1 ? <UiSelect id="ip-mic-device" label="Input device" value={check.deviceId} onChange={check.choose}
      options={check.devices.map((device) => ({ value: device.deviceId, label: device.label }))} /> : null}
    <InPersonLevel level={check.level} label="Microphone level" />
    <p className="field-hint">Speak for a moment: the bar should move. Place the device in the middle of the table.</p>
  </>;
  if (check.status === "error" && check.problem) return <Alert tone="danger" title={check.problem.title}
    actions={<button type="button" className="button secondary sm" onClick={() => void check.request(check.deviceId)}><RefreshCw aria-hidden="true" />Try again</button>}>
    {check.problem.detail}
  </Alert>;
  return <div className="ip-mic-idle">
    <p className="field-hint">Your browser asks for permission first. Nothing is recorded until you start.</p>
    <button type="button" className="button secondary" disabled={check.status === "requesting"} onClick={() => void check.request(check.deviceId)}>
      <Mic aria-hidden="true" />{check.status === "requesting" ? "Waiting for permission…" : "Allow microphone"}
    </button>
  </div>;
}
