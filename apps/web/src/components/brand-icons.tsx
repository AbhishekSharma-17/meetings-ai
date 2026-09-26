import type { ReactNode } from "react";
import { Video } from "lucide-react";
import type { MeetingPlatform } from "./calendar-events";
import type { CalendarProvider } from "./calendar-providers";

/*
 * Third-party brand marks. This is the only file allowed to carry literal colour
 * values: logos keep their owners' brand colours in both themes. Everything else
 * in the product uses design tokens (see scripts/lint-design.sh).
 *
 * The marks are simplified redrawings of each product's current app icon, sized
 * for 14–40px: Google Calendar and Google Meet (2020), the new Outlook icon,
 * the Calendly logomark, the Zoom app tile (2022) and the Microsoft Teams tile.
 */

export type BrandIconSize = "xs" | "sm" | "md" | "lg";
type MarkProps = { size?: BrandIconSize; className?: string; label?: string };

/** Unlabelled marks are decorative; a label makes the mark an image with a tooltip. */
function Mark({ viewBox, size = "md", className = "", label, children }: MarkProps & { viewBox: string; children: ReactNode }) {
  const classes = `brand-icon ${size} ${className}`.trim();
  if (!label) return <svg className={classes} viewBox={viewBox} aria-hidden="true" focusable="false">{children}</svg>;
  return <svg className={classes} viewBox={viewBox} role="img" aria-label={label} focusable="false"><title>{label}</title>{children}</svg>;
}

export function CalendarBrandIcon({ provider, ...props }: MarkProps & { provider: CalendarProvider }) {
  if (provider === "googlecalendar") return <GoogleCalendarMark {...props} />;
  if (provider === "outlook") return <OutlookMark {...props} />;
  if (provider === "calendly") return <CalendlyMark {...props} />;
  return <ZoomMark {...props} />;
}

/** The video platform an event runs on. Unknown platforms fall back to a neutral camera. */
export function PlatformBrandIcon({ platform, ...props }: MarkProps & { platform: MeetingPlatform | null }) {
  if (platform === "google_meet") return <GoogleMeetMark {...props} />;
  if (platform === "teams") return <TeamsMark {...props} />;
  if (platform === "zoom") return <ZoomMark {...props} />;
  const { size = "md", className = "", label } = props;
  return <span className={`brand-icon generic ${size} ${className}`.trim()} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} title={label}>
    <Video aria-hidden="true" />
  </span>;
}

function GoogleCalendarMark(props: MarkProps) {
  return <Mark viewBox="0 0 200 200" {...props}>
    <path fill="#fff" d="M152.6 47.4H47.4v105.2h105.2z" />
    <path fill="#EA4335" d="M152.6 200 200 152.6h-47.4z" />
    <path fill="#FBBC04" d="M200 47.4h-47.4v105.2H200z" />
    <path fill="#34A853" d="M152.6 152.6H47.4V200h105.2z" />
    <path fill="#188038" d="M0 152.6v31.6C0 192.9 7.1 200 15.8 200h31.6v-47.4z" />
    <path fill="#1967D2" d="M200 47.4V15.8C200 7.1 192.9 0 184.2 0h-31.6v47.4z" />
    <path fill="#4285F4" d="M152.6 0H15.8C7.1 0 0 7.1 0 15.8v136.8h47.4V47.4h105.2z" />
    <path fill="#4285F4" d="M69 129c-3.9-2.7-6.7-6.5-8.2-11.7l9.1-3.7c.8 3.1 2.3 5.6 4.3 7.3 2.1 1.7 4.6 2.6 7.5 2.6 3 0 5.6-.9 7.7-2.7 2.1-1.8 3.2-4.1 3.2-6.9 0-2.9-1.1-5.2-3.4-7-2.3-1.8-5.1-2.7-8.5-2.7h-5.3v-9H80c2.9 0 5.4-.8 7.4-2.4 2-1.6 3-3.7 3-6.5 0-2.4-.9-4.4-2.7-5.9-1.8-1.5-4-2.2-6.8-2.2-2.7 0-4.8.7-6.4 2.1a12.6 12.6 0 0 0-3.4 5.3l-9-3.8c1.2-3.4 3.4-6.4 6.6-9 3.2-2.6 7.3-3.9 12.3-3.9 3.7 0 7 .7 10 2.1 2.9 1.4 5.3 3.4 6.9 5.9 1.7 2.5 2.5 5.4 2.5 8.5 0 3.2-.8 5.9-2.3 8.2-1.6 2.2-3.5 3.9-5.7 5.1v.5a17.4 17.4 0 0 1 7.3 5.7c1.9 2.6 2.9 5.6 2.9 9.2 0 3.6-.9 6.8-2.7 9.6-1.8 2.8-4.3 5-7.5 6.6-3.2 1.6-6.8 2.4-10.8 2.4-4.6 0-8.9-1.3-12.8-4Zm56-45.3-10 7.2-5-7.6 18-13h6.9v61.2H125z" />
  </Mark>;
}

function OutlookMark(props: MarkProps) {
  return <Mark viewBox="0 0 48 48" {...props}>
    <path fill="#0364B8" d="M19 5h11v11H16V8a3 3 0 0 1 3-3Z" />
    <path fill="#0078D4" d="M30 5h11a3 3 0 0 1 3 3v8H30z" />
    <path fill="#28A8EA" d="M16 16h14v10H16z" />
    <path fill="#50D9FF" d="M30 16h14v10H30z" />
    <path fill="#1490DF" d="M16 24h28v15a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3z" />
    <path fill="#28A8EA" d="m16 24.5 14 9.2 14-9.2V39a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3z" />
    <path fill="#0A2767" opacity=".3" d="m16 42 14-8.3L44 42z" />
    <rect x="3" y="12" width="25" height="25" rx="3.5" fill="#0F6CBD" />
    <path fill="#fff" fillRule="evenodd" d="M15.5 17.6c-4.1 0-6.8 3-6.8 6.9s2.7 6.9 6.8 6.9 6.8-3 6.8-6.9-2.7-6.9-6.8-6.9Zm0 3.1c2 0 3.4 1.6 3.4 3.8s-1.4 3.8-3.4 3.8-3.4-1.6-3.4-3.8 1.4-3.8 3.4-3.8Z" />
  </Mark>;
}

function CalendlyMark(props: MarkProps) {
  return <Mark viewBox="0 0 48 48" {...props}>
    <rect x="3.5" y="3.5" width="41" height="41" rx="10" fill="#fff" stroke="#DCE4EE" />
    <path fill="#006BFF" d="M35.5 14.4A15 15 0 1 0 35.5 33.6l-4.1-3.4a9.6 9.6 0 1 1 0-12.4z" />
    <path fill="#0AE8F0" d="M30.9 18.2a9 9 0 0 1 0 11.6L28 27.3a5.2 5.2 0 0 0 0-6.6z" />
  </Mark>;
}

function ZoomMark(props: MarkProps) {
  return <Mark viewBox="0 0 48 48" {...props}>
    <rect x="3" y="3" width="42" height="42" rx="11" fill="#0B5CFF" />
    <path fill="#fff" d="M11 19.5a3.5 3.5 0 0 1 3.5-3.5H26a4 4 0 0 1 4 4v8.5a3.5 3.5 0 0 1-3.5 3.5H15a4 4 0 0 1-4-4z" />
    <path fill="#fff" d="m31.5 21.6 4.9-3.6c.9-.6 2.1 0 2.1 1.1v9.8c0 1.1-1.2 1.7-2.1 1.1l-4.9-3.6z" />
  </Mark>;
}

function GoogleMeetMark(props: MarkProps) {
  return <Mark viewBox="0 -7.75 87.5 87.5" {...props}>
    <path fill="#00832D" d="m49.5 36 8.53 9.75 11.47 7.33 2-17.02-2-16.64-11.69 6.44z" />
    <path fill="#0066DA" d="M0 51.5V66c0 3.3 2.7 6 6 6h14.5l3-10.96-3-9.54-9.95-3z" />
    <path fill="#E94235" d="M20.5 0 0 20.5l10.55 3 9.95-3 2.95-9.41z" />
    <path fill="#2684FC" d="M20.5 20.5H0v31h20.5z" />
    <path fill="#00AC47" d="M82.6 8.68 69.5 19.42v33.66l13.16 10.79c1.97 1.54 4.85.14 4.85-2.37V11c0-2.54-2.95-3.93-4.91-2.32ZM49.5 36v15.5h-29V72h43c3.3 0 6-2.7 6-6V53.08z" />
    <path fill="#FFBA00" d="M63.5 0h-43v20.5h29V36l20-16.57V6c0-3.3-2.7-6-6-6z" />
  </Mark>;
}

function TeamsMark(props: MarkProps) {
  return <Mark viewBox="0 0 48 48" {...props}>
    <circle cx="37" cy="12.5" r="4.5" fill="#5059C9" />
    <rect x="30" y="19" width="15" height="16" rx="4" fill="#5059C9" />
    <circle cx="26" cy="10.5" r="6" fill="#7B83EB" />
    <rect x="16" y="18.5" width="20" height="22" rx="5" fill="#7B83EB" />
    <rect x="3" y="13" width="24" height="24" rx="3.5" fill="#4B53BC" />
    <path fill="#fff" d="M9 18.8h12.2v3.3h-4.5v9.6h-3.3v-9.6H9z" />
  </Mark>;
}
