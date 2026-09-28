"use client";

import { useEffect, useMemo, useState } from "react";
import { formatFullDateTime, formatTime } from "@/lib/time-preferences";
import { History, RefreshCw } from "lucide-react";
import { meetingsService } from "@/lib/meetings-service";
import type { AuditEvent, WorkspaceMember } from "@/lib/types";
import { UiSelect } from "./ui-select";
import { Badge, EmptyState, LoadingRow } from "./ui/feedback";
import { activityCategories, activityCategoryOrder, dayLabel, describeAuditEvent, type ActivityCategory, type ActivityEntry } from "./audit-activity";
import { FilterInput, matchesQuery, NoMatches, ScrollPanel } from "./scroll-panel";
import { Avatar } from "./ui/avatar";

type CategoryFilter = ActivityCategory | "all";
/** Who to picture next to an entry: a teammate (photo or initials) or the assistant for automatic jobs. */
type ActorFace = { name: string; photoUrl: string | null; kind: "person" | "assistant" };

/** Workspace audit trail in plain language: who did what, to which meeting, person or knowledge base. */
export function ActivityCard({ members, meetingTitles, baseNames, teamNames }: { members: WorkspaceMember[]; meetingTitles: ReadonlyMap<string, string>; baseNames: ReadonlyMap<string, string>; teamNames?: ReadonlyMap<string, string> }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");

  useEffect(() => {
    void meetingsService.listWorkspaceAudit().then(setEvents).catch(() => {
      setError("Could not load recent activity.");
    }).finally(() => setLoaded(true));
  }, []);

  async function refresh() {
    setError(null); setRefreshing(true);
    try { setEvents(await meetingsService.listWorkspaceAudit()); }
    catch { setError("Could not load recent activity."); }
    finally { setRefreshing(false); }
  }

  const entries = useMemo(() => {
    const names = new Map(members.map((member) => [member.user_id, member.display_name]));
    const lookup = {
      actorName: (id: string) => names.get(id) ?? null,
      meetingTitle: (id: string) => meetingTitles.get(id) ?? null,
      knowledgeName: (id: string) => baseNames.get(id) ?? null,
      teamName: (id: string) => teamNames?.get(id) ?? null,
    };
    return events.map((event) => describeAuditEvent(event, lookup));
  }, [events, members, meetingTitles, baseNames, teamNames]);

  const faces = useMemo(() => {
    const byId = new Map(members.map((member) => [member.user_id, member]));
    const map = new Map<string, ActorFace>();
    for (const event of events) {
      const member = event.actor_user_id ? byId.get(event.actor_user_id) : undefined;
      if (member) map.set(event.id, { name: member.display_name, photoUrl: member.photo_url ?? null, kind: "person" });
      else if (!event.actor_user_id && event.action.startsWith("retention.")) map.set(event.id, { name: "Meetings AI", photoUrl: null, kind: "assistant" });
    }
    return map;
  }, [events, members]);

  const counts = useMemo(() => entries.reduce((map, entry) => map.set(entry.category, (map.get(entry.category) ?? 0) + 1), new Map<ActivityCategory, number>()), [entries]);
  const visible = entries.filter((entry) => (category === "all" || entry.category === category)
    && matchesQuery(query, [entry.sentence, activityCategories[entry.category].label, entry.failed ? "failed" : null]));
  const options = [{ value: "all", label: `All activity (${entries.length})` },
    ...activityCategoryOrder.filter((key) => counts.has(key)).map((key) => ({ value: key, label: `${activityCategories[key].label} (${counts.get(key)})` }))];
  const clear = () => { setQuery(""); setCategory("all"); };

  return <section className="card settings-section activity-card" id="settings-activity" aria-labelledby="workspace-audit-title">
    <div className="card-header">
      <div><h2 id="workspace-audit-title">Recent activity</h2><p>Changes, sign-ins and deliveries in this workspace. Message contents and credentials are never recorded.</p></div>
      <button type="button" className="button ghost sm" onClick={() => void refresh()} disabled={refreshing}><RefreshCw aria-hidden="true" className={refreshing ? "obs-spin" : undefined} /> Refresh</button>
    </div>
    {entries.length ? <div className="card-toolbar">
      <FilterInput id="activity-search" label="Search activity" value={query} onChange={setQuery} placeholder="Search people, meetings or actions" />
      <UiSelect id="activity-category" label="Activity category" hideLabel size="sm" value={category} onChange={(value) => setCategory(value as CategoryFilter)} options={options} className="card-toolbar-select" />
    </div> : null}
    {error ? <div className="card-body"><p className="form-error" role="alert">{error}</p></div> : null}
    {entries.length
      ? visible.length ? <ScrollPanel label="Activity log"><ActivityFeed entries={visible} faces={faces} /></ScrollPanel> : <NoMatches query={query} noun="activity entries" onClear={clear} />
      : loaded && !error ? <div className="card-body"><EmptyState plain icon={<History />} title="No activity yet">Sign-ins, meeting changes and recap deliveries will appear here.</EmptyState></div>
      : !error ? <LoadingRow>Loading recent activity…</LoadingRow> : null}
  </section>;
}

function ActivityFeed({ entries, faces }: { entries: ActivityEntry[]; faces: ReadonlyMap<string, ActorFace> }) {
  const now = new Date();
  const groups: Array<{ day: string; items: ActivityEntry[] }> = [];
  for (const entry of entries) {
    const day = dayLabel(entry.at, now);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(entry);
    else groups.push({ day, items: [entry] });
  }
  return <div className="activity-feed">
    {groups.map((group) => <section key={group.day} className="activity-day" aria-label={group.day}>
      <h3 className="activity-day-label">{group.day}</h3>
      <ol className="activity-list">{group.items.map((entry) => <ActivityRow key={entry.id} entry={entry} face={faces.get(entry.id)} />)}</ol>
    </section>)}
  </div>;
}

function ActivityRow({ entry, face }: { entry: ActivityEntry; face?: ActorFace }) {
  const Icon = entry.icon;
  const category = activityCategories[entry.category];
  const time = formatTime(entry.at);
  return <li className="activity-row" data-failed={entry.failed || undefined}>
    <span className="activity-icon" aria-hidden="true"><Icon /></span>
    <div className="activity-copy">
      <p className="activity-sentence">
        {face ? <Avatar name={face.name} photoUrl={face.photoUrl} kind={face.kind} size="sm" className="activity-avatar" /> : null}
        {entry.actor ? <b>{entry.actor}</b> : null}{entry.actor ? " " : null}{entry.text}
        {entry.target ? <> <span className="activity-target">{entry.target}</span></> : null}
        {entry.suffix ? ` ${entry.suffix}` : null}
      </p>
      <p className="activity-meta">
        <span>{category.label}</span>
        {entry.failed ? <Badge tone="danger">Failed</Badge> : null}
      </p>
    </div>
    <time className="activity-time" dateTime={entry.at.toISOString()} title={formatFullDateTime(entry.at)}>{time}</time>
  </li>;
}
