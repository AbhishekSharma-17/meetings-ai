"use client";

import { useEffect, useState } from "react";
import { Share2 } from "lucide-react";
import { sharingService, type SharedWithMeItem } from "@/lib/sharing-service";
import { formatDateTime } from "@/lib/time-preferences";
import { PageHeader } from "./ui/page-header";
import { EmptyState, LoadingRow } from "./ui/feedback";

/** Meetings an owner or admin shared with me: open one to read its transcript and approved MOM. */
export function SharedWithMeScreen({ onOpenMeeting }: { onOpenMeeting(id: string): void }) {
  const [items, setItems] = useState<SharedWithMeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void sharingService.sharedWithMe().then((next) => { if (active) setItems(next); })
      .catch((cause) => { if (active) { setItems([]); setError(cause instanceof Error ? cause.message : "Could not load shared meetings."); } });
    return () => { active = false; };
  }, []);
  return <section className="page narrow shared-with-me" aria-labelledby="shared-with-me-title">
    <PageHeader titleId="shared-with-me-title" title="Shared with me" description="Meetings teammates gave you access to. Open one to read its transcript and approved MOM." />
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {items === null ? <LoadingRow>Loading shared meetings…</LoadingRow>
      : items.length ? <ul className="card shared-with-me-list">
        {items.map((item) => <li key={item.meeting_id}>
          <button type="button" className="shared-with-me-row" onClick={() => onOpenMeeting(item.meeting_id)}>
            <b>{item.title}</b>
            <small>{formatDateTime(item.meeting_at)} · shared by {item.shared_by?.display_name ?? "a teammate"} {formatDateTime(item.shared_at)}</small>
            {item.note ? <small className="sharing-note">“{item.note}”</small> : null}
          </button>
        </li>)}
      </ul>
        : <EmptyState icon={<Share2 />} title="Nothing shared with you yet">When a teammate shares a meeting with you, it appears here and you get a notification.</EmptyState>}
  </section>;
}
