"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { CircleAlert, CircleCheck } from "lucide-react";
import { appReturnUrl, CALENDAR_OAUTH_CHANNEL, readCalendarOAuthResult, type CalendarOAuthResult } from "@/lib/calendar-oauth";

const CLOSE_AFTER_MS = 200;
const MANUAL_AFTER_MS = 900;

/**
 * The provider's return page when consent ran in a new tab. It reports the result
 * to the Meetings AI tab that opened it and closes itself; when the browser keeps
 * it open, it says so and links back to the app.
 */
export function CalendarOAuthCallback() {
  const [result, setResult] = useState<CalendarOAuthResult | null>(null);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    const next = readCalendarOAuthResult(window.location.search);
    try {
      // Only this app's own origin may receive the result.
      if (window.opener && window.opener !== window) window.opener.postMessage(next, window.location.origin);
    } catch { /* A severed or cross-origin opener; the channel and the opener's polling still work. */ }
    try {
      const channel = new BroadcastChannel(CALENDAR_OAUTH_CHANNEL);
      channel.postMessage(next);
      channel.close();
    } catch { /* Older browsers: the opener polls the account list instead. */ }
    const show = window.setTimeout(() => setResult(next), 0);
    const close = window.setTimeout(() => window.close(), CLOSE_AFTER_MS);
    const fallback = window.setTimeout(() => setManual(true), MANUAL_AFTER_MS);
    return () => { window.clearTimeout(show); window.clearTimeout(close); window.clearTimeout(fallback); };
  }, []);

  const connected = result?.status === "success";
  return <main className="oauth-callback">
    <section className="card oauth-callback-card" aria-live="polite" aria-busy={!manual}>
      {!manual || !result ? <>
        <Image src="/brand/meetings-ai-avatar.svg" alt="" width={44} height={44} className="oauth-callback-logo" />
        <div className="loading-row" role="status"><span className="spinner" aria-hidden="true" />Finishing the calendar connection…</div>
      </>
        : <>
          <span className={connected ? "oauth-callback-icon success" : "oauth-callback-icon danger"} aria-hidden="true">{connected ? <CircleCheck /> : <CircleAlert />}</span>
          <h1>{connected ? "Connected — you can close this tab" : "The calendar was not connected"}</h1>
          <p>{connected
            ? "Meetings AI has your new calendar account. Return to the app to see it."
            : `The provider did not finish the sign-in${result.detail ? ` (${result.detail})` : ""}. Nothing was changed.`}</p>
          <a className="button primary" href={appReturnUrl(result)}>Back to Meetings AI</a>
        </>}
    </section>
  </main>;
}
