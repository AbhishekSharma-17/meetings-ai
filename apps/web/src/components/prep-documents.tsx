"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Trash2, Upload } from "lucide-react";
import { prepService, serviceErrorStatus } from "@/lib/meetings-service";
import type { PrepDocument } from "@/lib/types";
import { Badge, LoadingRow } from "./ui/feedback";

const POLL_MS = 4000;
const ACCEPT = ".pdf,.docx,.pptx,.xlsx,.md,.markdown,.txt,.csv,.html,.htm,.png,.jpg,.jpeg";
const statusCopy: Record<string, { label: string; tone: "success" | "info" | "danger" | "neutral" }> = {
  indexed: { label: "Ready", tone: "success" },
  processing: { label: "Processing", tone: "info" },
  pending: { label: "Queued", tone: "info" },
  failed: { label: "Failed", tone: "danger" },
};

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Private files for this meeting only (proposals, notes, decks). Sent to the briefing model, never to web search. */
export function PrepDocuments({ eventId, canEdit }: { eventId: string; canEdit: boolean }) {
  const [documents, setDocuments] = useState<PrepDocument[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [uploading, setUploading] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => prepService.listDocuments(eventId).then((items) => {
    setDocuments(items);
    setState("ready");
  }, (cause: unknown) => {
    if (serviceErrorStatus(cause) === 404) { setState("unavailable"); return; }
    setState("ready");
    setError(cause instanceof Error ? cause.message : "Documents could not be loaded.");
  }), [eventId]);

  useEffect(() => { void load(); }, [load]);

  const inFlight = documents.some((item) => item.status === "pending" || item.status === "processing");
  useEffect(() => {
    if (!inFlight) return;
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [inFlight, load]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setError(null);
    try {
      for (const file of Array.from(files)) {
        const saved = await prepService.uploadDocument(eventId, file);
        setDocuments((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await prepService.deleteDocument(id);
      setDocuments((current) => current.filter((item) => item.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The document could not be removed.");
    } finally { setConfirming(null); }
  }

  return <div className="prep-documents" role="group" aria-labelledby="prep-documents-title">
    <div className="prep-documents-head">
      <div>
        <h3 id="prep-documents-title">Documents for this meeting</h3>
        <p className="field-hint">Proposals, notes or decks. Used by the briefing model only, never sent to web search.</p>
      </div>
      {canEdit && state !== "unavailable" ? <>
        <input ref={fileRef} id="prep-document-input" className="sr-only" type="file" multiple accept={ACCEPT} onChange={(event) => void upload(event.target.files)} />
        <button type="button" className="button secondary sm" disabled={uploading || state === "loading"} onClick={() => fileRef.current?.click()}>
          <Upload aria-hidden="true" /> {uploading ? "Uploading…" : "Upload"}
        </button>
      </> : null}
    </div>
    {state === "loading" ? <LoadingRow>Loading documents…</LoadingRow>
      : state === "unavailable" ? <p className="prep-documents-empty">Document uploads are not available in this workspace yet.</p>
        : documents.length ? <ul className="prep-document-list">
          {documents.map((item) => {
            const status = statusCopy[item.status] ?? { label: item.status, tone: "neutral" as const };
            const pages = item.page_count ? `${item.page_count} ${item.page_count === 1 ? "page" : "pages"}${item.ocr_page_count ? ` · ${item.ocr_page_count} read with OCR` : ""}` : null;
            return <li key={item.id} className="prep-document">
              <span className="prep-document-icon" aria-hidden="true"><FileText /></span>
              <span className="prep-document-copy">
                <b title={item.filename}>{item.filename}</b>
                <small>{[sizeLabel(item.size_bytes), pages].filter(Boolean).join(" · ")}{item.status === "failed" && item.error ? ` · ${item.error}` : ""}</small>
              </span>
              <Badge tone={status.tone} dot>{status.label}</Badge>
              {canEdit ? confirming === item.id
                ? <span className="prep-document-confirm">
                  <button type="button" className="button danger sm" onClick={() => void remove(item.id)}>Remove</button>
                  <button type="button" className="button ghost sm" onClick={() => setConfirming(null)}>Keep</button>
                </span>
                : <button type="button" className="button ghost icon sm" aria-label={`Remove ${item.filename}`} onClick={() => setConfirming(item.id)}><Trash2 aria-hidden="true" /></button>
                : null}
            </li>;
          })}
        </ul> : <p className="prep-documents-empty">No documents yet.</p>}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </div>;
}
