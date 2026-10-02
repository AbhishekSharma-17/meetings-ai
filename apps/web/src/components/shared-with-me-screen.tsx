"use client";

import { useEffect, useState } from "react";
import { Share2 } from "lucide-react";
import { sharingService, type SharedWithMeItem } from "@/lib/sharing-service";
import { formatDateTime } from "@/lib/time-preferences";
import { PageHeader } from "./ui/page-header";
import { EmptyState, LoadingRow } from "./ui/feedback";
import { minutesVersions, type MinutesVersionSummary } from "@/lib/minutes-versions";
import { MinutesVersionList } from "./minutes-versions-panel";
import { MinutesVersionDialog } from "./minutes-version-dialog";

/** Meetings an owner or admin shared with me: open one to read its transcript and approved MOM. */
export function SharedWithMeScreen({ onOpenMeeting }: { onOpenMeeting(id: string): void }) {
  const [items, setItems] = useState<SharedWithMeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<MinutesVersionSummary[]>([]);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  function loadVersions() { void minutesVersions.inbox().then((next) => { setVersions(next); setVersionError(null); }).catch((cause) => { setVersionError(cause instanceof Error ? cause.message : "Could not load personal MOMs."); }); }
  useEffect(() => {
    let active = true;
    void sharingService.sharedWithMe().then((next) => { if (active) setItems(next); })
      .catch((cause) => { if (active) { setItems([]); setError(cause instanceof Error ? cause.message : "Could not load shared meetings."); } });
    return () => { active = false; };
  }, []);
  useEffect(() => { loadVersions(); }, []);
  return <section className="page narrow shared-with-me" aria-labelledby="shared-with-me-title">
    <PageHeader titleId="shared-with-me-title" title="Shared with me" description="Meetings teammates gave you access to. Open one to read its transcript and approved MOM." />
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <section className="card minutes-versions-card" aria-label="My and shared MOM versions"><div className="card-header"><div><h2>My & shared MOMs</h2><p>Your own versions and approved notes explicitly shared with you. Sharing a MOM does not share its transcript.</p></div></div><div className="card-body">{versionError ? <p className="form-error" role="alert">{versionError} <button className="text-button" onClick={loadVersions}>Retry</button></p> : null}<MinutesVersionList items={versions} onOpen={setSelected} /></div></section>
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
    {selected ? <MinutesVersionDialog key={selected} versionId={selected} segments={[]} onChanged={loadVersions} onClose={() => { setSelected(null); loadVersions(); }} /> : null}
  </section>;
}
