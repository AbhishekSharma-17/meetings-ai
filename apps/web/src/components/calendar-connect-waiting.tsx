"use client";

import { ExternalLink } from "lucide-react";
import { calendarProviderNames } from "./calendar-providers";
import type { CalendarConnectWait } from "./use-calendar-connect";
import { Alert } from "./ui/feedback";

/** Shown while the provider's consent screen is open in another tab. */
export function CalendarConnectWaiting({ wait, onReopen, onRecheck, onCancel, className = "" }: {
  wait: CalendarConnectWait | null;
  onReopen(): void;
  onRecheck(): void;
  onCancel(): void;
  className?: string;
}) {
  if (!wait) return null;
  const name = calendarProviderNames[wait.provider];
  if (wait.demo) {
    return <Alert tone="info" className={`calendar-connect-wait ${className}`.trim()} title={`Connecting ${name}…`}>
      Demo: simulating the sign-in. No real account is connected.
    </Alert>;
  }
  const cancel = <button type="button" className="button ghost sm" onClick={onCancel}>Cancel</button>;
  if (wait.timedOut) {
    return <Alert tone="warning" className={`calendar-connect-wait ${className}`.trim()} title={`Still waiting for ${name}`}
      actions={<>
        <button type="button" className="button secondary sm" onClick={onRecheck}>Check again</button>
        <button type="button" className="button ghost sm" disabled={!wait.url} onClick={onReopen}>Open again</button>
        {cancel}
      </>}>
      If you finished signing in, check again. Otherwise open the sign-in tab again.
    </Alert>;
  }
  return <Alert tone="info" className={`calendar-connect-wait ${className}`.trim()} title="Finish connecting in the new tab…"
    actions={<>
      <button type="button" className="button secondary sm" disabled={!wait.url} onClick={onReopen}><ExternalLink aria-hidden="true" />Open again</button>
      {cancel}
    </>}>
    {wait.url ? `Sign in to ${name} there. This page updates by itself.` : `Preparing the ${name} sign-in…`}
  </Alert>;
}
