import type { CalendarProvider } from "./calendar-providers";

/*
 * Third-party brand marks. This is the only file allowed to carry literal colour
 * values: logos keep their owners' brand colours in both themes. Everything else
 * in the product uses design tokens (see scripts/lint-design.sh).
 */

type BrandIconProps = { provider: CalendarProvider; size?: "sm" | "md" | "lg"; className?: string };

export function CalendarBrandIcon({ provider, size = "md", className = "" }: BrandIconProps) {
  const classes = `brand-icon ${size} ${className}`.trim();
  if (provider === "googlecalendar") return <GoogleCalendarMark className={classes} />;
  if (provider === "outlook") return <OutlookMark className={classes} />;
  if (provider === "calendly") return <CalendlyMark className={classes} />;
  return <ZoomMark className={classes} />;
}

function GoogleCalendarMark({ className }: { className: string }) {
  return <svg className={className} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <rect x="5" y="7" width="38" height="36" rx="5" fill="#fff" />
    <path d="M5 13a6 6 0 0 1 6-6h10v8H5z" fill="#4285F4" />
    <path d="M21 7h16a6 6 0 0 1 6 6v2H21z" fill="#34A853" />
    <path d="M43 15v22a6 6 0 0 1-6 6h-2V15z" fill="#FBBC04" />
    <path d="M35 43H11a6 6 0 0 1-6-6v-2h30z" fill="#EA4335" />
    <path d="M5 15h8v20H5z" fill="#4285F4" />
    <path d="M20 24h4c2 0 3 1 3 3 0 1-.5 2-1.6 2.5 1.4.5 2 1.5 2 3 0 2.5-2 4-5 4-2 0-3.4-.4-4.8-1.3l1.2-2.5c1 .6 2 .9 3.2.9 1.1 0 1.7-.4 1.7-1.2 0-.8-.6-1.2-1.8-1.2h-1.7v-2.5h1.6c1.1 0 1.6-.4 1.6-1.1 0-.7-.5-1.1-1.4-1.1-1 0-2 .3-2.9.9l-1.2-2.5c1.4-.9 2.8-1.3 4.5-1.3Zm10 0h3v13h-3z" fill="#4285F4" />
  </svg>;
}

function OutlookMark({ className }: { className: string }) {
  return <svg className={className} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <rect x="13" y="7" width="30" height="34" rx="4" fill="#0078D4" />
    <path d="M15 17h26v20H15z" fill="#29A7F0" />
    <path d="M15 18 28 28l13-10v3L28 31 15 21z" fill="#fff" />
    <path d="M15 41 27 31l2 1 12 9z" fill="#0078D4" />
    <rect x="4" y="12" width="24" height="29" rx="3" fill="#005A9E" />
    <path d="M16 20c-4 0-6.4 2.8-6.4 6.8s2.4 6.8 6.4 6.8 6.4-2.8 6.4-6.8S20 20 16 20Zm0 3c2 0 3.2 1.5 3.2 3.8S18 30.6 16 30.6s-3.2-1.5-3.2-3.8S14 23 16 23Z" fill="#fff" />
  </svg>;
}

function CalendlyMark({ className }: { className: string }) {
  return <svg className={className} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <rect x="4" y="4" width="40" height="40" rx="10" fill="#006BFF" />
    <path d="M30.6 28.7c-1.5 1.4-3.4 2.3-5.7 2.3-4 0-7-3.1-7-7s3-7 7-7c2.3 0 4.2.8 5.7 2.3l2.6-2.6A11 11 0 0 0 24.9 13C18.8 13 14 17.9 14 24s4.8 11 10.9 11c3.3 0 6.3-1.3 8.3-3.6z" fill="#fff" />
    <circle cx="33.5" cy="24" r="2.6" fill="#0AE8F0" />
  </svg>;
}

function ZoomMark({ className }: { className: string }) {
  return <svg className={className} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <rect x="4" y="4" width="40" height="40" rx="10" fill="#0B5CFF" />
    <rect x="11" y="17" width="19" height="14" rx="3.5" fill="#fff" />
    <path d="m31.5 22.2 5.6-4a.9.9 0 0 1 1.4.8v10a.9.9 0 0 1-1.4.8l-5.6-4z" fill="#fff" />
  </svg>;
}
