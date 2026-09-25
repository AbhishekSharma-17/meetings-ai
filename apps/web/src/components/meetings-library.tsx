"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Search } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { CalendarSchedule, Meeting } from "@/lib/types";

type Filter = "all" | "scheduled" | "live" | "review" | "attention" | "completed";

export function MeetingsLibrary({ meetings, onOpen, onNew, onCalendar }: { meetings: Meeting[]; onOpen(id: string): void; onNew(): void; onCalendar(): void }) {
  const [schedules, setSchedules] = useState<CalendarSchedule[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  useEffect(() => { void meetingsService.listCalendarSchedules().then(setSchedules).catch(() => setSchedules([])); }, [meetings]);
  const byId = useMemo(() => new Map(schedules.map((item) => [item.meeting_id, item])), [schedules]);
  const counts = { all: meetings.length, scheduled: 0, live: 0, review: 0, attention: 0, completed: 0 };
  for (const meeting of meetings) {
    if (byId.get(meeting.id)?.status === "pending") counts.scheduled++;
    else if (["joining", "waiting_room", "live", "stopping", "processing"].includes(meeting.status)) counts.live++;
    else if (meeting.status === "ready") counts.review++;
    else if (["failed", "needs_attention"].includes(meeting.status)) counts.attention++;
    else if (meeting.status === "stopped") counts.completed++;
  }
  const visible = meetings.filter((meeting) => {
    const schedule = byId.get(meeting.id);
    const match = !query || `${meeting.title} ${meeting.platform} ${meeting.status}`.toLowerCase().includes(query.toLowerCase());
    if (!match) return false;
    if (filter === "all") return true;
    if (filter === "scheduled") return schedule?.status === "pending";
    if (filter === "live") return ["joining", "waiting_room", "live", "stopping", "processing"].includes(meeting.status) && schedule?.status !== "pending";
    if (filter === "review") return meeting.status === "ready";
    if (filter === "attention") return ["failed", "needs_attention"].includes(meeting.status);
    return meeting.status === "stopped";
  });
  const labels: { key: Filter; label: string }[] = [
    { key: "all", label: "All" }, { key: "scheduled", label: "Scheduled" }, { key: "live", label: "In progress" },
    { key: "review", label: "Ready to review" }, { key: "attention", label: "Needs attention" }, { key: "completed", label: "Stopped" },
  ];
  return <section className="page meetings-library"><div className="section-heading"><div><p className="eyebrow">MEETING RECORDS</p><h1>Meetings</h1><p>Manage scheduled assistants and past captures in one place.</p></div><div className="dashboard-hero-actions"><button className="button secondary" onClick={onCalendar}><CalendarClock /> Calendar</button><button className="button primary" onClick={onNew}>New meeting</button></div></div>
    <div className="meeting-library-controls"><div className="meeting-filter-tabs" role="group" aria-label="Filter meetings">{labels.map((item) => <button key={item.key} type="button" aria-pressed={filter === item.key} className={filter === item.key ? "selected" : ""} onClick={() => setFilter(item.key)}>{item.label}<span>{counts[item.key]}</span></button>)}</div><label className="meeting-library-search"><Search size={16} /><span className="sr-only">Search meetings</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search meetings" /></label></div>
    {visible.length ? <div className="meeting-list">{visible.map((meeting) => { const schedule = byId.get(meeting.id); return <article key={meeting.id} className="meeting-library-row"><div><b>{meeting.title}</b><small>{meeting.platform} · {schedule ? `${schedule.provider === "manual" ? "Manual" : schedule.provider} source · ${new Date(schedule.starts_at).toLocaleString()}` : meeting.startsAt}</small></div><span className={`status ${meeting.status}`}>{schedule?.status === "pending" ? "Scheduled" : meeting.status.replaceAll("_", " ")}</span><button className="button secondary" onClick={() => onOpen(meeting.id)}>Open</button></article>; })}</div> : <div className="empty-state"><b>No meetings match this view.</b><p>Try another status or search term.</p></div>}
  </section>;
}
