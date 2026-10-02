"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Lock, Plus } from "lucide-react";
import { minutesVersions, type MinutesVersionSummary } from "@/lib/minutes-versions";
import type { TranscriptSegment } from "@/lib/types";
import { Avatar } from "./ui/avatar";
import { Badge, LoadingRow } from "./ui/feedback";
import { MinutesVersionDialog } from "./minutes-version-dialog";
import { formatDateTime } from "@/lib/time-preferences";

/** The organizer's MOM stays in its existing card; this catalogue contains independent versions. */
export function MinutesVersionsPanel({ meetingId, segments }: { meetingId: string; segments: TranscriptSegment[] }) {
  const [items, setItems] = useState<MinutesVersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [canCreate, setCanCreate] = useState(false);
  const load = useCallback(() => minutesVersions.list(meetingId).then((next) => { setItems(next); setError(null); })
    .catch((cause) => { setError(cause instanceof Error ? cause.message : "Could not load MOM versions."); }), [meetingId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let active = true;
    import("@/lib/meetings-service").then(({ meetingsService }) => meetingsService.getCurrentAccount())
      .then((account) => { if (active) setCanCreate(account.role !== "viewer"); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return <section className="card minutes-versions-card" aria-label="Personal MOM versions">
    <div className="card-header"><div><h2>MOM versions <span className="section-count">{items?.length ?? 0}</span></h2>
      <p>One shared transcript. Separate notes for each perspective.</p></div>
      {canCreate ? <button className="button secondary sm" type="button" onClick={() => setCreating(true)}><Plus />Create my MOM</button> : null}</div>
    <div className="card-body">
      <p className="field-hint"><Lock className="inline-icon" />Private contents stay private—even from admins. Only the creator can edit or share a version. The organizer&apos;s MOM above remains unchanged.</p>
      {error ? <p className="form-error" role="alert">{error} <button className="text-button" onClick={() => void load()}>Retry</button></p> : null}
      {items === null && !error ? <LoadingRow>Loading versions…</LoadingRow> : null}
      {items ? <MinutesVersionList items={items} onOpen={setSelected} /> : null}
    </div>
    {(creating || selected) ? <MinutesVersionDialog key={selected ?? "new"} meetingId={meetingId} versionId={selected} segments={segments}
      onClose={() => { setCreating(false); setSelected(null); void load(); }} onChanged={() => void load()} /> : null}
  </section>;
}

export function MinutesVersionList({ items, onOpen }: { items: MinutesVersionSummary[]; onOpen(id: string): void }) {
  return items.length ? <ul className="minutes-versions-list">{items.map((item) => <li key={item.id}>
    <Avatar name={item.creator_name} size="sm" />
    <div className="minutes-version-copy"><b>{item.label}</b><small>{item.creator_name}{item.is_mine ? " · You" : ""} · {formatDateTime(item.updated_at)}</small>
      <span className="minutes-version-badges"><Badge tone={item.status === "approved" ? "success" : "neutral"}>{item.status === "empty" ? "Not drafted" : item.status}</Badge>
        <Badge tone="neutral">{item.template === "custom" ? "Custom focus" : item.template} · {item.visibility === "private" ? "Private" : item.visibility === "workspace" ? "Workspace" : "Selected people"}</Badge></span></div>
    {item.can_read ? <button className="button ghost sm" type="button" onClick={() => onOpen(item.id)}><FileText />{item.is_mine ? "Open my MOM" : "Read MOM"}</button> : <span className="minutes-version-private"><Lock aria-hidden="true" />Private contents</span>}
  </li>)}</ul> : <p className="field-hint">No personal versions yet. Create technical notes, a commercial recap, or your own custom format without sending another assistant.</p>;
}
