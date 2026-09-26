"use client";

import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { UsageEvent } from "@/lib/types";
import { Badge } from "./ui/feedback";
import { detailLabel, formatDuration, formatUsd, kindLabel, kindTone, providerLabel, purposeLabel, statusLabel, unitsLabel } from "./usage-labels";

function detailValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

/** Side sheet with every recorded field of one ledger row, including its non-secret details. */
export function UsageEventSheet({ event, onClose }: { event: UsageEvent | null; onClose(): void }) {
  const details = Object.entries(event?.details ?? {});
  return <Dialog.Root open={event !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="dialog-backdrop" />
      <Dialog.Popup className="sheet obs-sheet">
        {event ? <>
          <div className="obs-sheet-header">
            <Dialog.Close className="close-button" aria-label="Close call details"><X /></Dialog.Close>
            <p className="eyebrow">Usage record</p>
            <Dialog.Title className="dialog-title">{purposeLabel(event.purpose)}</Dialog.Title>
            <Dialog.Description className="dialog-intro">{new Date(event.created_at).toLocaleString()}</Dialog.Description>
            <div className="cluster obs-sheet-badges">
              <Badge tone={kindTone(event.kind)}>{kindLabel(event.kind)}</Badge>
              <Badge tone={event.status === "succeeded" ? "success" : "danger"} dot>{statusLabel(event.status)}</Badge>
              {event.estimated_usd === null ? <Badge tone="warning">Unpriced</Badge> : null}
            </div>
          </div>
          <div className="obs-sheet-body">
            <section aria-labelledby="obs-sheet-call">
              <h3 id="obs-sheet-call">Call</h3>
              <dl className="meta-list">
                <Row label="Provider">{providerLabel(event.provider)}</Row>
                <Row label="Model"><span className="obs-model">{event.model}</span></Row>
                <Row label="Input tokens">{event.input_tokens?.toLocaleString() ?? "—"}</Row>
                <Row label="Output tokens">{event.output_tokens?.toLocaleString() ?? "—"}</Row>
                <Row label="Units">{event.unit_type === "tokens" ? "—" : unitsLabel(event.units, event.unit_type)}</Row>
                <Row label="Duration">{formatDuration(event.duration_ms)}</Row>
                <Row label="Estimated cost">{event.estimated_usd === null ? "Unpriced" : formatUsd(event.estimated_usd)}</Row>
                <Row label="Price source">{event.price_source ? detailLabel(event.price_source) : "—"}</Row>
              </dl>
            </section>
            <section aria-labelledby="obs-sheet-context">
              <h3 id="obs-sheet-context">Context</h3>
              <dl className="meta-list">
                <Row label="Meeting">{event.meeting_title ?? (event.meeting_id ? "Deleted meeting" : "—")}</Row>
                <Row label="Meeting prep">{event.prep_event_title ?? (event.prep_event_id ? "Removed calendar event" : "—")}</Row>
                <Row label="Knowledge base">{event.knowledge_base_name ?? (event.knowledge_base_id ? "Deleted knowledge base" : "—")}</Row>
                <Row label="Triggered by">{event.actor_display_name ?? (event.actor_user_id ? "Former member" : "Automatic")}</Row>
              </dl>
            </section>
            <section aria-labelledby="obs-sheet-details">
              <h3 id="obs-sheet-details">Details</h3>
              {details.length ? <dl className="obs-kv">{details.map(([key, value]) => <div key={key}><dt>{detailLabel(key)}</dt><dd>{detailValue(value)}</dd></div>)}</dl>
                : <p className="field-hint text-tertiary">No extra details were recorded for this call.</p>}
              <p className="field-hint text-tertiary">Record ID <span className="obs-model">{event.id}</span></p>
            </section>
          </div>
        </> : null}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
