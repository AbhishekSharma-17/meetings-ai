/**
 * The message a calendar consent tab sends back to the Meetings AI tab that opened it.
 *
 * The provider returns to a fixed callback page on the server-configured origin
 * (`/calendar/connected?popup=1&status=…&connected_account_id=…`). That page posts
 * this shape to `window.opener` with its own origin as the target, and also on a
 * same-origin BroadcastChannel because some providers' sign-in pages sever the
 * opener link. Receivers must check `event.origin` and the shape before acting.
 */
export const CALENDAR_OAUTH_MESSAGE = "meetings-ai:calendar-connect";
export const CALENDAR_OAUTH_CHANNEL = "meetings-ai-calendar-connect";
export const CALENDAR_OAUTH_WINDOW = "meetings-ai-calendar-connect";
export const CALENDAR_OAUTH_FEATURES = "popup=yes,width=560,height=720";

export type CalendarOAuthResult = {
  type: typeof CALENDAR_OAUTH_MESSAGE;
  status: "success" | "failed";
  connectedAccountId: string | null;
  detail: string | null;
};

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_DETAIL = 200;

function plainDetail(value: string | null): string | null {
  const text = value?.replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, MAX_DETAIL) : null;
}

/** Reads the provider's callback query. A missing status counts as success; the opener re-checks the account list anyway. */
export function readCalendarOAuthResult(search: string): CalendarOAuthResult {
  const params = new URLSearchParams(search);
  const rawStatus = params.get("status")?.trim().toLowerCase() ?? "";
  const accountId = params.get("connected_account_id") ?? params.get("connectedAccountId");
  return {
    type: CALENDAR_OAUTH_MESSAGE,
    status: !rawStatus || rawStatus === "success" ? "success" : "failed",
    connectedAccountId: accountId && ACCOUNT_ID.test(accountId) ? accountId : null,
    detail: plainDetail(params.get("error_description") ?? params.get("error") ?? params.get("message")
      ?? (rawStatus && rawStatus !== "success" ? rawStatus : null)),
  };
}

export function isCalendarOAuthResult(value: unknown): value is CalendarOAuthResult {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.type === CALENDAR_OAUTH_MESSAGE
    && (item.status === "success" || item.status === "failed")
    && (item.connectedAccountId === null || (typeof item.connectedAccountId === "string" && ACCOUNT_ID.test(item.connectedAccountId)))
    && (item.detail === null || (typeof item.detail === "string" && item.detail.length <= MAX_DETAIL));
}

/** The same-tab app URL for this result, used by the callback page's "Back to Meetings AI" link. */
export function appReturnUrl(result: CalendarOAuthResult): string {
  const params = new URLSearchParams({ calendar: "connected", status: result.status });
  if (result.connectedAccountId) params.set("connected_account_id", result.connectedAccountId);
  return `/?${params.toString()}`;
}
