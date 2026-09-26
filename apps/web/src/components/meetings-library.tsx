"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarClock, Mic, Plus, Search, SearchX } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import { useUiPreference } from "@/lib/ui-preferences";
import { attentionStatuses, inProgressStatuses, meetingStatusLabel, platformMonogram } from "@/lib/meeting-status";
import type { CalendarSchedule, Meeting } from "@/lib/types";
import { PageHeader } from "./ui/page-header";
import { EmptyState } from "./ui/feedback";

type Filter = "all" | "scheduled" | "live" | "review" | "attention" | "completed";

const filters: Filter[] = ["all", "scheduled", "live", "review", "attention", "completed"];
const filterLabels: { key: Filter; label: string }[] = [
  { key: "all", label: "All" }, { key: "scheduled", label: "Scheduled" }, { key: "live", label: "In progress" },
  { key: "review", label: "Ready to review" }, { key: "attention", label: "Needs attention" }, { key: "completed", label: "Stopped" },
];
const sourceNames: Record<string, string> = { manual: "Manual schedule", googlecalendar: "Google Calendar", outlook: "Outlook", calendly: "Calendly", zoom: "Zoom" };

function matchesFilter(filter: Filter, meeting: Meeting, schedule: CalendarSchedule | undefined): boolean {
  if (filter === "all") return true;
  if (filter === "scheduled") return schedule?.status === "pending";
  if (filter === "live") return inProgressStatuses.has(meeting.status) && schedule?.status !== "pending";
  if (filter === "review") return meeting.status === "ready";
  if (filter === "attention") return attentionStatuses.has(meeting.status);
  return meeting.status === "stopped";
}

function countFilters(meetings: Meeting[], byId: Map<string, CalendarSchedule>): Record<Filter, number> {
  const counts: Record<Filter, number> = { all: meetings.length, scheduled: 0, live: 0, review: 0, attention: 0, completed: 0 };
  for (const meeting of meetings) {
    if (byId.get(meeting.id)?.status === "pending") counts.scheduled++;
    else if (inProgressStatuses.has(meeting.status)) counts.live++;
    else if (meeting.status === "ready") counts.review++;
    else if (attentionStatuses.has(meeting.status)) counts.attention++;
    else if (meeting.status === "stopped") counts.completed++;
  }
  return counts;
}

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function MeetingsLibrary({ identity, meetings, onOpen, onNew, onCalendar }: { identity: string; meetings: Meeting[]; onOpen(id: string): void; onNew(): void; onCalendar(): void }) {
  const [schedules, setSchedules] = useState<CalendarSchedule[]>([]);
  const [filter, setFilter] = useUiPreference(`meetings-ai:meeting-filter:${identity}`, "all" as Filter, (value): value is Filter => filters.includes(value as Filter));
  const [query, setQuery] = useUiPreference(`meetings-ai:meeting-query:${identity}`, "", (value): value is string => typeof value === "string" && value.length <= 120, "session");
  useEffect(() => { void meetingsService.listCalendarSchedules().then(setSchedules).catch(() => setSchedules([])); }, [meetings]);
  const byId = useMemo(() => new Map(schedules.map((item) => [item.meeting_id, item])), [schedules]);
  const counts = countFilters(meetings, byId);
  const visible = meetings.filter((meeting) => {
    const match = !query || `${meeting.title} ${meeting.platform} ${meeting.status}`.toLowerCase().includes(query.toLowerCase());
    return match && matchesFilter(filter, meeting, byId.get(meeting.id));
  });
  const clearFilters = () => { setFilter("all"); setQuery(""); };

  return <section className="page meetings-library" aria-labelledby="meetings-title">
    <PageHeader
      titleId="meetings-title"
      title="Meetings"
      description="Scheduled assistants and past captures, all in one place."
      actions={<><button className="button secondary" onClick={onCalendar}><CalendarClock aria-hidden="true" /> Calendar</button><button className="button primary" onClick={onNew}><Plus aria-hidden="true" /> New meeting</button></>}
    />
    <div className="library-toolbar">
      <div className="segmented library-filters" role="group" aria-label="Filter meetings">
        {filterLabels.map((item) => <button key={item.key} type="button" aria-pressed={filter === item.key} className={filter === item.key ? "selected" : ""} onClick={() => setFilter(item.key)}>{item.label}<span className="count">{counts[item.key]}</span></button>)}
      </div>
      <label className="input-with-icon library-search">
        <Search aria-hidden="true" />
        <span className="sr-only">Search meetings</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search meetings" />
      </label>
    </div>
    {visible.length ? <ul className="list-card library-list" aria-label={`${visible.length} meeting${visible.length === 1 ? "" : "s"}`}>
      {visible.map((meeting) => <LibraryRow key={meeting.id} meeting={meeting} schedule={byId.get(meeting.id)} onOpen={() => onOpen(meeting.id)} />)}
    </ul> : meetings.length ? <EmptyState icon={<SearchX />} title="No meetings match this view" action={<button type="button" className="button secondary" onClick={clearFilters}>Clear filters</button>}>Try another status or search term.</EmptyState>
      : <EmptyState icon={<Mic />} title="No meetings yet">Send the assistant to a Google Meet, Zoom, Teams or Jitsi call, or schedule one from your calendar.</EmptyState>}
  </section>;
}

function LibraryRow({ meeting, schedule, onOpen }: { meeting: Meeting; schedule: CalendarSchedule | undefined; onOpen(): void }) {
  const scheduled = schedule?.status === "pending";
  const when = schedule ? `${sourceNames[schedule.provider ?? ""] ?? schedule.provider ?? "Calendar"} · ${formatWhen(schedule.starts_at)}` : meeting.startsAt;
  return <li>
    <button type="button" className="library-row" aria-label={`Open ${meeting.title}`} onClick={onOpen}>
      <span className="library-platform" aria-hidden="true">{platformMonogram(meeting.platform)}</span>
      <span className="library-row-copy"><b>{meeting.title}</b><small>{meeting.platform} · {when}{meeting.participants ? ` · ${meeting.participants} participant${meeting.participants === 1 ? "" : "s"}` : ""}</small></span>
      <span className="library-row-duration">{meeting.duration === "—" ? "" : meeting.duration}</span>
      <span className={`status ${scheduled ? "scheduled" : meeting.status}`}>{scheduled ? "Scheduled" : meetingStatusLabel[meeting.status]}</span>
      <ArrowRight className="library-row-arrow" aria-hidden="true" />
    </button>
  </li>;
}
