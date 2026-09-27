import type { CalendarInvitee } from "../../types";
import { baseId, type Clock, localTime, meetingId, ORG_VENTURES } from "./ids";
import { DOMAIN } from "./people";
import { buildTranscript, type BackendSegment, type Line } from "./transcript-kit";
import { acmeRoadmap, acmeSecurity, acmeWeeklyLive } from "./transcripts-acme";
import { globexGoLive, globexRenewal, initechDiscovery } from "./transcripts-clients";
import { leadershipSync } from "./transcripts-internal";

export type BackendMeeting = {
  id: string; title: string; meeting_url: string; platform: string; status: string; bot_name: string;
  created_at: string; updated_at: string; joined_at: string | null; stopped_at: string | null; duration: string | null;
  participant_count: number; error_message: string | null; tags: string[]; knowledge_enabled: boolean; knowledge_base_id: string | null;
};

export type MinutesKey = "roadmap" | "discovery" | "renewal" | "leadership" | "golive" | "security";

export type MeetingSeed = {
  key: string;
  meeting: BackendMeeting;
  segments: BackendSegment[];
  /** Live meetings reveal segments as time passes (seconds since joined_at). */
  live: boolean;
  invitees: CalendarInvitee[];
  minutes: { key: MinutesKey; status: "draft" | "approved" | "sent" } | null;
  /** Automatic minutes drafting failed; "Retry automatic draft" recovers it. */
  draftFailed: boolean;
  fromCalendar: boolean;
  organizer: string;
  agenda: string;
};

const LINKS = {
  google_meet: "https://meet.google.com/xka-pqrm-tdw",
  zoom: "https://us06web.zoom.us/j/83421907756",
  teams: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_northwind_demo%40thread.v2/0",
} as const;
type Platform = keyof typeof LINKS;

const person = (name: string, email: string, response: string | null = "accepted"): CalendarInvitee => ({ name, email, response_status: response });
const team = (name: string, response: string | null = "accepted") => person(name, `${name.toLowerCase().replace(" ", ".")}@${DOMAIN}`, response);
const acme = (name: string, response: string | null = "accepted") => person(name, `${name.split(" ")[0].toLowerCase()}.${name.split(" ")[1].toLowerCase()}@acme-robotics.example`, response);
const globex = (name: string, response: string | null = "accepted") => person(name, `${name.split(" ")[0].toLowerCase()}@globex.example`, response);
const initech = (name: string, response: string | null = "accepted") => person(name, `${name.split(" ")[0].toLowerCase()}.${name.split(" ")[1].toLowerCase()}@initech.example`, response);

type Spec = {
  index: number; key: string; title: string; status: string; platform: Platform; joined: Date | null; minutes: number;
  lines: Line[] | null; gap?: number; kb: number | null; tags: string[]; invitees: CalendarInvitee[]; organizer: string; agenda: string;
  mom?: MeetingSeed["minutes"]; draftFailed?: boolean; error?: string; fromCalendar?: boolean; reviewed?: string[];
};

function seed(clock: Clock, spec: Spec): MeetingSeed {
  const joined = spec.joined;
  const ended = joined && ["completed", "failed", "stopped"].includes(spec.status) ? new Date(joined.getTime() + spec.minutes * 60_000) : null;
  const created = joined && spec.status !== "created" ? new Date(joined.getTime() - 4 * 60_000) : new Date(clock.start - 2 * 24 * 60 * 60_000);
  const segments = spec.lines ? buildTranscript(spec.key, spec.lines, { gap: spec.gap, reviewed: spec.reviewed }) : [];
  const speakers = new Set(segments.map((segment) => segment.speaker ?? segment.raw_speaker));
  return {
    key: spec.key,
    meeting: {
      id: meetingId(spec.index), title: spec.title, meeting_url: LINKS[spec.platform], platform: spec.platform, status: spec.status,
      bot_name: "Meetings AI", created_at: created.toISOString(), updated_at: (ended ?? joined ?? created).toISOString(),
      joined_at: spec.status === "created" || spec.status === "failed" ? null : joined?.toISOString() ?? null,
      stopped_at: ended?.toISOString() ?? null, duration: ended ? `${spec.minutes} min` : null,
      participant_count: Math.max(speakers.size - (speakers.has("Meetings AI") ? 1 : 0), spec.invitees.length),
      error_message: spec.error ?? null, tags: spec.tags, knowledge_enabled: spec.kb !== null, knowledge_base_id: spec.kb ? baseId(spec.kb) : null,
    },
    segments, live: spec.status === "live", invitees: spec.invitees, minutes: spec.mom ?? null, draftFailed: spec.draftFailed ?? false,
    fromCalendar: spec.fromCalendar ?? true, organizer: spec.organizer, agenda: spec.agenda,
  };
}

export function meetingSeeds(clock: Clock, orgId: string): MeetingSeed[] {
  const now = new Date(clock.start);
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const all: Array<Spec & { ventures?: boolean }> = [
    { index: 1, key: "acme-weekly", title: "Acme Robotics — weekly delivery sync", status: "live", platform: "google_meet", joined: ago(14), minutes: 0,
      lines: acmeWeeklyLive, gap: 36, kb: 1, tags: ["acme", "fieldguide", "delivery"], organizer: `alex.morgan@${DOMAIN}`,
      agenda: "Pilot access and data status, Rotterdam timeline, prototype walkthrough, success metrics.",
      invitees: [team("Alex Morgan"), team("Daniel Kim"), acme("Asha Patel"), acme("Chen Li"), acme("Grace Liu", "tentative")] },
    { index: 2, key: "globex-procurement", title: "Globex — procurement review", status: "waiting_room", platform: "teams", joined: ago(1), minutes: 0,
      lines: null, kb: 2, tags: ["globex", "renewal"], organizer: "maria@globex.example",
      agenda: "Review the renewal paperwork and the updated data processing addendum.",
      invitees: [globex("Maria Rossi"), globex("Lena Fischer"), team("Priya Shah"), team("Marcus Reed", "tentative")] },
    { index: 3, key: "acme-roadmap", title: "Acme Robotics — Q4 automation roadmap", status: "completed", platform: "google_meet", joined: localTime(clock, -1, 15), minutes: 48,
      lines: acmeRoadmap, kb: 1, tags: ["acme", "fieldguide", "roadmap"], organizer: `alex.morgan@${DOMAIN}`, mom: { key: "roadmap", status: "draft" }, reviewed: ["Asha Patel"],
      agenda: "Rotterdam MOU impact, maintenance knowledge pain points, pilot scope and commercials.",
      invitees: [team("Alex Morgan"), team("Priya Shah"), acme("Asha Patel"), acme("Chen Li"), acme("Ben Ortiz", "needsAction")] },
    { index: 4, key: "initech-discovery", title: "Initech — support automation discovery", status: "completed", platform: "zoom", joined: localTime(clock, -2, 11), minutes: 45,
      lines: initechDiscovery, kb: 2, tags: ["initech", "discovery", "support"], organizer: `alex.morgan@${DOMAIN}`, mom: { key: "discovery", status: "draft" },
      agenda: "Current support workflow, ticket volumes, automation goals, data access.",
      invitees: [team("Alex Morgan"), team("Sofia Alvarez"), initech("Omar Haddad"), initech("Nina Brooks"), initech("Raj Mehta")] },
    { index: 5, key: "globex-renewal", title: "Globex — contract renewal and SLA review", status: "completed", platform: "teams", joined: localTime(clock, -3, 14, 30), minutes: 40,
      lines: globexRenewal, kb: 2, tags: ["globex", "renewal", "commercial"], organizer: "maria@globex.example", mom: { key: "renewal", status: "draft" },
      agenda: "Managed service renewal: SLA, response times, pricing and DPA update.",
      invitees: [globex("Maria Rossi"), globex("Lena Fischer"), team("Alex Morgan"), team("Priya Shah"), team("Marcus Reed")] },
    { index: 6, key: "leadership", title: "Northwind Labs — weekly leadership sync", status: "completed", platform: "google_meet", joined: localTime(clock, -4, 9), minutes: 30, ventures: true,
      lines: leadershipSync, kb: 3, tags: ["internal", "leadership"], organizer: `alex.morgan@${DOMAIN}`, mom: { key: "leadership", status: "approved" },
      agenda: "Pipeline, delivery, hiring, numbers.",
      invitees: [team("Alex Morgan"), team("Priya Shah"), team("Daniel Kim"), team("Sofia Alvarez"), team("Marcus Reed")] },
    { index: 7, key: "globex-golive", title: "Globex — invoice automation go-live review", status: "completed", platform: "teams", joined: localTime(clock, -6, 16), minutes: 35,
      lines: globexGoLive, kb: 2, tags: ["globex", "go-live", "delivery"], organizer: `daniel.kim@${DOMAIN}`, mom: { key: "golive", status: "sent" },
      agenda: "First-week results for the Italian and Spanish entities, incidents, acceptance.",
      invitees: [team("Daniel Kim"), team("Sofia Alvarez"), globex("Maria Rossi"), globex("Tom Becker")] },
    { index: 8, key: "acme-security", title: "Acme Robotics — security and data review", status: "completed", platform: "google_meet", joined: localTime(clock, -5, 13), minutes: 38,
      lines: acmeSecurity, kb: 1, tags: ["acme", "security"], organizer: "asha.patel@acme-robotics.example", draftFailed: true,
      agenda: "Data residency, access control, logging and retention for the FieldGuide pilot.",
      invitees: [team("Daniel Kim"), team("Sofia Alvarez"), acme("Asha Patel"), acme("Grace Liu")] },
    { index: 9, key: "globex-workshop", title: "Globex — solution architecture workshop", status: "failed", platform: "teams", joined: localTime(clock, -8, 10), minutes: 12, ventures: true,
      lines: null, kb: 2, tags: ["globex"], organizer: "tom@globex.example",
      error: "The host did not admit the assistant from the lobby within 10 minutes. Nothing was recorded.",
      agenda: "Target architecture for invoice automation phase two.",
      invitees: [globex("Tom Becker"), team("Daniel Kim"), team("Sofia Alvarez")] },
    { index: 10, key: "initech-scoping", title: "Initech — pilot scoping workshop", status: "created", platform: "zoom", joined: localTime(clock, 1, 10), minutes: 60, ventures: true,
      lines: null, kb: 2, tags: ["initech", "pilot"], organizer: `alex.morgan@${DOMAIN}`,
      agenda: "Agree pilot scope for billing agent assist, success metrics, Spanish evaluation and timeline.",
      invitees: [team("Alex Morgan"), team("Sofia Alvarez"), team("Hannah Lee", "needsAction"), initech("Omar Haddad"), initech("Nina Brooks"), initech("Raj Mehta", "tentative")] },
  ];
  const specs = orgId === ORG_VENTURES ? all.filter((spec) => spec.ventures) : all;
  return specs.map((spec) => seed(clock, spec));
}

/** The meeting record as seen now: live meetings keep their transcript growing. */
export function visibleSegments(seedValue: MeetingSeed, nowMs: number): BackendSegment[] {
  if (!seedValue.live || !seedValue.meeting.joined_at) return seedValue.segments;
  const elapsed = (nowMs - new Date(seedValue.meeting.joined_at).getTime()) / 1000;
  return seedValue.segments.filter((segment) => segment.start_seconds <= elapsed);
}
