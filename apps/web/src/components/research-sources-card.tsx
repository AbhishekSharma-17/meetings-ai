"use client";

import { useCallback, useEffect, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { Link2, MoreHorizontal, RefreshCw, ShieldCheck, Telescope, Unplug } from "lucide-react";
import { apolloService, serviceErrorStatus } from "@/lib/meetings-service";
import { formatDateTime } from "@/lib/time-preferences";
import type { ApolloIntegration } from "@/lib/types";
import { Alert, Badge, LoadingRow } from "./ui/feedback";
import type { SettingsNotice } from "./settings-toast";
import { ProviderBrandIcon } from "./provider-brand-icons";
import { ApolloKeyDialog } from "./apollo-key-dialog";
import { creditLineText } from "./provider-balance";

const STATUS: Record<NonNullable<ApolloIntegration["status"]>, { label: string; tone: "success" | "danger" | "warning" }> = {
  active: { label: "Connected", tone: "success" },
  invalid: { label: "Key rejected", tone: "danger" },
  out_of_credit: { label: "Out of credits", tone: "warning" },
};

/** AI providers → Research sources: the workspace's Apollo connection (owners and admins). Members never see it. */
export function ResearchSourcesCard({ onNotice }: { onNotice(notice: SettingsNotice): void }) {
  const [view, setView] = useState<ApolloIntegration | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [dialog, setDialog] = useState<"connect" | "replace" | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    try { setView(await apolloService.status()); setError(null); }
    catch (cause) {
      const status = serviceErrorStatus(cause);
      if (status === 403 || status === 404) setHidden(true); // members, or an API without research sources
      else setError(cause instanceof Error ? cause.message : "Research sources could not be loaded.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  async function check() {
    setChecking(true);
    try {
      const next = await apolloService.test();
      setView(next);
      onNotice({ tone: "success", text: "Apollo checked just now: the key works." });
    } catch (cause) {
      onNotice({ tone: "danger", text: cause instanceof Error ? cause.message : "Apollo could not be checked." });
      void load();
    } finally { setChecking(false); }
  }

  async function disconnect() {
    setRemoving(true);
    try {
      await apolloService.disconnect();
      setConfirming(false);
      onNotice({ tone: "success", text: "Apollo disconnected. Briefings use web research only." });
      await load();
    } catch (cause) {
      onNotice({ tone: "danger", text: cause instanceof Error ? cause.message : "Apollo could not be disconnected." });
    } finally { setRemoving(false); }
  }

  if (hidden) return null;
  const connected = Boolean(view?.connected);
  const status = view?.status ? STATUS[view.status] : null;
  return <section className="card research-sources" aria-labelledby="research-sources-title">
    <div className="card-header provider-group-header">
      <span className="settings-icon" aria-hidden="true"><Telescope /></span>
      <div><h2 id="research-sources-title">Research sources</h2><p>Verified company and people data for meeting briefings, looked up before web research.</p></div>
    </div>
    {loading ? <div className="research-sources-state"><LoadingRow>Loading research sources…</LoadingRow></div>
      : error ? <div className="research-sources-state"><Alert tone="warning" title="Research sources are unavailable" actions={<button type="button" className="button secondary sm" onClick={() => void load()}>Retry</button>}>{error}</Alert></div>
        : <div className="research-source" data-state={view?.status ?? "off"}>
          <div className="research-source-row">
            <ProviderBrandIcon brand="apollo" />
            <span className="research-source-main">
              <b>Apollo</b>
              <small>Company size, funding, tech stack, verified titles, hiring and news</small>
            </span>
            {connected && view?.hint ? <code className="provider-key-hint" aria-label={`Key ending ${view.hint.replace(/•/g, "")}`}>{view.hint}</code> : null}
            {status ? <Badge tone={status.tone} dot>{status.label}</Badge> : <Badge tone="neutral">Not connected</Badge>}
            {connected ? <Menu.Root>
              <Menu.Trigger className="icon-button" aria-label="Apollo actions"><MoreHorizontal aria-hidden="true" /></Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner sideOffset={4} align="end">
                  <Menu.Popup className="popover">
                    <Menu.Item className="menu-item" disabled={checking} onClick={() => void check()}><ShieldCheck /> {checking ? "Checking…" : "Check key"}</Menu.Item>
                    <Menu.Item className="menu-item" onClick={() => setDialog("replace")}><RefreshCw /> Replace key</Menu.Item>
                    <Menu.Separator className="menu-separator" />
                    <Menu.Item className="menu-item destructive" onClick={() => setConfirming(true)}><Unplug /> Disconnect</Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root> : view?.available ? <button type="button" className="button secondary sm" onClick={() => setDialog("connect")}><Link2 aria-hidden="true" /> Connect Apollo</button> : null}
          </div>
          {connected && view ? <ConnectedDetail view={view} onReplace={() => setDialog("replace")} /> : null}
          {!connected && view && !view.available ? <Alert tone="neutral" role="note" className="research-source-note">Apollo isn’t available on this server yet. Contact your administrator.</Alert> : null}
          {confirming ? <Alert tone="danger" className="research-source-note" title="Disconnect Apollo?" actions={<>
            <button type="button" className="button danger sm" disabled={removing} onClick={() => void disconnect()}>{removing ? "Disconnecting…" : "Disconnect"}</button>
            <button type="button" className="button secondary sm" onClick={() => setConfirming(false)}>Cancel</button>
          </>}>New briefings stop using Apollo. Existing briefings keep their Apollo details.</Alert> : null}
        </div>}
    <ApolloKeyDialog mode={dialog} onClose={() => setDialog(null)} onSaved={(next) => {
      setView(next); setDialog(null);
      onNotice({ tone: "success", text: `Apollo connected (${next.hint ?? "key saved"}). New briefings include verified company and people data.` });
    }} />
  </section>;
}

function ConnectedDetail({ view, onReplace }: { view: ApolloIntegration; onReplace(): void }) {
  const who = [view.connected_by ? `Connected by ${view.connected_by}` : "Connected", view.connected_at ? formatDateTime(view.connected_at) : null].filter(Boolean).join(" · ");
  return <div className="research-source-detail">
    <p className="research-source-meta">{who}{view.last_checked_at ? ` · checked ${formatDateTime(view.last_checked_at)}` : ""}</p>
    {view.status === "invalid" ? <Alert tone="danger" title="Apollo rejected this key" actions={<button type="button" className="button secondary sm" onClick={onReplace}>Replace key</button>}>Briefings skip Apollo until you paste a working key.</Alert> : null}
    {view.status === "out_of_credit" ? <Alert tone="warning" title="Apollo is out of credits">Briefings skip Apollo until credits renew. Web research still runs.</Alert> : null}
    {view.credits.length ? <ul className="research-source-credits" aria-label="Apollo credits this billing cycle">
      {view.credits.map((line) => <li key={line.credit_type}><span>{line.label}</span><b>{creditLineText(line)}</b></li>)}
    </ul> : null}
  </div>;
}
