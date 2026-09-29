"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import { coordinationService, coveringList, firstName, possessive, type CalendarCoordination, type CoverageSummary, type TeammateAssistant } from "@/lib/coordination";
import type { Meeting } from "@/lib/types";
import type { CalendarEntry } from "./calendar-events";
import { formatDateTime } from "@/lib/time-preferences";
import { WEEKDAY_DATE_TIME } from "@/lib/time-format";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/feedback";

const MAX_NAMES = 2;

function names(people: CoverageSummary["covering"]): string {
  const shown = coveringList(people.slice(0, MAX_NAMES));
  return people.length > MAX_NAMES ? `${shown} +${people.length - MAX_NAMES}` : shown;
}

/** Library chips for every meeting that coordinates with teammates. Reloads when the list changes. */
export function useCoverageSummaries(meetings: Meeting[]): Map<string, CoverageSummary> {
  const [items, setItems] = useState<CoverageSummary[]>([]);
  useEffect(() => {
    let active = true;
    // Chips are an enhancement: the library still works when they cannot be loaded.
    void coordinationService.summaries().then((next) => { if (active) setItems(next); }).catch(() => { if (active) setItems([]); });
    return () => { active = false; };
  }, [meetings]);
  return useMemo(() => new Map(items.map((item) => [item.meeting_id, item])), [items]);
}

/** "Shared with you by Asha" / "Also covered for Ben" / "Handed over to Asha" / "Two assistants". */
export function CoverageChip({ summary }: { summary: CoverageSummary | undefined }) {
  if (!summary) return null;
  if (summary.your_role === "sharing") return <Badge tone="brand" className="coordination-chip">Shared with you by {firstName(summary.owner)}</Badge>;
  if (summary.handed_to_owner) return <Badge tone="neutral" className="coordination-chip">Handed over to {firstName(summary.handed_to_owner)}</Badge>;
  if (summary.covering.length) return <Badge tone="info" className="coordination-chip">Also covered for {names(summary.covering)}</Badge>;
  if (summary.other_assistants) return <Badge tone="warning" className="coordination-chip">{summary.kept_own ? "Two assistants" : "Teammate also scheduled"}</Badge>;
  return null;
}

/** Coordination facts for the viewer's synced events, keyed by calendar event id. */
export function useCalendarCoordination(startDate: string, endDate: string, version = "") {
  const [items, setItems] = useState<CalendarCoordination[]>([]);
  const load = useCallback(() => {
    const start = new Date(`${startDate}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 1);
    const end = new Date(`${endDate}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 2);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return Promise.resolve();
    return coordinationService.forCalendar(start.toISOString(), end.toISOString()).then(setItems).catch(() => setItems([]));
  }, [startDate, endDate]);
  // Reload after every calendar sync (`version` changes), so new events get their coordination facts.
  useEffect(() => { void load(); }, [load, version]);
  const byEvent = useMemo(() => new Map(items.map((item) => [item.event_id, item])), [items]);
  const forEntry = useCallback((entry: CalendarEntry | null) => entry ? entry.sources.map((source) => byEvent.get(source.id)).find(Boolean) ?? null : null, [byEvent]);
  return { forEntry, reload: load };
}

function lead(item: CalendarCoordination): TeammateAssistant | null {
  return item.assistants.find((assistant) => assistant.state === "in_call" || assistant.state === "joining" || assistant.state === "scheduled")
    ?? item.assistants[0] ?? null;
}

/** A short chip for an agenda row. */
export function CalendarCoordinationMark({ item }: { item: CalendarCoordination | null }) {
  if (!item) return null;
  const first = lead(item);
  if (item.your_role === "sharing") return <span className="coordination-mark">Sharing {possessive(firstName(item.shared_from))} assistant</span>;
  if (item.your_role === "owner" && item.assistants.length) return <span className="coordination-mark warn">Two assistants</span>;
  if (item.your_role === "owner") return null;
  if (first) return <span className="coordination-mark">{possessive(firstName(first.owner))} assistant</span>;
  return null;
}

/** The event panel block: whose assistant covers this call and the choice to share it. */
export function EventCoordination({ item, onShared, onOpenMeeting }: {
  item: CalendarCoordination | null;
  onShared(): void;
  onOpenMeeting?(id: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receiveRecap, setReceiveRecap] = useState(true);
  if (!item) return null;
  const first = lead(item);
  const sharing = item.your_role === "sharing";

  async function share(target: TeammateAssistant) {
    setBusy(true); setError(null);
    try { await coordinationService.share(target.meeting_id, receiveRecap); onShared(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not share this assistant."); }
    finally { setBusy(false); }
  }

  return <div className="calendar-detail-block coordination-event" aria-label="Teammates on this call">
    <h3>Call coordination</h3>
    {sharing ? <p className="coordination-note">You&apos;re sharing {possessive(item.shared_from?.display_name ?? "a teammate")} assistant for this call.
      {item.your_meeting_id && onOpenMeeting ? <> <button type="button" className="text-button" onClick={() => onOpenMeeting(item.your_meeting_id!)}>Open its notes</button></> : null}</p> : null}
    {first && !sharing ? <div className="coordination-bringer">
      <Avatar name={first.owner?.display_name ?? "Teammate"} size="sm" />
      <p><b>{first.owner?.display_name ?? "A teammate"}</b> {first.state === "in_call" ? "has the assistant in this call" : first.state === "ended" ? "recorded this call" : `has the assistant joining at ${formatDateTime(first.starts_at, WEEKDAY_DATE_TIME)}`}.
        {first.covering.length ? <small> Also covering: {coveringList(first.covering)}.</small> : null}</p>
    </div> : null}
    {item.your_role === "owner" && item.assistants.length ? <p className="coordination-note">Your assistant and {possessive(firstName(first?.owner))} are both set for this call. Open your meeting to decide who brings it.</p> : null}
    {item.teammates_on_calendar ? <p className="coordination-note"><Users aria-hidden="true" />{item.teammates_on_calendar} teammate{item.teammates_on_calendar === 1 ? " also has" : "s also have"} this meeting on their calendar.</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {first && !sharing && item.your_role !== "owner" ? <div className="coordination-actions">
      <label className="check-label"><input type="checkbox" checked={receiveRecap} onChange={(event) => setReceiveRecap(event.target.checked)} />Email me the recap</label>
      <button type="button" className="button secondary sm" disabled={busy} onClick={() => void share(first)}>{busy ? "Sharing…" : `Share ${possessive(firstName(first.owner))} assistant`}</button>
    </div> : null}
    {item.your_role === "owner" && item.your_meeting_id && onOpenMeeting ? <button type="button" className="text-button" onClick={() => onOpenMeeting(item.your_meeting_id!)}>Open your meeting</button> : null}
  </div>;
}
