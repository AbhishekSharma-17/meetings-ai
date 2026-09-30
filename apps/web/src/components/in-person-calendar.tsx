"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Users } from "lucide-react";
import { inPersonService } from "@/lib/in-person-service";
import type { InPersonCalendarLink, InPersonStatus } from "@/lib/in-person-types";
import type { CalendarEntry } from "./calendar-events";

const statusWords: Record<InPersonStatus, string> = {
  recording: "Recording in person", paused: "Recording in person", finalizing: "Creating transcript", done: "Recorded in person", failed: "Recording needs attention",
};

/** In-person recordings started from calendar events, for marks on those events. Decoration only: errors are ignored. */
export function useInPersonCalendarLinks(reloadKey: string) {
  const [links, setLinks] = useState<InPersonCalendarLink[]>([]);
  useEffect(() => {
    let active = true;
    void inPersonService.calendarLinks().then((items) => { if (active) setLinks(Array.isArray(items) ? items : []); }).catch(() => { if (active) setLinks([]); });
    return () => { active = false; };
  }, [reloadKey]);
  const byEvent = useMemo(() => new Map(links.map((link) => [`${link.connection_id}:${link.event_id}`, link])), [links]);
  /** The newest-listed link for any calendar copy of this entry. */
  const forEntry = useCallback((entry: CalendarEntry | null): InPersonCalendarLink | null => {
    if (!entry) return null;
    for (const source of entry.sources) {
      const link = byEvent.get(`${source.connection_id}:${source.event_id}`);
      if (link) return link;
    }
    return null;
  }, [byEvent]);
  return { forEntry };
}

/** Small mark in the day agenda row. */
export function InPersonCalendarMark({ link }: { link: InPersonCalendarLink | null }) {
  if (!link) return null;
  return <span className="ip-calendar-mark" data-status={link.status}><Users aria-hidden="true" />{statusWords[link.status]}</span>;
}

/** Block in the event panel: what happened to the in-person recording, and a way to open it. */
export function InPersonEventLink({ link, onOpenMeeting }: { link: InPersonCalendarLink | null; onOpenMeeting?(id: string): void }) {
  if (!link) return null;
  return <div className="calendar-detail-block ip-event-link" data-status={link.status}>
    <p className="ip-event-link-status"><span className="tag ip-chip"><Users aria-hidden="true" />In person</span><b>{statusWords[link.status]}</b></p>
    {link.title ? <p className="field-hint">{link.title}</p> : null}
    {onOpenMeeting ? <button type="button" className="button secondary sm" onClick={() => onOpenMeeting(link.meeting_id)}>Open recording <ArrowRight aria-hidden="true" /></button> : null}
  </div>;
}
