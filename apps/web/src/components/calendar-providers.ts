import type { CalendarConnection } from "@/lib/types";

export type CalendarProvider = CalendarConnection["provider"];

/** Display order for meeting sources everywhere in the product. */
export const calendarProviders: readonly CalendarProvider[] = ["googlecalendar", "outlook", "calendly", "zoom"];

export const calendarProviderNames: Record<CalendarProvider, string> = {
  googlecalendar: "Google Calendar",
  outlook: "Outlook Calendar",
  calendly: "Calendly",
  zoom: "Zoom",
};

/** One short line shown on a provider card before it is connected. */
export const calendarProviderHints: Record<CalendarProvider, string> = {
  googlecalendar: "Google Workspace or Gmail calendars",
  outlook: "Includes Microsoft Teams meetings",
  calendly: "Booked events and their invitees",
  zoom: "Meetings you host in Zoom",
};

const platformNames: Record<string, string> = {
  google_meet: "Google Meet",
  zoom: "Zoom",
  teams: "Microsoft Teams",
  microsoft_teams: "Microsoft Teams",
  jitsi: "Jitsi",
};

export function platformLabel(platform: string): string {
  return platformNames[platform] ?? platform.replaceAll("_", " ");
}

/** The browser time zone, with the legacy Calcutta alias normalised for the API. */
export function browserTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return zone === "Asia/Calcutta" ? "Asia/Kolkata" : zone;
}
