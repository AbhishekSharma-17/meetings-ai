"use client";

import { useEffect, useMemo, useState } from "react";
import { formatFullDateTime } from "@/lib/time-preferences";
import { ArrowRight, CalendarClock, Mic, Plus } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import { useUiPreference } from "@/lib/ui-preferences";
import { attentionStatuses, didNotHappen, inProgressStatuses, isReviewed, meetingBadge, meetingStatusLabel, needsReview, platformMonogram } from "@/lib/meeting-status";
import { toMeetingSchedule } from "./meeting-schedule-panel";
import { MeetingBadge } from "./meeting-badge";
import type { CalendarSchedule, Meeting } from "@/lib/types";
import { PageHeader } from "./ui/page-header";
import { EmptyState } from "./ui/feedback";
import { CoverageChip, useCoverageSummaries } from "./coordination-chips";
import type { CoverageSummary } from "@/lib/coordination";
import { FilterInput, NoMatches } from "./scroll-panel";
import { matchesQuery } from "@/lib/search";
import { InPersonChip, isInPerson } from "./in-person-meeting-panels";
import { useMeetingDuration } from "./use-meeting-duration";

type Filter = "all" | "scheduled" | "live" | "review" | "reviewed" | "attention" | "completed" | "cancelled";

const filters: Filter[] = ["all", "scheduled", "live", "review", "reviewed", "attention", "completed", "cancelled"];
const filterLabels: { key: Filter; label: string }[] = [
  { key: "all", label: "All" }, { key: "scheduled", label: "Scheduled" }, { key: "live", label: "In progress" },
  { key: "review", label: "Ready to review" }, { key: "reviewed", label: "Reviewed" },
  { key: "attention", label: "Needs attention" }, { key: "completed", label: "Stopped" }, { key: "cancelled", label: "Cancelled or missed" },
];
const sourceNames: Record<string, string> = { manual: "Manual schedule", googlecalendar: "Google Calendar", outlook: "Outlook", calendly: "Calendly", zoom: "Zoom" };

/** The meeting with its scheduled join: the freshly loaded schedule when there is one. */
function withSchedule(meeting: Meeting, schedule: CalendarSchedule | undefined): Meeting {
  return schedule ? { ...meeting, schedule: toMeetingSchedule(schedule, meeting.schedule?.changedAt) } : meeting;
}

function matchesFilter(filter: Filter, meeting: Meeting, schedule: CalendarSchedule | undefined): boolean {
  if (filter === "all") return true;
  if (filter === "scheduled") return schedule?.status === "pending";
  if (filter === "live") return inProgressStatuses.has(meeting.status) && schedule?.status !== "pending";
  if (filter === "review") return needsReview(meeting);
  if (filter === "reviewed") return isReviewed(meeting);
  if (filter === "attention") return attentionStatuses.has(meeting.status);
  if (filter === "cancelled") return didNotHappen(withSchedule(meeting, schedule));
  return meeting.status === "stopped" && !isReviewed(meeting);
}

function countFilters(meetings: Meeting[], byId: Map<string, CalendarSchedule>): Record<Filter, number> {
  const counts: Record<Filter, number> = { all: meetings.length, scheduled: 0, live: 0, review: 0, reviewed: 0, attention: 0, completed: 0, cancelled: 0 };
  for (const meeting of meetings) {
    if (byId.get(meeting.id)?.status === "pending") counts.scheduled++;
    else if (didNotHappen(withSchedule(meeting, byId.get(meeting.id)))) counts.cancelled++;
    else if (inProgressStatuses.has(meeting.status)) counts.live++;
    else if (isReviewed(meeting)) counts.reviewed++;
    else if (meeting.status === "ready") counts.review++;
    else if (attentionStatuses.has(meeting.status)) counts.attention++;
    else if (meeting.status === "stopped") counts.completed++;
  }
  return counts;
}

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatFullDateTime(date);
}

export function MeetingsLibrary({ identity, meetings, onOpen, onNew, onCalendar, onRecordInPerson }: { identity: string; meetings: Meeting[]; onOpen(id: string): void; onNew(): void; onCalendar(): void; onRecordInPerson?(): void }) {
  const [schedules, setSchedules] = useState<CalendarSchedule[]>([]);
  const [filter, setFilter] = useUiPreference(`meetings-ai:meeting-filter:${identity}`, "all" as Filter, (value): value is Filter => filters.includes(value as Filter));
  const [query, setQuery] = useUiPreference(`meetings-ai:meeting-query:${identity}`, "", (value): value is string => typeof value === "string" && value.length <= 120, "session");
  useEffect(() => { void meetingsService.listCalendarSchedules().then(setSchedules).catch(() => setSchedules([])); }, [meetings]);
  const byId = useMemo(() => new Map(schedules.map((item) => [item.meeting_id, item])), [schedules]);
  const coverage = useCoverageSummaries(meetings);
  const counts = countFilters(meetings, byId);
  const visible = meetings.filter((meeting) => matchesFilter(filter, meeting, byId.get(meeting.id)) && matchesQuery(query, meetingSearchFields(meeting, byId.get(meeting.id))));
  const clearFilters = () => { setFilter("all"); setQuery(""); };

  return <section className="page meetings-library" aria-labelledby="meetings-title">
    <PageHeader
      titleId="meetings-title"
      title="Meetings"
      description="Scheduled assistants and past captures, all in one place."
      actions={<><button className="button secondary" onClick={onCalendar}><CalendarClock aria-hidden="true" /> Calendar</button>{onRecordInPerson ? <button className="button secondary" onClick={onRecordInPerson}><Mic aria-hidden="true" /> Record in person</button> : null}<button className="button primary" onClick={onNew}><Plus aria-hidden="true" /> New meeting</button></>}
    />
    <div className="library-toolbar">
      <div className="segmented library-filters" role="group" aria-label="Filter meetings">
        {filterLabels.map((item) => <button key={item.key} type="button" aria-pressed={filter === item.key} className={filter === item.key ? "selected" : ""} onClick={() => setFilter(item.key)}>{item.label}<span className="count">{counts[item.key]}</span></button>)}
      </div>
      <FilterInput id="meeting-search" className="library-search page-search" label="Search meetings" value={query} onChange={setQuery} placeholder="Search meetings" />
    </div>
    {visible.length ? <ul className="list-card library-list" aria-label={`${visible.length} meeting${visible.length === 1 ? "" : "s"}`}>
      {visible.map((meeting) => <LibraryRow key={meeting.id} meeting={meeting} schedule={byId.get(meeting.id)} coverage={coverage.get(meeting.id)} onOpen={() => onOpen(meeting.id)} />)}
    </ul> : meetings.length ? <NoMatches query={query} noun="meetings" onClear={clearFilters} />
      : <EmptyState icon={<Mic />} title="No meetings yet">Send the assistant to a Google Meet, Zoom, Teams or Jitsi call, or schedule one from your calendar.</EmptyState>}
  </section>;
}

/** What a person would search a meeting by: title, platform, status, source and the date as shown. */
function meetingSearchFields(meeting: Meeting, schedule: CalendarSchedule | undefined) {
  return [meeting.title, meeting.platform, meeting.status, meetingStatusLabel[meeting.status], meetingBadge(meeting).label, schedule?.status === "pending" ? "Scheduled" : null,
    schedule?.rescheduled_from ? "Rescheduled" : null, didNotHappen(withSchedule(meeting, schedule)) ? "Cancelled" : null,
    schedule ? [sourceNames[schedule.provider ?? ""] ?? schedule.provider, formatWhen(schedule.starts_at)] : meeting.startsAt];
}

function LibraryRow({ meeting, schedule, coverage, onOpen }: { meeting: Meeting; schedule: CalendarSchedule | undefined; coverage?: CoverageSummary; onOpen(): void }) {
  const duration = useMeetingDuration(meeting);
  const scheduled = schedule?.status === "pending";
  const moved = scheduled && schedule?.rescheduled_from ? ` (was ${formatWhen(schedule.rescheduled_from)})` : "";
  const when = schedule ? `${sourceNames[schedule.provider ?? ""] ?? schedule.provider ?? "Calendar"} · ${formatWhen(schedule.starts_at)}${moved}` : meeting.startsAt;
  return <li>
    <button type="button" className="library-row" aria-label={`Open ${meeting.title}`} onClick={onOpen}>
      <span className="library-platform" aria-hidden="true">{platformMonogram(meeting.platform)}</span>
      <span className="library-row-copy"><b>{meeting.title}</b><small>{isInPerson(meeting) ? <InPersonChip className="inline" /> : meeting.platform} · {when}{meeting.participants ? ` · ${meeting.participants} participant${meeting.participants === 1 ? "" : "s"}` : ""}</small></span>
      <span className="library-row-duration">{duration === "—" ? "" : duration}</span>
      <span className="library-row-status">
        <CoverageChip summary={coverage} />
        <MeetingBadge meeting={withSchedule(meeting, schedule)} />
      </span>
      <ArrowRight className="library-row-arrow" aria-hidden="true" />
    </button>
  </li>;
}
