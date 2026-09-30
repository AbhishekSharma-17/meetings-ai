"use client";

import { useState } from "react";
import { formatDateTime } from "@/lib/time-preferences";
import { Link2, RefreshCw } from "lucide-react";
import type { CalendarConnection, CalendarSyncState, ScheduledOnDisconnect } from "@/lib/types";
import { AccountNotices, DisconnectConfirm, accountFacts } from "./calendar-account-notices";
import { AccountRow, CalendarAliasDialog, ProviderGrid, connectionStatusLabel } from "./calendar-connections";
import { calendarProviderNames, type CalendarProvider } from "./calendar-providers";
import { NoMatches, SearchToolbar } from "./scroll-panel";
import { useListSearch } from "./use-list-search";
import { Badge, EmptyState } from "./ui/feedback";

const syncFormat: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

/** Integrations tab: connect sources, then name, rename or disconnect each account. */
export function CalendarIntegrations({ connections, syncs, busy, connecting = false, syncingIds, canSync, onSync, onConnect, onRename, onDisconnect }: {
  connections: CalendarConnection[];
  syncs: CalendarSyncState[];
  busy: boolean;
  /** A provider sign-in is open in another tab. */
  connecting?: boolean;
  /** Accounts with a per-row sync in flight. */
  syncingIds: string[];
  /** False while the calendar's date range is invalid. */
  canSync: boolean;
  onSync(connectionId: string): void;
  onConnect(provider: CalendarProvider, alias: string): void;
  onRename(connectionId: string, alias: string): Promise<boolean>;
  onDisconnect(connectionId: string, scheduled: ScheduledOnDisconnect): Promise<boolean>;
}) {
  const [connectProvider, setConnectProvider] = useState<CalendarProvider | null>(null);
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [editAlias, setEditAlias] = useState("");
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);
  const active = connections.filter((item) => item.status === "ACTIVE");
  const search = useListSearch(connections, (item) => [item.label, item.identity, calendarProviderNames[item.provider], connectionStatusLabel(item.status)]);

  function startRename(item: CalendarConnection) {
    setDisconnectTarget(null);
    setEditAlias(item.identity === item.label ? "" : item.label);
    setEditTarget(item.id);
  }

  return <div className="calendar-integrations">
    <div className="section-heading">
      <div><h2>Connected meeting sources</h2><p>Connect as many accounts as you need. Each meeting keeps its original source.</p></div>
    </div>
    <ProviderGrid activeConnections={active} disabled={busy || connecting} onConnect={setConnectProvider} />
    <CalendarAliasDialog provider={connectProvider} busy={busy} onCancel={() => setConnectProvider(null)} onSubmit={(alias) => { if (connectProvider) { onConnect(connectProvider, alias); setConnectProvider(null); } }} />

    <section className="card calendar-accounts" aria-labelledby="calendar-accounts-title">
      <div className="card-header">
        <div><h3 id="calendar-accounts-title">Accounts</h3><p>Sync, rename or disconnect each account on its own.</p></div>
        <span className="section-count">{connections.length} total</span>
      </div>
      {search.offered ? <SearchToolbar id="calendar-account-search" label="Search accounts" value={search.query} onChange={search.setQuery} placeholder="Search name, email or source" /> : null}
      {search.noMatches ? <NoMatches query={search.query} noun="accounts" onClear={search.clear} /> : connections.length ? <ul className="calendar-account-list">
        {search.visible.map((item) => {
          const sync = syncs.find((state) => state.connection_id === item.id);
          const editing = editTarget === item.id;
          const confirming = disconnectTarget === item.id;
          const rowSyncing = syncingIds.includes(item.id);
          const syncLabel = rowSyncing ? "Syncing…" : sync ? `Synced ${formatDateTime(sync.last_synced_at, syncFormat)}` : "Not synced yet";
          const facts = accountFacts(item);
          const meta = item.status === "ACTIVE"
            ? <><small role={rowSyncing ? "status" : undefined}>{syncLabel}</small>{facts ? <small className="calendar-account-facts">{facts}</small> : null}</>
            : <Badge tone="warning" dot>{connectionStatusLabel(item.status)}</Badge>;
          const actions = editing || confirming ? null : <>
            {item.status === "ACTIVE" ? <button type="button" className="button ghost icon sm calendar-row-sync" aria-label={`Sync ${item.label}`} title={`Sync ${item.label}`} aria-busy={rowSyncing || undefined} disabled={busy || rowSyncing || !canSync} onClick={() => onSync(item.id)}>
              <RefreshCw aria-hidden="true" className={rowSyncing ? "calendar-spin" : undefined} />
            </button> : null}
            <button type="button" className="button ghost sm" disabled={busy} onClick={() => startRename(item)}>Rename</button>
            <button type="button" className="button ghost sm calendar-disconnect-button" disabled={busy} onClick={() => { setEditTarget(null); setDisconnectTarget(item.id); }}>Disconnect</button>
          </>;
          return <AccountRow key={item.id} connection={item} meta={meta} actions={actions}>
            {editing ? <form className="calendar-row-panel calendar-rename-form" onSubmit={(event) => { event.preventDefault(); void onRename(item.id, editAlias).then((saved) => { if (saved) setEditTarget(null); }); }}>
              <div className="field">
                <label htmlFor={`calendar-alias-${item.id}`}>Connection name</label>
                <input id={`calendar-alias-${item.id}`} value={editAlias} maxLength={80} placeholder={item.identity ?? "e.g. Work calendar"} onChange={(event) => setEditAlias(event.target.value)} autoFocus />
              </div>
              <div className="button-group">
                <button type="button" className="button ghost sm" disabled={busy} onClick={() => setEditTarget(null)}>Cancel</button>
                <button type="submit" className="button primary sm" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
              </div>
            </form> : null}
            {confirming ? <DisconnectConfirm connection={item} busy={busy} onCancel={() => setDisconnectTarget(null)}
              onConfirm={(scheduled) => void onDisconnect(item.id, scheduled).then((done) => { if (done) setDisconnectTarget(null); })} /> : null}
            {editing || confirming ? null : <AccountNotices connection={item} connections={connections} />}
          </AccountRow>;
        })}
      </ul> : <div className="card-body"><EmptyState plain icon={<Link2 />} title="No accounts yet">Connect a source above to bring in your meetings.</EmptyState></div>}
    </section>
    <p className="field-hint calendar-teams-note">Microsoft Teams meetings come through Outlook Calendar when the event has a Teams join link. No separate Teams connection is needed.</p>
  </div>;
}
