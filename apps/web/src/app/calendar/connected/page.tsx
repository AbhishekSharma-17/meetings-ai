import type { Metadata } from "next";
import { CalendarOAuthCallback } from "@/components/calendar-oauth-callback";

export const metadata: Metadata = {
  title: "Calendar connection · Meetings AI",
  robots: { index: false, follow: false },
};

/** Where the calendar provider returns when consent ran in a new tab (see calendar_callback_url). */
export default function CalendarConnectedPage() {
  return <CalendarOAuthCallback />;
}
