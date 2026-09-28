"use client";

import { useEffect, useId, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Globe } from "lucide-react";
import {
  dismissTimePreferencesError, formatTime, saveTimeFormat, saveTimeZone, useTimePreferences, zoneLabel, type TimePreferencesState,
} from "@/lib/time-preferences";
import { offsetLabel, offsetMinutes, zoneAbbreviation, type TimeFormat } from "@/lib/time-format";
import { TimeZonePicker } from "./time-zone-picker";
import { SwitchField } from "./ui/switch";

const MINUTE = 60_000;
const CLOCK_CHOICES: Array<{ value: TimeFormat; label: string }> = [
  { value: "auto", label: "Auto" }, { value: "12h", label: "12-hour" }, { value: "24h", label: "24-hour" },
];

/** The current time, re-rendered on each minute boundary. */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      setNow(new Date());
      interval = window.setInterval(() => setNow(new Date()), MINUTE);
    }, MINUTE - (Date.now() % MINUTE) + 50);
    return () => { window.clearTimeout(timeout); window.clearInterval(interval); };
  }, []);
  return now;
}

const browserDiffers = (prefs: TimePreferencesState) => prefs.source === "manual" && prefs.browserTimeZone !== prefs.timeZone;

/** Sidebar footer: live local time and zone; opens the time zone and clock settings. */
export function TimeZoneIndicator() {
  const prefs = useTimePreferences();
  const now = useMinuteClock();
  const label = zoneLabel(prefs.timeZone, now);
  const time = formatTime(now);
  return <Popover.Root>
    <Popover.Trigger className="tz-indicator" aria-label={`Time zone: ${prefs.timeZone}, local time ${time}. Change time zone or clock format`}>
      <Globe aria-hidden="true" />
      <span className="tz-indicator-copy"><b>{time}</b><span className="tz-indicator-sep" aria-hidden="true">·</span><span className="tz-indicator-zone">{label}</span></span>
      {browserDiffers(prefs) ? <span className="tz-indicator-dot" aria-hidden="true" /> : null}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="top" align="start" sideOffset={6} collisionPadding={12} className="ui-select-positioner">
        <Popover.Popup className="popover tz-popover">
          <Popover.Title className="tz-popover-title">Time zone & clock</Popover.Title>
          <Popover.Description className="tz-popover-intro">Calendars, meetings, reminders and every time in Meetings AI use this setting.</Popover.Description>
          <TimePreferencesPanel now={now} />
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

/** The settings themselves; shared by the sidebar popover and the profile page. */
export function TimePreferencesPanel({ now }: { now?: Date }) {
  const prefs = useTimePreferences();
  const ownClock = useMinuteClock();
  const at = now ?? ownClock;
  const id = useId();
  const browserLabel = `${prefs.browserTimeZone} · ${zoneAbbreviation(prefs.browserTimeZone, at)}, ${offsetLabel(offsetMinutes(at, prefs.browserTimeZone))}`;
  return <div className="tz-panel">
    <SwitchField id={`${id}-auto`} label="Use my browser's time zone" description={browserLabel}
      checked={prefs.source === "browser"} disabled={prefs.saving}
      onChange={(follow) => void saveTimeZone(follow ? null : prefs.browserTimeZone)} />
    {browserDiffers(prefs) ? <p className="tz-mismatch" role="note">
      Your browser is in {zoneLabel(prefs.browserTimeZone, at)}. <button type="button" className="text-button" disabled={prefs.saving} onClick={() => void saveTimeZone(null)}>Switch to it</button>
    </p> : null}
    <div className="tz-panel-section">
      <span className="tz-panel-label" id={`${id}-zone`}>Time zone <small>{prefs.source === "manual" ? "Set by you" : "Automatic"}</small></span>
      <TimeZonePicker value={prefs.timeZone} disabled={prefs.saving} label="Search time zones" onChange={(zone) => { if (zone !== prefs.timeZone || prefs.source === "browser") void saveTimeZone(zone); }} />
    </div>
    <div className="tz-panel-section">
      <span className="tz-panel-label" id={`${id}-clock`}>Clock <small>Now {formatTime(at)}</small></span>
      <div className="segmented tz-clock" role="group" aria-labelledby={`${id}-clock`}>
        {CLOCK_CHOICES.map((choice) => <button key={choice.value} type="button" aria-pressed={prefs.timeFormat === choice.value} disabled={prefs.saving}
          onClick={() => { if (choice.value !== prefs.timeFormat) void saveTimeFormat(choice.value); }}>{choice.label}</button>)}
      </div>
    </div>
    <p className="tz-panel-status" role="status">{prefs.saving ? "Saving…" : ""}</p>
    {prefs.error ? <p className="form-error tz-panel-error" role="alert">{prefs.error} <button type="button" className="text-button" onClick={dismissTimePreferencesError}>Dismiss</button></p> : null}
  </div>;
}

/** The same settings as a card on the profile page. */
export function TimePreferencesCard() {
  return <section className="card" aria-labelledby="time-preferences-title">
    <div className="card-header"><div><h2 id="time-preferences-title">Time zone & clock</h2><p>Follows your browser wherever you sign in, unless you pick a zone. Applies in every workspace.</p></div></div>
    <div className="card-body"><TimePreferencesPanel /></div>
  </section>;
}
