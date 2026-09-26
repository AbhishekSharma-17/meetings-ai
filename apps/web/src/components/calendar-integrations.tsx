"use client";

import { useState } from "react";
import { Link2 } from "lucide-react";
import type { CalendarConnection, CalendarSyncState } from "@/lib/types";
import { AccountRow, CalendarAliasDialog, ProviderGrid, connectionStatusLabel } from "./calendar-connections";
import type { CalendarProvider } from "./calendar-providers";
import { Badge, EmptyState } from "./ui/feedback";

const syncFormat: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

/** Integrations tab: connect sources, then name, rename or disconnect each account. */
export function CalendarIntegrations({ connections, syncs, busy, onConnect, onRename, onDisconnect }: {
  connections: CalendarConnection[];
  syncs: CalendarSyncState[];
  busy: boolean;
  onConnect(provider: CalendarProvider, alias: string): void;
  onRename(connectionId: string, alias: string): Promise<boolean>;
  onDisconnect(connectionId: string): Promise<boolean>;
}) {
  const [connectProvider, setConnectProvider] = useState<CalendarProvider | null>(null);
  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [editAlias, setEditAlias] = useState("");
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);
  const active = connections.filter((item) => item.status === "ACTIVE");

  function startRename(item: CalendarConnection) {
    setDisconnectTarget(null);
    setEditAlias(item.identity === item.label ? "" : item.label);
    setEditTarget(item.id);
  }

  return <div className="calendar-integrations">
    <div className="section-heading">
      <div><h2>Connected meeting sources</h2><p>Connect as many accounts as you need. Each meeting keeps its original source.</p></div>
    </div>
    <ProviderGrid activeConnections={active} disabled={busy} onConnect={setConnectProvider} />
    <CalendarAliasDialog provider={connectProvider} busy={busy} onCancel={() => setConnectProvider(null)} onSubmit={(alias) => { if (connectProvider) onConnect(connectProvider, alias); }} />

    <section className="card calendar-accounts" aria-labelledby="calendar-accounts-title">
      <div className="card-header">
        <div><h3 id="calendar-accounts-title">Accounts</h3><p>Rename an account to tell it apart, or disconnect it.</p></div>
        <span className="section-count">{connections.length} total</span>
      </div>
      {connections.length ? <ul className="calendar-account-list">
        {connections.map((item) => {
          const sync = syncs.find((state) => state.connection_id === item.id);
          const editing = editTarget === item.id;
          const confirming = disconnectTarget === item.id;
          const meta = item.status === "ACTIVE"
            ? <small>{sync ? `Synced ${new Date(sync.last_synced_at).toLocaleString(undefined, syncFormat)}` : "Not synced yet"}</small>
            : <Badge tone="warning" dot>{connectionStatusLabel(item.status)}</Badge>;
          const actions = editing || confirming ? null : <>
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
            {confirming ? <div className="calendar-row-panel calendar-disconnect-confirm" role="group" aria-label={`Disconnect ${item.label}`}>
              <p><b>Disconnect this account?</b> <span>Saved meetings and scheduled assistants remain.</span></p>
              <div className="button-group">
                <button type="button" className="button ghost sm" disabled={busy} onClick={() => setDisconnectTarget(null)}>Cancel</button>
                <button type="button" className="button danger sm" disabled={busy} onClick={() => void onDisconnect(item.id).then((done) => { if (done) setDisconnectTarget(null); })}>{busy ? "Disconnecting…" : "Confirm"}</button>
              </div>
            </div> : null}
          </AccountRow>;
        })}
      </ul> : <div className="card-body"><EmptyState plain icon={<Link2 />} title="No accounts yet">Connect a source above to bring in your meetings.</EmptyState></div>}
    </section>
    <p className="field-hint calendar-teams-note">Microsoft Teams meetings come through Outlook Calendar when the event has a Teams join link. No separate Teams connection is needed.</p>
  </div>;
}
